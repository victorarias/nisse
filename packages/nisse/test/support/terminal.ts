import { Terminal } from "@xterm/headless"
import { join } from "node:path"
import { deadline, RawClient } from "./raw.ts"
import type { tempHome } from "./server.ts"

const MAIN = join(import.meta.dir, "../../src/main.ts")
const COLS = 100
const ROWS = 30

export const nisseEnv = (home: ReturnType<typeof tempHome>, extra: Record<string, string> = {}) => ({
  ...process.env,
  NISSE_HOME: home.dir,
  NISSE_MODEL_SCRIPT: "",
  NISSE_CLAUDE: join(import.meta.dir, "fake-claude"),
  FAKE_CLAUDE_FIXTURE: join(import.meta.dir, "../../../../fixtures/claude/models.ndjson"),
  FAKE_CLAUDE_DIR: join(home.dir, "fake-claude"),
  USER: "ada",
  TERM: "xterm-256color",
  ...extra,
})

export const nisse = (args: Array<string>, env: Record<string, string | undefined>, cwd = env.NISSE_HOME!) =>
  Bun.spawn(["bun", MAIN, ...args], { env, cwd, stdout: "pipe", stderr: "pipe" })

export const stopServer = async (home: ReturnType<typeof tempHome>) => {
  const client = await RawClient.connect(home.socket).catch(() => undefined)
  if (!client) return
  await client.call("server/stop").catch(() => undefined)
  client.close()
}

export const screenSession = (args: Array<string>, env: Record<string, string | undefined>) => {
  const terminal = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true })
  let output = ""
  const changed = new Set<() => void>()
  const process = Bun.spawn(["bun", MAIN, ...args], {
    env,
    cwd: env.NISSE_HOME!,
    terminal: {
      cols: COLS,
      rows: ROWS,
      data: (_terminal, data) => {
        output += new TextDecoder().decode(data)
        terminal.write(data, () => {
          for (const check of changed) check()
        })
      },
    },
  })
  const screen = () => {
    const buffer = terminal.buffer.active
    return Array.from({ length: ROWS }, (_, row) => buffer.getLine(row)?.translateToString(true) ?? "").join("\n")
  }
  // A tripwire for a TUI that stopped drawing: at load ~50 on 10 cores the slowest of 317 waits took 5.2 s. The suite's
  // 30 s test timeout stays the larger, so a hang shows its screen.
  const waitFor = (predicate: (screen: string) => boolean, ms = 20_000) =>
    deadline(
      new Promise<string>((resolve) => {
        const check = () => {
          // A frame can arrive in several writes; a person sees only the finished one.
          if (terminal.modes.synchronizedOutputMode) return
          const current = screen()
          if (!predicate(current)) return
          changed.delete(check)
          resolve(current)
        }
        changed.add(check)
        check()
      }),
      ms,
      "screen condition",
    ).catch((error) => {
      throw new Error(`${error.message}\n${screen()}`)
    })
  return {
    screen,
    waitFor,
    output: () => output,
    type: (text: string) => process.terminal!.write(text),
    exited: process.exited,
    kill: () => process.kill(),
    hangUp: () => process.kill("SIGHUP"),
    /** Stops the TUI reading anything, as a frozen terminal does, until `resume`. */
    pause: () => process.kill("SIGSTOP"),
    resume: () => process.kill("SIGCONT"),
    pid: process.pid,
  }
}
