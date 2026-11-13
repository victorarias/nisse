// One Claude Code process, started through the Claude Agent SDK: its query, the inbox it reads its messages from, the
// pump that hands each frame it sends to the run it serves, and the callbacks Claude Code makes, which reach that run
// (F3). What a run does with the frames is `serving.ts`.
import {
  createSdkMcpServer,
  type EffortLevel,
  type HookCallbackMatcher,
  type HookEvent,
  type Options,
  query,
  type SDKMessage,
  type SDKUserMessage,
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk"
import type { Agent } from "@nisse/harness"
import type { Usage } from "@nisse/models"
import { Clock, type Duration, Effect, Option, Semaphore } from "effect"
import { z } from "zod"
import { claudeEnvironment, toolSearchSettings } from "./environment.ts"
import { Inbox } from "./inbox.ts"
import type { Said } from "./retell.ts"
import {
  type Ended,
  failure,
  makeServing,
  type ModelUsage,
  type OwnTool,
  type RunContext,
  type Serving,
  type ServingProcess,
  toolHooksOf,
} from "./serving.ts"

/** How a Claude Code instance is started: its executable, environment and extra arguments. */
export interface ClaudeProcessSettings {
  /** Default: the SDK's bundled Claude Code. */
  readonly executable?: string
  readonly env?: Readonly<Record<string, string>>
  readonly args?: ReadonlyArray<string>
}

/** Where a process starts in Claude Code's session. */
export type Start =
  /** A new session, named `title` so Claude Code does not ask a model for a name. */
  | { readonly _tag: "fresh"; readonly session: string; readonly title?: string }
  | { readonly _tag: "resume"; readonly session: string; readonly at: string }
  /** A fork of a conversation whose parent held the session: a new session continuing the parent's at `at`. */
  | { readonly _tag: "fork"; readonly from: string; readonly at: string; readonly session: string }

/** What a process is started with. */
export type ProcessConfig = {
  readonly agent: Agent
  readonly settings: ClaudeProcessSettings
  /** Extensions whose tools Claude Code has its own of; the rest reach it through nisse's MCP server. */
  readonly builtinExtensions: ReadonlySet<string>
  /** Tool names extensions removed: nisse's own, which stand for Claude Code's, and Claude Code's by its names. */
  readonly withheldTools: ReadonlyArray<string>
  /** The id of the conversation people started, for the `NISSE_ROOT_CONVERSATION` its commands see. */
  readonly rootConversation: string
}

/** The model and effort a process answers with; `""` and `undefined` leave them to the person's Claude Code settings. */
export type Selection = { readonly modelId: string; readonly effort: EffortLevel | undefined }

export const selectionOf = (agent: Agent): Selection => ({
  modelId: agent.model?.modelId ?? "",
  effort:
    agent.thinkingLevel === "off" || agent.thinkingLevel === undefined
      ? undefined
      : (agent.thinkingLevel as EffortLevel),
})

export interface ClaudeProcess {
  /**
   * Serves the run `run`: switches to the run's model and effort, sends it `opening`, then hands every frame to it
   * until the run ends. A process that exits before Claude Code took the opening ends the run `exited`.
   */
  readonly serve: (run: RunContext, opening: ReadonlyArray<Said>) => Effect.Effect<Ended, unknown>
  /**
   * Whether `serve` can switch the process to `selection`. Claude Code clears a model or effort to its own default,
   * not to the person's settings, so a run that clears either needs a new process (D4).
   */
  readonly canSelect: (selection: Selection) => boolean
  /**
   * Stops the turn of the run it served (D5): interrupts Claude Code and reads its frames, handing them to no run, until
   * the turn's result. Succeeds with whether the process can serve another run: it ended the turn within `within`, with
   * nothing left queued and no background work. A stopped run's subagents end with the turn.
   */
  readonly stop: (within: Duration.Input) => Effect.Effect<boolean>
  /** Background work Claude Code started and has not said ended: a background command or subagent (D6). */
  readonly busy: boolean
  /** Reads ahead while no run is served, and completes once the process has exited. */
  readonly exited: Effect.Effect<void>
  /** The cache facts of the newest main-loop request, once one was made (F13). */
  readonly lastRequest: LastRequest | undefined
}

/** What the newest main-loop request left in the prompt cache: when it was made, its context and the cache's TTL. */
export interface LastRequest {
  /** When its response started, by the clock the process was opened with, in milliseconds. */
  readonly at: number
  /** Its whole context in tokens: uncached input, cache reads and cache writes. */
  readonly context: number
  /** How long the cache it wrote lives, from the newest request that wrote one; `undefined` while none has. */
  readonly ttl: "5m" | "1h" | undefined
}

/** One model's running totals in one Claude Code process, as it reports them (`modelUsage`). */
type UsageTotals = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }

