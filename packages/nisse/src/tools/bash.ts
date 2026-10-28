import { Effect, Schema } from "effect"
import { tool } from "./tool.ts"

const OUTPUT_LIMIT = 16 * 1024
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const OUTPUT_GRACE_MS = 1000

class Tail {
  private kept = ""
  private cut = 0

  push(text: string) {
    this.kept += text
    if (this.kept.length > 2 * OUTPUT_LIMIT) this.trim()
  }

  private trim() {
    const excess = Math.max(0, this.kept.length - OUTPUT_LIMIT)
    this.kept = this.kept.slice(excess)
    this.cut += excess
  }

  text() {
    this.trim()
    return this.cut === 0 ? this.kept : `[${this.cut} characters cut]\n${this.kept}`
  }
}

const killGroup = (pid: number) => {
  try {
    process.kill(-pid, "SIGKILL")
  } catch {}
}

export const Bash = tool({
  name: "Bash",
  description:
    "Run a command with `sh -c` in the working directory, with no terminal and no stdin. Returns when the shell exits, with stdout and stderr interleaved, keeping the last 16 KiB; processes started in the background with `&` keep running. If the shell is still running after `timeout`, it and every process it started are killed.",
  readOnly: false,
  input: Schema.Struct({
    command: Schema.String.annotate({ description: "The shell command to run." }),
    timeout: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_TIMEOUT_MS })).annotate({
        description: "Milliseconds before the command is killed. Default 120000.",
      }),
    ),
  }),
  run: (input, context) =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        Bun.spawn(["sh", "-c", input.command], {
          cwd: context.cwd,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          detached: true,
        }),
      ),
      (child) =>
        Effect.callback<{ output: string; error: boolean }>((resume) => {
          const tail = new Tail()
          const decoder = new TextDecoder()
          const timeout = input.timeout ?? DEFAULT_TIMEOUT_MS
          let timedOut = false
          const pump = async (stream: ReadableStream<Uint8Array>) => {
            for await (const chunk of stream) {
              const text = decoder.decode(chunk, { stream: true })
              tail.push(text)
              Effect.runFork(context.output(text))
            }
          }
          const pumped = Promise.all([pump(child.stdout), pump(child.stderr)]).catch(() => undefined)
          const timer = setTimeout(() => {
            timedOut = true
            killGroup(child.pid)
          }, timeout)
          void child.exited.then(async (code) => {
            clearTimeout(timer)
            await Promise.race([pumped, Bun.sleep(OUTPUT_GRACE_MS)])
            let output = tail.text()
            if (timedOut) output += `\n[timed out after ${timeout} ms; the command and its processes were killed]`
            resume(Effect.succeed({ output, error: timedOut || code !== 0 }))
          })
        }),
      (child, exit) => Effect.sync(() => (exit._tag === "Failure" ? killGroup(child.pid) : undefined)),
    ),
})
