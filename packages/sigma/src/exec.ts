// `sigma exec`: start or open a conversation, submit one prompt, and follow the conversation's view
// until the run that prompt joined ends. Without `--auto` it denies every call that asks, its subagents' too, since
// nobody is there to answer.
import { applyImmutable, type Op } from "@sigma/delta"
import {
  type EntryRecord,
  type FellBehind,
  RUN_END_KIND,
  type RunEnd,
  TOAST_KIND,
  USER_KIND,
  type View,
  WITHDRAWN_KIND,
  type ViewItem,
} from "@sigma/protocol"
import { Deferred, Effect, Schedule, type Scope, Stream } from "effect"
import { imagesIn } from "./attach.ts"
import type { RpcClientError } from "effect/rpc/RpcClientError"
import { userName } from "./author.ts"
import { Client, serverRefusal, type StartOptions } from "./client.ts"
import { describeCall } from "./tui/calls.ts"

type Block = { readonly type: string; readonly text?: string; readonly name?: string; readonly arguments?: unknown }
type Message = { readonly content?: ReadonlyArray<Block> | string }
type Live = { readonly generation?: { message?: Message } }
type Request = { readonly tool: string; readonly arguments: unknown; readonly answer?: unknown }

const write = (text: string) => process.stdout.write(text)
const note = (text: string) => process.stderr.write(`${text}\n`)

const blocks = (message: Message | undefined): ReadonlyArray<Block> =>
  typeof message?.content === "string" ? [{ type: "text", text: message.content }] : (message?.content ?? [])

const textOf = (message: Message | undefined) =>
  blocks(message)
    .flatMap((block) => (block.type === "text" ? [block.text ?? ""] : []))
    .join("")

const liveOf = (view: View) => view.docs["pi.live"] as Live | undefined

const requestsOf = (view: View) =>
  Object.entries((view.docs["sigma.approvals"] as { requests?: Record<string, Request> } | undefined)?.requests ?? {})

const REWATCH_DELAY = "50 millis"
/** The entries one read of what a dropped watch missed asks for; a read pages on past it. */
const MISSED_PAGE = 200

/**
 * What the home's server last said refusing to start, noted once while exec waits for a server that starts, and
 * forgotten once one answers.
 */
let refusal: string | undefined
const answered = Effect.sync(() => {
  refusal = undefined
})
const noteRefusal = (error: unknown) =>
  Effect.sync(() => {
    const said = serverRefusal(error)
    if (said === undefined || said === refusal) return
    refusal = said
    note(`sigma's server cannot start: ${said}`)
  })

/**
 * A watch opened again each time it drops: when the connection goes, as when the server crashes and restarts, or when
 * the server ends it because this client fell behind.
 */
const rewatched = <A, E extends { readonly _tag: string }, R>(
  open: () => Stream.Stream<A, E | RpcClientError | FellBehind, R>,
): Stream.Stream<A, Exclude<E, RpcClientError | FellBehind>, R> =>
  open().pipe(
    Stream.tap(() => answered),
    Stream.catchIf(
      (error): error is RpcClientError | FellBehind => error._tag === "RpcClientError" || error._tag === "FellBehind",
      (error) =>
        Stream.concat(
          Stream.fromEffectDrain(Effect.andThen(noteRefusal(error), Effect.sleep(REWATCH_DELAY))),
          Stream.suspend(() => rewatched(open)),
        ),
    ),
  ) as Stream.Stream<A, Exclude<E, RpcClientError | FellBehind>, R>

/**
 * `call` asked again, spaced like a rewatch, while the connection is down, as when the server crashes and restarts.
 * Every call exec makes once it has a conversation is safe to ask again: it reads, or it is answered once (a
 * submission by its requestId, an approval by its first answer).
 */
const reconnecting = <A, E extends { readonly _tag: string }, R>(call: Effect.Effect<A, E, R>) =>
  call.pipe(
    Effect.tapError(noteRefusal),
    Effect.tap(() => answered),
    Effect.retry({ while: (error) => error._tag === "RpcClientError", schedule: Schedule.spaced(REWATCH_DELAY) }),
  )

