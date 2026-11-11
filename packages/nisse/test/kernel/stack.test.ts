// The `nisse` binary on the kernel (NISSE_KERNEL=1): its commands, and its server over its socket: stop, kill, restart.
import { afterEach, expect, test } from "bun:test"
import { applyImmutable, type Op } from "@nisse/delta"
import { KERNEL_PROTOCOL_VERSION, type View, type ViewItem } from "@nisse/wire"
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

/** What a `nisse` command printed and how it exited. */
const finished = async (process: ReturnType<typeof nisse>) => {
  const [code, stdout, stderr] = await deadline(
    Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]),
    20_000,
    "nisse exited",
  )
  return { code, stdout, stderr }
}

/** The home's conversations, from a client of its running server. */
const conversationsOf = async (nisseHome: ReturnType<typeof home>) => {
  const client = await RawClient.connect(nisseHome.socket)
  const listed = (await client.call("conversation/list")).result as Array<{ id: string; model: unknown }>
  client.close()
  return listed
}

/** A conversation's transcript, read from the home's running server. */
const transcriptOf = async (nisseHome: ReturnType<typeof home>, conversation: string) => {
  const client = await RawClient.connect(nisseHome.socket)
  const view = watchView(client, conversation)
  await view.until(() => true)
  client.close()
  return transcript(view.view().entries)
}

test("mode-print, answer-exec, server-on-demand: nisse exec on the kernel starts a server, prints the answer and exits 0", async () => {
  const nisseHome = home()
  const result = await finished(nisse(["exec", "hello there"], await kernelEnv(nisseHome)))
  expect(result).toMatchObject({ code: 0, stdout: "You said: hello there\n" })
  const [conversation] = await conversationsOf(nisseHome)
  expect(await transcriptOf(nisseHome, conversation!.id)).toEqual([
    "user: hello there",
    "assistant: You said: hello there",
    "run_end: answered",
  ])
}, 30_000)

test("mode-print, answer-exec-fail: nisse exec on the kernel exits 1 and says why when the run fails", async () => {
  const env = await kernelEnv(home(), [{ text: "half an ", fail: "provider went away" }])
  const result = await finished(nisse(["exec", "go"], env))
  // What was said before the failure stays on stdout.
  expect(result).toMatchObject({ code: 1, stdout: "half an \n" })
  expect(result.stderr).toContain("provider went away")
}, 30_000)

test("answer-exec-fail: nisse exec on the kernel exits 1 when an interrupt withdraws its queued prompt, instead of waiting for good", async () => {
  const nisseHome = home()
  const env = await kernelEnv(nisseHome, [{ text: "one two three four five six seven eight nine ten", delayMs: 300 }])
  await servingKernel(env)
  const client = await RawClient.connect(nisseHome.socket)
  await client.call("conversation/start", { id: "shared", cwd: nisseHome.dir })
  const view = watchView(client, "shared")
  await view.until(() => true)
  await submit(client, "shared", "count")
  const exec = nisse(["exec", "-c", "shared", "second"], env)
  const inbox = (watch: ViewWatch) => (watch.view().docs["pi.inbox"] as { items: Array<unknown> }).items
  await view.until((watch) => inbox(watch).length === 1, 10_000)
  await client.call("conversation/interrupt", { conversation: "shared" })
  const result = await finished(exec)
  expect(result).toMatchObject({ code: 1, stdout: "" })
  expect(result.stderr).toContain("the prompt was withdrawn before it ran")
  client.close()
}, 30_000)

test("mode-json, exec-json: nisse exec --json prints the view, then each commit's changes, until the run ends", async () => {
  const nisseHome = home()
  const result = await finished(nisse(["exec", "--json", "hello there"], await kernelEnv(nisseHome)))
  expect(result.code).toBe(0)
  const items = result.stdout
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as ViewItem)
  expect(items[0]!._tag).toBe("view")
  expect(items.slice(1).every((item) => item._tag === "change")).toBe(true)
  // A client applying each line in turn holds the conversation's view, ending with the answer.
  let view: View | undefined
  for (const item of items) view = item._tag === "view" ? item.view : applyImmutable(view, item.ops as Array<Op>)
  expect(transcript(view!.entries)).toEqual([
    "user: hello there",
    "assistant: You said: hello there",
    "run_end: answered",
  ])
  const [conversation] = await conversationsOf(nisseHome)
  expect(await transcriptOf(nisseHome, conversation!.id)).toEqual(transcript(view!.entries))
}, 30_000)

test("approval-exec-deny: nisse exec on the kernel shows its calls and, without --auto, denies the ones that would change things", async () => {
  const nisseHome = home()
  const env = await kernelEnv(nisseHome, [
    { tool: { name: "bash", input: { command: "echo ran" } } },
    { text: "could not run it" },
    { tool: { name: "bash", input: { command: "echo ran" } } },
    { text: "ran it" },
  ])
  const denied = await finished(nisse(["exec", "run something"], env))
  expect(denied).toMatchObject({ code: 0, stdout: "could not run it\n" })
  expect(denied.stderr).toContain("› bash(echo ran)")
  expect(denied.stderr).toContain("denied bash(echo ran): exec cannot ask, pass --auto to allow calls")
  const allowed = await finished(nisse(["exec", "--auto", "run something"], env))
  expect(allowed).toMatchObject({ code: 0, stdout: "ran it\n" })
  expect(allowed.stderr).toContain("› bash(echo ran)")
  expect(allowed.stderr).not.toContain("denied")
}, 30_000)

