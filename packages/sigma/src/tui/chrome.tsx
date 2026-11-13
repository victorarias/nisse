// What every TUI draws around a transcript, whichever wire it speaks: the header, the splash, the prompt, the status
// bar, the model picker and sign-in, and the renderer they draw on.
import { createCliRenderer, type CliRenderer, type KeyBinding, type TextareaRenderable } from "@opentui/core"
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { authEnded } from "@sigma/protocol"
import type {
  AuthResponse,
  AuthState,
  ExtensionInfo,
  ModelSelection,
  ProviderModels,
  ProviderSnapshot,
  TreeStatus,
} from "@sigma/protocol"
import { Deferred, Effect, Fiber, type Scope, Stream } from "effect"
import type { Accessor, JSX } from "solid-js"
import { createContext, createEffect, createMemo, createSignal, For, onCleanup, Show, useContext } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { runTerminal } from "../login.ts"
import { VERSION } from "../version.ts"
import {
  choicesOf,
  chosen,
  emptySetup,
  modelLabel,
  ModelPicker,
  pickerAt,
  ProviderList,
  SignInPanel,
  type SetupView,
} from "./setup.tsx"
import { color, KeyCap } from "./theme.tsx"

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

/** The conversation as the chrome draws it. */
export interface Screen {
  readonly id: string
  /** The conversation it was forked from, and that one's title. */
  readonly fork?: { readonly of: string; readonly title?: string | undefined } | undefined
  readonly cwd: string | undefined
  readonly model: ModelSelection | undefined
  readonly status: TreeStatus["status"]
  readonly workingSince: number | undefined
  /** Its parent's provider runs it, so it takes input only through its parent. */
  readonly hosted: boolean
  /** The server opened its home read-only: it takes no input, and only the commands that read work. */
  readonly readOnly: boolean
  readonly statusLines: Readonly<Record<string, string>>
  /** Nothing to show yet: the splash shows instead of the transcript. */
  readonly empty: boolean
  /** A subagent under it waits on a person. */
  readonly subagentAsks: boolean
  /** What the last command or input came to, such as why it was refused, until the next one. */
  readonly notice?: Notice | undefined
  /** What the run in flight and the compactions are doing, from the conversation's live state. */
  readonly live: LiveStatus
  /** The tokens the conversation spent, and how full its context was at its last answer. */
  readonly usage: UsageStatus
  /** A list a command opened in place of the transcript, until escape closes it. */
  readonly panel?: Panel | undefined
}

export type Notice = { readonly text: string; readonly warning: boolean }

export type LiveStatus = {
  readonly compacting: boolean
  /** Why the newest compaction failed, until one succeeds. */
  readonly compactionFailure?: string | undefined
  /** The model failed and is asked again at `at`. */
  readonly retry?: { readonly at: number; readonly error: string } | undefined
}

export type UsageStatus = {
  readonly tokens: number
  readonly context?: number | undefined
  readonly contextWindow?: number | undefined
}

export type Panel = { readonly title: string; readonly lines: ReadonlyArray<string> }

/** The slash commands, with what each does, as /help lists them. */
export const COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ["/model", "switch the model"],
  ["/fork", "go on in a new conversation from before your last prompt"],
  ["/reset [handoff]", "start a new, empty context, with the handoff as its first message"],
  ["/compact [instructions]", "summarize the context now"],
  ["/continue", "start a run with no new input, such as after one failed"],
  ["/withdraw", "take back the newest queued prompt"],
  ["/instructions [text]", "set the model's instructions; without text, clear them"],
  ["/max-turns [n]", "end a run after n tool rounds; without n, no limit"],
  ["/usage", "the tokens this conversation and every conversation spent"],
  ["/tasks", "the work running now in every conversation"],
  ["/help", "these commands"],
]

