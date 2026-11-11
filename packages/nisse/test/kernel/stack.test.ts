// The `nisse` binary on the kernel (NISSE_KERNEL=1), over its socket: stop, kill, restart.
import { afterEach, expect, test } from "bun:test"
import { KERNEL_PROTOCOL_VERSION } from "@nisse/wire"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { FakeClaude } from "../support/claude.ts"
import { deadline, RawClient } from "../support/raw.ts"
import {
  kernelEnv,
  runEnds,
  servingKernel,
  settled,
  start,
  submit,
  transcript,
  type ViewWatch,
  watchView,
} from "../support/kernel.ts"
import { homeAt } from "../../src/home.ts"
import { tempHome } from "../support/server.ts"
import { nisse, stopServer } from "../support/terminal.ts"

const homes: Array<ReturnType<typeof tempHome>> = []
const home = () => {
  const created = tempHome()
  homes.push(created)
  return created
}

afterEach(async () => {
  for (const created of homes.splice(0)) {
    await stopServer(created)
    rmSync(created.dir, { recursive: true, force: true })
  }
})

/** A process's CPU time in seconds, user and system, to the hundredth. */
const cpuSeconds = (pid: number) => {
  if (process.platform === "linux") {
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")
    return (Number(fields[11]) + Number(fields[12])) / 100
  }
  const out = Bun.spawnSync(["ps", "-o", "time=", "-p", String(pid)])
    .stdout.toString()
    .trim()
  const [minutes, seconds] = out.split(":")
  return Number(minutes) * 60 + Number(seconds)
}

test("server-stop: nisse serve on the kernel answers server/stop, then exits 0", async () => {
  const nisseHome = home()
  const server = await servingKernel(await kernelEnv(nisseHome))
  const client = await RawClient.connect(nisseHome.socket)
  expect(await client.call("server/stop", null)).toMatchObject({ result: null })
  expect(await deadline(server.exited, 5000, "server exit")).toBe(0)
  client.close()
})

test("crash-committed: a run cut off by a crashed server is answered once after the server comes back", async () => {
  const nisseHome = home()
  const env = await kernelEnv(nisseHome, [{ text: "one two three four five six seven eight nine ten", delayMs: 100 }])
  const first = await servingKernel(env)
  let client = await RawClient.connect(nisseHome.socket)
  const conversation = await start(client)
  const before = watchView(client, conversation)
  await submit(client, conversation, "count")
  await before.until((watch) => {
    const live = watch.view().docs["pi.live"] as { generation?: { message?: unknown } } | undefined
    return live?.generation?.message !== undefined
  })
  first.kill("SIGKILL")
  await first.exited
  client.close()

  await servingKernel(env)
  client = await RawClient.connect(nisseHome.socket)
  const after = watchView(client, conversation)
  await after.until(settled(1), 20_000)
  // What was said before the crash stays, cut off; the run then answers once.
  const said = transcript(after.view().entries)
  expect(said).toHaveLength(4)
  expect(said[0]).toBe("user: count")
  expect(said[1]).toMatch(/^assistant: one .*\[aborted\]$/)
  expect(said.slice(2)).toEqual(["assistant: one two three four five six seven eight nine ten", "run_end: answered"])
  client.close()
}, 30_000)

test("idle-server: a server on the kernel with no run in flight uses no CPU", async () => {
  const nisseHome = home()
  const server = await servingKernel(await kernelEnv(nisseHome, [{ text: "done" }]))
  const client = await RawClient.connect(nisseHome.socket)
  const conversation = await start(client)
  const view = watchView(client, conversation)
  await submit(client, conversation, "hi")
  await view.until(settled(1))
  // A watching client stays connected: an open view costs nothing while nothing commits. The second after an answer
  // still settles (measured: 0.01 s in it, then 0.00 or 0.01 s in each of the next nine), so the measure starts after.
  await Bun.sleep(1000)
  const before = cpuSeconds(server.pid)
  await Bun.sleep(3000)
  // The measuring tick is a hundredth of a second; two ticks in three seconds is flat.
  expect(Math.round((cpuSeconds(server.pid) - before) * 100)).toBeLessThanOrEqual(2)
  client.close()
}, 20_000)

