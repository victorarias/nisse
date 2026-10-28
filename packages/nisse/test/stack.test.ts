import { afterEach, expect, test } from "bun:test"
import type { Delivery } from "@nisse/protocol"
import { Database } from "bun:sqlite"
import { rmSync } from "node:fs"
import { deadline, RawClient } from "./support/raw.ts"
import { tempHome } from "./support/server.ts"
import { nisse, nisseEnv, stopServer } from "./support/terminal.ts"

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

const finished = async (process: ReturnType<typeof nisse>) => {
  const [code, stdout, stderr] = await deadline(
    Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]),
    20_000,
    "nisse exited",
  )
  return { code, stdout, stderr }
}

const withScript = async (nisseHome: ReturnType<typeof tempHome>, steps: unknown) => {
  const script = `${nisseHome.dir}/script.json`
  await Bun.write(script, JSON.stringify(steps))
  return nisseEnv(nisseHome, { NISSE_MODEL_SCRIPT: script })
}

test("nisse exec starts a server when none runs, prints the answer and exits 0", async () => {
  const result = await finished(nisse(["exec", "hello there"], nisseEnv(home())))
  expect(result).toMatchObject({ code: 0, stdout: "You said: hello there\n" })
})

test("a home the Rust version used still works and keeps its database", async () => {
  const nisseHome = home()
  const rust = new Database(`${nisseHome.dir}/nisse.sqlite`)
  rust.run("CREATE TABLE commits (seq INTEGER PRIMARY KEY, data TEXT)")
  rust.run("PRAGMA user_version = 6")
  rust.close()
  const result = await finished(nisse(["exec", "still here"], nisseEnv(nisseHome)))
  expect(result).toMatchObject({ code: 0, stdout: "You said: still here\n" })
  const kept = new Database(`${nisseHome.dir}/nisse.sqlite`, { readonly: true })
  expect(kept.query("PRAGMA user_version").get()).toEqual({ user_version: 6 })
  kept.close()
})

test("nisse exec exits 1 and reports the failure when the run fails", async () => {
  const env = await withScript(home(), [{ text: "half an ", fail: "provider went away" }])
  const result = await finished(nisse(["exec", "go"], env))
  expect(result.code).toBe(1)
  expect(result.stdout).toBe("half an \n")
  expect(result.stderr).toContain("provider went away")
})

test("nisse exec finishes when nisse answers with nothing", async () => {
  const env = await withScript(home(), [{ text: "" }])
  const result = await finished(nisse(["exec", "say nothing"], env))
  expect(result).toMatchObject({ code: 0, stdout: "" })
})

test("clients starting at the same moment share one server", async () => {
  const env = nisseEnv(home())
  const results = await Promise.all(Array.from({ length: 4 }, (_, i) => finished(nisse(["exec", `client ${i}`], env))))
  results.forEach((result, i) => expect(result).toMatchObject({ code: 0, stdout: `You said: client ${i}\n` }))
})

test("a second server for the same home refuses to start", async () => {
  const nisseHome = home()
  const env = nisseEnv(nisseHome)
  await finished(nisse(["exec", "start one"], env))
  const second = await finished(nisse(["serve"], env))
  expect(second).toMatchObject({ code: 1, stderr: `another server already serves ${nisseHome.dir}\n` })
})

test("a run cut off by a crashed server finishes after the server comes back", async () => {
  const nisseHome = home()
  const env = await withScript(nisseHome, [{ text: "one two three four five six seven eight nine ten", delayMs: 100 }])
  const server = nisse(["serve"], env)
  const exec = nisse(["exec", "count"], env)
  const reader = exec.stdout.getReader()
  let printed = ""
  while (!printed.includes("one")) {
    const { value } = await deadline(reader.read(), 10_000, "first words printed")
    printed += new TextDecoder().decode(value)
  }
  server.kill("SIGKILL")
  await server.exited
  while (true) {
    const { value, done } = await deadline(reader.read(), 20_000, "answer after restart")
    if (done) break
    printed += new TextDecoder().decode(value)
  }
  expect(await exec.exited).toBe(0)
  expect(printed).toBe("one two three four five six seven eight nine ten\n")

  const client = await RawClient.connect(nisseHome.socket)
  const conversations = (await client.call("conversation/list")).result
  const view = client.subscribe({ conversation: conversations[0].id })
  await view.until((deliveries) => deliveries.length > 0)
  const said = view.deliveries[0]!.entries.filter((entry) => entry.body._tag !== "user").map((entry) => entry.body)
  expect(said).toEqual([
    { _tag: "message", text: "one two three four five six seven eight nine ten" },
    { _tag: "run_end", outcome: "answered" },
  ])
  client.close()
}, 30_000)