/** The entries of `conversation` after `after` (from its start when undefined) up to `to`, oldest first, page by page. */
const missedEntries = (client: Client["Service"], conversation: string, after: number | undefined, to: number) =>
  Effect.gen(function* () {
    const entries: Array<EntryRecord> = []
    let cursor: unknown
    do {
      const page = yield* Effect.orDie(
        reconnecting(
          client["conversation/entries"]({
            conversation,
            ...(after === undefined ? {} : { from: after + 1 }),
            to,
            order: "ascending",
            limit: MISSED_PAGE,
            ...(cursor === undefined ? {} : { cursor: cursor as never }),
          }),
        ),
      )
      entries.push(...(page.entries as ReadonlyArray<EntryRecord>))
      cursor = page.next
    } while (cursor !== undefined)
    return entries
  })

/**
 * The view after each item, as a client keeps it, beside the entries that item added. What was committed between the
 * newest entry held and the window's start, as when a watch opened again starts a fresh window, is read with `missed`.
 */
const following = <E>(
  stream: Stream.Stream<ViewItem, E>,
  missed: (after: number | undefined, to: number) => Effect.Effect<ReadonlyArray<EntryRecord>>,
) =>
  Stream.mapAccumEffect(
    stream,
    () => ({ view: undefined as View | undefined, held: new Set<number>(), newest: undefined as number | undefined }),
    (state, item) =>
      Effect.gen(function* () {
        const view = item._tag === "view" ? item.view : applyImmutable(state.view, item.ops as ReadonlyArray<Op>)
        // A window that starts past the newest entry held, or past the start of a transcript that was empty when first
        // watched: a watch opened again, or one commit that added more entries than the window keeps.
        const gap =
          state.view !== undefined &&
          view.before !== undefined &&
          (state.newest === undefined || view.before > state.newest)
            ? yield* missed(state.newest, view.before)
            : []
        const added = [...gap, ...view.entries].filter((entry) => !state.held.has(entry.id))
        for (const entry of added) state.held.add(entry.id)
        const newest = added.reduce((most, entry) => Math.max(most, entry.id), state.newest ?? -Infinity)
        return [
          { view, held: state.held, newest: Number.isFinite(newest) ? newest : undefined },
          [{ item, view, added }],
        ] as const
      }),
  )

/** Text written so far: a streamed message goes on where it was, and a different one starts on a new line. */
class Printer {
  private printed = ""

  show(text: string) {
    if (text.startsWith(this.printed)) write(text.slice(this.printed.length))
    else if (this.printed.startsWith(text)) return
    else write(`\n${text}`)
    this.printed = text
  }

  end() {
    if (this.printed) write("\n")
    this.printed = ""
  }
}

