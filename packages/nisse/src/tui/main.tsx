import { createCliRenderer, type CliRenderer, type KeyBinding, type TextareaRenderable } from "@opentui/core"
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { authEnded } from "@nisse/protocol"
import type {
  ApprovalId,
  AuthState,
  CallId,
  ConversationId,
  Delivery,
  Entry,
  ModelSelection,
  Outcome,
  ProviderSnapshot,
} from "@nisse/protocol"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { userName } from "../author.ts"
import { Client, follow, startConversation, type StartOptions } from "../client.ts"
import { runTerminal } from "../login.ts"
import { VERSION } from "../version.ts"
import { describeCall } from "./calls.ts"
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
import { apply, emptyView, type View } from "./view.ts"

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

type Children = Record<ConversationId, View>

interface Actions {
  readonly submit: (text: string, steer: boolean) => void
  readonly answer: (conversation: ConversationId, approval: ApprovalId, allow: boolean) => void
  readonly interrupt: () => void
  readonly quit: () => void
  readonly openPicker: () => void
  readonly movePicker: (rows: number, efforts: number) => void
  readonly closePicker: (selection: ModelSelection | undefined) => void
  readonly signIn: () => void
  readonly cancelSignIn: () => void
  readonly pasteCallback: (url: string) => void
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

const SubagentCard = (props: { title: string; agentType: string | undefined; child: View | undefined }) => {
  const state = () => childState(props.child)
  const asking = () => {
    const child = props.child
    const pending = child?.pendingApprovals[0]
    const call =
      pending && child.entries.find((entry) => entry.body._tag === "tool_call" && entry.body.call === pending.call)
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
          <SubagentCard title={body.title} agentType={body.agentType} child={props.subagents[body.conversation]} />
        </box>
      )
    case "model":
      return (
        <text fg={color.dim} marginTop={1} marginLeft={2}>
          {`◆ ${authorLabel(props.entry).toLowerCase()} switched to ${modelLabel(body.selection)}`}
        </text>
      )
    default:
      return null
  }
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
      <KeyCap cap="^C" what="quit" />
    </box>
    <ProviderList providers={props.providers} />
  </box>
)

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

