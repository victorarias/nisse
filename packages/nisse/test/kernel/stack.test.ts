// The `nisse` binary on the kernel (NISSE_KERNEL=1), over its socket: stop, kill, restart.
import { afterEach, expect, test } from "bun:test"
import { KERNEL_PROTOCOL_VERSION } from "@nisse/wire"
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { deadline, RawClient } from "../support/raw.ts"
import { kernelEnv, runEnds, servingKernel, settled, start, submit, transcript, watchView } from "../support/kernel.ts"
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

test("crash-limit: a run that keeps crashing the server stops after three tries instead of looping", async () => {
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
