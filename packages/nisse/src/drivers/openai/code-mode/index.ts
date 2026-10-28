import type { CallId } from "@nisse/protocol"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { Effect, Fiber, FiberSet, Queue } from "effect"
import type { Call, Turn } from "../../../provider.ts"
import { failed, interrupted, type Tool, type ToolOutcome } from "../../../tools/tool.ts"
import { Host, NoRunningCell, type Delegated, type HostConnection, type Runtime } from "./host.ts"
import { definition, nestedCall, nestedTools, section } from "./nested.ts"

export const EXEC = "exec"
export const WAIT = "wait"
export const CELL = "cell"
export const HOST_PROGRAM = "codex-code-mode-host"
export const HOST_IDLE_MS = 300_000
const DEFAULT_YIELD_TIME_MS = 10_000
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000
const BYTES_PER_TOKEN = 4
const PRAGMA = "// @exec:"

export { Host }

const EXEC_GRAMMAR = `
start: pragma_source | plain_source
pragma_source: PRAGMA_LINE NEWLINE SOURCE
plain_source: SOURCE

PRAGMA_LINE: /[ \\t]*\\/\\/ @exec:[^\\r\\n]*/
NEWLINE: /\\r?\\n/
SOURCE: /[\\s\\S]+/
`

const EXEC_DESCRIPTION = `Run JavaScript code to orchestrate/compose tool calls
- Evaluates the provided JavaScript code in a fresh V8 isolate as an async module.
- All nested tools are available on the global \`tools\` object, for example \`await tools.{{ first_tool }}(...)\`. Tool names are exposed as normalized JavaScript identifiers.
- Nested tool methods take either a string or an object as their input argument.
- Nested tools return either an object or a string, based on the description.
- Runs raw JavaScript -- no Node, no file system, no network access, no console.
- Accepts raw JavaScript source text, not JSON, quoted strings, or markdown code fences.
- You may optionally start the tool input with a first-line pragma like \`// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}\`.
- \`yield_time_ms\` asks \`exec\` to yield early if the script is still running. Defaults to 10000 ms.
- \`max_output_tokens\` sets the token budget for direct \`exec\` results. Defaults to 10000 tokens.
- When the JS code is fully evaluated, the isolate's lifetime ends and unawaited promises are silently discarded.

- Global helpers:
- \`exit()\`: Immediately ends the current script successfully (like an early return from the top level).
- \`text(value: string | number | boolean | undefined | null)\`: Appends a text item. Non-string values are stringified with \`JSON.stringify(...)\` when possible.
- \`store(key: string, value: any)\`: stores a serializable value under a string key for later \`exec\` calls in the same session.
- \`load(key: string)\`: returns the stored value for a string key, or \`undefined\` if it is missing.
- \`setTimeout(callback: () => void, delayMs?: number)\`: schedules a callback to run later and returns a timeout id. Pending timeouts do not keep \`exec\` alive by themselves; await an explicit promise if you need to wait for one.
- \`clearTimeout(timeoutId?: number)\`: cancels a timeout created by \`setTimeout\`.
- \`ALL_TOOLS\`: metadata for the enabled nested tools as \`{ name, description }\` entries.
- \`yield_control()\`: yields the accumulated output to the model immediately while the script keeps running.`

const WAIT_DESCRIPTION = `Waits on a yielded \`exec\` cell and returns new output or completion.
- Use \`wait\` only after \`exec\` returns \`Script running with cell ID ...\`.
- \`cell_id\` identifies the running \`exec\` cell to resume.
- \`yield_time_ms\` controls how long to wait for more output before yielding again. Defaults to 10000 ms.
- \`max_tokens\` limits how much new output this wait call returns. Defaults to 10000 tokens.
- \`terminate: true\` stops the running cell; false or omitted waits for output.
- \`wait\` returns only the new output since the last yield, or the final completion or termination result for that cell.
- If the cell is still running, \`wait\` may yield again with the same \`cell_id\`.
- If the cell has already finished, \`wait\` returns the completed result and closes the cell.`

export const codeModeTools = (tools: ReadonlyArray<Tool>): ReadonlyArray<unknown> => [
  {
    type: "custom",
    name: EXEC,
    description: [
      EXEC_DESCRIPTION.replace("{{ first_tool }}", nestedTools(tools)[0]?.spec.name ?? "name"),
      ...nestedTools(tools).map(section),
    ].join("\n\n"),
    format: { type: "grammar", syntax: "lark", definition: EXEC_GRAMMAR },
  },
  {
    type: "function",
    name: WAIT,
    description: WAIT_DESCRIPTION,
    strict: false,
    parameters: {
      type: "object",
      properties: {
        cell_id: { type: "string", description: "Identifier of the running exec cell." },
        yield_time_ms: { type: "number", description: "Wait before yielding more output. Defaults to 10000 ms." },
        max_tokens: {
          type: "number",
          description: "Output token budget for this wait call. Defaults to 10000 tokens.",
        },
        terminate: {
          type: "boolean",
          description: "True stops the running exec cell; false or omitted waits for output.",
        },
      },
      required: ["cell_id"],
      additionalProperties: false,
    },
  },
]