/** Claude Code's tool for each of nisse's built-in tools, which Claude Code is never offered. */
const CLAUDE_TOOL: Readonly<Record<string, string>> = {
  read: "Read",
  grep: "Grep",
  glob: "Glob",
  write: "Write",
  edit: "Edit",
  bash: "Bash",
}

export const bundledExecutable = () => {
  for (const variant of ["", "-musl"]) {
    try {
      return Bun.resolveSync(
        `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${variant}/claude`,
        import.meta.dir,
      )
    } catch {}
  }
  return "claude"
}

/** `--flag value`, `--flag=value` and bare `--flag` arguments as the SDK's `extraArgs`. */
const extraArgs = (args: ReadonlyArray<string>) => {
  const extra: Record<string, string | null> = {}
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!
    if (!flag.startsWith("--")) continue
    const [name, joined] = flag.slice(2).split(/=(.*)/s, 2) as [string, string | undefined]
    const next = args[i + 1]
    if (joined !== undefined) extra[name] = joined
    else if (next !== undefined && !next.startsWith("--")) extra[name] = args[++i]!
    else extra[name] = null
  }
  return extra
}

const userMessage = (parts: ReadonlyArray<Said>, priority?: "next"): SDKUserMessage => ({
  type: "user",
  message: {
    role: "user",
    content: parts.map((part) =>
      typeof part === "string"
        ? { type: "text" as const, text: part }
        : {
            type: "image" as const,
            source: { type: "base64" as const, media_type: part.mimeType as "image/png", data: part.data },
          },
    ),
  },
  parent_tool_use_id: null,
  uuid: crypto.randomUUID(),
  session_id: "",
  ...(priority ? { priority } : {}),
})

/** What a process is started with that it cannot change once it runs. */
const spawnedWith = (config: ProcessConfig) => {
  const { agent } = config
  // Own tools: those of extensions other than nisse's built-in ones, offered to Claude Code over MCP.
  const builtin = new Set(
    agent.extensions
      .filter((extension) => config.builtinExtensions.has(extension.name))
      .flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name)),
  )
  const own = new Map<string, OwnTool>(
    agent.tools.filter((tool) => !builtin.has(tool.name)).map((tool) => [tool.name, tool]),
  )
  return {
    ...selectionOf(agent),
    own,
    // Claude Code's own tools an extension removed, and the own tools, which it reaches only over MCP.
    withheld: [...new Set([...config.withheldTools.map((name) => CLAUDE_TOOL[name] ?? name), ...own.keys()])],
  }
}

/**
 * The process key: what a process of `config` is spawned with, which a live one cannot change. A run whose key
 * differs from its live process's gets a new process. The model and effort are not in it: `serve` switches them.
 */
export const processKey = (config: ProcessConfig) => {
  const { own, withheld } = spawnedWith(config)
  return JSON.stringify({
    provider: config.agent.model?.provider,
    settings: config.settings,
    cwd: config.agent.cwd,
    maxTurns: config.agent.maxTurns,
    own: [...own.values()].map(({ name, description, parameters }) => ({ name, description, parameters })),
    withheld,
    afterHooks: toolHooksOf(config.agent).after.length > 0,
    rootConversation: config.rootConversation,
  })
}

