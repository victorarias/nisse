// The TUI on a server under NISSE_KERNEL=1: it watches the conversation's view, keeps every entry it saw in a
// `ConversationTranscript`, and draws the transcript's items with the view's documents: partial text and running
// output from `pi.live`, the queue from `pi.inbox`, waiting calls from `nisse.approvals`, the model from `pi.agent`.
// The marker above the oldest entry held, and one where entries are missing, load more once scrolled into view.
import type { CliRenderer, Renderable, ScrollBoxRenderable } from "@opentui/core"
import { applyImmutable, type Op } from "@nisse/delta"
import {
  ConversationTranscript,
  type ConversationView,
  type TranscriptGap,
  type TranscriptItem,
  type TranscriptView,
} from "@nisse/harness"
import type { EntryRecord } from "@nisse/kernel"
import {
  type ModelSelection,
  type Outcome,
  RUN_END_KIND,
  type RunEnd,
  STATUS_LINES_KIND,
  TOAST_KIND,
  USER_KIND,
  MODEL_KIND,
  type View,
} from "@nisse/wire"
import { Deferred, Effect, Schedule, type Scope, Stream } from "effect"
import {
  type Accessor,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
  untrack,
} from "solid-js"
import { userName } from "../author.ts"
import { mailPayload } from "../kernel/agents.ts"
import { KernelClient, type StartOptions } from "../client.ts"
import { describeCall } from "./calls.ts"
import { type ConversationActions, type Screen, setupOf, Shell, showUntilDone, Tag } from "./chrome.tsx"
import { modelLabel } from "./setup.tsx"
import { color, KeyCap } from "./theme.tsx"

const RESULT_LINES = 6
/** The running output a call shows: its last lines. */
const OUTPUT_LINES = 6
const REWATCH_DELAY = "50 millis"

const MAIL_KIND = "nisse.mail"
const SUBAGENT_KIND = "nisse.subagent"
const APPROVAL_KIND = "nisse.approval"

type Block = { readonly type: string; readonly text?: string; readonly id?: string; readonly name?: string }
type Message = {
  readonly role?: string
  readonly content?: string | ReadonlyArray<Block>
  readonly toolCallId?: string
  readonly isError?: boolean
  readonly details?: { readonly conversation?: number; readonly task?: string }
}
type ToolCallBlock = { readonly id: string; readonly name: string; readonly arguments?: unknown }

type LiveTool = { readonly callId: string; readonly status: string; readonly output?: string }
type Live = {
  readonly run?: unknown
  readonly generation?: { readonly message?: Message }
  readonly tools?: ReadonlyArray<LiveTool>
}
type Approval = { readonly callId: string; readonly answer?: unknown }
type Approvals = { readonly requests?: Readonly<Record<string, Approval>> }
type InboxItem = { readonly mode: string; readonly content?: Message["content"] }
type Agent = { readonly model?: { readonly provider: string; readonly modelId?: string }; readonly cwd?: string }
type Docs = {
  readonly "pi.live"?: Live
  readonly "pi.inbox"?: { readonly items?: ReadonlyArray<InboxItem> }
  readonly "pi.agent"?: Agent & { readonly thinkingLevel?: string }
  readonly "nisse.approvals"?: Approvals
  readonly [STATUS_LINES_KIND]?: { readonly lines?: Readonly<Record<string, string>> }
}

const messageOf = (entry: EntryRecord): Message | undefined => entry.model?.[0] as Message | undefined
const dataOf = <A,>(entry: EntryRecord) => (entry.data ?? {}) as A

const textOf = (content: Message["content"]) =>
  typeof content === "string"
    ? content
    : (content ?? []).flatMap((block) => (block.type === "text" && block.text ? [block.text] : [])).join("")

/** What a person wrote: their input's first text, before the skills it named, which follow it as text of their own. */
const typedOf = (content: Message["content"]) =>
  typeof content === "string" ? content : (content?.find((block) => block.type === "text")?.text ?? "")

const callsOf = (message: Message | undefined): ReadonlyArray<ToolCallBlock> =>
  typeof message?.content === "string"
    ? []
    : (message?.content ?? []).filter((block): block is Block & ToolCallBlock => block.type === "toolCall")