export const installedHost = (given: string | undefined, home: string): string | undefined => {
  if (given !== undefined) return existsSync(given) ? given : undefined
  const owned = join(home, "bin", HOST_PROGRAM)
  return existsSync(owned) ? owned : (Bun.which(HOST_PROGRAM) ?? undefined)
}

export const missingHost = `this model works in code mode, which needs Codex's ${HOST_PROGRAM}; install it with scripts/code-mode-host.sh, or point NISSE_CODE_MODE_HOST at it`

const parsePragma = (input: string) => {
  const newline = input.indexOf("\n")
  const [first, rest] = newline === -1 ? [input, ""] : [input.slice(0, newline), input.slice(newline + 1)]
  const trimmed = first.trimStart()
  if (!trimmed.startsWith(PRAGMA)) return { source: input, yieldTimeMs: undefined, maxOutputTokens: undefined }
  if (rest.trim() === "") return { error: "exec pragma must be followed by JavaScript source on subsequent lines" }
  try {
    const pragma = JSON.parse(trimmed.slice(PRAGMA.length).trim())
    if (typeof pragma !== "object" || pragma === null || Array.isArray(pragma)) throw new Error("not an object")
    return {
      source: rest,
      yieldTimeMs: typeof pragma.yield_time_ms === "number" ? pragma.yield_time_ms : undefined,
      maxOutputTokens: typeof pragma.max_output_tokens === "number" ? pragma.max_output_tokens : undefined,
    }
  } catch (error) {
    return {
      error: `exec pragma must be a JSON object with \`yield_time_ms\` and \`max_output_tokens\`: ${(error as Error).message}`,
    }
  }
}

const withinBudget = (text: string, maxTokens: number) => {
  const bytes = Buffer.from(text)
  const budget = maxTokens * BYTES_PER_TOKEN
  if (bytes.length <= budget) return text
  const head = new TextDecoder().decode(bytes.subarray(0, Math.floor(budget / 2))).replace(/�$/, "")
  const tail = new TextDecoder().decode(bytes.subarray(bytes.length - Math.floor(budget / 2))).replace(/^�/, "")
  const cut = Math.floor((bytes.length - Buffer.byteLength(head) - Buffer.byteLength(tail)) / BYTES_PER_TOKEN)
  return `Warning: truncated output (original token count: ${Math.floor(bytes.length / BYTES_PER_TOKEN)})\n${head}…${cut} tokens truncated…${tail}`
}

export const isScriptReport = (output: string) => output.startsWith("Script ")

const errorOf = (runtime: Runtime) => (runtime.state === "Result" ? (runtime.error_text ?? undefined) : undefined)

const statusOf = (runtime: Runtime) =>
  runtime.state === "Yielded"
    ? `Script running with cell ID ${runtime.cell_id}`
    : runtime.state === "Terminated"
      ? "Script terminated"
      : errorOf(runtime) === undefined
        ? "Script completed"
        : "Script failed"

