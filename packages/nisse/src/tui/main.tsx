import { createCliRenderer, type CliRenderer, type KeyBinding, type TextareaRenderable } from "@opentui/core"
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid"
import type { ConversationId, Entry } from "@nisse/protocol"
import { Deferred, Effect, Stream } from "effect"
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { userName } from "../author.ts"
import { Client, follow } from "../client.ts"
import { VERSION } from "../version.ts"
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
  readonly submit: (text: string) => void
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

const EntryView = (props: { entry: Entry }) => {
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
    case "answer":
      return (
        <box flexDirection="column" marginTop={1}>
          <Tag label="NISSE" color={color.cyan} />
          <text fg={color.ink} marginLeft={2}>
            {body.text}
          </text>
          <Show when={body.interrupted}>
            <text fg={color.dim} marginLeft={2}>
              ◆ interrupted
            </text>
          </Show>
        </box>
      )
    case "run_failed":
      return (
        <text fg={color.yellow} marginLeft={2}>
          {`✗ ${body.message}`}
        </text>
      )
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
    <For each={props.view.entries}>{(entry) => <EntryView entry={entry} />}</For>
    <Show when={props.view.live !== ""}>
      <box flexDirection="column" marginTop={1}>
        <Tag label="NISSE" color={color.cyan} />
        <text fg={color.ink} marginLeft={2}>
          {props.view.live}
        </text>
      </box>
    </Show>
    <For each={props.view.queued}>
      {(queued) => (
        <text fg={color.dim} marginLeft={2}>
          {`queued · ${queued.text}`}
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
    if (props.view.status !== "working") return
    const timer = setInterval(() => setNow(Date.now()), SPINNER_INTERVAL)
    onCleanup(() => clearInterval(timer))
  })
  const working = () => props.view.status === "working"
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
        <text fg={color.background} bg={color.cyan}>
          {` ${spinner()} WORKING ${elapsed(props.view.workingSince, now())} `}
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

const Prompt = (props: { view: View; actions: Actions }) => {
  let input: TextareaRenderable | undefined
  const submit = () => {
    if (!input) return
    const text = input.plainText
    if (text.trim() === "") return
    props.actions.submit(text)
    input.clear()
  }
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={color.violet}
      title={props.view.status === "working" ? " QUEUE " : " PROMPT "}
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
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") props.actions.quit()
    else if (key.name === "escape") props.actions.interrupt()
  })
  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={color.background}>
      <Header view={props.view} />
      <Show when={props.view.entries.length > 0 || props.view.live !== ""} fallback={<Splash />}>
        <Transcript view={props.view} />
      </Show>
      <Prompt view={props.view} actions={props.actions} />
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

export const tui = Effect.fnUntraced(function* (existing: string | undefined) {
  const client = yield* Client
  const conversation =
    (existing as ConversationId | undefined) ?? (yield* client["conversation/start"]({ cwd: process.cwd() })).id
  const [view, setView] = createStore(emptyView(conversation))
  const done = yield* Deferred.make<void, string>()

  yield* follow(client, conversation).pipe(
    Stream.runForEach((delivery) => Effect.sync(() => setView(produce((draft) => apply(draft, delivery, Date.now()))))),
    Effect.catchTag("NoSuchConversation", () => Deferred.fail(done, `no conversation ${conversation}`)),
    Effect.forkScoped,
  )

  const actions: Actions = {
    submit: (text) =>
      Effect.runFork(
        client["conversation/submit"]({ conversation, requestId: crypto.randomUUID(), author: userName(), text }),
      ),
    interrupt: () => Effect.runFork(client["conversation/interrupt"]({ conversation })),
    quit: () => Effect.runFork(Deferred.succeed(done, undefined)),
  }

  const outcome = yield* Effect.scoped(
    Effect.gen(function* () {
      const renderer = yield* openRenderer
      yield* Effect.promise(() => render(() => <App view={view} actions={actions} />, renderer))
      return yield* Effect.result(Deferred.await(done))
    }),
  )
  if (outcome._tag === "Failure") {
    process.stderr.write(`${outcome.failure}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write(`resume with: nisse --conversation ${conversation}\n`)
  }
})