/** The model a conversation answers with, as its `pi.agent` document says. */
const selectionOf = (agent: Docs["pi.agent"]): ModelSelection | undefined =>
  agent?.model === undefined
    ? undefined
    : {
        provider: agent.model.provider,
        ...(agent.model.modelId ? { model: agent.model.modelId } : {}),
        ...(agent.thinkingLevel === undefined || agent.thinkingLevel === "off" ? {} : { effort: agent.thinkingLevel }),
      }

/** One conversation as the TUI follows it. */
interface Followed {
  readonly id: string
  readonly items: Accessor<ReadonlyArray<TranscriptItem>>
  readonly docs: Accessor<Docs>
  readonly loaded: Accessor<boolean>
  /** Loads the page before the oldest entry held; `inserting` runs just before a page that adds entries shows. */
  readonly loadEarlier: (inserting: () => void) => void
  readonly fillGap: (gap: TranscriptGap, inserting: () => void) => void
}

/** What a conversation's entries say about its calls, rebuilt when its items change. */
interface Index {
  readonly results: ReadonlyMap<string, EntryRecord>
  readonly answers: ReadonlyMap<string, EntryRecord>
  /** The conversation each call that started a subagent started. */
  readonly subagents: ReadonlyMap<string, string>
}

const indexOf = (items: ReadonlyArray<TranscriptItem>): Index => {
  const results = new Map<string, EntryRecord>()
  const answers = new Map<string, EntryRecord>()
  const subagents = new Map<string, string>()
  for (const item of items) {
    if (item.kind !== "entry") continue
    const entry = item.entry
    if (entry.kind === "pi.tool-result") {
      const message = messageOf(entry)
      if (message?.toolCallId === undefined) continue
      results.set(message.toolCallId, entry)
      if (message.details?.conversation !== undefined)
        subagents.set(message.toolCallId, String(message.details.conversation))
    } else if (entry.kind === APPROVAL_KIND) answers.set(dataOf<{ callId: string }>(entry).callId, entry)
    else if (entry.kind === SUBAGENT_KIND) {
      const data = dataOf<{ call: string; conversation: number }>(entry)
      subagents.set(data.call, String(data.conversation))
    }
  }
  return { results, answers, subagents }
}

const pendingCalls = (docs: Docs) =>
  Object.entries(docs["nisse.approvals"]?.requests ?? {}).filter(([, request]) => request.answer === undefined)

const statusOf = (docs: Docs) =>
  pendingCalls(docs).length > 0 ? "waiting" : docs["pi.live"]?.run !== undefined ? "working" : "idle"

/**
 * Follows `id` for as long as `scope` is open: watches its view and, when the watch drops (the client fell behind, or
 * the server went away), watches again from where the transcript reaches. Fails `done` when there is no such conversation.
 */
