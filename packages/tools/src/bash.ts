// `bash` and `powershell`. Derived from pi-durable's `src/tools/bash.ts` (earendil-works/pi, packages/durable, commit
// 7d073328e), under the MIT license in this package's LICENSE (Copyright 2025 Mario Zechner).
import type { ExecutionError, ShellExecResult } from "@sigma/env"
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@sigma/env/truncate"
import { defineTool, type ToolExecutionApi, type ToolExecutionResult } from "@sigma/harness"
import { bool, num, obj, opt, type Static, str } from "@sigma/schema"
import { Effect, Exit } from "effect"
import { requireEnv } from "./environment.ts"

const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000

// Open objects, as the tools accepted extra arguments when their schemas were TypeBox's.
const bashSchema = obj(
  {
    command: str({ description: "Bash command to execute" }),
    timeout: opt(num({ description: "Timeout in seconds (optional, no default timeout)" })),
  },
  { open: true },
)

const powershellSchema = obj(
  {
    command: str({ description: "PowerShell command to execute" }),
    timeout: opt(num({ description: "Timeout in seconds (optional, no default timeout)" })),
  },
  { open: true },
)

/** What a program that calls `bash` or `powershell` receives. */
const shellStructuredOutputSchema = obj(
  {
    output: str({ description: "Combined stdout and stderr: the retained tail, as the model sees it" }),
    truncated: bool({ description: "Whether earlier output was dropped" }),
    fullOutputPath: opt(str({ description: "File with the complete output, when it was spilled" })),
    exitCode: num(),
  },
  { open: true },
)

export type BashToolInput = Static<typeof bashSchema>
export type PowerShellToolInput = Static<typeof powershellSchema>
export type ShellStructuredOutput = Static<typeof shellStructuredOutputSchema>

/** A command about to run, which `prepare` may change: the script, its working directory and environment. */
export interface BashExecution {
  command: string
  cwd: string
  env: Record<string, string>
  inheritEnv: boolean
}

export type BashPrepare = (execution: BashExecution, api: ToolExecutionApi) => Effect.Effect<void, unknown>

export interface BashToolOptions {
  /** Lines run before each command. */
  commandPrefix?: string
  prepare?: BashPrepare
}

export interface PowerShellToolOptions extends BashToolOptions {
  /** PowerShell programs to try in order; default `pwsh`, then `powershell`. A program that cannot start is skipped. */
  programs?: readonly string[]
}

