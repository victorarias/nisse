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
  USER: "ada",
  TERM: "xterm-256color",
  ...extra,
})

export const nisse = (args: Array<string>, env: Record<string, string | undefined>) =>
  Bun.spawn(["bun", MAIN, ...args], { env, cwd: env.NISSE_HOME!, stdout: "pipe", stderr: "pipe" })

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
  const waitFor = (predicate: (screen: string) => boolean, ms = 10_000) =>
    deadline(
      new Promise<string>((resolve) => {
        const check = () => {
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
  }
}