const follow = (
  client: KernelClient["Service"],
  id: string,
  scope: Scope.Scope,
  done: Deferred.Deferred<void, string>,
) =>
  Effect.gen(function* () {
    const transcript = new ConversationTranscript((query, limit) =>
      client["conversation/entries"]({
        conversation: id,
        ...(query.minEntryId === undefined ? {} : { from: query.minEntryId }),
        ...(query.maxEntryId === undefined ? {} : { to: query.maxEntryId }),
        ...(query.order === undefined ? {} : { order: query.order }),
        limit,
      }).pipe(
        Effect.map((page) => ({
          items: page.entries as unknown as ReadonlyArray<EntryRecord>,
          ...(page.next === undefined ? {} : { next: page.next as Record<string, never> }),
        })),
      ),
    )
    const [view, setView] = createSignal<TranscriptView | undefined>(undefined)
    const show = (next: TranscriptView) => setView(() => next)
    const watch = Effect.suspend(() => {
      let value: View | undefined
      const window = transcript.resume
      return client["conversation/watch"]({ conversation: id, ...(window ? { window } : {}) }).pipe(
        Stream.runForEach((item) =>
          Effect.sync(() => {
            value = item._tag === "view" ? item.view : applyImmutable(value, item.ops as ReadonlyArray<Op>)
            show(transcript.merge(value as unknown as ConversationView))
          }),
        ),
      )
    })
    // A watch that ends or drops is watched again; only a conversation that is not there ends the following.
    const rewatch: Effect.Effect<void> = watch.pipe(
      Effect.catchIf(
        (error) => error._tag !== "NoSuchConversation",
        () => Effect.void,
      ),
      Effect.andThen(Effect.sleep(REWATCH_DELAY)),
      Effect.andThen(Effect.suspend(() => rewatch)),
      Effect.catchTag("NoSuchConversation", () => Effect.asVoid(Deferred.fail(done, `no conversation ${id}`))),
    )
    yield* Effect.forkIn(rewatch, scope)
    // A load that fails leaves its marker, and scrolling to it again loads again.
    const load = (effect: Effect.Effect<TranscriptView, unknown>, inserting: () => void) =>
      Effect.runFork(
        effect.pipe(
          Effect.tap((next) =>
            Effect.sync(() => {
              if (next === untrack(view)) return
              inserting()
              show(next)
            }),
          ),
          Effect.ignore,
        ),
      )
    // Memos, so what reads only the items does not run again for a change to the documents, such as a streamed word.
    const { items, docs } = createRoot(() => ({
      items: createMemo(() => view()?.items ?? []),
      docs: createMemo(() => (view()?.docs ?? {}) as Docs),
    }))
    const followed: Followed = {
      id,
      items,
      docs,
      loaded: () => view() !== undefined,
      loadEarlier: (inserting) => load(transcript.loadEarlier, inserting),
      fillGap: (gap, inserting) => load(transcript.fillGap(gap), inserting),
    }
    return followed
  })

const lastLine = (text: string) => text.trimEnd().split("\n").at(-1) ?? ""
const tail = (text: string, lines: number) => text.trimEnd().split("\n").slice(-lines).join("\n")
const head = (text: string, lines: number) => {
  const all = text.trimEnd().split("\n")
  return all.length <= lines ? all.join("\n") : `${all.slice(0, lines).join("\n")}\n… ${all.length - lines} more lines`
}

/** The kinds the transcript draws a row for; the rest (the context's system entries, results, answers) it skips. */
const DRAWN = new Set([
  "pi.user",
  USER_KIND,
  MAIL_KIND,
  "pi.assistant",
  RUN_END_KIND,
  MODEL_KIND,
  TOAST_KIND,
  SUBAGENT_KIND,
])

const drawn = (item: TranscriptItem) => item.kind !== "entry" || DRAWN.has(item.entry.kind)

/** Whether the model's words after `previous` start a new turn, under their own NISSE tag. */
const startsTurn = (previous: TranscriptItem | undefined) =>
  previous?.kind !== "entry" ||
  previous.entry.kind === "pi.user" ||
  previous.entry.kind === USER_KIND ||
  previous.entry.kind === MAIL_KIND ||
  previous.entry.kind === RUN_END_KIND

/** The conversations the TUI follows: the one it opened and every subagent under it, keyed by id. */
interface Tree {
  readonly root: Followed
  readonly children: Readonly<Record<string, Followed>>
  /** Each subagent's parent. */
  readonly parents: Readonly<Record<string, string>>
}

const isUnder = (tree: Tree, id: string, ancestor: string) => {
  let parent = tree.parents[id]
  while (parent !== undefined) {
    if (parent === ancestor) return true
    parent = tree.parents[parent]
  }
  return false
}

/** The subagent, or one under it, whose call waits on a person. */
const askingIn = (tree: Tree, subagent: string) =>
  [tree.children[subagent], ...Object.values(tree.children).filter((each) => isUnder(tree, each.id, subagent))].find(
    (each) => each !== undefined && pendingCalls(each.docs()).length > 0,
  )

const lastActivity = (child: Followed) => {
  const live = textOf(child.docs()["pi.live"]?.generation?.message?.content)
  if (live !== "") return lastLine(live)
  for (const item of child.items().toReversed()) {
    if (item.kind !== "entry") continue
    const entry = item.entry
    if (entry.kind === "pi.assistant") {
      const message = messageOf(entry)
      const call = callsOf(message).at(-1)
      if (call) return describeCall(call.name, call.arguments)
      const text = textOf(message?.content)
      if (text !== "") return lastLine(text)
    }
    if (entry.kind === "pi.user" || entry.kind === USER_KIND) return lastLine(typedOf(messageOf(entry)?.content))
  }
  return ""
}