const answered = (runtime: Runtime, startedAt: number, maxTokens: number | undefined): ToolOutcome => {
  const error = errorOf(runtime)
  const status = statusOf(runtime)
  const items = runtime.content_items.map((item) =>
    typeof item.text === "string" ? item.text : `[${item.type ?? "item"} omitted]`,
  )
  if (error !== undefined) items.push(`Script error:\n${error}`)
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
  return {
    output: `${status}\nWall time ${seconds} seconds\nOutput:\n${withinBudget(items.join("\n"), maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS)}`,
    error: error !== undefined,
  }
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const codeModeRun = Effect.fnUntraced(function* (host: Host, program: string, turn: Turn) {
  const conversation = turn.conversation.id
  const tools = nestedTools(turn.tools)
  let starting: CallId | undefined

  const delegated = yield* Queue.unbounded<Delegated>()
  const nested = yield* FiberSet.make()
  const cells = new Set<CallId>()

  const answerNested = (call: Delegated) =>
    Effect.gen(function* () {
      const parent = (call.script as CallId | undefined) ?? starting
      if (parent === undefined) return call.answer({ error: "no exec call started this cell" })
      const resolved = nestedCall(tools, call.tool, call.input)
      if ("error" in resolved) return call.answer({ error: resolved.error })
      const outcome = yield* turn.runTool(
        {
          call: `${parent}/${call.runtimeCallId}` as CallId,
          tool: resolved.tool.spec.name,
          input: resolved.input,
          parent,
        },
        resolved.tool,
      )
      call.answer({ ok: { output: outcome.output, is_error: outcome.error } })
    }).pipe(
      Effect.onInterrupt(() => Effect.sync(() => call.answer({ error: "the run that started this script has ended" }))),
    )

  const nestedByScript = new Map<CallId, Set<Fiber.Fiber<unknown, unknown>>>()
  const answeredInScript = (call: Delegated) =>
    Effect.withFiber((fiber) => {
      const script = (call.script as CallId | undefined) ?? starting
      if (script === undefined) return answerNested(call)
      const inScript = nestedByScript.get(script) ?? new Set()
      nestedByScript.set(script, inScript.add(fiber))
      return Effect.ensuring(
        answerNested(call),
        Effect.sync(() => {
          inScript.delete(fiber)
          if (inScript.size === 0) nestedByScript.delete(script)
        }),
      )
    })
  const stopNested = (script: CallId) => Fiber.interruptAll([...(nestedByScript.get(script) ?? [])])

  const cellCall = (script: CallId) => `${script}/${CELL}` as CallId
  const startCell = (script: CallId) =>
    Effect.andThen(
      turn.recordCall({ call: cellCall(script), tool: CELL, input: { cell_id: script }, parent: script }),
      Effect.sync(() => cells.add(script)),
    )
  const endCell = (script: CallId, outcome: ToolOutcome) =>
    Effect.andThen(
      stopNested(script),
      Effect.suspend(() => (cells.delete(script) ? turn.recordResult(cellCall(script), outcome) : Effect.void)),
    )
  const hostGone = Effect.andThen(
    FiberSet.clear(nested),
    Effect.suspend(() => Effect.forEach([...cells], (script) => endCell(script, interrupted), { discard: true })),
  )
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      host.beginRun(conversation, {
        delegated: (call) => void Queue.offerUnsafe(delegated, call),
        hostStopped: () => void Effect.runFork(hostGone),
      }),
    ),
    () => Effect.sync(() => host.endRun(conversation)),
  )
  yield* Effect.forkScoped(
    Effect.forever(Effect.flatMap(Queue.take(delegated), (call) => FiberSet.run(nested, answeredInScript(call)))),
  )

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      const scripts = starting === undefined ? [...cells] : [...cells, starting]
      if (scripts.length === 0) return
      void host
        .session(program, conversation)
        .then((connection) => Promise.all(scripts.map((script) => connection.terminate(conversation, script))))
        .catch(() => undefined)
    }),
  )

  const outcomeOf = (
    script: CallId,
    tool: typeof EXEC | typeof WAIT,
    startedAt: number,
    maxTokens: number | undefined,
    ask: (connection: HostConnection) => Promise<Runtime>,
  ) =>
    Effect.gen(function* () {
      const connection = yield* Effect.result(Effect.tryPromise(() => host.session(program, conversation)))
      if (connection._tag === "Failure") return failed(errorText(connection.failure.cause))
      const runtime = yield* Effect.result(Effect.tryPromise(() => ask(connection.success)))
      if (runtime._tag === "Success") {
        const ran = runtime.success
        if (ran.state === "Yielded") {
          if (tool === EXEC) yield* startCell(script)
        } else if (tool === WAIT) yield* endCell(script, { output: statusOf(ran), error: errorOf(ran) !== undefined })
        else yield* stopNested(script)
        return answered(ran, startedAt, maxTokens)
      }
      if (runtime.failure.cause instanceof NoRunningCell) return failed(runtime.failure.cause.message)
      if (!connection.success.alive) yield* hostGone
      else if (tool === WAIT) yield* endCell(script, interrupted)
      else yield* stopNested(script)
      return failed(`interrupted: ${errorText(runtime.failure.cause)}; the script may or may not have taken effect`)
    })

  const exec = (call: Call, startedAt: number): Effect.Effect<ToolOutcome> => {
    if (typeof call.input !== "string" || call.input.trim() === "")
      return Effect.succeed(failed("exec expects raw JavaScript source text"))
    const pragma = parsePragma(call.input)
    if ("error" in pragma) return Effect.succeed(failed(pragma.error as string))
    return outcomeOf(call.call, EXEC, startedAt, pragma.maxOutputTokens, (connection) => {
      starting = call.call
      return connection
        .execute(conversation, call.call, {
          enabled_tools: tools.map(definition),
          source: pragma.source,
          yield_time_ms: pragma.yieldTimeMs ?? DEFAULT_YIELD_TIME_MS,
          max_output_tokens: pragma.maxOutputTokens ?? null,
        })
        .finally(() => (starting = undefined))
    })
  }

  const wait = (call: Call, startedAt: number): Effect.Effect<ToolOutcome> => {
    const args: any = call.input
    if (typeof args?.cell_id !== "string")
      return Effect.succeed(failed("bad arguments for wait: `cell_id` must be a string"))
    const maxTokens = typeof args.max_tokens === "number" ? args.max_tokens : undefined
    const script = args.cell_id as CallId
    return outcomeOf(script, WAIT, startedAt, maxTokens, (connection) =>
      args.terminate === true
        ? connection.terminate(conversation, args.cell_id)
        : connection.wait(
            conversation,
            args.cell_id,
            typeof args.yield_time_ms === "number" ? args.yield_time_ms : DEFAULT_YIELD_TIME_MS,
          ),
    )
  }

  return (call: Call) =>
    Effect.gen(function* () {
      const startedAt = Date.now()
      yield* turn.recordCall(call)
      const outcome =
        call.tool === EXEC
          ? yield* exec(call, startedAt)
          : call.tool === WAIT
            ? yield* wait(call, startedAt)
            : failed(`no tool named ${call.tool}`)
      yield* turn.recordResult(call.call, outcome)
      return outcome
    })
})