const validateTimeout = (timeout: number | undefined): Effect.Effect<void, Error> => {
  if (timeout === undefined) return Effect.void
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return Effect.fail(new Error("Invalid timeout: must be a finite number of seconds"))
  }
  if (timeout > MAX_TIMEOUT_SECONDS) {
    return Effect.fail(new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`))
  }
  return Effect.void
}

/** The execution of one call: the command with its prefix, in the environment's working directory, then `prepare`. */
const prepareExecution = (command: string, options: BashToolOptions | undefined, api: ToolExecutionApi) =>
  Effect.gen(function* () {
    const execution: BashExecution = {
      command: options?.commandPrefix ? `${options.commandPrefix}\n${command}` : command,
      cwd: (yield* requireEnv(api)).cwd,
      env: {},
      inheritEnv: true,
    }
    if (options?.prepare !== undefined) yield* options.prepare(execution, api)
    return execution
  })

/**
 * Runs each command form in turn until one starts, streaming output to `api.output()` within the retained window, and
 * turns the result into the tool's result: a spill diagnostic, an error result for a nonzero exit, and a failure for a
 * timeout. The structured output repeats the retained output with the exit code.
 */
const runCommand = (
  commands: readonly (string | readonly string[])[],
  execution: BashExecution,
  timeout: number | undefined,
  api: ToolExecutionApi,
) =>
  Effect.gen(function* () {
    const env = yield* requireEnv(api)
    let exit: Exit.Exit<ShellExecResult, ExecutionError> | undefined
    for (const command of commands) {
      exit = yield* Effect.exit(
        env.exec(command, {
          cwd: execution.cwd,
          env: execution.env,
          inheritEnv: execution.inheritEnv,
          ...(timeout === undefined ? {} : { timeout }),
          onOutput: (text, info) => api.output(text, info.skipped),
          spill: { afterBytes: DEFAULT_MAX_BYTES, afterLines: DEFAULT_MAX_LINES },
          // An environment may then omit output outside the retained tail and report the omission.
          ...(api.outputWindow === undefined ? {} : { window: api.outputWindow }),
        }),
      )
      // A program that could not start produced no output; the next form may.
      if (Exit.isSuccess(exit) || spawnFailed(exit) === false) break
    }
    if (exit === undefined) return yield* Effect.fail(new Error("No command to run"))
    if (Exit.isFailure(exit)) {
      const error = failure(exit)
      if (error === undefined) return yield* exit
      if (error.spillPath !== undefined) spilled(api, error.spillPath)
      if (error.code === "timeout") return yield* Effect.fail(new Error(`Command timed out after ${timeout} seconds`))
      if (error.code === "aborted") return yield* Effect.fail(new Error("Command aborted"))
      return yield* Effect.fail(error)
    }
    const { exitCode, spillPath } = exit.value
    if (spillPath !== undefined) spilled(api, spillPath)
    const retained = api.retainedOutput()
    const structuredOutput: ShellStructuredOutput = {
      output: retained.text,
      truncated: retained.truncated,
      ...(spillPath === undefined ? {} : { fullOutputPath: spillPath }),
      exitCode,
    }
    if (exitCode === 0) return { structuredOutput } satisfies ToolExecutionResult
    return {
      structuredOutput,
      isError: true,
      diagnostics: [{ severity: "error", code: "exit_code", message: `Command exited with code ${exitCode}` }],
    } satisfies ToolExecutionResult
  })

const failure = (exit: Exit.Failure<unknown, ExecutionError>): ExecutionError | undefined => {
  const reason = exit.cause.reasons[0]
  return reason?._tag === "Fail" ? reason.error : undefined
}

const spawnFailed = (exit: Exit.Exit<unknown, ExecutionError>) =>
  Exit.isFailure(exit) && failure(exit)?.code === "spawn_error"

const spilled = (api: ToolExecutionApi, path: string) =>
  api.diagnostic({ severity: "info", code: "full_output", message: `Full output: ${path}` })

/**
 * Runs a command through the environment's shell. Its output streams to `api.output()`, where the Harness keeps the
 * tail within the default limits; the result content is that retained output. The retained window goes to the
 * environment, which may omit output outside it and report how much it omitted, so dropped counts stay exact. Output
 * beyond the limits is spilled to a file whose path is reported as a diagnostic. A nonzero exit is an error result with
 * the exit code; a timeout fails, which makes an error result that still carries the output and diagnostics. Programs
 * get `{ output, truncated, fullOutputPath?, exitCode }`.
 */
export function createBashTool(options?: BashToolOptions) {
  return defineTool({
    name: "bash",
    description: `Execute a bash command in the current working directory. Returns combined stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
    parameters: bashSchema,
    structuredOutputSchema: shellStructuredOutputSchema,
    outputLimits: { retain: "tail" },
    execute: (args: BashToolInput, api: ToolExecutionApi) =>
      Effect.gen(function* () {
        yield* validateTimeout(args.timeout)
        const execution = yield* prepareExecution(args.command, options, api)
        return yield* runCommand([execution.command], execution, args.timeout, api)
      }),
  })
}

/** Output in UTF-8 whatever the console's code page, as the coding agent's `powershell` tool does. */
const UTF8_OUTPUT = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}"
const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"] as const

/**
 * Runs a PowerShell command, like `bash` but through PowerShell instead of the environment's shell: `pwsh` (PowerShell
 * 7), else Windows PowerShell, started directly with the command as an argument, so no other shell parses it.
 */
export function createPowerShellTool(options?: PowerShellToolOptions) {
  const programs = options?.programs ?? ["pwsh", "powershell"]
  return defineTool({
    name: "powershell",
    description: `Execute a PowerShell command in the current working directory. Returns combined stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
    parameters: powershellSchema,
    structuredOutputSchema: shellStructuredOutputSchema,
    outputLimits: { retain: "tail" },
    execute: (args: PowerShellToolInput, api: ToolExecutionApi) =>
      Effect.gen(function* () {
        yield* validateTimeout(args.timeout)
        const execution = yield* prepareExecution(args.command, options, api)
        const script = `${UTF8_OUTPUT}\n${execution.command}`
        const commands = programs.map((program) => [program, ...POWERSHELL_ARGS, script])
        return yield* runCommand(commands, execution, args.timeout, api)
      }),
  })
}