const childState = (child: Followed | undefined): { label: string; tone: string } => {
  if (!child || !child.loaded()) return { label: "working", tone: color.cyan }
  const status = statusOf(child.docs())
  if (status === "working") return { label: "working", tone: color.cyan }
  if (status === "waiting") return { label: "waiting on you", tone: color.yellow }
  const end = child.items().findLast((item) => item.kind === "entry" && item.entry.kind === RUN_END_KIND)
  const outcome = end?.kind === "entry" ? dataOf<RunEnd>(end.entry).outcome : "answered"
  if (outcome === "answered") return { label: "done", tone: color.dim }
  return { label: outcome === "interrupted" ? "interrupted" : "failed", tone: color.yellow }
}

const SubagentCard = (props: { tree: Tree; conversation: string; title: string; agentType: string | undefined }) => {
  const child = () => props.tree.children[props.conversation]
  const asker = () => askingIn(props.tree, props.conversation)
  const state = () => (asker() ? { label: "waiting on you", tone: color.yellow } : childState(child()))
  const asking = () => {
    const pending = asker() && pendingCalls(asker()!.docs())[0]
    if (!pending) return undefined
    const [, request] = pending as [string, Approval & { tool?: string; arguments?: unknown }]
    return describeCall(request.tool ?? "", request.arguments)
  }
  return (
    <box flexDirection="column" marginTop={1} marginLeft={2}>
      <box flexDirection="row" gap={1}>
        <text fg={color.violet}>{`⧉ ${props.title}${props.agentType ? ` (${props.agentType})` : ""}`}</text>
        <text fg={state().tone}>{state().label}</text>
      </box>
      <Show when={child() && lastActivity(child()!)}>
        {(activity) => (
          <text fg={color.dim} marginLeft={2}>
            {activity()}
          </text>
        )}
      </Show>
      <Show when={asking()}>
        {(call) => (
          <box flexDirection="row" marginLeft={2} gap={1}>
            <text fg={color.yellow}>{`allow ${call()}?`}</text>
            <KeyCap cap="^Y" what="allow" />
            <KeyCap cap="^N" what="deny" />
          </box>
        )}
      </Show>
    </box>
  )
}

const ToolCallView = (props: { followed: Followed; index: Index; tree: Tree; call: ToolCallBlock }) => {
  const result = () => {
    const entry = props.index.results.get(props.call.id)
    const message = entry && messageOf(entry)
    return message && { text: textOf(message.content), error: message.isError === true }
  }
  const output = () =>
    props.followed.docs()["pi.live"]?.tools?.find((tool) => tool.callId === props.call.id)?.output ?? ""
  const asking = () => pendingCalls(props.followed.docs()).some(([, request]) => request.callId === props.call.id)
  const answer = () => {
    const entry = props.index.answers.get(props.call.id)
    return entry && dataOf<{ allow: boolean; author: string }>(entry)
  }
  const subagent = () => props.index.subagents.get(props.call.id)
  const input = () => props.call.arguments as { task_name?: string; agent_type?: string } | undefined
  return (
    <Show
      when={subagent()}
      fallback={
        <box flexDirection="column" marginLeft={2}>
          <text fg={color.violet}>{`▸ ${describeCall(props.call.name, props.call.arguments)}`}</text>
          <Show when={asking()}>
            <box flexDirection="row" marginLeft={2} gap={1}>
              <text fg={color.yellow}>allow this call?</text>
              <KeyCap cap="^Y" what="allow" />
              <KeyCap cap="^N" what="deny" />
            </box>
          </Show>
          <Show when={answer()}>
            {(given) => (
              <text fg={color.dim} marginLeft={2}>
                {`${given().allow ? "✓ allowed" : "✗ denied"} by ${given().author.toLowerCase()}`}
              </text>
            )}
          </Show>
          <Show when={result() === undefined && output() !== ""}>
            <text fg={color.dim} marginLeft={2}>
              {tail(output(), OUTPUT_LINES)}
            </text>
          </Show>
          <Show when={result()}>
            {(shown) => (
              <Show when={shown().text.trim() !== ""}>
                <text fg={shown().error ? color.yellow : color.dim} marginLeft={2}>
                  {head(shown().text, RESULT_LINES)}
                </text>
              </Show>
            )}
          </Show>
        </box>
      }
    >
      {(conversation) => (
        <SubagentCard
          tree={props.tree}
          conversation={conversation()}
          title={input()?.task_name ?? props.call.name}
          agentType={input()?.agent_type}
        />
      )}
    </Show>
  )
}

