import { createCliRenderer, type CliRenderer, type KeyBinding, type TextareaRenderable } from "@opentui/core"
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid"
import type { ApprovalId, CallId, Entry, Outcome } from "@nisse/protocol"
import { Deferred, Effect, Stream } from "effect"
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { userName } from "../author.ts"
import { Client, follow, startConversation, type StartOptions } from "../client.ts"
import { VERSION } from "../version.ts"
import { describeCall } from "./calls.ts"
import { apply, emptyView, type View } from "./view.ts"

const color = {
  background: "#0B0817",
  panel: "#16122B",
  cyan: "#00F0FF",
  magenta: "#FF2E88",
  yellow: "#F3E600",
  violet: "#B46CFF",
  ink: "#E8E6FF",
  dim: "#8A86B8",
  faint: "#3D366E",
}

const LOGO = [
  "█   █  ███  ████  ████  ████",
  "██  █   █   █     █     █   ",
  "█ █ █   █   ████  ████  ███ ",
  "█  ██   █      █     █  █   ",
  "█   █  ███  ████  ████  ████",
]
const LOGO_COLORS = ["#00F0FF", "#40C8F8", "#7FA0F0", "#BF67BC", "#FF2E88"]
const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
const SPINNER_INTERVAL = 80

const promptKeys: Array<KeyBinding> = [
  { name: "return", action: "submit" },
  { name: "linefeed", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "return", meta: true, action: "newline" },
  { name: "j", ctrl: true, action: "newline" },
]

interface Actions {
  readonly submit: (text: string, steer: boolean) => void
  readonly answer: (approval: ApprovalId, allow: boolean) => void
  readonly interrupt: () => void
  readonly quit: () => void
}

const Tag = (props: { label: string; color: string }) => {
  const dimensions = useTerminalDimensions()
  const rule = () => "─".repeat(Math.max(0, dimensions().width - props.label.length - 6))
  return (
    <box flexDirection="row" height={1}>
      <text fg={color.background} bg={props.color}>
        {` ${props.label} `}
      </text>
      <text fg={color.faint}>{` ${rule()}`}</text>
    </box>
  )
}

const authorLabel = (entry: Entry) => (entry.author._tag === "person" ? entry.author.name.toUpperCase() : "NISSE")

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
      <Show when={result()}>
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