test("server-old-home: a home the shipping server used starts on the kernel and keeps its database as it was", async () => {
  const nisseHome = home()
  writeFileSync(nisseHome.database, "the shipping server's store")
  await servingKernel(await kernelEnv(nisseHome))
  const client = await RawClient.connect(nisseHome.socket)
  await start(client)
  expect(readFileSync(nisseHome.database, "utf8")).toBe("the shipping server's store")
  expect(existsSync(nisseHome.kernel)).toBe(true)
  client.close()
})

test("wire-schema: nisse schema --kernel prints the kernel wire's schema, the one committed beside the code", async () => {
  const printed = nisse(["schema", "--kernel"], await kernelEnv(home()))
  const [code, stdout] = await Promise.all([printed.exited, new Response(printed.stdout).text()])
  expect(code).toBe(0)
  const schema = JSON.parse(stdout)
  expect(schema).toMatchObject({ title: "Nisse kernel protocol", protocol: KERNEL_PROTOCOL_VERSION })
  expect(Object.keys(schema.methods)).toContain("conversation/watch")
  expect(stdout).toBe(readFileSync(join(import.meta.dir, "../../../../schema/nisse.kernel.schema.json"), "utf8"))
})

test("crash-limit, conversation-ended: a run that keeps crashing the server stops after three tries instead of looping, and the conversation list says why", async () => {
  const nisseHome = home()
  // The command says it started through one fifo, so the test kills the server only once the call runs, and waits
  // on another, which the test opens at its end so the orphaned commands exit with it.
  const fifo = join(nisseHome.dir, "started.fifo")
  const release = join(nisseHome.dir, "release.fifo")
  expect(Bun.spawnSync(["mkfifo", fifo, release]).exitCode).toBe(0)
  await using _released = { [Symbol.asyncDispose]: async () => closeSync(openSync(release, "r+")) }
  const env = await kernelEnv(nisseHome, [
    { tool: { name: "bash", input: { command: `echo ran > ${fifo}; cat ${release}` } } },
  ])
  let conversation: string | undefined
  for (let attempt = 1; attempt <= 3; attempt++) {
    const server = await servingKernel(env)
    const client = await RawClient.connect(nisseHome.socket)
    conversation ??= (await client.call("conversation/start", { cwd: nisseHome.dir, approvals: "auto" })).result
      .conversation as string
    if (attempt === 1) await submit(client, conversation, "go")
    // Each server's model calls again, after its call was cut off; kill the server while that call runs.
    expect(await deadline(readFile(fifo, "utf8"), 10_000, `call ${attempt} started`)).toBe("ran\n")
    server.kill("SIGKILL")
    await server.exited
    client.close()
  }
  await servingKernel(env)
  const client = await RawClient.connect(nisseHome.socket)
  const view = watchView(client, conversation!)
  await view.until(settled(1), 10_000)
  expect(runEnds(view.seen())).toEqual([
    { outcome: "restart_limit", message: "the server stopped during this run 3 times in a row" },
  ])
  expect(transcript(view.seen()).filter((line) => line.startsWith("assistant"))).toHaveLength(3)
  const listed = (await client.call("conversation/list")).result as Array<{ id: string; ended?: unknown }>
  expect(listed.find((item) => item.id === conversation)?.ended).toEqual({
    outcome: "restart_limit",
    message: "the server stopped during this run 3 times in a row",
  })
  client.close()
}, 60_000)

test("start-with-id: a conversation opened on a client's id survives a restart, and a second start with it is answered", async () => {
  const nisseHome = home()
  const env = await kernelEnv(nisseHome, [{ text: "noted" }])
  const id = crypto.randomUUID()
  const first = await servingKernel(env)
  let client = await RawClient.connect(nisseHome.socket)
  expect((await client.call("conversation/start", { id, cwd: nisseHome.dir })).result).toEqual({
    conversation: id,
    model: { provider: "script", model: "script" },
  })
  const before = watchView(client, id)
  await submit(client, id, "remember")
  await before.until(settled(1))
  first.kill("SIGKILL")
  await first.exited
  client.close()

  await servingKernel(env)
  client = await RawClient.connect(nisseHome.socket)
  expect((await client.call("conversation/start", { id, cwd: "/elsewhere" })).result).toEqual({
    conversation: id,
    model: { provider: "script", model: "script" },
  })
  const after = watchView(client, id)
  await after.until(() => true)
  expect(transcript(after.view().entries)).toEqual(["user: remember", "assistant: noted", "run_end: answered"])
  expect((after.view().docs["pi.agent"] as { cwd?: string }).cwd).toBe(nisseHome.dir)
  client.close()
}, 30_000)