const RunEndView = (props: { outcome: Outcome; message: string | undefined }) => (
  <Switch>
    <Match when={props.outcome === "interrupted"}>
      <text fg={color.dim} marginLeft={2}>
        ◆ interrupted
      </text>
    </Match>
    <Match when={props.outcome !== "answered"}>
      <text fg={color.yellow} marginLeft={2}>
        {`✗ ${props.message ?? props.outcome}`}
      </text>
    </Match>
  </Switch>
)

const UserView = (props: { label: string; tone: string; text: string; skills: ReadonlyArray<string> }) => (
  <box flexDirection="column" marginTop={1}>
    <Tag label={props.label} color={props.tone} />
    <text fg={color.ink} marginLeft={2}>
      {props.text}
    </text>
    <Show when={props.skills.length > 0}>
      <text fg={color.dim} marginLeft={2}>
        {`with ${props.skills.join(", ")}`}
      </text>
    </Show>
  </box>
)

const EntryView = (props: {
  followed: Followed
  index: Index
  tree: Tree
  entry: EntryRecord
  previous: TranscriptItem | undefined
}) => {
  const entry = props.entry
  switch (entry.kind) {
    case USER_KIND:
    case "pi.user": {
      const data = dataOf<{ author?: string; skills?: ReadonlyArray<{ name: string }> }>(entry)
      return (
        <UserView
          label={(data.author ?? "you").toUpperCase()}
          tone={color.magenta}
          text={typedOf(messageOf(entry)?.content)}
          skills={(data.skills ?? []).map((skill) => skill.name)}
        />
      )
    }
    case MAIL_KIND:
      return (
        <UserView
          label={dataOf<{ sender: string }>(entry).sender}
          tone={color.violet}
          text={mailPayload(textOf(messageOf(entry)?.content))}
          skills={[]}
        />
      )
    case "pi.assistant": {
      const message = messageOf(entry)
      const text = textOf(message?.content)
      const calls = callsOf(message)
      if (text === "" && calls.length === 0) return null
      return (
        <box flexDirection="column" marginTop={1}>
          <Show when={startsTurn(props.previous)}>
            <Tag label="NISSE" color={color.cyan} />
          </Show>
          <Show when={text !== ""}>
            <text fg={color.ink} marginLeft={2}>
              {text}
            </text>
          </Show>
          <For each={calls}>
            {(call) => <ToolCallView followed={props.followed} index={props.index} tree={props.tree} call={call} />}
          </For>
        </box>
      )
    }
    case RUN_END_KIND: {
      const end = dataOf<RunEnd>(entry)
      return <RunEndView outcome={end.outcome} message={end.message} />
    }
    case MODEL_KIND: {
      const data = dataOf<{ author: string; selection: ModelSelection }>(entry)
      return (
        <text fg={color.dim} marginTop={1} marginLeft={2}>
          {`◆ ${data.author.toLowerCase()} switched to ${modelLabel(data.selection)}`}
        </text>
      )
    }
    case TOAST_KIND: {
      const data = dataOf<{ extension: string; text: string }>(entry)
      return (
        <text fg={color.dim} marginLeft={2}>
          {`◆ ${data.extension}: ${data.text}`}
        </text>
      )
    }
    case SUBAGENT_KIND: {
      const data = dataOf<{ conversation: number; title: string; agentType?: string }>(entry)
      return (
        <SubagentCard
          tree={props.tree}
          conversation={String(data.conversation)}
          title={data.title}
          agentType={data.agentType}
        />
      )
    }
    default:
      return null
  }
}

