import type { CliRenderer } from "@opentui/core"
import type { CallId, ConversationId, Entry, Outcome } from "@nisse/protocol"
import { Deferred, Effect, Stream } from "effect"
import { For, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { userName } from "../author.ts"
import { Client, followTree, startConversation, type Followed, type StartOptions } from "../client.ts"
import { describeCall } from "./calls.ts"
import { type ConversationActions, type Screen, setupOf, Shell, showUntilDone, Tag } from "./chrome.tsx"
import { modelLabel } from "./setup.tsx"
import { color, KeyCap } from "./theme.tsx"
import { apply, emptyView, type View } from "./view.ts"

type Children = Record<ConversationId, View>

const authorLabel = (entry: Entry) => {
  const author = entry.author
  if (author._tag === "person") return author.name.toUpperCase()
  if (author._tag === "agent" && entry.body._tag === "user" && entry.body.mail) return entry.body.mail.sender
  return "NISSE"
}

const lastLine = (text: string) => text.trimEnd().split("\n").at(-1) ?? ""

const lastActivity = (child: View) => {
  if (child.live.text !== "") return lastLine(child.live.text)
  for (const entry of child.entries.toReversed()) {
    const body = entry.body
    if (body._tag === "message") return lastLine(body.text)
    if (body._tag === "tool_call") return describeCall(body.tool, body.input)
    if (body._tag === "user") return lastLine(body.text)
  }
  return ""
}

const childState = (child: View | undefined): { label: string; tone: string } => {
  if (!child || child.status === "working") return { label: "working", tone: color.cyan }
  if (child.status === "waiting") return { label: "waiting on you", tone: color.yellow }
  const end = child.entries.findLast((entry) => entry.body._tag === "run_end")?.body
  if (end?._tag !== "run_end" || end.outcome === "answered") return { label: "done", tone: color.dim }
  return { label: end.outcome === "interrupted" ? "interrupted" : "failed", tone: color.yellow }
}

const isUnder = (subagents: Children, view: View, ancestor: ConversationId) => {
  let parent = view.conversation?.lineage?.parent
  while (parent !== undefined) {
    if (parent === ancestor) return true
    parent = subagents[parent]?.conversation?.lineage?.parent
  }
  return false
}

const askingIn = (subagents: Children, subagent: ConversationId) =>
  [subagents[subagent], ...Object.values(subagents).filter((view) => isUnder(subagents, view, subagent))].find(
    (view) => view !== undefined && view.pendingApprovals.length > 0,
  )

const SubagentCard = (props: {
  title: string
  agentType: string | undefined
  child: View | undefined
  asker: View | undefined
}) => {
  const state = () => (props.asker ? { label: "waiting on you", tone: color.yellow } : childState(props.child))
  const asking = () => {
    const asker = props.asker
    const pending = asker?.pendingApprovals[0]
    const call =
      pending && asker.entries.find((entry) => entry.body._tag === "tool_call" && entry.body.call === pending.call)
    return call?.body._tag === "tool_call" ? describeCall(call.body.tool, call.body.input) : undefined
  }
  return (
    <box flexDirection="column" marginLeft={2}>
      <box flexDirection="row" gap={1}>
        <text fg={color.violet}>{`⧉ ${props.title}${props.agentType ? ` (${props.agentType})` : ""}`}</text>
        <text fg={state().tone}>{state().label}</text>
      </box>
      <Show when={props.child && lastActivity(props.child)}>
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

const RESULT_LINES = 6

const tail = (text: string, lines: number) => text.trimEnd().split("\n").slice(-lines).join("\n")
const head = (text: string, lines: number) => {
  const all = text.trimEnd().split("\n")
  return all.length <= lines ? all.join("\n") : `${all.slice(0, lines).join("\n")}\n… ${all.length - lines} more lines`
}

const startsTurn = (previous: Entry | undefined) =>
  previous === undefined || previous.body._tag === "user" || previous.body._tag === "run_end"

const ToolCallView = (props: { view: View; call: CallId; tool: string; input: unknown }) => {
  const result = () => props.view.results[props.call]?.body
  const output = () => props.view.live.output[props.call] ?? ""
  const asking = () => props.view.pendingApprovals.some((pending) => pending.call === props.call)
  const answer = () => props.view.answers[props.call]
  return (
    <box flexDirection="column" marginLeft={2}>
      <text fg={color.violet}>{`▸ ${describeCall(props.tool, props.input)}`}</text>
      <Show when={asking()}>
        <box flexDirection="row" marginLeft={2} gap={1}>
          <text fg={color.yellow}>allow this call?</text>
          <KeyCap cap="^Y" what="allow" />
          <KeyCap cap="^N" what="deny" />
        </box>
      </Show>
      <Show when={answer()}>
        {(entry) => {
          const body = entry().body
          return (
            <text fg={color.dim} marginLeft={2}>
              {`${body._tag === "approval_answer" && body.allow ? "✓ allowed" : "✗ denied"} by ${authorLabel(entry()).toLowerCase()}`}
            </text>
          )
        }}
      </Show>
      <Show when={result()?._tag !== "tool_result" && output() !== ""}>
        <text fg={color.dim} marginLeft={2}>
          {tail(output(), RESULT_LINES)}
        </text>
      </Show>
      <Show when={props.view.delegated[props.call] ? undefined : result()}>
        {(body) => {
          const outcome = body()
          if (outcome._tag !== "tool_result" || outcome.output.trim() === "") return null
          return (
            <text fg={outcome.error ? color.yellow : color.dim} marginLeft={2}>
              {head(outcome.output, RESULT_LINES)}
            </text>
          )
        }}
      </Show>
    </box>
  )
}

const RunEndView = (props: { outcome: Outcome; message: string | undefined }) => {
  switch (props.outcome) {
    case "answered":
      return null
    case "interrupted":
      return (
        <text fg={color.dim} marginLeft={2}>
          ◆ interrupted
        </text>
      )
    default:
      return (
        <text fg={color.yellow} marginLeft={2}>
          {`✗ ${props.message ?? props.outcome}`}
        </text>
      )
  }
}

const EntryView = (props: { view: View; subagents: Children; entry: Entry; previous: Entry | undefined }) => {
  const body = props.entry.body
  switch (body._tag) {
    case "user":
      return (
        <box flexDirection="column" marginTop={1}>
          <Tag label={authorLabel(props.entry)} color={body.mail ? color.violet : color.magenta} />
          <text fg={color.ink} marginLeft={2}>
            {body.text}
          </text>
          <Show when={body.skills?.length}>
            <text fg={color.dim} marginLeft={2}>
              {`with ${body.skills!.map((skill) => skill.name).join(", ")}`}
            </text>
          </Show>
        </box>
      )
    case "message":
    case "tool_call":
      return (
        <box flexDirection="column" marginTop={1}>
          <Show when={startsTurn(props.previous)}>
            <Tag label="NISSE" color={color.cyan} />
          </Show>
          {body._tag === "message" ? (
            <text fg={color.ink} marginLeft={2}>
              {body.text}
            </text>
          ) : (
            <ToolCallView view={props.view} call={body.call} tool={body.tool} input={body.input} />
          )}
        </box>
      )
    case "run_end":
      return <RunEndView outcome={body.outcome} message={body.message} />
    case "subagent":
      return (
        <box flexDirection="column" marginTop={1}>
          <SubagentCard
            title={body.title}
            agentType={body.agentType}
            child={props.subagents[body.conversation]}
            asker={askingIn(props.subagents, body.conversation)}
          />
        </box>
      )
    case "model":
      return (
        <text fg={color.dim} marginTop={1} marginLeft={2}>
          {`◆ ${authorLabel(props.entry).toLowerCase()} switched to ${modelLabel(body.selection)}`}
        </text>
      )
    case "toast":
      return (
        <text fg={color.dim} marginLeft={2}>
          {`◆ ${body.extension}: ${body.text}`}
        </text>
      )
    default:
      return null
  }
}

const Transcript = (props: { view: View; subagents: Children }) => (
  <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" paddingLeft={1} paddingRight={1}>
    <For each={props.view.entries}>
      {(entry, index) => (
        <EntryView
          view={props.view}
          subagents={props.subagents}
          entry={entry}
          previous={props.view.entries[index() - 1]}
        />
      )}
    </For>
    <Show when={props.view.live.text !== ""}>
      <box flexDirection="column" marginTop={1}>
        <Show when={startsTurn(props.view.entries.at(-1))}>
          <Tag label="NISSE" color={color.cyan} />
        </Show>
        <text fg={color.ink} marginLeft={2}>
          {props.view.live.text}
        </text>
      </box>
    </Show>
    <For each={props.view.queued}>
      {(queued) => (
        <text fg={color.dim} marginLeft={2}>
          {`${queued.steer ? "steering" : "queued"} · ${queued.text}`}
        </text>
      )}
    </For>
  </scrollbox>
)

export const tui = Effect.fnUntraced(function* (
  id: string | undefined,
  options: StartOptions,
  prompt: string | undefined,
) {
  const client = yield* Client
  const conversation = yield* startConversation(client, id, options)
  const [view, setView] = createStore(emptyView(conversation))
  const done = yield* Deferred.make<void, string>()

  const [children, setChildren] = createStore<Children>({})
  const scope = yield* Effect.scope
  const applyTo = ({ conversation: from, delivery }: Followed) =>
    Effect.sync(() => {
      if (from === conversation) setView(produce((draft) => apply(draft, delivery, Date.now())))
      else {
        if (!(from in children)) setChildren(from, emptyView(from))
        setChildren(
          from,
          produce((draft) => apply(draft, delivery, Date.now())),
        )
      }
    })

  yield* followTree(client, conversation).pipe(
    Stream.runForEach(applyTo),
    Effect.catchTag("NoSuchConversation", () => Deferred.fail(done, `no conversation ${conversation}`)),
    Effect.forkScoped,
  )

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
  const screen: Screen = {
    id: conversation,
    get cwd() {
      return view.conversation?.cwd
    },
    get model() {
      return view.conversation?.model
    },
    get status() {
      return view.status
    },
    get workingSince() {
      return view.workingSince
    },
    get hosted() {
      const lineage = view.conversation?.lineage
      return lineage !== undefined && lineage.task === undefined
    },
    get statusLines() {
      return view.extensionStatus
    },
    get empty() {
      return view.entries.length === 0 && view.live.text === ""
    },
    get subagentAsks() {
      return Object.values(children).some((subagent) => subagent.pendingApprovals.length > 0)
    },
  }
  const actions: ConversationActions = {
    submit: (text, steer) =>
      Effect.runFork(
        client["conversation/submit"]({
          conversation,
          requestId: crypto.randomUUID(),
          author: userName(),
          text,
          steer,
        }),
      ),
    answer: (allow) => {
      const asking = [view, ...Object.values(children)].find((each) => each.pendingApprovals.length > 0)
      const pending = asking?.pendingApprovals[0]
      if (asking && pending) {
        Effect.runFork(
          client["approval/resolve"]({
            conversation: asking.id,
            approval: pending.approval,
            author: userName(),
            allow,
          }),
        )
      }
    },
    interrupt: () => Effect.runFork(client["conversation/interrupt"]({ conversation })),
    selectModel: (selection) =>
      Effect.runFork(client["conversation/select_model"]({ conversation, author: userName(), selection })),
    quit: () => Effect.runFork(Deferred.succeed(done, undefined)),
  }

  yield* showUntilDone(
    () => (
      <Shell
        screen={screen}
        setup={setup}
        actions={actions}
        transcript={() => <Transcript view={view} subagents={children} />}
      />
    ),
    done,
    conversation,
    (opened) => (renderer = opened),
  )
})
