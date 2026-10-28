import { afterEach, expect, test } from "bun:test"
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
  expect(second.stderr).toContain(`another server already serves ${nisseHome.dir}`)
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
  const answers = view.deliveries[0]!.entries.filter((entry) => entry.body._tag === "answer")
  expect(answers.map((entry) => entry.body)).toEqual([
    { _tag: "answer", text: "one two three four five six seven eight nine ten", interrupted: false },
  ])
  client.close()
}, 30_000)