/** What a person can do to the conversation itself, on the wire the TUI speaks. */
export interface ConversationActions {
  readonly submit: (text: string, steer: boolean) => void
  /** The names of the images `text` attaches, for a wire that carries images. */
  readonly attachments?: (text: string) => ReadonlyArray<string>
  /** Answers the first call that waits on a person, in the conversation or a subagent under it. */
  readonly answer: (allow: boolean) => void
  readonly interrupt: () => void
  readonly selectModel: (selection: ModelSelection) => void
  /** Runs `/name argument`; false when it names no command, so the text goes to the model. */
  readonly command: (name: string, argument: string) => boolean
  readonly closePanel: () => void
  readonly quit: () => void
}

/**
 * The terminal's width, from the one resize subscription the screen holds: a subscription per speaker bar would pass
 * Node's limit of ten listeners in a long transcript, and its warning would print over the screen.
 */
const Width = createContext<Accessor<number>>(() => 0)

export const Tag = (props: { label: string; color: string }) => {
  const width = useContext(Width)
  const rule = () => "─".repeat(Math.max(0, width() - props.label.length - 6))
  return (
    <box flexDirection="row" height={1}>
      <text fg={color.background} bg={props.color}>
        {` ${props.label} `}
      </text>
      <text fg={color.faint}>{` ${rule()}`}</text>
    </box>
  )
}

const Splash = (props: { providers: ReadonlyArray<ProviderSnapshot> }) => (
  <box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center">
    <For each={LOGO}>{(line, row) => <text fg={LOGO_COLORS[row()]}>{line}</text>}</For>
    <text fg={color.dim} marginTop={1}>
      D U R A B L E · M U L T I P L A Y E R · C O D I N G A G E N T
    </text>
    <box flexDirection="row" marginTop={1} gap={3}>
      <KeyCap cap="⏎" what="send" />
      <KeyCap cap="⇧⏎" what="newline" />
      <KeyCap cap="esc" what="stop" />
      <KeyCap cap="/model" what="switch model" />
      <KeyCap cap="/help" what="commands" />
      <KeyCap cap="^C" what="quit" />
    </box>
    <ProviderList providers={props.providers} />
  </box>
)

