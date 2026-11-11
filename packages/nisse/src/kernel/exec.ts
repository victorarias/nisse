// `nisse exec` on the kernel wire: start or open a conversation, submit one prompt, and follow the conversation's view
// until the run that prompt joined ends. Without `--auto` it denies every call that asks, its subagents' too, since
// nobody is there to answer.
import { applyImmutable, type Op } from "@nisse/delta"
import {
  type EntryRecord,
  RUN_END_KIND,
  type RunEnd,
  TOAST_KIND,
  USER_KIND,
  type View,
  type ViewItem,
} from "@nisse/wire"
import { Deferred, Effect, type Scope, Stream } from "effect"
import { imagesIn } from "../attach.ts"
import { userName } from "../author.ts"
import { KernelClient, type StartOptions } from "../client.ts"
import { describeCall } from "../tui/calls.ts"

type Block = { readonly type: string; readonly text?: string; readonly name?: string; readonly arguments?: unknown }
type Message = { readonly content?: ReadonlyArray<Block> | string }
type Live = { readonly run?: { readonly inputs: ReadonlyArray<number> }; readonly generation?: { message?: Message } }
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

const queued = (view: View, submission: number) =>
  (view.docs["pi.inbox"] as { items?: ReadonlyArray<{ id: number }> } | undefined)?.items?.some(
    (item) => item.id === submission,
  ) === true

const requestsOf = (view: View) =>
  Object.entries((view.docs["nisse.approvals"] as { requests?: Record<string, Request> } | undefined)?.requests ?? {})

/** The view after each item, as a client keeps it, beside the entries that item added. */
const following = <E>(stream: Stream.Stream<ViewItem, E>) =>
  Stream.mapAccum(
    stream,
    () => ({ view: undefined as View | undefined, held: new Set<number>() }),
    (state, item) => {
      const view = item._tag === "view" ? item.view : applyImmutable(state.view, item.ops as ReadonlyArray<Op>)
      const added = view.entries.filter((entry) => !state.held.has(entry.id))
      for (const entry of added) state.held.add(entry.id)
      return [{ view, held: state.held }, [{ item, view, added }]]
    },
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

export const execOnKernel = Effect.fnUntraced(function* (
  prompt: string,
  id: string | undefined,
  options: StartOptions,
  json: boolean,
) {
  const client = yield* KernelClient
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
        return client["approval/resolve"]({ conversation: from, approval: key, author: userName(), allow: false }).pipe(
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
  const listed = yield* client["conversation/list"]()
  const root = listed.find((info) => info.id === conversation)?.lineage?.root ?? conversation
  const followed = new Set([conversation])
  const discover: Effect.Effect<void, never, Scope.Scope> = Effect.gen(function* () {
    const conversations = yield* Effect.orDie(client["conversation/list"]())
    const parents = new Map(conversations.map((info) => [info.id, info.lineage?.parent]))
    const under = (id: string | undefined): boolean => id !== undefined && (followed.has(id) || under(parents.get(id)))
    for (const info of conversations) {
      if (followed.has(info.id) || !under(info.lineage?.parent)) continue
      followed.add(info.id)
      yield* watching(
        following(client["conversation/watch"]({ conversation: info.id })).pipe(
          Stream.runForEach(({ view, added }) =>
            Effect.andThen(deny(info.id, view), added.length > 0 ? discover : Effect.void),
          ),
        ),
      )
    }
  })
  yield* watching(
    client["status/watch"]().pipe(
      Stream.filter((item) => item._tag === "trees" || item.conversation === root),
      Stream.runForEach(() => discover),
    ),
  )

  const printer = new Printer()
  let submission: number | undefined
  // Placed once a run holds the submission; the run's first input after that is the start of what this prompt sees,
  // so a run that ends in the same commit as it is placed belongs to the input before.
  let placed = false
  let waited = false
  let withdrawn = false
  let started = false
  let ended: RunEnd | undefined
  const onEntry = (entry: EntryRecord) => {
    if (entry.kind === USER_KIND || entry.kind === "pi.user") started = true
    if (!started) return
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

  const images = imagesIn(prompt, process.cwd())
  yield* following(client["conversation/watch"]({ conversation })).pipe(
    Stream.tap(({ item, view, added }) =>
      Effect.gen(function* () {
        // Submitted once the watch holds the view, so the watch covers the whole run.
        submission ??= (yield* client["conversation/submit"]({
          conversation,
          requestId: crypto.randomUUID(),
          author: userName(),
          text: prompt,
          ...(images.length === 0 ? {} : { images }),
        })).submission
        if (json) write(`${JSON.stringify(item)}\n`)
        placed ||= liveOf(view)?.run?.inputs.includes(submission) === true
        // A queued input that leaves the queue without being placed was withdrawn, as an interrupt does.
        const waiting = queued(view, submission)
        if (!placed && waited && !waiting) withdrawn = true
        waited ||= waiting
        if (placed) {
          for (const entry of added) if (ended === undefined) onEntry(entry)
          const live = liveOf(view)?.generation?.message
          if (!json && started && ended === undefined && live !== undefined) printer.show(textOf(live))
        }
        yield* deny(conversation, view)
        if (added.length > 0) yield* discover
      }),
    ),
    Stream.takeUntil(() => ended !== undefined || withdrawn),
    Stream.runDrain,
    Effect.raceFirst(Deferred.await(failed)),
  )
  if (withdrawn) note("the prompt was withdrawn before it ran, as an interrupt withdraws what waits")
  else if (ended === undefined) note("the server ended the watch before the run ended")
  return ended?.outcome === "answered"
})