test("subagent-exec: nisse exec on the kernel without --auto denies the calls its subagents would ask about too", async () => {
  const env = await kernelEnv(home(), [
    { tool: { name: "spawn_agent", input: { task_name: "kid", message: "go" } } },
    { tool: { name: "wait_agent", input: { timeout_ms: 600_000 } } },
    { text: "the kid is done" },
    { agent: "/root/kid", tool: { name: "bash", input: { command: "echo ran" } } },
    { agent: "/root/kid", text: "could not run it" },
  ])
  const result = await finished(nisse(["exec", "delegate"], env))
  expect(result).toMatchObject({ code: 0, stdout: "the kid is done\n" })
  expect(result.stderr).toContain("denied bash(echo ran): exec cannot ask")
}, 30_000)

const DECLINE =
  "Run the bash command `touch declined.txt` with the Bash tool. If it is not allowed, reply with exactly: declined"
const MAKE = "Run the bash command `touch made.txt` with the Bash tool, then reply with exactly: made"

test("claude-exec-deny: nisse exec on the kernel refuses Claude's calls that would ask", async () => {
  using claude = new FakeClaude("bash_declined")
  const nisseHome = home()
  const env = { ...(await kernelEnv(nisseHome)), ...claude.options.env }
  const result = await finished(nisse(["exec", "--provider", "claude", DECLINE], env))
  expect(result).toMatchObject({ code: 0, stdout: "declined\n" })
  expect(result.stderr).toContain("› Bash(touch declined.txt)")
  expect(result.stderr).toContain("denied Bash(touch declined.txt): exec cannot ask, pass --auto to allow calls")
  expect(JSON.stringify(claude.log())).toContain('"behavior":"deny"')
}, 30_000)

test("claude-exec-deny, claude-auto: nisse exec --auto on the kernel lets Claude's calls run without asking", async () => {
  using claude = new FakeClaude("bash_allowed")
  const env = { ...(await kernelEnv(home())), ...claude.options.env }
  const result = await finished(nisse(["exec", "--provider", "claude", "--auto", MAKE], env))
  expect(result).toMatchObject({ code: 0, stdout: "made\n" })
  expect(result.stderr).toContain("› Bash(touch made.txt)")
  expect(result.stderr).not.toContain("denied")
  expect(JSON.stringify(claude.log())).toContain('"behavior":"allow"')
}, 30_000)

test("chosen-id: nisse exec --conversation on the kernel starts a conversation with an id it does not name yet, and continues it", async () => {
  const nisseHome = home()
  const env = await kernelEnv(nisseHome)
  expect(await finished(nisse(["exec", "--conversation", "picked-1", "first words"], env))).toMatchObject({
    code: 0,
    stdout: "You said: first words\n",
  })
  expect(await finished(nisse(["exec", "-c", "picked-1", "again"], env))).toMatchObject({
    code: 0,
    stdout: "You said: again\n",
  })
  expect((await conversationsOf(nisseHome)).map((conversation) => conversation.id)).toEqual(["picked-1"])
  expect(await transcriptOf(nisseHome, "picked-1")).toEqual([
    "user: first words",
    "assistant: You said: first words",
    "run_end: answered",
    "user: again",
    "assistant: You said: again",
    "run_end: answered",
  ])
}, 30_000)

test("reopen-continue: nisse exec --conversation on the kernel continues a conversation by the number it was given", async () => {
  const nisseHome = home()
  const env = await kernelEnv(nisseHome)
  expect(await finished(nisse(["exec", "first"], env))).toMatchObject({ code: 0, stdout: "You said: first\n" })
  const { id } = (await conversationsOf(nisseHome))[0]!
  expect(id).toMatch(/^[0-9]+$/)
  expect(await finished(nisse(["exec", "-c", id, "again"], env))).toMatchObject({
    code: 0,
    stdout: "You said: again\n",
  })
  expect(await transcriptOf(nisseHome, id)).toEqual([
    "user: first",
    "assistant: You said: first",
    "run_end: answered",
    "user: again",
    "assistant: You said: again",
    "run_end: answered",
  ])
}, 30_000)

test("provider-choose, model-flags: nisse exec on the kernel starts on the provider, model and effort it names", async () => {
  const nisseHome = home()
  const env = await kernelEnv(nisseHome)
  const args = ["exec", "--provider", "script", "--model", "script", "--effort", "low", "hi"]
  expect(await finished(nisse(args, env))).toMatchObject({ code: 0, stdout: "You said: hi\n" })
  expect((await conversationsOf(nisseHome))[0]!.model).toEqual({ provider: "script", model: "script", effort: "low" })
}, 30_000)