const elapsed = (since: number | undefined, now: number) => {
  const seconds = since === undefined ? 0 : Math.max(0, Math.floor((now - since) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`
}

/**
 * Why a compaction failed, named once: the harness words a summarizer's failure `Summarization failed: <cause>`, which
 * under `compaction failed` would say it twice.
 */
const compactionFailed = (error: string) => `compaction failed: ${error.replace(/^Summarization failed: /, "")}`

/** `text` cut to `max` characters, ending in … when cut. */
export const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/** The most of a conversation's title a line shows: a first prompt can be a pasted file. */
export const TITLE_WIDTH = 40

/** 1234 as 1.2k, 1234567 as 1.2M. */
export const tokens = (count: number) =>
  count < 1000
    ? String(count)
    : count < 1_000_000
      ? `${(count / 1000).toFixed(1)}k`
      : `${(count / 1_000_000).toFixed(1)}M`

const usageLabel = (usage: UsageStatus) => {
  const context =
    usage.context === undefined
      ? ""
      : usage.contextWindow === undefined
        ? ` · context ${tokens(usage.context)}`
        : ` · context ${Math.round((usage.context / usage.contextWindow) * 100)}% of ${tokens(usage.contextWindow)}`
  return usage.tokens === 0 && context === "" ? "" : `${tokens(usage.tokens)} tokens${context}  `
}

const statusLines = (lines: Readonly<Record<string, string>>) => {
  const shown = Object.entries(lines).map(([extension, text]) => `${extension}: ${text}`)
  return shown.length === 0 ? "" : ` ${shown.join(" · ")}`
}

const StatusBar = (props: { screen: Screen }) => {
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (props.screen.status === "idle") return
    const timer = setInterval(() => setNow(Date.now()), SPINNER_INTERVAL)
    onCleanup(() => clearInterval(timer))
  })
  const working = () => props.screen.status !== "idle"
  const waiting = () => props.screen.status === "waiting" || props.screen.subagentAsks
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
        <text fg={color.background} bg={waiting() ? color.yellow : color.cyan}>
          {` ${waiting() ? "◆ WAITING" : `${spinner()} WORKING`} ${elapsed(props.screen.workingSince, now())} `}
        </text>
      </Show>
      <Show when={props.screen.live.compacting}>
        <text fg={color.cyan}> ◆ compacting</text>
      </Show>
      <Show when={props.screen.live.retry}>
        {(retry) => (
          <text fg={color.yellow}>
            {` ↻ retrying in ${Math.max(0, Math.ceil((retry().at - now()) / 1000))}s · ${retry().error}`}
          </text>
        )}
      </Show>
      <text fg={color.dim}>{statusLines(props.screen.statusLines)}</text>
      <box flexGrow={1} />
      <text fg={color.dim}>{usageLabel(props.screen.usage)}</text>
      <Show when={props.screen.model}>{(model) => <text fg={color.violet}>{`${modelLabel(model())}  `}</text>}</Show>
      <text fg={color.dim}>{`sigma ${VERSION} `}</text>
    </box>
  )
}

// Only the directory gives way when the row is too narrow: the rest says which conversation this is.
const Header = (props: { screen: Screen }) => (
  <box flexDirection="row" height={1} backgroundColor={color.panel}>
    <text fg={color.background} bg={color.cyan} flexShrink={0}>
      {" S I G M A ▓▒░"}
    </text>
    <text fg={color.faint} flexShrink={0}>
      {" // "}
    </text>
    <text fg={color.dim} flexShrink={0}>
      {"conversation "}
    </text>
    <text fg={color.ink} flexShrink={0}>
      {props.screen.id}
    </text>
    <Show when={props.screen.fork}>
      {(fork) => (
        <text fg={color.violet} flexShrink={0}>
          {`  ⑂ fork of ${fork().of}${fork().title === undefined ? "" : ` · ${fork().title}`}`}
        </text>
      )}
    </Show>
    <Show when={props.screen.cwd}>{(cwd) => <text fg={color.dim} flexShrink={1}>{`  ${cwd()}`}</text>}</Show>
  </box>
)

const Prompt = (props: {
  screen: Screen
  setup: SetupView
  submit: (text: string) => void
  openPicker: () => void
  command: (name: string, argument: string) => boolean
  pasteCallback: (url: string) => void
  steer: boolean
  attachments: ((text: string) => ReadonlyArray<string>) | undefined
}) => {
  let input: TextareaRenderable | undefined
  const [text, setText] = createSignal("")
  const attached = createMemo(() => (text() === "" ? [] : (props.attachments?.(text()) ?? [])))
  const submit = () => {
    if (!input || props.screen.hosted) return
    const text = input.plainText
    if (text.trim() === "") return
    const typed = /^\/([a-z-]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
    if (props.screen.readOnly) {
      // Only commands run on a read-only server; anything else stays typed, and submit says why.
      if (typed && props.command(typed[1]!, typed[2]?.trim() ?? "")) input.clear()
      else props.submit(text)
      return
    }
    input.clear()
    if (text.trim() === "/model") props.openPicker()
    else if (props.setup.signIn?.interaction?._tag === "browser") props.pasteCallback(text.trim())
    else if (typed && props.command(typed[1]!, typed[2]?.trim() ?? "")) return
    else props.submit(text)
  }
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={color.violet}
      title={
        props.screen.hosted
          ? " INPUT GOES THROUGH ITS PARENT "
          : props.screen.readOnly
            ? " READ ONLY "
            : props.screen.status === "idle"
              ? " PROMPT "
              : props.steer
                ? " STEER · tab "
                : " QUEUE · tab "
      }
      titleColor={color.magenta}
      flexDirection="column"
      paddingLeft={1}
      minHeight={3}
    >
      <box flexDirection="row">
        <text fg={color.magenta}>❯ </text>
        <textarea
          ref={(element: TextareaRenderable) => (input = element)}
          flexGrow={1}
          minHeight={1}
          maxHeight={8}
          focused={props.setup.picker === undefined}
          textColor={color.ink}
          focusedTextColor={color.ink}
          placeholder={
            props.screen.hosted
              ? "Claude Code runs this subagent; talk to it through its parent"
              : props.screen.readOnly
                ? "the server shows this home read-only and takes no input; /usage, /tasks and /help still work"
                : "type a message"
          }
          placeholderColor={color.faint}
          keyBindings={promptKeys}
          onSubmit={submit}
          onContentChange={() => setText(input?.plainText ?? "")}
        />
      </box>
      <Show when={attached().length > 0}>
        <text fg={color.dim}>{`attaching ${attached().join(", ")}`}</text>
      </Show>
    </box>
  )
}

const PanelView = (props: { panel: Panel }) => (
  <scrollbox flexGrow={1} paddingLeft={2} paddingRight={1}>
    <box flexDirection="row" marginTop={1} gap={2}>
      <text fg={color.violet}>{props.panel.title}</text>
      <KeyCap cap="esc" what="close" />
    </box>
    <For each={props.panel.lines}>{(line) => <text fg={color.ink}>{line}</text>}</For>
  </scrollbox>
)

/** The whole screen, with `transcript` drawn between the header and the prompt. */
export const Shell = (props: {
  screen: Screen
  setup: Setup
  actions: ConversationActions
  transcript: () => JSX.Element
}) => {
  const [steer, setSteer] = createSignal(false)
  const setup = props.setup
  useKeyboard((key) => {
    const picker = setup.view.picker
    if (key.ctrl && key.name === "c") props.actions.quit()
    else if (props.screen.panel && key.name === "escape") props.actions.closePanel()
    else if (picker) {
      if (key.name === "up") setup.movePicker(-1, 0)
      else if (key.name === "down") setup.movePicker(1, 0)
      else if (key.name === "left") setup.movePicker(0, -1)
      else if (key.name === "right") setup.movePicker(0, 1)
      else if (key.name === "return") {
        const selection = chosen(picker)
        setup.closePicker()
        if (selection) props.actions.selectModel(selection)
      } else if (key.name === "escape") setup.closePicker()
    } else if (key.name === "escape" && setup.view.signIn) setup.cancelSignIn()
    else if (key.ctrl && key.name === "l") setup.signIn(props.screen.model?.provider)
    else if (key.ctrl && key.name === "y") props.actions.answer(true)
    else if (key.ctrl && key.name === "n") props.actions.answer(false)
    else if (key.name === "tab" && props.screen.status !== "idle") setSteer((on) => !on)
    else if (key.name === "escape") props.actions.interrupt()
  })
  const dimensions = useTerminalDimensions()
  return (
    <Width.Provider value={() => dimensions().width}>
      <box flexDirection="column" flexGrow={1} backgroundColor={color.background}>
        <Header screen={props.screen} />
        <Show
          when={setup.view.picker}
          fallback={
            <Show
              when={props.screen.panel}
              fallback={
                <Show when={!props.screen.empty} fallback={<Splash providers={setup.view.providers} />}>
                  {props.transcript()}
                </Show>
              }
            >
              {(panel) => <PanelView panel={panel()} />}
            </Show>
          }
        >
          {(picker) => <ModelPicker picker={picker()} />}
        </Show>
        <Show when={setup.view.signIn}>{(state) => <SignInPanel state={state()} />}</Show>
        <Show when={props.screen.live.compactionFailure}>
          {(failure) => (
            <text fg={color.yellow} marginLeft={1} flexShrink={0}>
              {`✗ ${compactionFailed(failure())}`}
            </text>
          )}
        </Show>
        <Show when={props.screen.notice}>
          {(notice) => (
            <text fg={notice().warning ? color.yellow : color.dim} marginLeft={1} flexShrink={0}>
              {`${notice().warning ? "✗" : "◆"} ${notice().text}`}
            </text>
          )}
        </Show>
        <For each={setup.view.brokenExtensions}>
          {(extension) => (
            <text fg={color.yellow} marginLeft={1} flexShrink={0}>
              {`✗ extension ${extension.name} failed to load: ${extension.message ?? "no reason given"}`}
            </text>
          )}
        </For>
        <Prompt
          screen={props.screen}
          setup={setup.view}
          submit={(text) => props.actions.submit(text, steer() && props.screen.status !== "idle")}
          openPicker={() => setup.openPicker(props.screen.model)}
          command={props.actions.command}
          pasteCallback={setup.pasteCallback}
          steer={steer()}
          attachments={props.actions.attachments}
        />
        <StatusBar screen={props.screen} />
      </box>
    </Width.Provider>
  )
}

/** The calls the chrome makes, which both wires answer alike. */
export interface SetupClient {
  readonly "providers/list": (payload: {
    readonly refresh?: boolean
  }) => Effect.Effect<ReadonlyArray<ProviderSnapshot>, unknown>
  readonly "models/list": (payload: {
    readonly refresh?: boolean
  }) => Effect.Effect<ReadonlyArray<ProviderModels>, unknown>
  readonly "extensions/list": () => Effect.Effect<ReadonlyArray<ExtensionInfo>, unknown>
  readonly "auth/start": (payload: {
    readonly provider: string
    readonly method?: "browser" | "device_code" | "terminal"
  }) => Effect.Effect<AuthState, unknown>
  readonly "auth/respond": (payload: {
    readonly provider: string
    readonly flow: string
    readonly response: AuthResponse
  }) => Effect.Effect<unknown, unknown>
  readonly "auth/cancel": (payload: {
    readonly provider: string
    readonly flow: string
  }) => Effect.Effect<unknown, unknown>
  readonly "auth/watch": () => Stream.Stream<AuthState, unknown>
}

export interface Setup {
  readonly view: SetupView
  readonly openPicker: (current: ModelSelection | undefined) => void
  readonly movePicker: (rows: number, efforts: number) => void
  readonly closePicker: () => void
  /** Signs in to the first signed-out provider, `current` first. */
  readonly signIn: (current: string | undefined) => void
  readonly cancelSignIn: () => void
  readonly pasteCallback: (url: string) => void
}

const remote = () => process.env.SSH_CONNECTION !== undefined || process.env.SSH_TTY !== undefined

const openBrowser = (url: string) => {
  if (remote()) return
  try {
    Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }).unref()
  } catch {}
}

/**
 * The providers, broken extensions, sign-in and model picker, kept current from `client` for as long as `scope` is
 * open. `renderer` gives the terminal to a provider's own sign-in while it runs.
 */
export const setupOf = (client: SetupClient, scope: Scope.Scope, renderer: () => CliRenderer | undefined) =>
  Effect.gen(function* () {
    const [view, setView] = createStore<SetupView>(emptySetup())
    const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runFork(effect)
    const refreshProviders = (refresh: boolean) =>
      client["providers/list"]({ refresh }).pipe(
        Effect.tap((providers) => Effect.sync(() => setView("providers", [...providers]))),
        Effect.ignore,
      )
    yield* Effect.forkIn(refreshProviders(false), scope)
    yield* client["extensions/list"]().pipe(
      Effect.tap((extensions) =>
        Effect.sync(() =>
          setView(
            "brokenExtensions",
            extensions.filter((extension) => extension.state === "failed"),
          ),
        ),
      ),
      Effect.ignore,
      Effect.forkIn(scope),
    )

    const signInTerminal = (state: AuthState, command: ReadonlyArray<string>, env: Readonly<Record<string, string>>) =>
      Effect.acquireUseRelease(
        Effect.promise(async () => renderer()?.suspend()),
        () => runTerminal(command, env),
        () => Effect.promise(async () => renderer()?.resume()),
      ).pipe(
        Effect.flatMap((success) =>
          client["auth/respond"]({
            provider: state.provider,
            flow: state.flow,
            response: { _tag: "terminal_exited", success },
          }),
        ),
        Effect.ignore,
      )

    const seen = new Map<string, AuthState>()
    const acted = new Set<string>()
    const terminals = new Map<string, Fiber.Fiber<void>>()
    let mine: string | undefined
    const act = (state: AuthState) =>
      Effect.gen(function* () {
        if (authEnded(state.phase)) {
          mine = undefined
          setView("signIn", state.phase === "failed" ? state : undefined)
          const terminal = terminals.get(state.flow)
          terminals.delete(state.flow)
          if (terminal) yield* Fiber.interrupt(terminal)
          yield* refreshProviders(false)
          return
        }
        setView("signIn", state)
        const interaction = state.interaction
        if (state.phase !== "waiting" || !interaction || acted.has(state.flow)) return
        acted.add(state.flow)
        if (interaction._tag === "browser") openBrowser(interaction.url)
        if (interaction._tag === "terminal")
          terminals.set(
            state.flow,
            yield* Effect.forkIn(signInTerminal(state, interaction.command, interaction.env), scope),
          )
      })
    const onAuth = (state: AuthState) =>
      Effect.suspend(() => {
        seen.set(state.flow, state)
        if (state.flow === mine) return act(state)
        return authEnded(state.phase) ? refreshProviders(false) : Effect.void
      })
    yield* client["auth/watch"]().pipe(Stream.runForEach(onAuth), Effect.ignore, Effect.forkIn(scope))

    const setup: Setup = {
      view,
      openPicker: (current) =>
        run(
          client["models/list"]({}).pipe(
            Effect.tap((lists) => Effect.sync(() => setView("picker", pickerAt(choicesOf(lists), current)))),
            Effect.ignore,
          ),
        ),
      movePicker: (rows, efforts) =>
        setView(
          "picker",
          produce((picker) => {
            if (!picker) return
            const row = Math.min(picker.choices.length - 1, Math.max(0, picker.row + rows))
            const choices = picker.choices[row]?.efforts.length ?? 0
            picker.effort = rows === 0 ? (picker.effort + efforts + choices + 1) % (choices + 1) : 0
            picker.row = row
          }),
        ),
      closePicker: () => setView("picker", undefined),
      signIn: (current) => {
        if (view.signIn && view.signIn.phase !== "failed") return
        const signedOut = view.providers.filter((provider) => provider.health.status === "signed_out")
        const target = signedOut.find((provider) => provider.id === current) ?? signedOut[0]
        if (!target) return
        const method = remote() && target.signIn.includes("device_code") ? "device_code" : undefined
        run(
          client["auth/start"]({ provider: target.id, ...(method ? { method } : {}) }).pipe(
            Effect.flatMap((started) =>
              Effect.suspend(() => {
                mine = started.flow
                return act(seen.get(started.flow) ?? started)
              }),
            ),
            Effect.ignore,
          ),
        )
      },
      cancelSignIn: () => {
        const state = view.signIn
        if (state?.phase === "failed") setView("signIn", undefined)
        else if (state) run(client["auth/cancel"]({ provider: state.provider, flow: state.flow }))
      },
      pasteCallback: (url) => {
        const state = view.signIn
        if (state) {
          run(
            client["auth/respond"]({ provider: state.provider, flow: state.flow, response: { _tag: "callback", url } }),
          )
        }
      },
    }
    return setup
  })

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

/**
 * Draws `app` until the person quits (`done` succeeds), the terminal closes, or `done` fails with what to tell them;
 * then says how to reopen `conversation`. `opened` gets the renderer once it draws.
 */
export const showUntilDone = (
  app: () => JSX.Element,
  done: Deferred.Deferred<void, string>,
  conversation: string,
  opened: (renderer: CliRenderer) => void,
  /** Whether the person quit, rather than moved on to another conversation: then the reopen hint prints. */
  hint: () => boolean = () => true,
) =>
  Effect.gen(function* () {
    const outcome = yield* Effect.scoped(
      Effect.gen(function* () {
        const renderer = yield* openRenderer
        opened(renderer)
        yield* Effect.promise(() => render(app, renderer))
        const closedByTerminal = Effect.promise(() => renderer.closed)
        return yield* Effect.result(Effect.raceFirst(Deferred.await(done), closedByTerminal))
      }),
    )
    if (outcome._tag === "Failure") {
      process.stderr.write(`${outcome.failure}\n`)
      process.exitCode = 1
    } else if (hint()) {
      process.stdout.write(`resume with: sigma --conversation ${conversation}\n`)
    }
  })
