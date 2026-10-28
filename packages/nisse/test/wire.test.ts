import { expect, test } from "bun:test"
import { LIVE_OUTPUT_TAIL, type Delivery } from "@nisse/protocol"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { bodies, deadline, entriesOf, errorTag, RawClient } from "./support/raw.ts"
import { runningServer, servingUntilIdle, tempHome } from "./support/server.ts"

const start = async (client: RawClient, options: Record<string, unknown> = {}) =>
  (await client.call("conversation/start", { cwd: "/work", ...options })).result.id

const submit = (
  client: RawClient,
  conversation: string,
  text: string,
  requestId: string = crypto.randomUUID(),
  steer = false,
) => client.call("conversation/submit", { conversation, requestId, author: "ada", text, steer })

const ended = (count: number) => (deliveries: ReadonlyArray<Delivery>) =>
  bodies(deliveries).filter((body) => body._tag === "run_end").length >= count

const settled = (deliveries: ReadonlyArray<Delivery>) => ended(1)(deliveries) && deliveries.at(-1)?.status === "idle"

const speaking = (deliveries: ReadonlyArray<Delivery>) =>
  deliveries.some((delivery) => delivery._tag === "commit" && delivery.live?.some((change) => change._tag === "text"))

const withoutUsers = (deliveries: ReadonlyArray<Delivery>) => bodies(deliveries).filter((body) => body._tag !== "user")

const workdir = () => mkdtempSync("/tmp/nisse-work-")

test("every client of a conversation sees the prompt and the same answer", async () => {
  await using server = await runningServer([{ text: "hello ada" }])
  const ada = await RawClient.connect(server.home.socket)
  const grace = await RawClient.connect(server.home.socket)
  const conversation = await start(ada)
  const adaView = ada.subscribe({ conversation })
  const graceView = grace.subscribe({ conversation })
  await adaView.until((deliveries) => deliveries.length > 0)
  await graceView.until((deliveries) => deliveries.length > 0)
  await submit(ada, conversation, "hi")
  await adaView.until(ended(1))
  await graceView.until(ended(1))
  expect(bodies(adaView.deliveries)).toEqual([
    expect.objectContaining({ _tag: "user", text: "hi" }),
    { _tag: "message", text: "hello ada" },
    { _tag: "run_end", outcome: "answered" },
  ])
  expect(graceView.deliveries.map((delivery) => delivery.seq)).toEqual(adaView.deliveries.map((d) => d.seq))
  expect(adaView.deliveries.at(-1)).toMatchObject({ status: "idle" })
  ada.close()
  grace.close()
})

