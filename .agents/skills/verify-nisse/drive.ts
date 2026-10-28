#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import * as Net from "node:net"

const REPO = resolve(import.meta.dir, "../../..")
const MAIN = join(REPO, "packages/nisse/src/main.ts")
const ROOT = "/tmp/nisse-verify"
const COLS = "100"
const ROWS = "30"

const usage = `usage: drive.ts <run> <command> [args]

  up [--script steps.json]         make the run's home and evidence folders
  doctor                           is this run's instance worth driving?
  nisse <args...>                  run the nisse CLI against the run's home
  serve                            start the run's server in the foreground of a tmux window
  kill-server                      SIGKILL the server that holds the run's home lock
  rpc <method> [params-json]       one raw JSON-RPC call over the run's socket
  watch <conversation> [--since N] [--submit TEXT] [--until TAG] [--timeout MS] [--save NAME]
                                   subscribe and print each delivery as one JSON line;
                                   --submit sends TEXT as ada once the first delivery arrives;
                                   without --until it returns after a second with no delivery
  watch-auth [--until PHASE] [--timeout MS] [--save NAME]
                                   follow every sign-in and print each state as one JSON line;
                                   --until returns once a state reaches PHASE, such as waiting
  idle [--seconds N]               measure the TUI's and server's CPU time over N seconds (10)
  tui start [nisse args...]        open the TUI in a ${COLS}x${ROWS} tmux pane
  tui type <text>                  type literal text into the TUI
  tui key <key...>                 press tmux keys: Enter, Escape, Tab, C-y, C-n, C-c, C-j, C-l, Up, Down, Left, Right
  tui wait <text> [--gone] [--timeout MS]
                                   wait until the screen shows (or stops showing) text
  tui screen [NAME]                print the screen; with NAME, save it as evidence
  tui stop                         press ^C, wait for the TUI to exit, print what it left in the terminal
  down                             stop everything this run started; keep the evidence`

const fail = (message: string): never => {
  console.error(message)
  process.exit(1)
}

const [run, command, ...args] = process.argv.slice(2)
if (!run || !command) fail(usage)
if (!/^[a-z0-9-]{1,24}$/.test(run!)) fail("run ids are 1-24 characters of a-z, 0-9 and -")

const dir = join(ROOT, run!)
const home = join(dir, "home")
const evidence = join(dir, "evidence")
const scriptPath = join(dir, "script.json")
const socket = join(home, "nisse.sock")
const lock = join(home, "nisse.lock")
const tmuxServer = `nisse-verify-${run}`

const env = (): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  NISSE_HOME: home,
  NISSE_MODEL_SCRIPT: existsSync(scriptPath) ? scriptPath : "",
  USER: "ada",
  TERM: "xterm-256color",
})

const record = (line: string) => {
  mkdirSync(evidence, { recursive: true })
  appendFileSync(join(evidence, "steps.log"), `${new Date().toISOString()} ${line}\n`)
}

const save = (name: string, content: string) => {
  const path = join(evidence, name)
  writeFileSync(path, content)
  record(`saved ${path}`)
  return path
}

const flag = (name: string) => {
  const at = args.indexOf(name)
  if (at < 0) return undefined
  const value = args[at + 1]
  args.splice(at, 2)
  return value
}

const switchOn = (name: string) => {
  const at = args.indexOf(name)
  if (at >= 0) args.splice(at, 1)
  return at >= 0
}

const requireUp = () => {
  if (!existsSync(home)) fail(`run ${run} is not up: drive.ts ${run} up`)
}