const EntryView = (props: { view: View; entry: Entry; previous: Entry | undefined }) => {
  const body = props.entry.body
  switch (body._tag) {
    case "user":
      return (
        <box flexDirection="column" marginTop={1}>
          <Tag label={authorLabel(props.entry)} color={color.magenta} />
          <text fg={color.ink} marginLeft={2}>
            {body.text}
          </text>
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
    default:
      return null
  }
}

const Splash = () => (
  <box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center">
    <For each={LOGO}>{(line, row) => <text fg={LOGO_COLORS[row()]}>{line}</text>}</For>
    <text fg={color.dim} marginTop={1}>
      D U R A B L E · M U L T I P L A Y E R · C O D I N G A G E N T
    </text>
    <box flexDirection="row" marginTop={1} gap={3}>
      <KeyCap cap="⏎" what="send" />
      <KeyCap cap="⇧⏎" what="newline" />
      <KeyCap cap="esc" what="stop" />
      <KeyCap cap="^C" what="quit" />
    </box>
  </box>
)

const KeyCap = (props: { cap: string; what: string }) => (
  <box flexDirection="row" gap={1}>
    <text fg={color.cyan} bg={color.faint}>{` ${props.cap} `}</text>
    <text fg={color.dim}>{props.what}</text>
  </box>
)

const Transcript = (props: { view: View }) => (
  <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" paddingLeft={1} paddingRight={1}>
    <For each={props.view.entries}>
      {(entry, index) => <EntryView view={props.view} entry={entry} previous={props.view.entries[index() - 1]} />}
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

const elapsed = (since: number | undefined, now: number) => {
  const seconds = since === undefined ? 0 : Math.max(0, Math.floor((now - since) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`
}

const StatusBar = (props: { view: View }) => {
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (props.view.status === "idle") return
    const timer = setInterval(() => setNow(Date.now()), SPINNER_INTERVAL)
    onCleanup(() => clearInterval(timer))
  })
  const working = () => props.view.status !== "idle"
  const spinner = () => SPINNER[Math.floor(now() / SPINNER_INTERVAL) % SPINNER.length]
  return (
    <box flexDirection="row" height={1} backgroundColor={color.panel}>
      <Show
        when={working()}
        fallback={
          <text fg={color.background} bg={color.magenta}>
            {" ■ READY "}
          </text>
        }
      >
        <text fg={color.background} bg={props.view.status === "waiting" ? color.yellow : color.cyan}>
          {` ${props.view.status === "waiting" ? "◆ WAITING" : `${spinner()} WORKING`} ${elapsed(props.view.workingSince, now())} `}
        </text>
      </Show>
      <box flexGrow={1} />
      <text fg={color.dim}>{`nisse ${VERSION} `}</text>
    </box>
  )
}

const Header = (props: { view: View }) => (
  <box flexDirection="row" height={1} backgroundColor={color.panel}>
    <text fg={color.background} bg={color.cyan}>
      {" N I S S E ▓▒░"}
    </text>
    <text fg={color.faint}> // </text>
    <text fg={color.dim}>conversation </text>
    <text fg={color.ink}>{props.view.id}</text>
    <Show when={props.view.conversation}>
      {(conversation) => <text fg={color.dim}>{`  ${conversation().cwd}`}</text>}
    </Show>
  </box>
)

const Prompt = (props: { view: View; actions: Actions; steer: boolean }) => {
  let input: TextareaRenderable | undefined
  const submit = () => {
    if (!input) return
    const text = input.plainText
    if (text.trim() === "") return
    props.actions.submit(text, props.steer && props.view.status !== "idle")
    input.clear()
  }
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={color.violet}
      title={props.view.status === "idle" ? " PROMPT " : props.steer ? " STEER · tab " : " QUEUE · tab "}
      titleColor={color.magenta}
      flexDirection="row"
      paddingLeft={1}
      minHeight={3}
    >
      <text fg={color.magenta}>❯ </text>
      <textarea
        ref={(element: TextareaRenderable) => (input = element)}
        flexGrow={1}
        minHeight={1}
        maxHeight={8}
        focused
        textColor={color.ink}
        focusedTextColor={color.ink}
        placeholder="type a message"
        placeholderColor={color.faint}
        keyBindings={promptKeys}
        onSubmit={submit}
      />
    </box>
  )
}

const App = (props: { view: View; actions: Actions }) => {
  const [steer, setSteer] = createSignal(false)
  const answer = (allow: boolean) => {
    const pending = props.view.pendingApprovals[0]
    if (pending) props.actions.answer(pending.approval, allow)
  }
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") props.actions.quit()
    else if (key.ctrl && key.name === "y") answer(true)
    else if (key.ctrl && key.name === "n") answer(false)
    else if (key.name === "tab" && props.view.status !== "idle") setSteer((on) => !on)
    else if (key.name === "escape") props.actions.interrupt()
  })
  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={color.background}>
      <Header view={props.view} />
      <Show when={props.view.entries.length > 0 || props.view.live.text !== ""} fallback={<Splash />}>
        <Transcript view={props.view} />
      </Show>
      <Prompt view={props.view} actions={props.actions} steer={steer()} />
      <StatusBar view={props.view} />
    </box>
  )
}

const openRenderer = Effect.acquireRelease(
  Effect.promise(() =>
    createCliRenderer({ exitOnCtrlC: false, targetFps: 30, useMouse: true, backgroundColor: color.background }),
  ),
  (renderer: CliRenderer) =>
    Effect.promise(() => {
      renderer.destroy()
      return renderer.closed
    }),
)

export const tui = Effect.fnUntraced(function* (existing: string | undefined, options: StartOptions) {
  const client = yield* Client
  const conversation = yield* startConversation(client, existing, options)
  const [view, setView] = createStore(emptyView(conversation))
  const done = yield* Deferred.make<void, string>()

  yield* follow(client, conversation).pipe(
    Stream.runForEach((delivery) => Effect.sync(() => setView(produce((draft) => apply(draft, delivery, Date.now()))))),
    Effect.catchTag("NoSuchConversation", () => Deferred.fail(done, `no conversation ${conversation}`)),
    Effect.forkScoped,
  )

  const actions: Actions = {
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
    answer: (approval, allow) =>
      Effect.runFork(client["approval/resolve"]({ conversation, approval, author: userName(), allow })),
    interrupt: () => Effect.runFork(client["conversation/interrupt"]({ conversation })),
    quit: () => Effect.runFork(Deferred.succeed(done, undefined)),
  }

  const outcome = yield* Effect.scoped(
    Effect.gen(function* () {
      const renderer = yield* openRenderer
      yield* Effect.promise(() => render(() => <App view={view} actions={actions} />, renderer))
      const closedByTerminal = Effect.promise(() => renderer.closed)
      return yield* Effect.result(Effect.raceFirst(Deferred.await(done), closedByTerminal))
    }),
  )
  if (outcome._tag === "Failure") {
    process.stderr.write(`${outcome.failure}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write(`resume with: nisse --conversation ${conversation}\n`)
  }
})