test("extensions-load: a home named relative to the folder nisse serves from loads its extensions, listed by full path", async () => {
  const folder = home()
  const relative = homeAt(join(folder.dir, "h1"))
  homes.unshift(relative)
  mkdirSync(relative.extensions, { recursive: true })
  writeFileSync(
    join(relative.extensions, "clock.ts"),
    `import { Extension } from "@nisse/extension"
import { Effect } from "effect"
export default Extension.define(() => Effect.void)
`,
  )
  const env = { ...(await kernelEnv(relative)), NISSE_HOME: "h1" }
  const server = await servingKernel(env, folder.dir)
  const client = await RawClient.connect(relative.socket)
  expect((await client.call("extensions/list")).result).toEqual([
    { name: "clock", path: `${relative.extensions}/clock.ts`, state: "loaded" },
  ])
  client.close()
  await stopServer(relative)
  expect(await deadline(server.exited, 5000, "server exit")).toBe(0)
})

test("reload: a server on the kernel refuses to start on a config.toml that does not read, and says why", async () => {
  const nisseHome = home()
  await Bun.write(`${nisseHome.dir}/config.toml`, "[extensions.guard\n")
  const server = nisse(["serve"], await kernelEnv(nisseHome))
  expect(await deadline(server.exited, 10_000, "server exit")).toBe(1)
  expect(await new Response(server.stderr).text()).toContain(`${nisseHome.dir}/config.toml`)
})

/** A conversation on the script's code-mode model, whose calls run without asking. */
const codeModeConversation = async (client: RawClient, cwd: string) =>
  (await client.call("conversation/start", { cwd, approvals: "auto", model: "script-code-mode" })).result
    .conversation as string