const sh = (cmd: Array<string>, options: { env?: Record<string, string> } = {}) => {
  const result = Bun.spawnSync(cmd, { env: options.env ?? env(), stdout: "pipe", stderr: "pipe" })
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

const tmux = (...rest: Array<string>) => sh(["tmux", "-L", tmuxServer, ...rest])

const TUI = "nisse:tui"

const tuiOpen = () => tmux("list-windows", "-t", "nisse", "-F", "#{window_name}").stdout.split("\n").includes("tui")

const lockOwner = () => {
  const pid = sh(["lsof", "-t", lock]).stdout.trim().split("\n")[0]
  if (!pid) return undefined
  return { pid: Number(pid), command: sh(["ps", "-o", "command=", "-p", pid]).stdout.trim() }
}

interface Reply {
  readonly result?: unknown
  readonly error?: unknown
}

const connect = () => {
  if (!existsSync(socket)) fail(`no server listens on ${socket}: drive.ts ${run} serve`)
  return new Promise<Net.Socket>((resolveSocket, reject) => {
    const client = Net.connect(socket)
    client.once("error", reject)
    client.once("connect", () => resolveSocket(client))
  })
}

const lines = (client: Net.Socket, onMessage: (message: any) => void) => {
  let buffer = ""
  client.setEncoding("utf8")
  client.on("data", (data: string) => {
    buffer += data
    let newline: number
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line) onMessage(JSON.parse(line))
    }
  })
}