/** Starts a Claude Code process at `start`; it is closed with the scope. */
export const openProcess = (config: ProcessConfig, start: Start) =>
  Effect.gen(function* () {
    const { agent, settings } = config
    const { modelId, effort, own, withheld } = spawnedWith(config)
    const serial = yield* Semaphore.make(1)
    const clock = yield* Clock.Clock
    let lastRequest: LastRequest | undefined
    const inbox = new Inbox<SDKUserMessage>()
    const awaitingReplay = new Set<string>()
    let session = start.session
    /** What Claude Code answers with now: what it was spawned with, then what the last run switched it to. */
    let selected: Selection = { modelId, effort }
    let resetting = false
    // `modelUsage` at this process's previous result: a process reports its own running totals, which a resumed
    // session does not carry over (died_while_idle's second process reports a first turn's cache read again).
    let totals: Record<string, UsageTotals> | undefined
    /** The run the process serves now, which its callbacks reach. */
    let serving: Serving | undefined
    /** The last run it served, whose subagents end with the process. */
    let served: Serving | undefined
    /** The tasks Claude Code started and has not said ended. */
    const tasks = new Set<string>()
    /** Frames read while no run was served, or reads still waiting, in order: the next run gets them first. */
    const ahead: Array<Promise<IteratorResult<SDKMessage, unknown>>> = []

    const controller = yield* Effect.acquireRelease(
      Effect.sync(() => new AbortController()),
      (controller) =>
        Effect.gen(function* () {
          inbox.close()
          controller.abort()
          if (served !== undefined) yield* served.end
        }),
    )

    const current = () => {
      if (serving === undefined) throw new Error("Claude Code called back while the process served no run")
      return serving
    }

    const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
      PreToolUse: [{ hooks: [async (...args) => current().preToolUse(...args)] }],
      PostCompact: [{ hooks: [async (...args) => current().postCompact(...args)] }],
      ...(toolHooksOf(agent).after.length === 0
        ? {}
        : { PostToolUse: [{ hooks: [async (...args) => current().postToolUse(...args)] }] }),
    }
    const canUseTool: NonNullable<Options["canUseTool"]> = async (...args) => current().canUseTool(...args)
    const mcpServers =
      own.size === 0
        ? {}
        : {
            nisse: createSdkMcpServer({
              name: "nisse",
              tools: [...own.values()].map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputSchema: z.fromJSONSchema(tool.parameters as z.core.JSONSchema.JSONSchema),
                handler: async (input: unknown, extra: unknown) => current().runOwn(tool.name)(input, extra),
              })),
            }),
          }
    const settingSources: SettingSource[] = ["user", "project", "local"]
    const env = {
      ...claudeEnvironment(settings.env),
      NISSE_ROOT_CONVERSATION: config.rootConversation,
      CLAUDE_AGENT_SDK_CLIENT_APP: "nisse",
    }
    const toolSearch = yield* toolSearchSettings(agent.cwd, settingSources, env)
    const messages = query({
      prompt: inbox,
      options: {
        ...(agent.cwd === undefined ? {} : { cwd: agent.cwd }),
        abortController: controller,
        includePartialMessages: true,
        canUseTool,
        hooks,
        mcpServers,
        ...(withheld.length === 0 ? {} : { disallowedTools: withheld }),
        settingSources,
        // Claude Code's own idle compaction would compact with no run to commit its summary; nisse's does it (D7).
        settings: { ...toolSearch, idleCompaction: false },
        extraArgs: { ...extraArgs(settings.args ?? []), "replay-user-messages": null },
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          ...(agent.instructions === undefined ? {} : { append: agent.instructions }),
        },
        env,
        ...(modelId === "" ? {} : { model: modelId }),
        ...(effort === undefined ? {} : { effort: effort as EffortLevel }),
        ...(agent.maxTurns === undefined ? {} : { maxTurns: agent.maxTurns }),
        ...(start._tag === "fresh"
          ? { sessionId: start.session, ...(start.title === undefined ? {} : { title: start.title }) }
          : {}),
        ...(start._tag === "resume" ? { resume: start.session, resumeSessionAt: start.at } : {}),
        ...(start._tag === "fork"
          ? { resume: start.from, resumeSessionAt: start.at, forkSession: true, sessionId: start.session }
          : {}),
        pathToClaudeCodeExecutable: settings.executable ?? bundledExecutable(),
      },
    })

    const send = (parts: ReadonlyArray<Said>, priority?: "next") => {
      const message = userMessage(parts, priority)
      awaitingReplay.add(message.uuid!)
      inbox.push(message)
      return message.uuid!
    }

    /** What each model spent since the previous result; a total that went down started over, as after `/clear`. */
    const spent = (modelUsage: ModelUsage) => {
      const before = totals ?? {}
      const now: Record<string, UsageTotals> = {}
      for (const [model, usage] of Object.entries(modelUsage)) {
        now[model] = {
          input: usage.inputTokens,
          output: usage.outputTokens,
          cacheRead: usage.cacheReadInputTokens,
          cacheWrite: usage.cacheCreationInputTokens,
          cost: usage.costUSD,
        }
      }
      const added: Array<readonly [string, Usage]> = []
      for (const [model, total] of Object.entries(now)) {
        const previous = before[model]
        const continues =
          previous !== undefined &&
          (["input", "output", "cacheRead", "cacheWrite", "cost"] as const).every((key) => total[key] >= previous[key])
        const base = continues ? previous : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
        added.push([
          model,
          {
            input: total.input - base.input,
            output: total.output - base.output,
            cacheRead: total.cacheRead - base.cacheRead,
            cacheWrite: total.cacheWrite - base.cacheWrite,
            totalTokens:
              total.input +
              total.output +
              total.cacheRead +
              total.cacheWrite -
              (base.input + base.output + base.cacheRead + base.cacheWrite),
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: total.cost - base.cost },
          },
        ])
      }
      totals = now
      return added
    }

    const view: ServingProcess = {
      get session() {
        return session
      },
      get resetting() {
        return resetting
      },
      get awaitingReplay() {
        return awaitingReplay.size > 0
      },
      own,
      send,
      stopTask: (taskId) => messages.stopTask(taskId),
      serially: (effect) => serial.withPermits(1)(effect),
      spent,
    }

    const iterator = messages[Symbol.asyncIterator]()
    /** The next frame, or how the process ended: `done`, with the error its end raised if it raised one. */
    const read = () =>
      iterator.next().then(
        (result) => result,
        (error: unknown) => ({ done: true as const, value: error }),
      )
    /** The next frame, which stays first in `ahead` until it arrived, so a reader interrupted while it waits loses none. */
    const pull = Effect.gen(function* () {
      if (ahead.length === 0) ahead.push(read())
      const next = yield* Effect.promise(() => ahead[0]!)
      ahead.shift()
      return next
    })
    const exited = Effect.gen(function* () {
      for (;;) {
        const next = read()
        ahead.push(next)
        if ((yield* Effect.promise(() => next)).done) return
      }
    })

    /** Tracks Claude Code's tasks, which end the process when its run ends with one still working (D6). */
    const track = (message: SDKMessage) => {
      if (message.type === "stream_event") return observeRequest(message)
      if (message.type !== "system") return
      if (message.subtype === "task_started") tasks.add(message.task_id)
      else if (message.subtype === "task_notification") tasks.delete(message.task_id)
      else if (
        message.subtype === "task_updated" &&
        ["completed", "failed", "killed"].includes(message.patch.status!)
      ) {
        tasks.delete(message.task_id)
      }
    }

    const canSelect = (wanted: Selection) =>
      (wanted.modelId !== "" || selected.modelId === "") &&
      (wanted.effort !== undefined || selected.effort === undefined)

    /** Switches Claude Code to `wanted`, which `canSelect` allows; the model first, as an effort may depend on it. */
    const select = (wanted: Selection) =>
      Effect.tryPromise(async () => {
        if (wanted.modelId !== selected.modelId) {
          await messages.setModel(wanted.modelId)
          selected = { ...selected, modelId: wanted.modelId }
        }
        if (wanted.effort !== selected.effort) {
          await messages.applyFlagSettings({ effortLevel: wanted.effort! })
          selected = { ...selected, effort: wanted.effort }
        }
      })

    /**
     * What every frame tells the process, whether or not a run is served: its session, its tasks and its replays.
     * Returns whether the frame is for the run: a replay of a message nisse sent is not.
     */
    const observe = (message: SDKMessage) => {
      track(message)
      if (resetting && "session_id" in message && message.session_id && message.session_id !== session) {
        session = message.session_id
        resetting = false
      }
      if (message.type === "user" && "isReplay" in message && message.isReplay) {
        awaitingReplay.delete(message.uuid)
        return false
      }
      // `/clear`: the session goes on under the id the next frames carry (F13).
      if (message.type === "conversation_reset") resetting = true
      return true
    }

    /** Keeps the cache facts of each main-loop request from the usage its response starts with (F13). */
    const observeRequest = (message: Extract<SDKMessage, { type: "stream_event" }>) => {
      if (message.parent_tool_use_id !== null || message.event.type !== "message_start") return
      const usage = message.event.message.usage
      const written = usage.cache_creation
      const ttl =
        (written?.ephemeral_1h_input_tokens ?? 0) > 0
          ? "1h"
          : (written?.ephemeral_5m_input_tokens ?? 0) > 0
            ? "5m"
            : lastRequest?.ttl
      lastRequest = {
        at: clock.currentTimeMillisUnsafe(),
        context: usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
        ttl,
      }
    }

    const serve = (run: RunContext, opening: ReadonlyArray<Said>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const now = makeServing(run, view)
          serving = served = now
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              serving = undefined
            }),
          )
          const switched = yield* Effect.result(select(selectionOf(run.agent)))
          // Nothing of the run reached Claude Code yet, so a process that cannot switch costs a cold start.
          if (switched._tag === "Failure") {
            return {
              _tag: "exited",
              message: `Claude Code did not switch its model or effort: ${String(switched.failure)}`,
            } as const
          }
          const opened = send(opening)
          for (;;) {
            const next = yield* pull
            if (next.done) {
              const error = next.value
              const message =
                error === undefined
                  ? "Claude Code exited before the turn finished"
                  : `Claude Code stopped: ${error instanceof Error ? error.message : String(error)}`
              // Claude Code never took the opening, so nothing of the run reached it.
              return awaitingReplay.has(opened) ? ({ _tag: "exited", message } as const) : failure(message)
            }
            const message = next.value
            const ended = yield* serial.withPermits(1)(
              Effect.suspend(() => (observe(message) ? now.handle(message) : Effect.succeed(undefined))),
            )
            if (ended !== undefined) return ended
          }
        }),
      )

    const stop = (within: Duration.Input) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => messages.interrupt().catch(() => undefined))
        for (;;) {
          const next = yield* pull
          if (next.done) return false
          observe(next.value)
          if (next.value.type === "result") return awaitingReplay.size === 0 && tasks.size === 0
        }
      }).pipe(
        Effect.timeoutOption(within),
        Effect.map(Option.getOrElse(() => false)),
        Effect.tap(() => served?.end ?? Effect.void),
      )

    return {
      serve,
      canSelect,
      stop,
      get busy() {
        return tasks.size > 0
      },
      exited,
      get lastRequest() {
        return lastRequest
      },
    } satisfies ClaudeProcess
  })