/** The text of the conversation's `codemode` result. */
const codemodeResult = (entries: ReadonlyArray<{ kind: string; model?: ReadonlyArray<unknown> }>) =>
  entries.flatMap((entry) => {
    const message = entry.model?.[0] as { role?: string; toolName?: string; content?: Array<any> } | undefined
    return message?.role === "toolResult" && message.toolName === "codemode"
      ? [message.content!.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")]
      : []
  })

test("codemode-replay: a script whose server is killed during a nested call resumes in a new server without running its finished calls again", async () => {
  const nisseHome = home()
  const fifo = join(nisseHome.dir, "started.fifo")
  const release = join(nisseHome.dir, "release.fifo")
  const log = join(nisseHome.dir, "calls.log")
  expect(Bun.spawnSync(["mkfifo", fifo, release]).exitCode).toBe(0)
  // Opened at the end, so the call the kill orphaned exits with the test.
  await using _released = { [Symbol.asyncDispose]: async () => closeSync(openSync(release, "r+")) }
  const code = [
    `await tools.bash({ command: "echo first >> ${log}" })`,
    `try { await tools.bash({ command: "echo ran > ${fifo}; cat ${release}" }) } catch (error) { text("second: " + error.message) }`,
    `await tools.bash({ command: "echo third >> ${log}" })`,
  ].join("\n")
  const first = await servingKernel(await kernelEnv(nisseHome, [{ tool: { name: "codemode", input: { code } } }]))
  let client = await RawClient.connect(nisseHome.socket)
  const conversation = await codeModeConversation(client, nisseHome.dir)
  await submit(client, conversation, "go")
  expect(await deadline(readFile(fifo, "utf8"), 10_000, "the second call started")).toBe("ran\n")
  first.kill("SIGKILL")
  await first.exited
  client.close()

  // A script's steps start over in a new process: the restarted model answers the script's result.
  await servingKernel(await kernelEnv(nisseHome, [{ text: "done" }]))
  client = await RawClient.connect(nisseHome.socket)
  const view = watchView(client, conversation)
  await view.until(settled(1), 20_000)
  // The first call ran once, before the kill; the cut-off call is not run again, and the script went on after it.
  expect(readFileSync(log, "utf8")).toBe("first\nthird\n")
  const [result] = codemodeResult(view.seen())
  expect(result).toStartWith("Script completed")
  expect(result).toContain("second: ")
  expect(transcript(view.seen()).slice(-2)).toEqual(["assistant: done", "run_end: answered"])
  client.close()
}, 40_000)

test("codemode-stop: a script stuck in a long built-in stops when its run is interrupted, and the server then exits at once", async () => {
  const nisseHome = home()
  // A naive search QuickJS runs without checking for an interrupt: about 40 s on an M-series Mac (receipt: half the
  // string took 19 s after its abort). A worker in it survives `terminate()` (F19).
  const code = [
    `await tools.bash({ command: "true" })`,
    `const haystack = "a".repeat(1 << 23)`,
    `text(haystack.indexOf("a".repeat(1 << 12) + "b"))`,
  ].join("\n")
  const server = await servingKernel(await kernelEnv(nisseHome, [{ tool: { name: "codemode", input: { code } } }]))
  const client = await RawClient.connect(nisseHome.socket)
  const conversation = await codeModeConversation(client, nisseHome.dir)
  const view = watchView(client, conversation)
  await view.until(() => true)
  await submit(client, conversation, "go")
  const live = (current: ViewWatch) =>
    current.view().docs["pi.live"] as { nestedTools?: Array<{ status: string }> } | undefined
  await view.until((current) => live(current)?.nestedTools?.some((slot) => slot.status === "done") === true, 10_000)
  // Nothing is committed once the worker enters the search, and interrupting it before then lets the worker end
  // cleanly, which proves nothing (measured: 5 of 5 runs passed without serve's exit). The server's CPU is the one
  // sign that the worker is inside: an idle server spends at most 0.02 s in a second (the idle-server test above).
  const before = cpuSeconds(server.pid)
  await deadline(
    (async () => {
      while (cpuSeconds(server.pid) - before < 0.3) await Bun.sleep(50)
    })(),
    20_000,
    "the script searching",
  )
  // Interrupting the run stops the script without waiting for its worker, which goes on searching.
  await client.call("conversation/interrupt", { conversation })
  await view.until(settled(1), 5000)
  // With the run ended the server stops, and its process ends though the worker still searches.
  expect(await client.call("server/stop", null)).toMatchObject({ result: null })
  expect(await deadline(server.exited, 5000, "server exit")).toBe(0)
  client.close()
}, 45_000)

test("provider-default: a conversation that names no provider and has no default model starts on Claude, or on the scripted provider when NISSE_MODEL_SCRIPT is set", async () => {
  for (const [script, provider] of [
    [true, "script"],
    [false, "claude"],
  ] as const) {
    const nisseHome = home()
    const env = await kernelEnv(nisseHome)
    const server = await servingKernel(script ? env : { ...env, NISSE_MODEL_SCRIPT: undefined })
    const client = await RawClient.connect(nisseHome.socket)
    const started = await client.call("conversation/start", { cwd: nisseHome.dir })
    expect(started.result.model.provider).toBe(provider)
    await client.call("server/stop", null)
    expect(await deadline(server.exited, 5000, "server exit")).toBe(0)
    client.close()
  }
})

test("crash-claude-settled: a Claude Code answer committed before the server was killed is not run again", async () => {
  using claude = new FakeClaude("crash_points")
  const nisseHome = home()
  const env = { ...(await kernelEnv(nisseHome)), ...claude.options.env }
  const prompt =
    "First write one short sentence saying that you will read the notes. Then use the Read tool to read notes.txt. Then reply with where the gnome lives, in three words."
  const first = await servingKernel(env)
  let client = await RawClient.connect(nisseHome.socket)
  const conversation = (
    await client.call("conversation/start", { cwd: nisseHome.dir, provider: "claude", approvals: "auto" })
  ).result.conversation as string
  const before = watchView(client, conversation)
  await submit(client, conversation, prompt)
  await before.until(settled(1), 20_000)
  first.kill("SIGKILL")
  await first.exited
  client.close()

  await servingKernel(env)
  client = await RawClient.connect(nisseHome.socket)
  const after = watchView(client, conversation)
  await after.until(() => true)
  expect(transcript(after.view().entries)).toEqual(transcript(before.view().entries))
  expect(transcript(after.view().entries).slice(-2)).toEqual(["assistant: Under the floor.", "run_end: answered"])
  expect(claude.spawns()).toHaveLength(1)
  client.close()
}, 30_000)