const elapsed = (since: number | undefined, now: number) => {
  const seconds = since === undefined ? 0 : Math.max(0, Math.floor((now - since) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`
}

const StatusBar = (props: { view: View; subagentAsks: boolean }) => {
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (props.view.status === "idle") return
    const timer = setInterval(() => setNow(Date.now()), SPINNER_INTERVAL)
    onCleanup(() => clearInterval(timer))
  })
  const working = () => props.view.status !== "idle"
  const waiting = () => props.view.status === "waiting" || props.subagentAsks
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
          {` ${waiting() ? "◆ WAITING" : `${spinner()} WORKING`} ${elapsed(props.view.workingSince, now())} `}
        </text>
      </Show>
      <box flexGrow={1} />
      <Show when={props.view.conversation}>
        {(conversation) => <text fg={color.violet}>{`${modelLabel(conversation().model)}  `}</text>}
      </Show>
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

const Prompt = (props: { view: View; setup: SetupView; actions: Actions; steer: boolean }) => {
  let input: TextareaRenderable | undefined
  const submit = () => {
    if (!input) return
    const text = input.plainText
    if (text.trim() === "") return
    input.clear()
    if (text.trim() === "/model") props.actions.openPicker()
    else if (props.setup.signIn?.interaction?._tag === "browser") props.actions.pasteCallback(text.trim())
    else props.actions.submit(text, props.steer && props.view.status !== "idle")
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
        focused={props.setup.picker === undefined}
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

const App = (props: { view: View; subagents: Children; setup: SetupView; actions: Actions }) => {
  const [steer, setSteer] = createSignal(false)
  const answer = (allow: boolean) => {
    const asking = [props.view, ...Object.values(props.subagents)].find((view) => view.pendingApprovals.length > 0)
    const pending = asking?.pendingApprovals[0]
    if (asking && pending) props.actions.answer(asking.id, pending.approval, allow)
  }
  useKeyboard((key) => {
    const picker = props.setup.picker
    if (key.ctrl && key.name === "c") props.actions.quit()
    else if (picker) {
      if (key.name === "up") props.actions.movePicker(-1, 0)
      else if (key.name === "down") props.actions.movePicker(1, 0)
      else if (key.name === "left") props.actions.movePicker(0, -1)
      else if (key.name === "right") props.actions.movePicker(0, 1)
      else if (key.name === "return") props.actions.closePicker(chosen(picker))
      else if (key.name === "escape") props.actions.closePicker(undefined)
    } else if (key.name === "escape" && props.setup.signIn) props.actions.cancelSignIn()
    else if (key.ctrl && key.name === "l") props.actions.signIn()
    else if (key.ctrl && key.name === "y") answer(true)
    else if (key.ctrl && key.name === "n") answer(false)
    else if (key.name === "tab" && props.view.status !== "idle") setSteer((on) => !on)
    else if (key.name === "escape") props.actions.interrupt()
  })
  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={color.background}>
      <Header view={props.view} />
      <Show
        when={props.setup.picker}
        fallback={
          <Show
            when={props.view.entries.length > 0 || props.view.live.text !== ""}
            fallback={<Splash providers={props.setup.providers} />}
          >
            <Transcript view={props.view} subagents={props.subagents} />
          </Show>
        }
      >
        {(picker) => <ModelPicker picker={picker()} />}
      </Show>
      <Show when={props.setup.signIn}>{(state) => <SignInPanel state={state()} />}</Show>
      <Prompt view={props.view} setup={props.setup} actions={props.actions} steer={steer()} />
      <StatusBar
        view={props.view}
        subagentAsks={Object.values(props.subagents).some((subagent) => subagent.pendingApprovals.length > 0)}
      />
    </box>
  )
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

  const [children, setChildren] = createStore<Children>({})
  const scope = yield* Effect.scope
  const followChildren = (delivery: Delivery) =>
    Effect.forEach(
      delivery.entries.flatMap((entry) => (entry.body._tag === "subagent" ? [entry.body.conversation] : [])),
      (child) =>
        child in children
          ? Effect.void
          : Effect.andThen(
              Effect.sync(() => setChildren(child, emptyView(child))),
              follow(client, child).pipe(
                Stream.runForEach((update) =>
                  Effect.sync(() =>
                    setChildren(
                      child,
                      produce((draft) => apply(draft, update, Date.now())),
                    ),
                  ),
                ),
                Effect.ignore,
                Effect.forkIn(scope),
              ),
            ),
      { discard: true },
    )

  yield* follow(client, conversation).pipe(
    Stream.runForEach((delivery) =>
      Effect.andThen(
        Effect.sync(() => setView(produce((draft) => apply(draft, delivery, Date.now())))),
        followChildren(delivery),
      ),
    ),
    Effect.catchTag("NoSuchConversation", () => Deferred.fail(done, `no conversation ${conversation}`)),
    Effect.forkScoped,
  )

  const [setup, setSetup] = createStore<SetupView>(emptySetup())
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runFork(effect)
  const refreshProviders = (refresh: boolean) =>
    client["providers/list"]({ refresh }).pipe(
      Effect.tap((providers) => Effect.sync(() => setSetup("providers", [...providers]))),
      Effect.ignore,
    )
  yield* Effect.forkScoped(refreshProviders(false))

  let renderer: CliRenderer | undefined
  const signInTerminal = (state: AuthState, command: ReadonlyArray<string>, env: Readonly<Record<string, string>>) =>
    Effect.acquireUseRelease(
      Effect.promise(async () => renderer?.suspend()),
      () => runTerminal(command, env),
      () => Effect.promise(async () => renderer?.resume()),
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
        setSetup("signIn", state.phase === "failed" ? state : undefined)
        const terminal = terminals.get(state.flow)
        terminals.delete(state.flow)
        if (terminal) yield* Fiber.interrupt(terminal)
        yield* refreshProviders(false)
        return
      }
      setSetup("signIn", state)
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
  yield* client["auth/watch"]().pipe(Stream.runForEach(onAuth), Effect.ignore, Effect.forkScoped)

  const actions: Actions = {
    openPicker: () =>
      run(
        client["models/list"]({}).pipe(
          Effect.tap((lists) =>
            Effect.sync(() => setSetup("picker", pickerAt(choicesOf(lists), view.conversation?.model))),
          ),
          Effect.ignore,
        ),
      ),
    movePicker: (rows, efforts) =>
      setSetup(
        "picker",
        produce((picker) => {
          if (!picker) return
          const row = Math.min(picker.choices.length - 1, Math.max(0, picker.row + rows))
          const choices = picker.choices[row]?.efforts.length ?? 0
          picker.effort = rows === 0 ? (picker.effort + efforts + choices + 1) % (choices + 1) : 0
          picker.row = row
        }),
      ),
    closePicker: (selection) => {
      setSetup("picker", undefined)
      if (selection) run(client["conversation/select_model"]({ conversation, author: userName(), selection }))
    },
    signIn: () => {
      if (setup.signIn && setup.signIn.phase !== "failed") return
      const current = view.conversation?.model.provider
      const signedOut = setup.providers.filter((provider) => provider.health.status === "signed_out")
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
      const state = setup.signIn
      if (state?.phase === "failed") setSetup("signIn", undefined)
      else if (state) run(client["auth/cancel"]({ provider: state.provider, flow: state.flow }))
    },
    pasteCallback: (url) => {
      const state = setup.signIn
      if (state) {
        run(client["auth/respond"]({ provider: state.provider, flow: state.flow, response: { _tag: "callback", url } }))
      }
    },
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
    answer: (asked, approval, allow) =>
      Effect.runFork(client["approval/resolve"]({ conversation: asked, approval, author: userName(), allow })),
    interrupt: () => Effect.runFork(client["conversation/interrupt"]({ conversation })),
    quit: () => Effect.runFork(Deferred.succeed(done, undefined)),
  }

  const outcome = yield* Effect.scoped(
    Effect.gen(function* () {
      const opened = yield* openRenderer
      renderer = opened
      yield* Effect.promise(() =>
        render(() => <App view={view} subagents={children} setup={setup} actions={actions} />, opened),
      )
      const closedByTerminal = Effect.promise(() => opened.closed)
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