test("provider-unknown, model-flags: nisse exec on the kernel refuses a provider or an effort nisse does not have", async () => {
  const env = await kernelEnv(home())
  expect(await finished(nisse(["exec", "--provider", "nope", "hi"], env))).toMatchObject({
    code: 1,
    stdout: "",
    stderr: "nisse has no provider named nope\n",
  })
  const effort = await finished(nisse(["exec", "--effort", "lots", "hi"], env))
  expect(effort).toMatchObject({ code: 1, stdout: "" })
  expect(effort.stderr).toStartWith("nisse knows no effort named lots; it knows minimal, ")
}, 30_000)

test("provider-config-invalid: nisse exec on the kernel says why the server it started refused the home's config.toml", async () => {
  const nisseHome = home()
  await Bun.write(`${nisseHome.dir}/config.toml`, '[providers.gem]\ndriver = "gemini"\n')
  const result = await finished(nisse(["exec", "hi"], await kernelEnv(nisseHome)))
  expect(result).toMatchObject({ code: 1, stdout: "" })
  expect(result.stderr).toContain(`${nisseHome.dir}/config.toml`)
  expect(result.stderr).toContain("driver")
}, 30_000)

test("provider-binary: nisse exec on the kernel runs a Claude provider's binary from config.toml, with its env and args", async () => {
  using claude = new FakeClaude("text")
  const nisseHome = home()
  const { executable, env: fake } = claude.options
  const table = Object.entries(fake!)
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
    .join(", ")
  await Bun.write(
    `${nisseHome.dir}/config.toml`,
    `[providers.claude-alt]\ndriver = "claude"\nbinary = ${JSON.stringify(executable)}\nenv = { ${table} }\nargs = ["--add-dir", "/tmp"]\n`,
  )
  const env = { ...(await kernelEnv(nisseHome)), NISSE_CLAUDE: join(nisseHome.dir, "no-claude") }
  const result = await finished(nisse(["exec", "--provider", "claude-alt", "Reply with exactly: fixture text ok"], env))
  expect(result).toMatchObject({ code: 0, stdout: "fixture text ok\n" })
  // The run's spawn adds the provider's args; the probe, which asks Claude nothing, does not.
  const spawn = claude.log().find((entry) => entry.argv && entry.probe === undefined)
  expect(spawn.argv.join(" ")).toContain("--add-dir /tmp")
}, 30_000)

test("server-restart: nisse serve --restart on the kernel replaces the running server once its run settles", async () => {
  const nisseHome = home()
  // About 2.4 s of answer, so the stop arrives while the run works.
  const env = await kernelEnv(nisseHome, [{ text: "one two three four five six seven eight", delayMs: 300 }])
  const first = await servingKernel(env)
  const client = await RawClient.connect(nisseHome.socket)
  const conversation = await start(client, nisseHome.dir)
  const view = watchView(client, conversation)
  await view.until(() => true)
  await submit(client, conversation, "count")
  await view.until((watch) => (watch.view().docs["pi.live"] as { run?: unknown } | undefined)?.run !== undefined)
  const second = await servingKernel(env, undefined, ["serve", "--restart"])
  expect(await deadline(first.exited, 5000, "old server exit")).toBe(0)
  // The old server let its run answer before it stopped: its own watch delivered the run's end.
  expect(runEnds(view.seen())).toEqual([{ outcome: "answered", answer: expect.any(Number) }])
  client.close()
  expect(await transcriptOf(nisseHome, conversation)).toEqual([
    "user: count",
    "assistant: one two three four five six seven eight",
    "run_end: answered",
  ])
  expect(second.exitCode).toBeNull()
}, 30_000)

test("extensions-load: nisse extensions on the kernel lists each extension by its full path", async () => {
  const nisseHome = home()
  mkdirSync(nisseHome.extensions, { recursive: true })
  writeFileSync(
    join(nisseHome.extensions, "clock.ts"),
    `import { Extension } from "@nisse/extension"
import { Effect } from "effect"
export default Extension.define(() => Effect.void)
`,
  )
  const env = await kernelEnv(nisseHome)
  const line = `clock  loaded  ${nisseHome.extensions}/clock.ts\n`
  expect(await finished(nisse(["extensions"], env))).toMatchObject({ code: 0, stdout: line })
  expect(await finished(nisse(["extensions", "reload"], env))).toMatchObject({ code: 0, stdout: line })
}, 30_000)

test("signout, signin-cannot: nisse logout and login on the kernel sign out of a provider and refuse one nisse does not have", async () => {
  const env = await kernelEnv(home())
  expect(await finished(nisse(["logout", "openai"], env))).toMatchObject({
    code: 0,
    stderr: "signed out of openai: signed out\n",
  })
  const login = await finished(nisse(["login", "nope"], env))
  expect(login.code).toBe(1)
  expect(login.stderr).toStartWith("no provider named nope; there are ")
}, 30_000)