test("submitting again with the same request id is answered once", async () => {
  await using server = await runningServer([{ text: "once" }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client)
  const view = client.subscribe({ conversation })
  const first = await submit(client, conversation, "hi", "request-1")
  const again = await submit(client, conversation, "hi", "request-1")
  expect(again.result.submission).toBe(first.result.submission)
  await view.until(ended(1))
  const snapshot = client.subscribe({ conversation })
  await snapshot.until((deliveries) => deliveries.length > 0)
  expect(bodies(snapshot.deliveries).filter((body) => body._tag === "user")).toHaveLength(1)
  client.close()
})

test("a client resuming from a seq receives exactly the commits it missed", async () => {
  await using server = await runningServer([{ text: "first" }, { text: "second" }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client)
  const view = client.subscribe({ conversation })
  await submit(client, conversation, "one")
  await view.until(ended(1))
  const resumeAt = view.deliveries.at(-1)!.seq
  await submit(client, conversation, "two")
  await view.until(ended(2))
  const resumed = client.subscribe({ conversation, sinceSeq: resumeAt })
  const missed = view.deliveries.filter((delivery) => delivery.seq > resumeAt)
  await resumed.until((deliveries) => deliveries.length >= missed.length)
  expect(resumed.deliveries).toEqual(missed)
  client.close()
})

test("prompts sent while nisse is working wait in a visible queue and run in order", async () => {
  await using server = await runningServer([{ text: "slow answer here", delayMs: 100 }, { text: "quick" }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client)
  const view = client.subscribe({ conversation })
  await submit(client, conversation, "first")
  await view.until(speaking)
  await submit(client, conversation, "second")
  await view.until((deliveries) =>
    deliveries.some((delivery) => delivery._tag === "commit" && delivery.enqueued?.text === "second"),
  )
  await view.until(ended(2))
  expect(bodies(view.deliveries).map((body) => ("text" in body ? body.text : body._tag))).toEqual([
    "first",
    "slow answer here",
    "run_end",
    "second",
    "quick",
    "run_end",
  ])
  client.close()
})

test("interrupting keeps what nisse already said and marks the run interrupted", async () => {
  await using server = await runningServer([{ text: "one two three four five six seven eight", delayMs: 150 }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client)
  const view = client.subscribe({ conversation })
  await submit(client, conversation, "count")
  await view.until(speaking)
  await client.call("conversation/interrupt", { conversation })
  await view.until(ended(1))
  const [said, end] = withoutUsers(view.deliveries)
  expect(end).toEqual({ _tag: "run_end", outcome: "interrupted" })
  expect(said).toMatchObject({ _tag: "message" })
  expect("one two three four five six seven eight".startsWith((said as { text: string }).text)).toBe(true)
  expect(view.deliveries.at(-1)).toMatchObject({ status: "idle" })
  client.close()
})

test("a model failure is recorded after what was said and the conversation goes idle", async () => {
  await using server = await runningServer([{ text: "partial", fail: "provider went away" }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client)
  const view = client.subscribe({ conversation })
  await submit(client, conversation, "go")
  await view.until(ended(1))
  expect(withoutUsers(view.deliveries)).toEqual([
    { _tag: "message", text: "partial" },
    { _tag: "run_end", outcome: "failed", message: "provider went away" },
  ])
  await view.until((deliveries) => deliveries.at(-1)?.status === "idle")
  client.close()
})

test("a client that stops reading is dropped while the others keep up", async () => {
  await using server = await runningServer(Array.from({ length: 1500 }, () => ({ text: "ok" })))
  const reader = await RawClient.connect(server.home.socket)
  const stalled = await RawClient.connect(server.home.socket, { ack: false })
  const conversation = await start(reader)
  const live = reader.subscribe({ conversation })
  const behind = stalled.subscribe({ conversation })
  await Promise.all([live, behind].map((view) => view.until((deliveries) => deliveries.length > 0)))
  for (let batch = 0; batch < 15; batch++) {
    await Promise.all(Array.from({ length: 100 }, (_, i) => submit(reader, conversation, `prompt ${batch}-${i}`)))
  }
  await live.until(ended(1500), 20_000)
  stalled.resumeAcks(behind.id)
  expect(errorTag(await deadline(behind.ended, 5000, "stalled client told it fell behind"))).toBe("FellBehind")
  expect(behind.deliveries.length).toBe(1)
  reader.close()
  stalled.close()
}, 30_000)

test("subscribing to a conversation that does not exist says so", async () => {
  await using server = await runningServer()
  const client = await RawClient.connect(server.home.socket)
  const reply = await client.subscribe({ conversation: "nope" }).ended
  expect(errorTag(reply)).toBe("NoSuchConversation")
  client.close()
})

test("the server exits once no client is connected and nothing is running", async () => {
  const home = tempHome()
  const served = await deadline(servingUntilIdle(home, "200 millis"), 5000, "server listening")
  const client = await RawClient.connect(home.socket)
  const conversation = await start(client)
  const view = client.subscribe({ conversation })
  await view.until((deliveries) => deliveries.length > 0)
  client.close()
  await deadline(served.exited, 5000, "server exit")
})

test("stopping the server answers the caller, then the server exits", async () => {
  const home = tempHome()
  const served = await deadline(servingUntilIdle(home, "1 hour"), 5000, "server listening")
  const client = await RawClient.connect(home.socket)
  const reply = await client.call("server/stop", null)
  expect(reply).toMatchObject({ result: null })
  await deadline(served.exited, 5000, "server exit")
  client.close()
})

const writeCall = (path: string, content: string) => ({ tool: { name: "Write", input: { file_path: path, content } } })

test("a call that changes files waits for a person's answer and runs once allowed", async () => {
  const cwd = workdir()
  await using server = await runningServer([writeCall(`${cwd}/note.txt`, "hi"), { text: "wrote it" }])
  const ada = await RawClient.connect(server.home.socket)
  const grace = await RawClient.connect(server.home.socket)
  const conversation = await start(ada, { cwd })
  const view = ada.subscribe({ conversation })
  await submit(ada, conversation, "write a note")
  await view.until((deliveries) => deliveries.at(-1)?.status === "waiting")
  const approval = bodies(view.deliveries).find((body) => body._tag === "approval")!
  expect(approval).toMatchObject({ tool: "Write", input: { file_path: `${cwd}/note.txt` } })
  expect(() => readFileSync(`${cwd}/note.txt`)).toThrow()
  const answer = { conversation, approval: (approval as { approval: string }).approval, author: "grace", allow: true }
  expect((await grace.call("approval/resolve", answer)).result).toEqual({ accepted: true })
  expect((await ada.call("approval/resolve", { ...answer, author: "ada", allow: false })).result).toEqual({
    accepted: false,
  })
  await view.until(settled)
  expect(withoutUsers(view.deliveries).map((body) => body._tag)).toEqual([
    "tool_call",
    "approval",
    "approval_answer",
    "tool_result",
    "message",
    "run_end",
  ])
  expect(entriesOf(view.deliveries).find((entry) => entry.body._tag === "approval_answer")?.author).toEqual({
    _tag: "person",
    name: "grace",
  })
  expect(readFileSync(`${cwd}/note.txt`, "utf8")).toBe("hi")
  ada.close()
  grace.close()
  rmSync(cwd, { recursive: true })
})

test("a denied call is reported to the model as denied and nothing changes", async () => {
  const cwd = workdir()
  await using server = await runningServer([writeCall(`${cwd}/note.txt`, "hi"), { text: "ok, I won't" }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, { cwd })
  const view = client.subscribe({ conversation })
  await submit(client, conversation, "write a note")
  await view.until((deliveries) => deliveries.at(-1)?.status === "waiting")
  const approval = bodies(view.deliveries).find((body) => body._tag === "approval") as { approval: string }
  await client.call("approval/resolve", { conversation, approval: approval.approval, author: "ada", allow: false })
  await view.until(settled)
  expect(bodies(view.deliveries).find((body) => body._tag === "tool_result")).toMatchObject({ error: true })
  expect(() => readFileSync(`${cwd}/note.txt`)).toThrow()
  client.close()
  rmSync(cwd, { recursive: true })
})

test("reading calls and conversations started with auto approvals run without asking", async () => {
  const cwd = workdir()
  await Bun.write(`${cwd}/a.txt`, "alpha\n")
  await using server = await runningServer([
    { tool: { name: "Read", input: { file_path: `${cwd}/a.txt` } } },
    { text: "read it" },
    writeCall(`${cwd}/b.txt`, "beta"),
    { text: "wrote it" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const asking = await start(client, { cwd })
  const reading = client.subscribe({ conversation: asking })
  await submit(client, asking, "read a")
  await reading.until(settled)
  expect(bodies(reading.deliveries).some((body) => body._tag === "approval")).toBe(false)
  expect(bodies(reading.deliveries).find((body) => body._tag === "tool_result")).toMatchObject({
    output: expect.stringContaining("alpha"),
    error: false,
  })

  const auto = await start(client, { cwd, approvals: "auto" })
  const writing = client.subscribe({ conversation: auto })
  await submit(client, auto, "write b")
  await writing.until(settled)
  expect(bodies(writing.deliveries).some((body) => body._tag === "approval")).toBe(false)
  expect(readFileSync(`${cwd}/b.txt`, "utf8")).toBe("beta")
  client.close()
  rmSync(cwd, { recursive: true })
})

test("a running command's output streams live and ends as its result", async () => {
  const cwd = workdir()
  await using server = await runningServer([
    { tool: { name: "Bash", input: { command: "echo first; sleep 0.3; echo second" } } },
    { text: "done" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, { cwd, approvals: "auto" })
  const view = client.subscribe({ conversation })
  await submit(client, conversation, "run it")
  await view.until(settled)
  const live = view.deliveries.flatMap((delivery) => (delivery._tag === "commit" ? (delivery.live ?? []) : []))
  const streamed = live.flatMap((change) => (change._tag === "output" ? [change.append] : [])).join("")
  expect(streamed).toBe("first\nsecond\n")
  expect(live.findIndex((change) => change._tag === "output")).toBeLessThan(
    live.findIndex((change) => change._tag === "output_end"),
  )
  expect(bodies(view.deliveries).find((body) => body._tag === "tool_result")).toMatchObject({
    output: expect.stringContaining("first\nsecond"),
  })
  client.close()
  rmSync(cwd, { recursive: true })
})

test("interrupting while nisse waits for an answer withdraws the question", async () => {
  const cwd = workdir()
  await using server = await runningServer([writeCall(`${cwd}/note.txt`, "hi")])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, { cwd })
  const view = client.subscribe({ conversation })
  await submit(client, conversation, "write a note")
  await view.until((deliveries) => deliveries.at(-1)?.status === "waiting")
  const approval = bodies(view.deliveries).find((body) => body._tag === "approval") as { approval: string }
  await client.call("conversation/interrupt", { conversation })
  await view.until(settled)
  expect(withoutUsers(view.deliveries).slice(-3)).toEqual([
    { _tag: "approval_answer", approval: approval.approval, allow: false },
    expect.objectContaining({ _tag: "tool_result", error: true }),
    { _tag: "run_end", outcome: "interrupted" },
  ])
  const late = await client.call("approval/resolve", {
    conversation,
    approval: approval.approval,
    author: "ada",
    allow: true,
  })
  expect(late.result).toEqual({ accepted: false })
  client.close()
  rmSync(cwd, { recursive: true })
})

test("a steering prompt reaches nisse during the run instead of after it", async () => {
  const cwd = workdir()
  await using server = await runningServer([
    { tool: { name: "Bash", input: { command: "sleep 0.5" } } },
    { text: "steered" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, { cwd, approvals: "auto" })
  const view = client.subscribe({ conversation })
  await submit(client, conversation, "start")
  await view.until((deliveries) => bodies(deliveries).some((body) => body._tag === "tool_call"))
  await submit(client, conversation, "also do this", crypto.randomUUID(), true)
  await view.until(settled)
  expect(bodies(view.deliveries).map((body) => ("text" in body ? body.text : body._tag))).toEqual([
    "start",
    "tool_call",
    "tool_result",
    "also do this",
    "steered",
    "run_end",
  ])
  client.close()
  rmSync(cwd, { recursive: true })
})

test("starting a conversation with a provider nisse does not have says so", async () => {
  await using server = await runningServer()
  const client = await RawClient.connect(server.home.socket)
  const reply = await client.call("conversation/start", { cwd: "/work", provider: "nope" })
  expect(errorTag(reply)).toBe("UnknownProvider")
  client.close()
})

const outputChanges = (deliveries: ReadonlyArray<Delivery>) =>
  deliveries.flatMap((delivery) =>
    delivery._tag === "commit"
      ? (delivery.live ?? []).flatMap((change) => (change._tag === "output" ? [change] : []))
      : [],
  )

test("a command's output keeps characters split across reads and between streams whole", async () => {
  const cwd = workdir()
  await using server = await runningServer([
    {
      tool: {
        name: "Bash",
        input: { command: "printf '\\342'; sleep 0.1; printf 'err\\n' >&2; sleep 0.1; printf '\\202\\254\\n'" },
      },
    },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, { cwd, approvals: "auto" })
  const view = client.subscribe({ conversation })
  await submit(client, conversation, "euro")
  await view.until(settled)
  expect(bodies(view.deliveries).find((body) => body._tag === "tool_result")).toMatchObject({ output: "err\n€\n" })
  client.close()
  rmSync(cwd, { recursive: true })
})

test("a verbose command's live output stays a bounded tail", async () => {
  const cwd = workdir()
  await using server = await runningServer([
    { tool: { name: "Bash", input: { command: "head -c 2000000 /dev/zero | tr '\\0' x; sleep 0.3" } } },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, { cwd, approvals: "auto" })
  const view = client.subscribe({ conversation })
  await submit(client, conversation, "flood")
  await view.until(settled)
  const appended = outputChanges(view.deliveries).map((change) => change.append.length)
  expect(appended.length).toBeGreaterThan(0)
  expect(Math.max(...appended)).toBeLessThanOrEqual(LIVE_OUTPUT_TAIL)
  expect(appended.reduce((sum, length) => sum + length, 0)).toBeLessThan(200_000)
  client.close()
  rmSync(cwd, { recursive: true })
})

test("output a background process writes after its call ends never reaches the conversation", async () => {
  const cwd = workdir()
  await using server = await runningServer([
    { tool: { name: "Bash", input: { command: "(sleep 1.5; echo late) & echo now" } } },
    { tool: { name: "Bash", input: { command: "sleep 1" } } },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, { cwd, approvals: "auto" })
  const view = client.subscribe({ conversation })
  await submit(client, conversation, "background")
  await view.until(settled)
  expect(bodies(view.deliveries).find((body) => body._tag === "tool_result")).toMatchObject({ output: "now\n" })
  expect(outputChanges(view.deliveries).some((change) => change.append.includes("late"))).toBe(false)
  client.close()
  rmSync(cwd, { recursive: true })
})

test("Grep reports only the lines a file has, whatever its line endings", async () => {
  const cwd = workdir()
  await Bun.write(`${cwd}/notes.txt`, "alpha\n\nbeta\n")
  await Bun.write(`${cwd}/windows.txt`, "alpha\r\n\r\nbeta\r\n")
  await using server = await runningServer([{ tool: { name: "Grep", input: { pattern: "^$" } } }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, { cwd })
  const view = client.subscribe({ conversation })
  await submit(client, conversation, "blank lines")
  await view.until(settled)
  expect(bodies(view.deliveries).find((body) => body._tag === "tool_result")).toMatchObject({
    output: expect.stringMatching(/^(notes\.txt:2:\nwindows\.txt:2:|windows\.txt:2:\nnotes\.txt:2:)$/),
    error: false,
  })
  client.close()
  rmSync(cwd, { recursive: true })
})