const call = async (method: string, params?: unknown, ms = 5000): Promise<Reply> => {
  const client = await connect()
  try {
    return await new Promise<Reply>((resolveReply, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} got no reply in ${ms}ms`)), ms)
      lines(client, (message) => {
        if (message.id !== 1) return
        clearTimeout(timer)
        resolveReply(message)
      })
      client.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n")
    })
  } finally {
    client.destroy()
  }
}

const openWindow = (name: string, command: Array<string>) => {
  if (tmux("has-session", "-t", "nisse").code !== 0) {
    const session = tmux("-f", "/dev/null", "new-session", "-d", "-s", "nisse", "-n", "idle", "-x", COLS, "-y", ROWS)
    if (session.code !== 0) fail(`tmux could not start: ${session.stderr}`)
    tmux("set-option", "-g", "remain-on-exit", "on")
  }
  const window = tmux("new-window", "-d", "-t", "nisse", "-n", name, "-c", REPO, "--", ...command)
  if (window.code !== 0) fail(`tmux could not open ${name}: ${window.stderr}`)
  tmux("resize-window", "-t", `nisse:${name}`, "-x", COLS, "-y", ROWS)
}

const tuiPid = () => {
  if (!tuiOpen() || paneState().dead) return undefined
  return Number(tmux("display-message", "-p", "-t", TUI, "#{pane_pid}").stdout.trim())
}

const cpuSeconds = (pid: number) => {
  if (process.platform === "linux") {
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")
    return (Number(fields[11]) + Number(fields[12])) / 100
  }
  const [minutes, rest] = sh(["ps", "-o", "time=", "-p", String(pid)])
    .stdout.trim()
    .split(":")
  return Number(minutes) * 60 + Number(rest)
}

const screen = () => tmux("capture-pane", "-p", "-t", TUI).stdout

const paneState = () => {
  const [dead, status] = tmux("display-message", "-p", "-t", TUI, "#{pane_dead} #{pane_dead_status}")
    .stdout.trim()
    .split(" ")
  return { dead: dead === "1", status }
}

const until = async (check: () => boolean, ms: number) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await Bun.sleep(100)
  }
  return check()
}

const commands: Record<string, () => Promise<void> | void> = {
  up: () => {
    const script = flag("--script")
    mkdirSync(home, { recursive: true, mode: 0o700 })
    mkdirSync(evidence, { recursive: true })
    if (script) writeFileSync(scriptPath, readFileSync(script))
    record(`up home=${home}${script ? ` script=${script}` : ""}`)
    console.log(`home     ${home}\nevidence ${evidence}\nscript   ${existsSync(scriptPath) ? scriptPath : "echo"}`)
  },

  doctor: async () => {
    requireUp()
    const problems: Array<string> = []
    if (resolve(home) === resolve(join(homedir(), ".nisse"))) problems.push("home is the production ~/.nisse")
    const commit = sh(["git", "-C", REPO, "rev-parse", "--short", "HEAD"]).stdout.trim()
    const dirty = sh(["git", "-C", REPO, "status", "--porcelain"]).stdout.trim() !== ""
    console.log(`checkout ${REPO} ${commit}${dirty ? " (uncommitted changes)" : ""}`)
    console.log(`home     ${home}`)
    console.log(`script   ${existsSync(scriptPath) ? scriptPath : "none: nisse echoes"}`)
    const owner = lockOwner()
    if (!owner) console.log("server   none running (exec or the TUI starts one)")
    else {
      console.log(`server   pid ${owner.pid}: ${owner.command}`)
      if (!owner.command.includes(MAIN)) problems.push(`the server does not run this checkout's ${MAIN}`)
      const reply = await call("initialize", { client: "verify-nisse", version: "0", protocol: 0 }).catch(
        (error: Error): Reply => ({ error: error.message }),
      )
      if (reply.error) problems.push(`initialize failed: ${JSON.stringify(reply.error)}`)
      else console.log(`protocol ${JSON.stringify(reply.result)}`)
    }
    for (const tool of ["tmux", "lsof"]) if (sh(["which", tool]).code !== 0) problems.push(`${tool} is not installed`)
    if (tuiOpen()) {
      const pane = paneState()
      const pid = tmux("display-message", "-p", "-t", TUI, "#{pane_pid}").stdout.trim()
      console.log(`tui      ${pane.dead ? `exited with ${pane.status}` : `running, pid ${pid}`}`)
    }
    if (problems.length > 0) fail(`not fit to drive:\n- ${problems.join("\n- ")}`)
    console.log("ok")
  },

  nisse: async () => {
    requireUp()
    const line = `nisse ${args.join(" ")}`
    record(line)
    const child = Bun.spawn([MAIN, ...args], { env: env(), stdout: "pipe", stderr: "pipe", cwd: REPO })
    process.stdout.write(`$ ${line}\n--- stdout\n`)
    let stdout = ""
    const decoder = new TextDecoder()
    const streamed = (async () => {
      for await (const chunk of child.stdout) {
        const text = decoder.decode(chunk, { stream: true })
        stdout += text
        process.stdout.write(text)
      }
    })()
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), streamed])
    const tail = `--- stderr\n${stderr}--- exit ${code}\n`
    process.stdout.write(tail)
    const n = readFileSync(join(evidence, "steps.log"), "utf8").split("\n").length
    save(`${String(n).padStart(3, "0")}-nisse.txt`, `$ ${line}\n--- stdout\n${stdout}${tail}`)
  },

  idle: async () => {
    requireUp()
    const seconds = Number(flag("--seconds") ?? 10)
    const watched = [
      { name: "tui", pid: tuiPid() },
      { name: "server", pid: lockOwner()?.pid },
    ].filter((each): each is { name: string; pid: number } => each.pid !== undefined)
    if (watched.length === 0) fail("neither a TUI nor a server is running in this run")
    const before = watched.map((each) => cpuSeconds(each.pid))
    await Bun.sleep(seconds * 1000)
    const report = watched
      .map(
        (each, i) =>
          `${each.name} pid ${each.pid}: ${(cpuSeconds(each.pid) - before[i]!).toFixed(2)}s CPU in ${seconds}s`,
      )
      .join("\n")
    save("idle.txt", report + "\n")
    console.log(report)
  },

  serve: async () => {
    requireUp()
    if (lockOwner()) fail(`a server already holds ${lock}`)
    openWindow("serve", [MAIN, "serve"])
    record("serve")
    if (!(await until(() => existsSync(socket) && lockOwner() !== undefined, 10_000)))
      fail(`the server did not take ${lock} in 10s:\n${tmux("capture-pane", "-p", "-t", "serve").stdout}`)
    console.log(`serving, pid ${lockOwner()!.pid}`)
  },

  "kill-server": async () => {
    requireUp()
    const owner = lockOwner() ?? fail("no server holds this run's home lock")
    if (!owner.command.includes(MAIN)) fail(`refusing to kill pid ${owner.pid}, which is not this checkout's nisse`)
    process.kill(owner.pid, "SIGKILL")
    record(`kill-server SIGKILL pid ${owner.pid}`)
    if (!(await until(() => lockOwner()?.pid !== owner.pid, 5000))) fail(`pid ${owner.pid} still holds the lock`)
    console.log(`killed ${owner.pid}`)
  },

  rpc: async () => {
    requireUp()
    const [method, params] = args
    if (!method) fail(usage)
    record(`rpc ${method} ${params ?? ""}`)
    const reply = await call(method!, params ? JSON.parse(params) : undefined)
    console.log(JSON.stringify(reply, null, 2))
    if (reply.error) process.exit(1)
  },

  watch: async () => {
    requireUp()
    const since = flag("--since")
    const untilTag = flag("--until")
    const ms = Number(flag("--timeout") ?? 10_000)
    const name = flag("--save")
    const submit = flag("--submit")
    const [conversation] = args
    if (!conversation) fail(usage)
    record(
      `watch ${conversation}${since ? ` since ${since}` : ""}${submit ? ` submit ${JSON.stringify(submit)}` : ""}${untilTag ? ` until ${untilTag}` : ""}`,
    )
    const out: Array<string> = []
    const client = await connect()
    const done = Promise.withResolvers<boolean>()
    let quiet: ReturnType<typeof setTimeout> | undefined
    const settleAfterQuiet = () => {
      if (untilTag !== undefined) return
      clearTimeout(quiet)
      quiet = setTimeout(() => done.resolve(true), 1000)
    }
    let snapshot = since === undefined
    let submitted = submit === undefined
    lines(client, (message) => {
      if (message.id === 2) {
        out.push(JSON.stringify(message))
        return console.log(out.at(-1))
      }
      if (message.id !== 1) return
      if (!message.chunk) {
        out.push(JSON.stringify(message))
        console.log(out.at(-1))
        return done.resolve(untilTag === undefined)
      }
      for (const delivery of message.result) {
        out.push(JSON.stringify(delivery))
        console.log(out.at(-1))
        const tags = (delivery.entries ?? []).map((entry: any) => entry.body?._tag)
        if (!snapshot && untilTag && tags.includes(untilTag)) done.resolve(true)
        snapshot = false
      }
      settleAfterQuiet()
      if (!submitted) {
        submitted = true
        const params = { conversation, requestId: crypto.randomUUID(), author: "ada", text: submit }
        client.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "conversation/submit", params }) + "\n")
      }
      client.write(JSON.stringify({ jsonrpc: "2.0", method: "@effect/rpc/Ack", params: { requestId: 1 } }) + "\n")
    })
    client.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "conversation/subscribe",
        params: { conversation, ...(since ? { sinceSeq: Number(since) } : {}) },
      }) + "\n",
    )
    const timer = setTimeout(() => done.resolve(untilTag === undefined), ms)
    const met = await done.promise
    clearTimeout(timer)
    clearTimeout(quiet)
    client.destroy()
    if (name) save(`${name}.ndjson`, out.join("\n") + "\n")
    if (!met) fail(`no ${untilTag} entry arrived in ${ms}ms`)
  },

  "watch-auth": async () => {
    requireUp()
    const untilPhase = flag("--until")
    const ms = Number(flag("--timeout") ?? 10_000)
    const name = flag("--save")
    record(`watch-auth${untilPhase ? ` until ${untilPhase}` : ""}`)
    const out: Array<string> = []
    const client = await connect()
    const done = Promise.withResolvers<boolean>()
    let quiet: ReturnType<typeof setTimeout> | undefined
    const settleAfterQuiet = () => {
      if (untilPhase !== undefined) return
      clearTimeout(quiet)
      quiet = setTimeout(() => done.resolve(true), 1000)
    }
    settleAfterQuiet()
    lines(client, (message) => {
      if (message.id !== 1) return
      if (!message.chunk) {
        out.push(JSON.stringify(message))
        console.log(out.at(-1))
        return done.resolve(untilPhase === undefined)
      }
      for (const state of message.result) {
        out.push(JSON.stringify(state))
        console.log(out.at(-1))
        if (state.phase === untilPhase) done.resolve(true)
      }
      settleAfterQuiet()
      client.write(JSON.stringify({ jsonrpc: "2.0", method: "@effect/rpc/Ack", params: { requestId: 1 } }) + "\n")
    })
    client.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "auth/watch" }) + "\n")
    const timer = setTimeout(() => done.resolve(untilPhase === undefined), ms)
    const met = await done.promise
    clearTimeout(timer)
    clearTimeout(quiet)
    client.destroy()
    if (name) save(`${name}.ndjson`, out.join("\n") + "\n")
    if (!met) fail(`no ${untilPhase} sign-in state arrived in ${ms}ms`)
  },

  tui: async () => {
    requireUp()
    const [sub, ...rest] = args
    args.splice(0, 1)
    switch (sub) {
      case "start": {
        if (tuiOpen()) fail("a TUI is already open in this run: tui stop first")
        openWindow("tui", [MAIN, ...rest])
        record(`tui start ${rest.join(" ")}`)
        console.log("opened; wait for READY with: tui wait READY")
        return
      }
      case "type":
        tmux("send-keys", "-t", TUI, "-l", rest.join(" "))
        record(`tui type ${JSON.stringify(rest.join(" "))}`)
        return
      case "key":
        tmux("send-keys", "-t", TUI, ...rest)
        record(`tui key ${rest.join(" ")}`)
        return
      case "wait": {
        const ms = Number(flag("--timeout") ?? 10_000)
        const gone = switchOn("--gone")
        const text = args.join(" ")
        const met = await until(() => screen().includes(text) !== gone, ms)
        record(`tui wait ${gone ? "gone " : ""}${JSON.stringify(text)} ${met ? "met" : "timed out"}`)
        if (!met) fail(`timed out after ${ms}ms waiting for ${gone ? "no " : ""}${JSON.stringify(text)}:\n${screen()}`)
        return
      }
      case "screen": {
        const current = screen()
        if (rest[0]) save(`${rest[0]}.screen.txt`, current)
        process.stdout.write(current)
        return
      }
      case "stop": {
        tmux("send-keys", "-t", TUI, "C-c")
        record("tui stop")
        if (!(await until(() => paneState().dead, 10_000))) fail(`the TUI did not exit on ^C:\n${screen()}`)
        const last = tmux("capture-pane", "-p", "-S", "-", "-t", TUI).stdout.trim()
        save("tui-exit.screen.txt", last)
        console.log(`${last}\n[exited ${paneState().status}]`)
        tmux("kill-window", "-t", TUI)
        return
      }
      default:
        fail(usage)
    }
  },

  down: async () => {
    if (!existsSync(dir)) return console.log(`run ${run} has nothing to stop`)
    const tui = tuiPid()
    if (tui !== undefined) {
      tmux("send-keys", "-t", TUI, "C-c")
      if (!(await until(() => paneState().dead, 5000))) process.kill(tui, "SIGKILL")
    }
    tmux("kill-server")
    if (existsSync(socket)) await call("server/stop", undefined, 15_000).catch(() => undefined)
    const owner = lockOwner()
    if (owner?.command.includes(MAIN)) process.kill(owner.pid, "SIGKILL")
    record("down")
    rmSync(home, { recursive: true, force: true })
    rmSync(scriptPath, { force: true })
    console.log(`stopped; evidence kept in ${evidence}`)
  },
}

const handler = commands[command!] ?? fail(usage)
await handler()