/** A row that loads more once it is scrolled into view. */
const Marker = (props: { text: string; register: (renderable: Renderable | undefined) => void }) => {
  onCleanup(() => props.register(undefined))
  return (
    <box ref={(element: Renderable) => props.register(element)} marginTop={1} marginLeft={2} height={1}>
      <text fg={color.dim}>{props.text}</text>
    </box>
  )
}

const Transcript = (props: { followed: Followed; tree: Tree }) => {
  let box: ScrollBoxRenderable | undefined
  const markers = new Map<TranscriptItem, { renderable: Renderable; load: (inserting: () => void) => void }>()
  /** The distance from the bottom to keep while a load inserts entries above the rows in view. */
  let anchor: number | undefined
  // Measured inside the content, which a scroll moves as a whole, against where the scroll has it now.
  const visible = (renderable: Renderable) => {
    if (!box) return false
    const at = renderable.y - box.content.y
    return at + renderable.height > box.scrollTop && at < box.scrollTop + box.viewport.height
  }
  const check = () => {
    for (const marker of markers.values()) {
      if (!visible(marker.renderable)) continue
      marker.load(() => {
        if (box) anchor = box.scrollHeight - box.scrollTop
      })
    }
  }
  const resized = () => {
    if (box && anchor !== undefined) {
      box.scrollTop = box.scrollHeight - anchor
      anchor = undefined
    }
    check()
  }
  const attach = (element: ScrollBoxRenderable) => {
    box = element
    const own = element.content.onSizeChange
    element.content.onSizeChange = () => {
      own?.call(element.content)
      resized()
    }
  }
  const register =
    (item: TranscriptItem, load: (inserting: () => void) => void) => (renderable: Renderable | undefined) => {
      if (renderable) markers.set(item, { renderable, load })
      else markers.delete(item)
    }
  const rows = createMemo(() => props.followed.items().filter(drawn))
  const index = createMemo(() => indexOf(props.followed.items()))
  const live = () => textOf(props.followed.docs()["pi.live"]?.generation?.message?.content)
  const queued = () =>
    (props.followed.docs()["pi.inbox"]?.items ?? []).filter((item) => item.mode === "steer" || item.mode === "followUp")
  return (
    <scrollbox
      ref={attach}
      flexGrow={1}
      stickyScroll
      stickyStart="bottom"
      paddingLeft={1}
      paddingRight={1}
      onMouseScroll={() => queueMicrotask(check)}
    >
      <For each={rows()}>
        {(item, at) => (
          <Switch>
            <Match when={item.kind === "earlier"}>
              <Marker text="↑ earlier messages" register={register(item, props.followed.loadEarlier)} />
            </Match>
            <Match when={item.kind === "gap" && item}>
              {(gap) => (
                <Marker
                  text="… missing messages"
                  register={register(item, (inserting) => props.followed.fillGap(gap(), inserting))}
                />
              )}
            </Match>
            <Match when={item.kind === "entry" && item.entry}>
              {(entry) => (
                <EntryView
                  followed={props.followed}
                  index={index()}
                  tree={props.tree}
                  entry={entry()}
                  previous={rows()[at() - 1]}
                />
              )}
            </Match>
          </Switch>
        )}
      </For>
      <Show when={live() !== ""}>
        <box flexDirection="column" marginTop={1}>
          <Show when={startsTurn(rows().at(-1))}>
            <Tag label="NISSE" color={color.cyan} />
          </Show>
          <text fg={color.ink} marginLeft={2}>
            {live()}
          </text>
        </box>
      </Show>
      <For each={queued()}>
        {(item) => (
          <text fg={color.dim} marginLeft={2}>
            {`${item.mode === "steer" ? "steering" : "queued"} · ${typedOf(item.content)}`}
          </text>
        )}
      </For>
    </scrollbox>
  )
}

/** The subagents `followed`'s entries started. */
const subagentsOf = (followed: Followed) => [...indexOf(followed.items()).subagents.values()]