export const exec = Effect.fnUntraced(function* (
  prompt: string,
  id: string | undefined,
  options: StartOptions,
  json: boolean,
) {
  const client = yield* Client
  const { conversation } = yield* client["conversation/start"]({
    cwd: process.cwd(),
    ...options,
    ...(id === undefined ? {} : { id }),
  })

  const asked = new Set<string>()
  const deny = (from: string, view: View) =>
    Effect.forEach(
      requestsOf(view).filter(([key, request]) => request.answer === undefined && !asked.has(`${from} ${key}`)),
      ([key, request]) => {
        asked.add(`${from} ${key}`)
        return reconnecting(
          client["approval/resolve"]({ conversation: from, approval: key, author: userName(), allow: false }),
        ).pipe(
          Effect.tap(({ accepted }) =>
            Effect.sync(() => {
              if (accepted) {
                note(
                  `denied ${describeCall(request.tool, request.arguments)}: exec cannot ask, pass --auto to allow calls`,
                )
              }
            }),
          ),
          // Settled before the answer arrived: nothing waits on it any more.
          Effect.catchTag("NoSuchApproval", () => Effect.void),
        )
      },
      { discard: true },
    )

  // A watch that fails would leave a call unanswered and exec waiting for good, so it fails exec instead.
  const failed = yield* Deferred.make<never>()
  const watching = <E, R>(effect: Effect.Effect<void, E, R>) =>
    Effect.forkScoped(Effect.catchCause(Effect.orDie(effect), (cause) => Deferred.failCause(failed, cause)))

  // Subagents ask in their own conversations, so exec follows every conversation under its own, which may itself be a
  // subagent: it looks again when the status of the tree it is in changes, as when a subagent waits on a person, and
  // when a followed conversation adds entries, as when it starts one. A subagent's watch ends when exec does.
  const listed = yield* reconnecting(client["conversation/list"]())
  const root = listed.find((info) => info.id === conversation)?.lineage?.root ?? conversation
  const followed = new Set([conversation])
  const discover: Effect.Effect<void, never, Scope.Scope> = Effect.gen(function* () {
    const conversations = yield* Effect.orDie(reconnecting(client["conversation/list"]()))
    const parents = new Map(conversations.map((info) => [info.id, info.lineage?.parent]))
    const under = (id: string | undefined): boolean => id !== undefined && (followed.has(id) || under(parents.get(id)))
    for (const info of conversations) {
      if (followed.has(info.id) || !under(info.lineage?.parent)) continue
      followed.add(info.id)
      yield* watching(
        following(
          rewatched(() => client["conversation/watch"]({ conversation: info.id })),
          (after, to) => missedEntries(client, info.id, after, to),
        ).pipe(
          Stream.runForEach(({ view, added }) =>
            Effect.andThen(deny(info.id, view), added.length > 0 ? discover : Effect.void),
          ),
        ),
      )
    }
  })
  yield* watching(
    rewatched(() => client["status/watch"]()).pipe(
      Stream.filter((item) => item._tag === "trees" || item.conversation === root),
      Stream.runForEach(() => discover),
    ),
  )

  const printer = new Printer()
  const images = imagesIn(prompt, process.cwd())
  const requestId = crypto.randomUUID()
  let submitted = false
  // The prompt's fate is read from the entries committed under its requestId, which every watch, reopened or not, is
  // handed in order: its sigma.user entry places it, and what follows is its run until the run's sigma.run_end; a
  // sigma.withdrawn entry says it was withdrawn before it ran.
  let placed = false
  let withdrawn = false
  let ended: RunEnd | undefined
  const ours = (entry: EntryRecord) => (entry.data as { requestId?: string } | undefined)?.requestId === requestId
  const onEntry = (entry: EntryRecord) => {
    if (!placed) {
      if (entry.kind === WITHDRAWN_KIND && ours(entry)) withdrawn = true
      placed = entry.kind === USER_KIND && ours(entry)
      return
    }
    if (entry.kind === "pi.assistant") {
      const message = entry.model?.[0] as Message | undefined
      if (!json) {
        const text = textOf(message)
        if (text) printer.show(text)
        printer.end()
      }
      for (const block of blocks(message)) {
        if (block.type === "toolCall") note(`› ${describeCall(block.name ?? "", block.arguments)}`)
      }
    } else if (entry.kind === TOAST_KIND) {
      const toast = entry.data as { extension: string; text: string }
      // On stderr, so a message streaming to stdout goes on where it was.
      note(`◆ ${toast.extension}: ${toast.text}`)
    } else if (entry.kind === RUN_END_KIND) {
      printer.end()
      ended = entry.data as RunEnd
      if (ended.outcome !== "answered") note(ended.message ?? ended.outcome)
    }
  }

  yield* following(
    rewatched(() => client["conversation/watch"]({ conversation })),
    (after, to) => missedEntries(client, conversation, after, to),
  ).pipe(
    Stream.tap(({ item, view, added }) =>
      Effect.gen(function* () {
        // Submitted once the watch holds the view, so the entries it is handed from then on cover the whole run.
        if (!submitted) {
          yield* reconnecting(
            client["conversation/submit"]({
              conversation,
              requestId,
              author: userName(),
              text: prompt,
              ...(images.length === 0 ? {} : { images }),
            }),
          )
          submitted = true
        }
        if (json) write(`${JSON.stringify(item)}\n`)
        for (const entry of added) if (ended === undefined && !withdrawn) onEntry(entry)
        if (placed && ended === undefined && !json) {
          const live = liveOf(view)?.generation?.message
          if (live !== undefined) printer.show(textOf(live))
        }
        yield* deny(conversation, view)
        if (added.length > 0) yield* discover
      }),
    ),
    Stream.takeUntil(() => ended !== undefined || withdrawn),
    Stream.runDrain,
    Effect.raceFirst(Deferred.await(failed)),
  )
  if (withdrawn) note("the prompt was withdrawn before it ran")
  else if (ended === undefined) note("the server ended the watch before the run ended")
  return ended?.outcome === "answered"
})