const snapshotOf = async (nisseHome: ReturnType<typeof tempHome>) => {
  const client = await RawClient.connect(nisseHome.socket)
  const conversations = (await client.call("conversation/list")).result
  const view = client.subscribe({ conversation: conversations[0].id })
  await view.until((deliveries) => deliveries.length > 0)
  client.close()
  return view.deliveries[0]!
}

const serving = async (env: Record<string, string | undefined>, nisseHome: ReturnType<typeof tempHome>) => {
  const server = nisse(["serve"], env)
  const log = server.stderr.getReader()
  let printed = ""
  while (!printed.includes("serving")) {
    const { value, done } = await deadline(log.read(), 10_000, "server listening")
    if (done) throw new Error(`server exited: ${printed}`)
    printed += new TextDecoder().decode(value)
  }
  log.releaseLock()
  return { server, client: await RawClient.connect(nisseHome.socket) }
}

const calls = (deliveries: ReadonlyArray<Delivery>) =>
  deliveries.flatMap((delivery) => delivery.entries).filter((entry) => entry.body._tag === "tool_call").length

test("nisse exec shows the calls nisse makes and, without --auto, denies the ones that would change things", async () => {
  const nisseHome = home()
  const env = await withScript(nisseHome, [
    { tool: { name: "Bash", input: { command: "echo ran" } } },
    { text: "could not run it" },
    { tool: { name: "Bash", input: { command: "echo ran" } } },
    { text: "ran it" },
  ])
  const denied = await finished(nisse(["exec", "run something"], env))
  expect(denied).toMatchObject({ code: 0, stdout: "could not run it\n" })
  expect(denied.stderr).toContain("› Bash(echo ran)")
  expect(denied.stderr).toContain("pass --auto")
  const allowed = await finished(nisse(["exec", "--auto", "run something"], env))
  expect(allowed).toMatchObject({ code: 0, stdout: "ran it\n" })
  const results = (await snapshotOf(nisseHome)).entries.filter((entry) => entry.body._tag === "tool_result")
  expect(results.map((entry) => entry.body)).toMatchObject([{ output: "ran\n", error: false }])
}, 30_000)

test("a call cut off by a crashed server is recorded as interrupted and the run carries on", async () => {
  const nisseHome = home()
  const script = `${nisseHome.dir}/script.json`
  await Bun.write(script, JSON.stringify([{ tool: { name: "Bash", input: { command: "sleep 60" } } }]))
  const env = nisseEnv(nisseHome, { NISSE_MODEL_SCRIPT: script })
  const first = await serving(env, nisseHome)
  const conversation = (await first.client.call("conversation/start", { cwd: nisseHome.dir, approvals: "auto" })).result
    .id
  const view = first.client.subscribe({ conversation })
  await first.client.call("conversation/submit", { conversation, requestId: "r1", author: "ada", text: "go" })
  await view.until((deliveries) => calls(deliveries) === 1)
  first.server.kill("SIGKILL")
  await first.server.exited
  first.client.close()

  await Bun.write(script, JSON.stringify([{ text: "picked up again" }]))
  const second = await serving(env, nisseHome)
  const resumed = second.client.subscribe({ conversation, sinceSeq: view.deliveries.at(-1)!.seq })
  await resumed.until((deliveries) => deliveries.at(-1)?.status === "idle", 10_000)
  expect(resumed.deliveries.flatMap((delivery) => delivery.entries).map((entry) => entry.body)).toMatchObject([
    { _tag: "tool_result", output: "interrupted; it may or may not have taken effect", error: true },
    { _tag: "message", text: "picked up again" },
    { _tag: "run_end", outcome: "answered" },
  ])
  second.client.close()
}, 30_000)

test("a run that keeps crashing the server stops after three tries instead of looping", async () => {
  const nisseHome = home()
  const env = await withScript(nisseHome, [{ tool: { name: "Bash", input: { command: "sleep 60" } } }])
  let conversation: string | undefined
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { server, client } = await serving(env, nisseHome)
    conversation ??= (await client.call("conversation/start", { cwd: nisseHome.dir, approvals: "auto" })).result.id
    const view = client.subscribe({ conversation })
    if (attempt === 1) {
      await client.call("conversation/submit", { conversation, requestId: "r1", author: "ada", text: "go" })
    }
    await view.until((deliveries) => calls(deliveries) === attempt, 10_000)
    server.kill("SIGKILL")
    await server.exited
    client.close()
  }
  const { client } = await serving(env, nisseHome)
  const view = client.subscribe({ conversation })
  await view.until((deliveries) => deliveries.at(-1)?.status === "idle", 10_000)
  expect(view.deliveries.flatMap((delivery) => delivery.entries).at(-1)?.body).toEqual({
    _tag: "run_end",
    outcome: "restart_limit",
    message: "the server stopped during this run 3 times in a row",
  })
  client.close()
}, 30_000)