export const kernelTui = Effect.fnUntraced(function* (
  id: string | undefined,
  options: StartOptions,
  prompt: string | undefined,
) {
  const client = yield* KernelClient
  // A number names a conversation the server numbered; any other id is one a client chose, and starting with it
  // opens that conversation or starts it.
  const numbered = id !== undefined && /^\d+$/.test(id)
  const started = numbered
    ? undefined
    : yield* client["conversation/start"]({ cwd: process.cwd(), ...options, ...(id === undefined ? {} : { id }) })
  const conversation = started?.conversation ?? id!
  const info = (yield* client["conversation/list"]()).find((each) => each.id === conversation)
  const done = yield* Deferred.make<void, string>()
  const scope = yield* Effect.scope

  const root = yield* follow(client, conversation, scope, done)
  const [children, setChildren] = createSignal<Readonly<Record<string, Followed>>>({})
  const parents: Record<string, string> = {}
  const tree: Tree = {
    root,
    get children() {
      return children()
    },
    parents,
  }
  // Follows each subagent once some conversation the TUI follows shows it started.
  const followSubagents = () =>
    createEffect(() => {
      for (const parent of [root, ...Object.values(children())]) {
        for (const child of subagentsOf(parent)) {
          if (child in untrack(children)) continue
          parents[child] = parent.id
          const followed = Effect.runSync(follow(client, child, scope, done))
          setChildren((all) => ({ ...all, [child]: followed }))
        }
      }
    })

  if (prompt !== undefined) {
    yield* client["conversation/submit"]({
      conversation,
      requestId: crypto.randomUUID(),
      author: userName(),
      text: prompt,
    })
  }

  let renderer: CliRenderer | undefined
  const setup = yield* setupOf(client, scope, () => renderer)
  const [workingSince, setWorkingSince] = createSignal<number | undefined>(undefined)
  const status = () => statusOf(root.docs())
  const screen: Screen = {
    id: conversation,
    get cwd() {
      return root.docs()["pi.agent"]?.cwd ?? info?.cwd
    },
    get model() {
      return selectionOf(root.docs()["pi.agent"]) ?? info?.model
    },
    get status() {
      return status()
    },
    get workingSince() {
      return workingSince()
    },
    hosted: info?.lineage !== undefined && info.lineage.task === undefined,
    get statusLines() {
      return root.docs()[STATUS_LINES_KIND]?.lines ?? {}
    },
    get empty() {
      return (
        !root.items().some((item) => item.kind !== "entry" || DRAWN.has(item.entry.kind)) &&
        textOf(root.docs()["pi.live"]?.generation?.message?.content) === ""
      )
    },
    get subagentAsks() {
      return Object.values(tree.children).some((child) => pendingCalls(child.docs()).length > 0)
    },
  }
  const actions: ConversationActions = {
    // While the server is away the prompt is sent again under the same request id, which the server answers once.
    submit: (text, steer) => {
      const payload = { conversation, requestId: crypto.randomUUID(), author: userName(), text, steer }
      Effect.runFork(
        client["conversation/submit"](payload).pipe(
          Effect.retry({ while: (error) => error._tag === "RpcClientError", schedule: Schedule.spaced(REWATCH_DELAY) }),
        ),
      )
    },
    answer: (allow) => {
      const asking = [root, ...Object.values(tree.children)].find((each) => pendingCalls(each.docs()).length > 0)
      const pending = asking && pendingCalls(asking.docs())[0]
      if (asking && pending) {
        Effect.runFork(
          client["approval/resolve"]({ conversation: asking.id, approval: pending[0], author: userName(), allow }),
        )
      }
    },
    interrupt: () => Effect.runFork(client["conversation/interrupt"]({ conversation })),
    selectModel: (selection) =>
      Effect.runFork(client["conversation/select_model"]({ conversation, author: userName(), selection })),
    quit: () => Effect.runFork(Deferred.succeed(done, undefined)),
  }

  yield* showUntilDone(
    () => {
      followSubagents()
      createMemo((was: string) => {
        const now = status()
        if (now === "idle") setWorkingSince(undefined)
        else if (was === "idle") setWorkingSince(Date.now())
        return now
      }, "idle")
      return (
        <Shell
          screen={screen}
          setup={setup}
          actions={actions}
          transcript={() => <Transcript followed={root} tree={tree} />}
        />
      )
    },
    done,
    conversation,
    (opened) => (renderer = opened),
  )
})
