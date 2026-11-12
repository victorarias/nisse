// The wire: a real server in process, driven as a raw JSON-RPC client over its socket.
import { expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homeWithExtensions } from "./support/extensions.ts"
import { deadline, errorTag, hangUpMidAnswer, RawClient } from "./support/raw.ts"
import {
  runEnds,
  runningServer,
  servingUntilIdle,
  settled,
  start,
  submit,
  transcript,
  type ViewWatch,
  watchView,
  tempHome,
} from "./support/server.ts"
import { applyImmutable, type Op } from "@nisse/delta"
import { DEFAULT_MAX_BYTES } from "@nisse/env/truncate"
import { PROTOCOL_VERSION, RUN_END_KIND, STATUS_LINES_KIND, TOAST_KIND, USER_KIND, type View } from "@nisse/protocol"
import { VERSION } from "../src/version.ts"

type Tree = { _tag: "tree"; conversation: string; seq: number; status: string; ended?: Record<string, string> }
type Trees = { _tag: "trees"; seq: number; trees: Array<Tree> } | Tree
const opened = (watch: ViewWatch) => watch.until(() => true)

/** The model has said something the view shows live, before the run ends. */
const speaking = (watch: ViewWatch) => {
  const live = watch.view().docs["pi.live"] as { generation?: { message?: { content?: unknown[] } } } | undefined
  return (live?.generation?.message?.content?.length ?? 0) > 0
}

test("answer-wire, answer-shared: every client of a conversation sees the prompt, the answer and how the run ended", async () => {
  await using server = await runningServer([{ text: "hello ada" }])
  const ada = await RawClient.connect(server.home.socket)
  const grace = await RawClient.connect(server.home.socket)
  const conversation = await start(ada)
  const adaView = watchView(ada, conversation)
  const graceView = watchView(grace, conversation)
  await Promise.all([opened(adaView), opened(graceView)])
  await submit(ada, conversation, "hi")
  await adaView.until(settled(1))
  await graceView.until(settled(1))
  expect(transcript(adaView.view().entries)).toEqual(["user: hi", "assistant: hello ada", "run_end: answered"])
  const answer = adaView.view().entries.find((entry) => entry.kind === "pi.assistant")!.id
  expect(runEnds(adaView.view().entries)).toEqual([{ outcome: "answered", answer }])
  expect(graceView.view()).toEqual(adaView.view())
  ada.close()
  grace.close()
})

test("queue-idempotent: submitting again with the same request id is answered once", async () => {
  await using server = await runningServer([{ text: "once" }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client)
  const view = watchView(client, conversation)
  const first = await submit(
    client,
    conversation,
    "hi",
    "request-1" as `${string}-${string}-${string}-${string}-${string}`,
  )
  const again = await submit(
    client,
    conversation,
    "hi",
    "request-1" as `${string}-${string}-${string}-${string}-${string}`,
  )
  expect(again.result).toEqual(first.result)
  await view.until(settled(1))
  expect(transcript(view.view().entries)).toEqual(["user: hi", "assistant: once", "run_end: answered"])
  client.close()
})

test("queue-run: prompts sent while nisse is working wait and run in order, each to its own end", async () => {
  await using server = await runningServer([{ text: "the first answer", delayMs: 100 }, { text: "second answer" }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client)
  const view = watchView(client, conversation)
  await submit(client, conversation, "one")
  await view.until(speaking)
  await submit(client, conversation, "two")
  await view.until(settled(2))
  expect(transcript(view.view().entries)).toEqual([
    "user: one",
    "assistant: the first answer",
    "run_end: answered",
    "user: two",
    "assistant: second answer",
    "run_end: answered",
  ])
  client.close()
})

test("queue-run: a prompt sent while nisse works runs after the run fails, instead of waiting for another prompt", async () => {
  await using server = await runningServer([
    { text: "half an answer", delayMs: 100, fail: "provider went away" },
    { text: "second answer" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client)
  const view = watchView(client, conversation)
  await submit(client, conversation, "one")
  await view.until(speaking)
  await submit(client, conversation, "two")
  // Queued behind the run that is about to fail, not started after it.
  await view.until((watch) => (watch.view().docs["pi.inbox"] as { items: Array<unknown> }).items.length === 1)
  await view.until(settled(2))
  expect(transcript(view.view().entries)).toEqual([
    "user: one",
    "assistant: half an answer [error]",
    "run_end: failed (provider went away)",
    "user: two",
    "assistant: second answer",
    "run_end: answered",
  ])
  expect(view.view().docs["pi.inbox"]).toEqual({ items: [] })
  client.close()
})

test("interrupt-wire: interrupting keeps what nisse already said and marks the run interrupted", async () => {
  await using server = await runningServer([{ text: "one two three four five six seven eight", delayMs: 100 }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client)
  const view = watchView(client, conversation)
  await submit(client, conversation, "count")
  await view.until(speaking)
  expect(await client.call("conversation/interrupt", { conversation })).toMatchObject({ result: null })
  await view.until(settled(1))
  const said = transcript(view.view().entries)
  expect(said[0]).toBe("user: count")
  expect(said[1]).toMatch(/^assistant: one /)
  expect(said[1]!.length).toBeLessThan("assistant: one two three four five six seven eight".length)
  expect(said.slice(2)).toEqual(["run_end: interrupted (aborted)"])
  client.close()
})

test("interrupt-withdraw: interrupting withdraws the prompts that wait, and the transcript names each by its requestId", async () => {
  await using server = await runningServer([{ text: "one two three four five six seven eight", delayMs: 100 }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client)
  const view = watchView(client, conversation)
  await submit(client, conversation, "count")
  await view.until(speaking)
  await submit(client, conversation, "then this", "waiting-1")
  await submit(client, conversation, "and this", "waiting-2")
  await client.call("conversation/interrupt", { conversation })
  await view.until(settled(1))
  const said = transcript(view.view().entries)
  expect(said[0]).toBe("user: count")
  // The interrupt withdraws what waits before the run it stops ends.
  expect(said.slice(1).filter((line) => !line.startsWith("assistant"))).toEqual([
    "withdrawn: waiting-1",
    "withdrawn: waiting-2",
    "run_end: interrupted (aborted)",
  ])
  client.close()
})

test("answer-failed: a model failure is recorded after what was said and the conversation goes idle", async () => {
  await using server = await runningServer([{ text: "half", fail: "provider went away" }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client)
  const view = watchView(client, conversation)
  await submit(client, conversation, "hi")
  await view.until(settled(1))
  expect(transcript(view.view().entries)).toEqual([
    "user: hi",
    "assistant: half [error]",
    "run_end: failed (provider went away)",
  ])
  client.close()
})

test("wire-dropped: a client that stops reading is dropped while the others keep up", async () => {
  // A client that reads peaked at 34 queued changes with 100 prompts submitted at once; 200 prompts make about 600.
  const connectionQueue = 128
  const prompts = 200
  await using server = await runningServer(
    Array.from({ length: prompts }, () => ({ text: "ok" })),
    { connectionQueue },
  )
  const reader = await RawClient.connect(server.home.socket)
  const stalled = await RawClient.connect(server.home.socket, { ack: false })
  const conversation = await start(reader)
  const live = watchView(reader, conversation)
  const behind = watchView(stalled, conversation)
  await Promise.all([opened(live), opened(behind)])
  for (let batch = 0; batch < prompts / 100; batch++) {
    await Promise.all(Array.from({ length: 100 }, (_, i) => submit(reader, conversation, `prompt ${batch}-${i}`)))
  }
  // Every run ends while the stalled client holds the server's queue full: its commits never waited for it.
  await live.until(settled(prompts))
  stalled.resumeAcks(behind.id)
  const dropped = await deadline(behind.ended, 5000, "stalled client told it fell behind")
  expect(errorTag(dropped)).toBe("FellBehind")
  expect(behind.items).toHaveLength(1)
  reader.close()
  stalled.close()
})

test("wire-hangup: a client that hangs up while the server still writes to it is not logged as an error", async () => {
  await using server = await runningServer([{ text: "long ".repeat(5000) }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client)
  const view = watchView(client, conversation)
  await opened(view)
  await submit(client, conversation, "go")
  await view.until(settled(1))
  await hangUpMidAnswer(server.home.socket, "conversation/watch", { conversation })
  await submit(client, conversation, "still here")
  await view.until(settled(2))
  client.close()
  await server.stop()
  expect(server.logged.filter((entry) => entry.level === "Error")).toEqual([])
})

test("wire-unknown: watching a conversation that does not exist says so", async () => {
  await using server = await runningServer()
  const client = await RawClient.connect(server.home.socket)
  for (const conversation of ["nope", "999"]) {
    const reply = await client.watch("conversation/watch", { conversation }).ended
    expect(errorTag(reply)).toBe("NoSuchConversation")
  }
  expect(errorTag(await submit(client, "999", "hi"))).toBe("NoSuchConversation")
  client.close()
})

test("server-idle-exit: the server exits once no client is connected and nothing is running", async () => {
  const home = tempHome()
  const served = await deadline(servingUntilIdle(home, "200 millis"), 5000, "server listening")
  const client = await RawClient.connect(home.socket)
  const conversation = await start(client)
  await opened(watchView(client, conversation))
  client.close()
  await deadline(served.exited, 5000, "server exit")
})

test("server-idle-exit: a submission's run keeps the server up after its client leaves, past the idle grace", async () => {
  const home = tempHome()
  const served = await deadline(
    servingUntilIdle(home, "50 millis", [{ text: "one two three four", delayMs: 100 }]),
    5000,
    "server listening",
  )
  let client = await RawClient.connect(home.socket)
  const conversation = await start(client)
  // No watch: only the submission's run keeps the server up once the client goes.
  await submit(client, conversation, "count")
  client.close()
  await deadline(served.exited, 5000, "server exit")

  // A server that went idle mid-run would have left no answer and no run_end.
  await using again = await runningServer([], { home })
  client = await RawClient.connect(again.home.socket)
  const after = watchView(client, conversation)
  await after.until(() => true)
  expect(transcript(after.view().entries)).toEqual([
    "user: count",
    "assistant: one two three four",
    "run_end: answered",
  ])
  client.close()
  rmSync(home.dir, { recursive: true, force: true })
})

test("server-idle-exit, child-tools: a subagent's work keeps the server up after its client leaves, past the idle grace", async () => {
  const home = tempHome()
  const served = await deadline(
    servingUntilIdle(home, "50 millis", [
      call("spawn_agent", { task_name: "writer", message: "count", fork_turns: "none" }),
      { text: "spawned" },
      { text: "one two three four", delayMs: 100, agent: "/root/writer" },
      { text: "heard it" },
    ]),
    5000,
    "server listening",
  )
  let client = await RawClient.connect(home.socket)
  const conversation = await start(client)
  await submit(client, conversation, "delegate")
  client.close()
  await deadline(served.exited, 5000, "server exit")

  // A server that went idle while the subagent worked would have mailed nothing back to the parent.
  await using again = await runningServer([], { home })
  client = await RawClient.connect(again.home.socket)
  const after = watchView(client, conversation)
  await after.until(() => true)
  expect(mails(after)).toEqual([{ kind: "final_answer", task: "/root", sender: "/root/writer" }])
  expect(transcript(after.view().entries).slice(-2)).toEqual(["assistant: heard it", "run_end: answered"])
  client.close()
  rmSync(home.dir, { recursive: true, force: true })
})

test("server-stop, child-tools: stopping the server lets a working subagent finish and report first", async () => {
  const home = tempHome()
  const served = await deadline(
    servingUntilIdle(home, "1 hour", [
      call("spawn_agent", { task_name: "writer", message: "count", fork_turns: "none" }),
      { text: "spawned" },
      { text: "one two three four", delayMs: 100, agent: "/root/writer" },
      { text: "heard it" },
    ]),
    5000,
    "server listening",
  )
  let client = await RawClient.connect(home.socket)
  const conversation = await start(client)
  const view = watchView(client, conversation)
  await submit(client, conversation, "delegate")
  await view.until(settled(1))
  expect(await client.call("server/stop", null)).toMatchObject({ result: null })
  client.close()
  await deadline(served.exited, 5000, "server exit")

  // A stop that cut the subagent off would have mailed nothing back to the parent.
  await using again = await runningServer([], { home })
  client = await RawClient.connect(again.home.socket)
  const after = watchView(client, conversation)
  await after.until(() => true)
  expect(mails(after)).toEqual([{ kind: "final_answer", task: "/root", sender: "/root/writer" }])
  client.close()
  rmSync(home.dir, { recursive: true, force: true })
}, 30_000)

test("server-stop: stopping the server answers the caller, then the server exits", async () => {
  const home = tempHome()
  const served = await deadline(servingUntilIdle(home, "1 hour"), 5000, "server listening")
  const client = await RawClient.connect(home.socket)
  expect(await client.call("server/stop", null)).toMatchObject({ result: null })
  await deadline(served.exited, 5000, "server exit")
  client.close()
})

test("wire-initialize: a client is answered with the server's version and the protocol", async () => {
  await using server = await runningServer()
  const client = await RawClient.connect(server.home.socket)
  const reply = await client.call("initialize", { client: "test", version: "0", protocol: PROTOCOL_VERSION })
  expect(reply.result).toEqual({ version: VERSION, protocol: PROTOCOL_VERSION, readOnly: false })
  client.close()
})

test("watch-rpc: a watch through a window opens on the newest entries, and from a position gets only what followed", async () => {
  await using server = await runningServer([{ text: "a" }, { text: "b" }, { text: "c" }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client)
  const all = watchView(client, conversation)
  for (const [i, text] of ["one", "two", "three"].entries()) {
    await submit(client, conversation, text)
    await all.until(settled(i + 1))
  }
  const entries = all.view().entries
  const third = entries.findIndex((entry) => transcript([entry])[0] === "user: three")

  const newest = watchView(client, conversation, { min: 3, max: 6 })
  await newest.until(() => true)
  expect(transcript(newest.view().entries)).toEqual(["user: three", "assistant: c", "run_end: answered"])
  expect(newest.view().before).toBe(entries[third - 1]!.id)

  const resumed = watchView(client, conversation, { from: entries[3]!.id })
  await resumed.until(() => true)
  expect(resumed.view().entries.map((entry) => entry.id)).toEqual(entries.slice(3).map((entry) => entry.id))
  client.close()
})

test("watch-rpc: a window that is not one is refused by name, and the connection's other watches go on", async () => {
  await using server = await runningServer([{ text: "still here" }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client)
  const view = watchView(client, conversation)
  await opened(view)
  const refused = await client.watch("conversation/watch", { conversation, window: { min: 10, max: 5 } }).ended
  expect(errorTag(refused)).toBe("InvalidWindow")
  expect(JSON.stringify(refused.error)).toContain("Window max must be an integer >= min (10), got 5")
  await submit(client, conversation, "hi")
  await view.until(settled(1))
  expect(transcript(view.view().entries)).toEqual(["user: hi", "assistant: still here", "run_end: answered"])
  client.close()
})

test("server-stop: stopping the server while nisse answers lets the answer finish first", async () => {
  const home = tempHome()
  const served = await deadline(
    servingUntilIdle(home, "1 hour", [{ text: "one two three four", delayMs: 100 }]),
    5000,
    "server listening",
  )
  let client = await RawClient.connect(home.socket)
  const conversation = await start(client)
  const view = watchView(client, conversation)
  await submit(client, conversation, "count")
  await view.until(speaking)
  expect(await client.call("server/stop", null)).toMatchObject({ result: null })
  await deadline(served.exited, 5000, "server exit")
  client.close()

  // What the stopped server committed, as a fresh server shows it: the whole answer, and its run's end.
  await using again = await runningServer([], { home })
  client = await RawClient.connect(again.home.socket)
  const after = watchView(client, conversation)
  await after.until(() => true)
  expect(transcript(after.view().entries)).toEqual([
    "user: count",
    "assistant: one two three four",
    "run_end: answered",
  ])
  client.close()
  rmSync(home.dir, { recursive: true, force: true })
})

type Approvals = { auto?: true; requests: Record<string, { tool: string; answer?: unknown }> }
const approvalsOf = (watch: ViewWatch) => watch.view().docs["nisse.approvals"] as Approvals | undefined
const waitingApproval = async (watch: ViewWatch) => {
  await watch.until((current) => Object.keys(approvalsOf(current)?.requests ?? {}).length > 0)
  return Object.keys(approvalsOf(watch)!.requests)[0]!
}
const toolResults = (watch: ViewWatch) =>
  watch
    .seen()
    .filter((entry) => entry.kind === "pi.tool-result")
    .map((entry) => {
      const message = entry.model![0] as { content: Array<{ text?: string }>; isError: boolean }
      return { text: message.content.map((block) => block.text ?? "").join(""), isError: message.isError }
    })
const ECHO = [{ text: "checking", tool: { name: "bash", input: { command: "echo approved" } } }, { text: "all done" }]

test("approval-wire: two clients answer one approval at once and the first answer counts", async () => {
  await using server = await runningServer(ECHO)
  const ada = await RawClient.connect(server.home.socket)
  const bo = await RawClient.connect(server.home.socket)
  const conversation = await start(ada, server.home.dir)
  const view = watchView(ada, conversation)
  await submit(ada, conversation, "check it")
  const approval = await waitingApproval(view)
  expect(approvalsOf(view)!.requests[approval]).toMatchObject({ tool: "bash" })
  const answers = await Promise.all([
    ada.call("approval/resolve", { conversation, approval, author: "ada", allow: true }),
    bo.call("approval/resolve", { conversation, approval, author: "bo", allow: false }),
  ])
  const accepted = answers.map((reply) => (reply.result as { accepted: boolean }).accepted)
  expect(accepted.filter(Boolean)).toHaveLength(1)
  const winner = accepted[0] ? { author: "ada", allow: true } : { author: "bo", allow: false }
  await view.until(settled(1))
  const answered = view.seen().filter((entry) => entry.kind === "nisse.approval")
  expect(answered.map((entry) => entry.data)).toEqual([expect.objectContaining({ approval, ...winner })])
  expect(toolResults(view)).toEqual([
    winner.allow
      ? { text: "approved\n", isError: false }
      : { text: expect.stringContaining("denied by bo: the person did not allow this call"), isError: true },
  ])
  // The request leaves with its call, and a late answer is not accepted.
  expect(approvalsOf(view)!.requests).toEqual({})
  const late = await ada.call("approval/resolve", { conversation, approval, author: "cy", allow: true })
  expect(late.result).toEqual({ accepted: false })
  expect(transcript(view.view().entries).slice(-2)).toEqual(["assistant: all done", "run_end: answered"])
  ada.close()
  bo.close()
})

test("approval-wire: a denied call is reported to the model as denied and does not run, and an unknown approval is refused by name", async () => {
  await using server = await runningServer([
    { tool: { name: "bash", input: { command: "touch made" } } },
    { text: "all done" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "make it")
  const approval = await waitingApproval(view)
  const reply = await client.call("approval/resolve", { conversation, approval, author: "bo", allow: false })
  expect(reply.result).toEqual({ accepted: true })
  await view.until(settled(1))
  expect(toolResults(view)).toEqual([
    { text: expect.stringContaining("denied by bo: the person did not allow this call"), isError: true },
  ])
  expect(await Bun.file(`${server.home.dir}/made`).exists()).toBe(false)
  expect(
    errorTag(await client.call("approval/resolve", { conversation, approval: "999", author: "bo", allow: true })),
  ).toBe("NoSuchApproval")
  client.close()
})

test("codemode-nested-policy: a script's call that changes things asks first, and a denied one fails in the script without running", async () => {
  const code = 'try { await tools.bash({ command: "touch made" }) } catch (error) { text("refused: " + error.message) }'
  await using server = await runningServer([{ tool: { name: "codemode", input: { code } } }, { text: "all done" }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = (await client.call("conversation/start", { cwd: server.home.dir, model: "script-code-mode" }))
    .result.conversation as string
  const view = watchView(client, conversation)
  await submit(client, conversation, "make it")
  const approval = await waitingApproval(view)
  expect(approvalsOf(view)!.requests[approval]).toMatchObject({ tool: "bash" })
  await client.call("approval/resolve", { conversation, approval, author: "bo", allow: false })
  await view.until(settled(1))
  const result = toolResults(view).at(-1)
  expect(result!.text).toStartWith("Script completed")
  expect(result!.text).toContain("refused: ")
  expect(result!.text).toContain("denied by bo: the person did not allow this call")
  expect(await Bun.file(`${server.home.dir}/made`).exists()).toBe(false)
  expect(transcript(view.view().entries).slice(-2)).toEqual(["assistant: all done", "run_end: answered"])
  client.close()
})

test("tool-read-only, approval-auto: reading calls and conversations started with auto approvals run without asking", async () => {
  await using server = await runningServer([
    { tool: { name: "read", input: { path: "notes.txt" } } },
    { text: "read it" },
    ...ECHO,
  ])
  await Bun.write(`${server.home.dir}/notes.txt`, "the gnome lives under the floor\n")
  const client = await RawClient.connect(server.home.socket)
  const reading = await start(client, server.home.dir)
  const readView = watchView(client, reading)
  await submit(client, reading, "read it")
  await readView.until(settled(1))
  expect(toolResults(readView)).toEqual([{ text: expect.stringContaining("the gnome lives"), isError: false }])
  const auto = (await client.call("conversation/start", { cwd: server.home.dir, approvals: "auto" })).result
    .conversation as string
  const autoView = watchView(client, auto)
  await submit(client, auto, "check it")
  await autoView.until(settled(1))
  expect(toolResults(autoView)).toEqual([{ text: "approved\n", isError: false }])
  expect(autoView.seen().some((entry) => entry.kind === "nisse.approval")).toBe(false)
  client.close()
})

test("start-with-id: starting a conversation with an id it already has answers with that conversation, and an all-digit id is refused by name", async () => {
  await using server = await runningServer([{ text: "hello" }])
  const client = await RawClient.connect(server.home.socket)
  const id = crypto.randomUUID()
  const first = await client.call("conversation/start", { id, cwd: "/work" })
  const again = await client.call("conversation/start", { id, cwd: "/elsewhere" })
  expect(first.result).toEqual({ conversation: id, model: { provider: "script", model: "script" } })
  expect(again.result).toEqual({ conversation: id, model: { provider: "script", model: "script" } })
  const view = watchView(client, id)
  await submit(client, id, "hi")
  await view.until(settled(1))
  expect((view.view().docs["pi.agent"] as { cwd?: string }).cwd).toBe("/work")
  expect(errorTag(await client.call("conversation/start", { id: "42", cwd: "/work" }))).toBe("InvalidConversationId")
  client.close()
})

const call = (name: string, input: Record<string, unknown>, agent?: string) => ({
  tool: { name, input },
  ...(agent === undefined ? {} : { agent }),
})
const mails = (watch: ViewWatch) =>
  watch
    .seen()
    .filter((entry) => entry.kind === "nisse.mail")
    .map((entry) => entry.data as { kind: string; task: string; sender: string })

test("start-with-id: a chosen id that names an object property, such as toString, opens its own conversation", async () => {
  await using server = await runningServer([{ text: "hello" }])
  const client = await RawClient.connect(server.home.socket)
  await client.call("conversation/start", { id: "first", cwd: "/work" })
  expect((await client.call("conversation/start", { id: "toString", cwd: "/work" })).result).toEqual({
    conversation: "toString",
    model: { provider: "script", model: "script" },
  })
  const view = watchView(client, "toString")
  await submit(client, "toString", "hi")
  await view.until(settled(1))
  expect(transcript(view.view().entries)).toEqual(["user: hi", "assistant: hello", "run_end: answered"])
  client.close()
})

test("child-tools, subagent-answer: the model spawns a subagent, waits for it, and its final answer is mailed back", async () => {
  await using server = await runningServer([
    call("spawn_agent", { task_name: "writer", message: "write a note", fork_turns: "none" }),
    call("wait_agent", { timeout_ms: 600_000 }),
    { text: "the note is written", agent: "/root/writer" },
    call("list_agents", {}),
    { text: "writer finished" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "delegate it")
  await view.until(settled(1), 20_000)
  const results = toolResults(view).map((result) => JSON.parse(result.text))
  expect(results[0]).toEqual({ task_name: "/root/writer", nickname: null })
  expect(results[1]).toEqual({ message: "Wait completed.", timed_out: false })
  expect(results[2]).toEqual({
    agents: [
      { agent_name: "/root", agent_status: "running" },
      { agent_name: "/root/writer", agent_status: { completed: "the note is written" } },
    ],
  })
  expect(mails(view)).toEqual([{ kind: "final_answer", task: "/root", sender: "/root/writer" }])
  // The answer reached the running turn as a message, and the turn went on with it.
  expect(transcript(view.seen()).slice(-2)).toEqual(["assistant: writer finished", "run_end: answered"])
  client.close()
}, 30_000)

/** The conversation of the subagent a spawn_agent call started, from its result's details. */
const spawned = (watch: ViewWatch, task: string) => {
  const result = watch
    .seen()
    .map((entry) => (entry.model?.[0] as { details?: { task?: string; conversation?: number } } | undefined)?.details)
    .find((details) => details?.task === task)
  return String(result!.conversation)
}

test("child-tools: a prompt queued while the model waits on a subagent does not end the wait, and runs after it", async () => {
  await using server = await runningServer([
    call("spawn_agent", { task_name: "writer", message: "write a note", fork_turns: "none" }),
    call("wait_agent", { timeout_ms: 600_000 }),
    { text: "writer finished" },
    { text: "now the next prompt" },
    { tool: { name: "bash", input: { command: "echo noted" } }, agent: "/root/writer" },
    { text: "the note is written", agent: "/root/writer" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "delegate it")
  // The writer holds on its approval, so the prompt below is queued while the parent's run goes on.
  await view.until((current) => toolResults(current).length > 0)
  const child = spawned(view, "/root/writer")
  const writer = watchView(client, child)
  const approval = await waitingApproval(writer)
  await submit(client, conversation, "and then this")
  await client.call("approval/resolve", { conversation: child, approval, author: "ada", allow: true })
  await view.until(settled(2), 20_000)
  expect(JSON.parse(toolResults(view)[1]!.text)).toEqual({ message: "Wait completed.", timed_out: false })
  expect(transcript(view.seen()).filter((line) => !line.startsWith("assistant: ") || line.includes("next"))).toEqual([
    "user: delegate it",
    "run_end: answered",
    "user: and then this",
    "assistant: now the next prompt",
    "run_end: answered",
  ])
  client.close()
}, 30_000)

test("child-tools, approval-auto: a subagent of a conversation that runs calls without asking does not ask either", async () => {
  await using server = await runningServer([
    call("spawn_agent", { task_name: "writer", message: "write a note", fork_turns: "none" }),
    call("wait_agent", { timeout_ms: 600_000 }),
    { text: "writer finished" },
    { tool: { name: "bash", input: { command: "echo noted" } }, agent: "/root/writer" },
    { text: "the note is written", agent: "/root/writer" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = (await client.call("conversation/start", { cwd: server.home.dir, approvals: "auto" })).result
    .conversation as string
  const view = watchView(client, conversation)
  await submit(client, conversation, "delegate it")
  await view.until(settled(1), 20_000)
  expect(mails(view)).toEqual([{ kind: "final_answer", task: "/root", sender: "/root/writer" }])
  const writer = watchView(client, spawned(view, "/root/writer"))
  await writer.until(() => true)
  expect(toolResults(writer)).toEqual([{ text: "noted\n", isError: false }])
  client.close()
}, 30_000)

test("subagent-types: spawning an agent of a type nisse doesn't know is refused, naming it", async () => {
  await using server = await runningServer([
    call("spawn_agent", { task_name: "review", message: "review it", agent_type: "reviewer" }),
    { text: "no reviewer" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "get it reviewed")
  await view.until(settled(1))
  expect(toolResults(view)).toEqual([{ text: "no agent type reviewer; there are none", isError: true }])
  client.close()
})

/** Six subagents `/root/a1`.. that each hold on an approval, and a seventh the limit refuses, spawned at once. */
const SEVEN = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"]
const holding = SEVEN.map((name) => ({
  tool: { name: "bash", input: { command: "echo held" } },
  agent: `/root/${name}`,
}))
const spawnSeven = {
  tools: SEVEN.map((name) => ({
    name: "spawn_agent",
    input: { task_name: name, message: "hold", fork_turns: "none" },
  })),
}
const MAX_THREADS = "at most 6 subagents work at once (maxThreads); 6 are working, so wait for one to finish"

test("subagent-limits, child-tools: spawns in one response start at most maxThreads subagents", async () => {
  await using server = await runningServer([spawnSeven, { text: "spawned them" }, ...holding])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "fan out")
  await view.until(settled(1), 20_000)
  const results = toolResults(view)
  expect(results.filter((result) => result.isError)).toEqual([{ text: MAX_THREADS, isError: true }])
  expect(results.filter((result) => !result.isError)).toHaveLength(6)
  client.close()
}, 30_000)

test("subagent-limits, child-tools: a follow-up task does not wake an idle subagent while maxThreads subagents work", async () => {
  await using server = await runningServer([
    call("spawn_agent", { task_name: "idle", message: "answer", fork_turns: "none" }),
    call("wait_agent", { timeout_ms: 600_000 }),
    { ...spawnSeven, tools: spawnSeven.tools.slice(0, 6) },
    call("followup_task", { target: "idle", message: "again" }),
    { text: "asked" },
    { text: "answered", agent: "/root/idle" },
    ...holding,
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "fan out")
  await view.until(settled(1), 20_000)
  const results = toolResults(view)
  expect(results.slice(2, 8).every((result) => !result.isError)).toBe(true)
  expect(results[8]).toEqual({ text: MAX_THREADS, isError: true })
  client.close()
}, 30_000)

test("child-tools: a subagent's answer that waits in its parent's queue still reaches it when the person stops the parent", async () => {
  await using server = await runningServer([
    {
      tools: [
        { name: "spawn_agent", input: { task_name: "writer", message: "write a note", fork_turns: "none" } },
        { name: "bash", input: { command: "echo waiting" } },
      ],
    },
    { text: "the note is written", agent: "/root/writer" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "delegate it")
  // The parent holds on its call's approval while the writer's answer queues behind it.
  await waitingApproval(view)
  await view.until((current) => ((current.view().docs["pi.inbox"] as { items?: unknown[] })?.items ?? []).length > 0)
  await client.call("conversation/interrupt", { conversation })
  await view.until((current) => mails(current).length > 0, 10_000)
  expect(mails(view)).toEqual([{ kind: "final_answer", task: "/root", sender: "/root/writer" }])
  expect(runEnds(view.seen()).map((end) => end.outcome)).toEqual(["interrupted"])
  client.close()
}, 30_000)

test("child-tools: a follow-up task reaches a working subagent at its next step, in the same run", async () => {
  await using server = await runningServer([
    call("spawn_agent", { task_name: "writer", message: "write a note", fork_turns: "none" }),
    call("followup_task", { target: "writer", message: "sign it too" }),
    { text: "asked" },
    { tool: { name: "bash", input: { command: "echo noted" } }, agent: "/root/writer" },
    { text: "written and signed", agent: "/root/writer" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "delegate it")
  await view.until((current) => toolResults(current).length > 0)
  const child = spawned(view, "/root/writer")
  const writer = watchView(client, child)
  const approval = await waitingApproval(writer)
  // The follow-up waits in the writer's queue while its call holds on the approval.
  await writer.until((current) => ((current.view().docs["pi.inbox"] as { items?: unknown[] })?.items ?? []).length > 0)
  await client.call("approval/resolve", { conversation: child, approval, author: "ada", allow: true })
  await writer.until(settled(1), 20_000)
  expect(mails(writer).map((mail) => mail.kind)).toEqual(["new_task", "new_task"])
  expect(transcript(writer.seen()).slice(-2)).toEqual(["assistant: written and signed", "run_end: answered"])
  expect(runEnds(writer.seen())).toHaveLength(1)
  client.close()
}, 30_000)

test("child-tools, subagent-message, subagent-followup: a subagent takes messages and follow-up tasks, and cannot start subagents past the depth limit", async () => {
  await using server = await runningServer([
    call("spawn_agent", { task_name: "helper", message: "first", fork_turns: "none" }),
    call("spawn_agent", { task_name: "deeper", message: "go" }, "/root/helper"),
    { text: "first done", agent: "/root/helper" },
    call("wait_agent", { timeout_ms: 600_000 }),
    call("send_message", { target: "helper", message: "fyi" }),
    call("followup_task", { target: "/root/helper", message: "second" }),
    call("wait_agent", { timeout_ms: 600_000 }),
    { text: "second done", agent: "/root/helper" },
    { text: "all done" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "delegate it")
  await view.until(settled(1), 20_000)
  const helper = watchView(client, spawned(view, "/root/helper"))
  await helper.until(settled(2), 20_000)
  expect(mails(view)).toEqual([
    { kind: "final_answer", task: "/root", sender: "/root/helper" },
    { kind: "final_answer", task: "/root", sender: "/root/helper" },
  ])
  expect(mails(helper)).toEqual([
    { kind: "new_task", task: "/root/helper", sender: "/root" },
    { kind: "message", task: "/root/helper", sender: "/root" },
    { kind: "new_task", task: "/root/helper", sender: "/root" },
  ])
  // At the depth limit the helper is not offered spawn_agent; its call is refused and it answers anyway.
  expect(toolResults(helper)).toEqual([{ text: expect.stringContaining("not available"), isError: true }])
  expect(transcript(helper.seen()).filter((line) => line.startsWith("assistant: ") && line !== "assistant: ")).toEqual([
    "assistant: first done",
    "assistant: second done",
  ])
  expect(transcript(view.seen()).slice(-2)).toEqual(["assistant: all done", "run_end: answered"])
  client.close()
}, 30_000)

test("child-tools, subagent-agents: interrupting a subagent stops its turn and reports what it was doing", async () => {
  await using server = await runningServer([
    call("spawn_agent", { task_name: "slow", message: "make it", fork_turns: "none" }),
    call("bash", { command: "echo ready" }),
    call("bash", { command: "touch made" }, "/root/slow"),
    call("interrupt_agent", { target: "slow" }),
    call("list_agents", {}),
    { text: "stopped it" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "start and stop")
  // The root waits on its own approval until the subagent waits on one too, so the subagent is working.
  const rootApproval = await waitingApproval(view)
  const slow = watchView(client, spawned(view, "/root/slow"))
  await waitingApproval(slow)
  await client.call("approval/resolve", { conversation, approval: rootApproval, author: "ada", allow: true })
  await view.until(settled(1), 20_000)
  await slow.until(settled(1), 20_000)
  const results = toolResults(view).map((result) => result.text)
  expect(JSON.parse(results[2]!)).toEqual({ previous_status: "running" })
  expect(JSON.parse(results[3]!).agents).toEqual([
    { agent_name: "/root", agent_status: "running" },
    { agent_name: "/root/slow", agent_status: "interrupted" },
  ])
  expect(runEnds(slow.seen())).toEqual([expect.objectContaining({ outcome: "interrupted" })])
  expect(approvalsOf(slow)!.requests).toEqual({})
  expect(await Bun.file(`${server.home.dir}/made`).exists()).toBe(false)
  client.close()
}, 30_000)

/** What the people in a conversation see of its calls: each call, each toast and each result, in order. */
const callsAndToasts = (watch: ViewWatch) =>
  watch.seen().flatMap((entry): Array<string> => {
    const message = entry.model?.[0] as
      | { content: Array<{ type: string; text?: string; name?: string; arguments?: unknown }>; isError?: boolean }
      | undefined
    if (entry.kind === TOAST_KIND) {
      const toast = entry.data as { extension: string; text: string }
      return [`toast ${toast.extension}: ${toast.text}`]
    }
    if (entry.kind === "pi.assistant")
      return message!.content.flatMap((block) =>
        block.type === "toolCall" ? [`call ${block.name} ${JSON.stringify(block.arguments)}`] : [],
      )
    if (entry.kind === "pi.tool-result") {
      const text = message!.content.map((block) => block.text ?? "").join("")
      return [`result${message!.isError ? " error" : ""}: ${text}`]
    }
    return []
  })
/** A result the harness wrote without running the call, as the model reads it. */
const notRun = (why: string) => `result error: <harness>\n[error] ${why}\n</harness>`
/** The results the harness wrote without running their calls. */
const whyNotRun = (watch: ViewWatch) =>
  callsAndToasts(watch).filter((line) => line.startsWith("result error: <harness>"))
const statusLines = (watch: ViewWatch) =>
  (watch.view().docs[STATUS_LINES_KIND] as { lines: Record<string, string> } | undefined)?.lines ?? {}
const startAuto = async (client: RawClient, cwd: string, id?: string) =>
  (await client.call("conversation/start", { cwd, approvals: "auto", ...(id === undefined ? {} : { id }) })).result
    .conversation as string

const clockAndNoGlob = `
import { Extension, Tool } from "@nisse/extension"
import { Effect, Schema } from "effect"

export default Extension.define((ctx) =>
  ctx.tool.transform((tools) => {
    tools.add(
      Tool.make({
        name: "Clock",
        description: "The time in " + String(ctx.options.city ?? "nowhere"),
        input: Schema.Struct({ zone: Schema.String }),
        readOnly: true,
        run: ({ zone }) => Effect.succeed(Tool.ok("noon in " + zone)),
      }),
    )
    tools.remove("glob")
    tools.update("read", (tool) => {
      tool.readOnly = false
    })
  }),
)
`

test("tools-transform, extensions-load: an extension's tool answers the model's calls, a tool it removes is gone, and one it makes not read-only asks", async () => {
  const home = homeWithExtensions({ "clock.ts": clockAndNoGlob }, `[extensions.clock]\ncity = "Oslo"\n`)
  await using server = await runningServer(
    [
      { tool: { name: "Clock", input: { zone: "CET" } } },
      { tool: { name: "glob", input: { pattern: "*" } } },
      { tool: { name: "read", input: { path: "notes.txt" } } },
      { text: "done" },
    ],
    { home },
  )
  await Bun.write(`${home.dir}/notes.txt`, "gnome\n")
  const client = await RawClient.connect(server.home.socket)
  expect((await client.call("extensions/list")).result).toEqual([
    { name: "clock", path: join(home.extensions, "clock.ts"), state: "loaded" },
  ])
  const conversation = await start(client, home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "what time is it")
  const approval = await waitingApproval(view)
  expect(approvalsOf(view)!.requests[approval]).toMatchObject({ tool: "read" })
  await client.call("approval/resolve", { conversation, approval, author: "ada", allow: true })
  await view.until(settled(1))
  expect(callsAndToasts(view)).toEqual([
    `call Clock {"zone":"CET"}`,
    "result: noon in CET",
    `call glob {"pattern":"*"}`,
    notRun("Tool glob is not available"),
    `call read {"path":"notes.txt"}`,
    "result: gnome\n",
  ])
  client.close()
  rmSync(home.dir, { recursive: true })
})

const guard = `
import { Extension, Tool } from "@nisse/extension"
import { Effect } from "effect"

export default Extension.define((ctx) =>
  Effect.gen(function* () {
    yield* ctx.tool.hook("execute.before", (call) =>
      Effect.gen(function* () {
        if (call.tool !== "bash") return
        const command = String((call.input as { command: string }).command)
        if (command.includes("rm -rf")) return yield* Tool.refuse("that deletes too much")
        call.input = { command: command.replace("hello", "hej") }
      }),
    )
    yield* ctx.tool.hook("execute.after", (call) =>
      Effect.gen(function* () {
        call.outcome.output = call.outcome.output.toUpperCase()
        yield* call.conversation.status(
          "ran " + call.tool + " in " + call.conversation.id + " at " + call.conversation.model.effort,
        )
        yield* call.conversation.toast(call.tool + " ran " + String((call.input as { command: string }).command))
      }),
    )
  }),
)
`

test("execute-before, execute-after, toast, status-line: an extension can refuse a call, change what runs and what the model sees, and tell every client", async () => {
  const home = homeWithExtensions({ "guard.ts": guard })
  await using server = await runningServer(
    [
      { tool: { name: "bash", input: { command: "rm -rf precious" } } },
      { tool: { name: "bash", input: { command: "echo hello" } } },
      { text: "done" },
    ],
    { home },
  )
  const client = await RawClient.connect(server.home.socket)
  const conversation = (
    await client.call("conversation/start", { cwd: home.dir, approvals: "auto", id: "guarded", effort: "high" })
  ).result.conversation as string
  const view = watchView(client, conversation)
  await submit(client, conversation, "clean up")
  await view.until(settled(1))
  expect(callsAndToasts(view)).toEqual([
    `call bash {"command":"rm -rf precious"}`,
    notRun("Tool call blocked: guard refused this call: that deletes too much"),
    `call bash {"command":"echo hello"}`,
    "toast guard: bash ran echo hej",
    "result: HEJ\n",
  ])
  expect(statusLines(view)).toEqual({ guard: "ran bash in guarded at high" })
  const other = await RawClient.connect(server.home.socket)
  const late = watchView(other, conversation)
  await opened(late)
  expect(statusLines(late)).toEqual({ guard: "ran bash in guarded at high" })
  client.close()
  other.close()
  rmSync(home.dir, { recursive: true })
})

test("subagent-root-env, tool-root-env: an extension's tool run by a subagent knows the conversation people started", async () => {
  const home = homeWithExtensions({
    "rooted.ts": `import { Extension, Tool } from "@nisse/extension"
import { Effect, Schema } from "effect"
export default Extension.define((ctx) =>
  ctx.tool.transform((tools) => {
    tools.add(
      Tool.make({
        name: "Root",
        description: "Says which conversation people started",
        input: Schema.Struct({}),
        readOnly: true,
        run: (_, context) => Effect.succeed(Tool.ok("root=" + context.env.NISSE_ROOT_CONVERSATION)),
      }),
    )
  }),
)`,
  })
  await using server = await runningServer(
    [
      { tool: { name: "spawn_agent", input: { task_name: "envy", message: "show your root", fork_turns: "none" } } },
      { tool: { name: "wait_agent", input: { timeout_ms: 600000 } } },
      { text: "envy answered" },
      { agent: "/root/envy", tool: { name: "Root", input: {} } },
      { agent: "/root/envy", text: "shown" },
    ],
    { home },
  )
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "delegate")
  await view.until(settled(1), 20_000)
  const child = watchView(client, spawned(view, "/root/envy"))
  await child.until(() => toolResults(child).length > 0)
  expect(toolResults(child).map((result) => result.text)).toEqual([`root=${conversation}`])
  client.close()
  rmSync(home.dir, { recursive: true })
}, 30_000)

test("extensions-failed, hook-failure: an extension that fails to load is listed with why, while the others load and run", async () => {
  const home = homeWithExtensions(
    {
      "broken.ts": `export default 42`,
      "crashes/index.ts": `import { Extension } from "@nisse/extension"
import { Effect } from "effect"
export default Extension.define((ctx) =>
  ctx.tool.hook("execute.before", () => Effect.die(new Error("the guard crashed"))),
)`,
      "off.ts": `throw new Error("a disabled extension never runs")`,
      "throws.ts": `throw new Error("the clock broke")`,
      "twisted.ts": `import { Extension } from "@nisse/extension"
import { Effect } from "effect"
export default Extension.define((ctx) =>
  Effect.gen(function* () {
    // Its edits before the transform that throws are dropped with it, so read stays.
    yield* ctx.tool.transform((tools) => tools.remove("read"))
    yield* ctx.tool.transform(() => { throw new Error("no such tool") })
    yield* ctx.tool.hook("execute.before", () => Effect.die(new Error("a failed extension never runs")))
  }),
)`,
      "bad name.ts": `export default 1`,
    },
    `[extensions.off]\nenabled = false\n`,
  )
  await using server = await runningServer(
    [{ tool: { name: "read", input: { path: "notes.txt" } } }, { text: "done" }],
    { home },
  )
  const client = await RawClient.connect(server.home.socket)
  expect((await client.call("extensions/list")).result).toEqual([
    {
      name: "bad name",
      path: join(home.extensions, "bad name.ts"),
      state: "failed",
      message: "an extension's name may use only letters, digits, - and _",
    },
    {
      name: "broken",
      path: join(home.extensions, "broken.ts"),
      state: "failed",
      message: "it exports no extension; export default Extension.define(...)",
    },
    { name: "crashes", path: join(home.extensions, "crashes", "index.ts"), state: "loaded" },
    { name: "off", path: join(home.extensions, "off.ts"), state: "disabled" },
    { name: "throws", path: join(home.extensions, "throws.ts"), state: "failed", message: "the clock broke" },
    {
      name: "twisted",
      path: join(home.extensions, "twisted.ts"),
      state: "failed",
      message: "its tool transform failed: no such tool",
    },
  ])
  const conversation = await start(client, home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "read it")
  await view.until(settled(1))
  expect(callsAndToasts(view)).toEqual([
    `call read {"path":"notes.txt"}`,
    "toast crashes: execute.before failed: the guard crashed",
    notRun("Tool call blocked: crashes refused this call: it failed: the guard crashed"),
  ])
  client.close()
  rmSync(home.dir, { recursive: true })
})

const statusSaying = (text: string) => `import { Extension } from "@nisse/extension"
export default Extension.define((ctx) =>
  ctx.tool.hook("execute.after", (call) => call.conversation.status("${text}")),
)`
const READ = [{ tool: { name: "read", input: { path: "notes.txt" } } }, { text: "done" }]

test("reload: reloading runs the extensions as they are now, and no status outlives the code that set it", async () => {
  const home = homeWithExtensions({ "lines.ts": statusSaying("first") })
  await Bun.write(`${home.dir}/notes.txt`, "gnome\n")
  const statusIn = async (client: RawClient, conversation: string) => {
    const watch = watchView(client, conversation)
    await opened(watch)
    return statusLines(watch)
  }
  let conversation: string
  {
    await using server = await runningServer([...READ, ...READ], { home })
    const client = await RawClient.connect(server.home.socket)
    conversation = await start(client, home.dir)
    const view = watchView(client, conversation)
    await submit(client, conversation, "read it")
    await view.until(settled(1))
    expect(await statusIn(client, conversation)).toEqual({ lines: "first" })

    writeFileSync(join(home.extensions, "lines.ts"), statusSaying("second"))
    expect((await client.call("extensions/reload")).result).toEqual([
      { name: "lines", path: join(home.extensions, "lines.ts"), state: "loaded" },
    ])
    expect(await statusIn(client, conversation)).toEqual({})
    await submit(client, conversation, "read it again")
    await view.until(settled(2))
    expect(await statusIn(client, conversation)).toEqual({ lines: "second" })
    client.close()
  }
  rmSync(join(home.extensions, "lines.ts"))
  {
    await using server = await runningServer([], { home })
    const client = await RawClient.connect(server.home.socket)
    expect(await statusIn(client, conversation)).toEqual({})
    client.close()
  }
  rmSync(home.dir, { recursive: true })
})

/**
 * A gate a test opens: the server runs in the test's process, so an extension waits on it by name, and the server's own
 * load and hook limits are its deadline.
 */
const gate = (name: string) => {
  const opened = Promise.withResolvers<void>()
  ;(globalThis as Record<string, unknown>)[name] = opened.promise
  return {
    open: () => opened.resolve(),
    [Symbol.dispose]: () => delete (globalThis as Record<string, unknown>)[name],
  }
}
const awaitGate = (name: string) => `Effect.promise(() => globalThis[${JSON.stringify(name)}])`

/** A signal the extension gives the test: it calls the function the test put under `name`. */
const signal = (name: string) => {
  const given = Promise.withResolvers<void>()
  ;(globalThis as Record<string, unknown>)[name] = given.resolve
  return {
    given: given.promise,
    [Symbol.dispose]: () => delete (globalThis as Record<string, unknown>)[name],
  }
}

/** A tool that runs until interrupted, then holds its abort open until the `release` gate opens. */
const hold = `import { Extension, Tool } from "@nisse/extension"
import { Effect, Schema } from "effect"
export default Extension.define((ctx) =>
  ctx.tool.transform((tools) => {
    tools.add(
      Tool.make({
        name: "Hold",
        description: "Holds until interrupted, then until released",
        input: Schema.Struct({}),
        readOnly: true,
        run: () =>
          Effect.andThen(
            Effect.sync(() => globalThis.holdStarted()),
            Effect.never.pipe(
              Effect.onInterrupt(() => Effect.andThen(Effect.sync(() => globalThis.holdAborting()), ${awaitGate("holdRelease")})),
            ),
          ),
      }),
    )
  }),
)`

test("queue-run, interrupt-withdraw: a prompt sent after an interrupt, while the run still stops, runs once it stopped", async () => {
  using started = signal("holdStarted")
  using aborting = signal("holdAborting")
  using release = gate("holdRelease")
  const home = homeWithExtensions({ "hold.ts": hold })
  await using server = await runningServer([{ tool: { name: "Hold", input: {} } }, { text: "late answer" }], { home })
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "go")
  await deadline(started.given, 5000, "Hold started")
  // The interrupt withdraws what waits now and answers once the run stopped, which the held tool delays.
  const interrupted = client.call("conversation/interrupt", { conversation })
  await deadline(aborting.given, 5000, "Hold interrupted")
  await submit(client, conversation, "late")
  release.open()
  await interrupted
  await view.until(settled(2))
  expect(transcript(view.view().entries)).toEqual([
    "user: go",
    "assistant: ",
    "run_end: interrupted (aborted)",
    "user: late",
    "assistant: late answer",
    "run_end: answered",
  ])
  client.close()
  rmSync(home.dir, { recursive: true })
})

const refusingAfter = (reason: string, loadsAfter?: string) => `import { Extension, Tool } from "@nisse/extension"
import { Effect } from "effect"
export default Extension.define((ctx) =>
  Effect.gen(function* () {
    ${loadsAfter === undefined ? "" : `yield* ${awaitGate(loadsAfter)}`}
    yield* ctx.tool.hook("execute.before", () => Tool.refuse("${reason}"))
  }),
)`

test("reload: while extensions reload, the loaded ones keep guarding calls until their replacements are ready", async () => {
  const home = homeWithExtensions({ "guard.ts": refusingAfter("the old guard says no") })
  const script = [{ tool: { name: "bash", input: { command: "echo hi" } } }, { text: "done" }]
  await using server = await runningServer([...script, ...script], { home })
  const client = await RawClient.connect(server.home.socket)
  const conversation = await startAuto(client, home.dir)
  const view = watchView(client, conversation)

  using ready = gate("nisseNewGuardReady")
  writeFileSync(join(home.extensions, "guard.ts"), refusingAfter("the new guard says no", "nisseNewGuardReady"))
  const reloading = client.call("extensions/reload")
  await submit(client, conversation, "say hi")
  await view.until(settled(1))
  expect(whyNotRun(view)).toEqual([notRun("Tool call blocked: guard refused this call: the old guard says no")])

  ready.open()
  expect((await reloading).result).toEqual([
    { name: "guard", path: join(home.extensions, "guard.ts"), state: "loaded" },
  ])
  await submit(client, conversation, "say hi again")
  await view.until(settled(2))
  expect(whyNotRun(view)).toEqual([
    notRun("Tool call blocked: guard refused this call: the old guard says no"),
    notRun("Tool call blocked: guard refused this call: the new guard says no"),
  ])
  client.close()
  rmSync(home.dir, { recursive: true })
})

test("status-line: a hook still running when its extension is unloaded can't bring back a status line", async () => {
  const home = homeWithExtensions({})
  await Bun.write(`${home.dir}/notes.txt`, "gnome\n")
  using released = gate("nisseSlowReleased")
  writeFileSync(
    join(home.extensions, "slow.ts"),
    `import { Extension } from "@nisse/extension"
import { Effect } from "effect"
export default Extension.define((ctx) =>
  ctx.tool.hook("execute.after", (call) =>
    Effect.gen(function* () {
      yield* ${awaitGate("nisseSlowReleased")}
      yield* call.conversation.status("stale")
    }),
  ),
)`,
  )
  await using server = await runningServer(READ, { home })
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "read it")
  await view.until((watch) => watch.seen().some((entry) => entry.kind === "pi.assistant"))

  rmSync(join(home.extensions, "slow.ts"))
  expect((await client.call("extensions/reload")).result).toEqual([])
  released.open()
  await view.until(settled(1))
  expect(statusLines(view)).toEqual({})
  client.close()
  rmSync(home.dir, { recursive: true })
})

const rewriting = (command: string) => `import { Extension } from "@nisse/extension"
import { Effect } from "effect"
export default Extension.define((ctx) =>
  ctx.tool.hook("execute.before", (call) => Effect.sync(() => { call.input = { command: "${command}" } })),
)`

test("approval-restart, status-snapshot: a call waiting for approval across a restart, whose hook computes other arguments on the rerun, asks again with them", async () => {
  const home = homeWithExtensions({ "rewrite.ts": rewriting("echo one") })
  let conversation: string
  let approval: string
  {
    await using server = await runningServer(
      [{ tool: { name: "bash", input: { command: "echo model" } } }, { text: "done" }],
      { home },
    )
    const client = await RawClient.connect(server.home.socket)
    conversation = await start(client, home.dir)
    const view = watchView(client, conversation)
    await submit(client, conversation, "say it")
    approval = await waitingApproval(view)
    expect(approvalsOf(view)!.requests[approval]).toMatchObject({ arguments: { command: "echo one" } })
    client.close()
  }
  writeFileSync(join(home.extensions, "rewrite.ts"), rewriting("echo two"))
  {
    await using server = await runningServer([{ text: "done" }], { home })
    const client = await RawClient.connect(server.home.socket)
    const view = watchView(client, conversation)
    const asked = (watch: ViewWatch) => approvalsOf(watch)?.requests[approval] as { arguments?: unknown } | undefined
    await view.until((watch) => JSON.stringify(asked(watch)?.arguments) === `{"command":"echo two"}`)
    const status = client.watch<Trees>("status/watch")
    await status.until((items) => items.length > 0)
    expect(status.items[0]).toMatchObject({ _tag: "trees", trees: [{ conversation, status: "waiting" }] })
    expect(asked(view)).not.toHaveProperty("answer")
    await client.call("approval/resolve", { conversation, approval, author: "ada", allow: true })
    await view.until(settled(1))
    expect(toolResults(view)).toEqual([{ text: "two\n", isError: false }])
    client.close()
  }
  rmSync(home.dir, { recursive: true })
})

test("reload: a config.toml that stops reading fails every extension in a reload, and says why", async () => {
  const home = homeWithExtensions({ "lines.ts": statusSaying("first") })
  await using server = await runningServer([], { home })
  const client = await RawClient.connect(server.home.socket)
  writeFileSync(join(home.dir, "config.toml"), "[extensions.lines\n")
  const [lines] = (await client.call("extensions/reload")).result as Array<{ state: string; message: string }>
  expect(lines).toMatchObject({ state: "failed", message: expect.stringContaining(`${home.dir}/config.toml: `) })
  expect((await client.call("extensions/list")).result).toEqual([lines])
  client.close()
  rmSync(home.dir, { recursive: true })
})

const treesOf = (items: ReadonlyArray<Trees>, conversation: string) =>
  items.filter((item): item is Tree => item._tag === "tree" && item.conversation === conversation)

test("status-follow, status-ended: watching status follows each run of a tree and says how it ended", async () => {
  await using server = await runningServer([{ text: "all done" }, { text: "again" }])
  const client = await RawClient.connect(server.home.socket)
  const watch = client.watch<Trees>("status/watch")
  await watch.until((items) => items.length > 0)
  expect(watch.items[0]).toMatchObject({ _tag: "trees", trees: [] })
  const conversation = (await client.call("conversation/start", { cwd: "/work", id: "followed" })).result
    .conversation as string
  await submit(client, conversation, "go")
  await watch.until((items) => treesOf(items, conversation).some((tree) => tree.ended))
  await submit(client, conversation, "go again")
  await watch.until((items) => treesOf(items, conversation).filter((tree) => tree.ended).length === 2)

  const seen = treesOf(watch.items, conversation)
  expect(seen.map(({ status, ended }) => ({ status, ended }))).toEqual([
    { status: "working", ended: undefined },
    { status: "idle", ended: { outcome: "answered", said: "all done" } },
    { status: "working", ended: undefined },
    { status: "idle", ended: { outcome: "answered", said: "again" } },
  ])
  const seqs = seen.map((tree) => tree.seq)
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
  expect(new Set(seqs).size).toBe(4)
  client.close()
})

test("status-subagent, status-snapshot: a subagent waiting on a person shows as its whole tree waiting, to watchers then and later", async () => {
  await using server = await runningServer([
    call("spawn_agent", { task_name: "writer", message: "write a note", fork_turns: "none" }),
    call("wait_agent", { timeout_ms: 600_000 }),
    { tool: { name: "bash", input: { command: "echo noted" } }, agent: "/root/writer" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const watch = client.watch<Trees>("status/watch")
  await watch.until((items) => items.length > 0)
  const conversation = await start(client, server.home.dir)
  await submit(client, conversation, "have someone write a note")
  await watch.until((items) => treesOf(items, conversation).at(-1)?.status === "waiting", 20_000)

  const late = await RawClient.connect(server.home.socket)
  const lateWatch = late.watch<Trees>("status/watch")
  await lateWatch.until((items) => items.length > 0)
  expect(lateWatch.items[0]).toMatchObject({
    _tag: "trees",
    trees: [{ _tag: "tree", conversation, status: "waiting" }],
  })
  expect(treesOf(watch.items, conversation).map((tree) => tree.status)).toEqual(["working", "waiting"])
  // One interrupt of the root stops its subagent too, so the whole tree goes idle.
  await client.call("conversation/interrupt", { conversation })
  await watch.until((items) => treesOf(items, conversation).at(-1)?.status === "idle", 20_000)
  const ended = treesOf(watch.items, conversation).filter((tree) => tree.ended)
  expect(ended.map((tree) => tree.ended)).toEqual([{ outcome: "interrupted", message: "aborted" }])
  client.close()
  late.close()
}, 30_000)

test("submit-author, queue-shared: every client sees who wrote each prompt, while it waits and once it runs", async () => {
  await using server = await runningServer([{ text: "the first answer", delayMs: 100 }, { text: "second answer" }])
  const ada = await RawClient.connect(server.home.socket)
  const bo = await RawClient.connect(server.home.socket)
  const conversation = await start(ada)
  const view = watchView(bo, conversation)
  await submit(ada, conversation, "one", undefined, "ada")
  await view.until(speaking)
  await submit(bo, conversation, "two", undefined, "bo")
  await view.until((watch) => ((watch.view().docs["pi.inbox"] as { items?: unknown[] })?.items ?? []).length > 0)
  expect((view.view().docs["pi.inbox"] as { items: unknown[] }).items).toEqual([
    expect.objectContaining({ entry: { kind: USER_KIND, data: expect.objectContaining({ author: "bo" }) } }),
  ])
  await view.until(settled(2))
  const users = view.seen().filter((entry) => entry.kind === USER_KIND)
  expect(users.map((entry) => (entry.data as { author: string }).author)).toEqual(["ada", "bo"])
  expect(transcript(view.seen()).filter((line) => line.startsWith("user: "))).toEqual(["user: one", "user: two"])
  ada.close()
  bo.close()
})

test("subagent-limits: a tree runs at most as many subagents at once as config.toml allows", async () => {
  await using server = await runningServer([spawnSeven, { text: "spawned them" }, ...holding], {
    config: { agents: { max_threads: 2 } },
  })
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "fan out")
  await view.until(settled(1), 20_000)
  const results = toolResults(view)
  expect(results.filter((result) => !result.isError)).toHaveLength(2)
  expect(results.filter((result) => result.isError)).toHaveLength(5)
  expect(results.find((result) => result.isError)?.text).toContain("at most 2 subagents work at once (maxThreads)")
  client.close()
}, 30_000)

const idle = (watch: ViewWatch) => (watch.view().docs["pi.live"] as { run?: unknown } | undefined)?.run === undefined

test("subagent-interrupt: interrupting a conversation stops the runs of its subagents too, and the tree goes idle", async () => {
  await using server = await runningServer([
    call("spawn_agent", { task_name: "slow", message: "make it", fork_turns: "none" }),
    call("wait_agent", { timeout_ms: 600_000 }),
    call("bash", { command: "touch made" }, "/root/slow"),
    call("list_agents", {}),
    call("followup_task", { target: "slow", message: "try again" }),
    call("wait_agent", { timeout_ms: 600_000 }),
    { text: "made it this time", agent: "/root/slow" },
    { text: "slow is done" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "start a slow one")
  await view.until((current) => toolResults(current).length > 0)
  const slow = watchView(client, spawned(view, "/root/slow"))
  // The subagent waits on a person while its parent waits on it.
  await waitingApproval(slow)

  await client.call("conversation/interrupt", { conversation })
  await view.until(settled(1), 10_000)
  await slow.until(settled(1), 10_000)

  expect(runEnds(view.seen()).map((end) => end.outcome)).toEqual(["interrupted"])
  expect(runEnds(slow.seen()).map((end) => end.outcome)).toEqual(["interrupted"])
  expect(approvalsOf(slow)!.requests).toEqual({})
  await view.until(idle)
  await slow.until(idle)
  expect(await Bun.file(`${server.home.dir}/made`).exists()).toBe(false)

  // The subagent stays in the tree, and takes a new task.
  await submit(client, conversation, "go on")
  await view.until(settled(2), 20_000)
  expect(JSON.parse(toolResults(view).at(-3)!.text).agents).toEqual([
    { agent_name: "/root", agent_status: "running" },
    { agent_name: "/root/slow", agent_status: "interrupted" },
  ])
  expect(transcript(slow.seen()).slice(-2)).toEqual(["assistant: made it this time", "run_end: answered"])
  expect(mails(view)).toEqual([{ kind: "final_answer", task: "/root", sender: "/root/slow" }])
  expect(transcript(view.seen()).slice(-2)).toEqual(["assistant: slow is done", "run_end: answered"])
  client.close()
}, 30_000)

type Listed = {
  id: string
  number: number
  title?: string
  cwd: string
  model: { provider: string; model?: string; effort?: string }
  approvals: string
  lineage?: Record<string, string>
  instructions?: string
  ended?: { outcome: string; message?: string; said?: string }
}
const list = async (client: RawClient) => {
  const reply = await client.call("conversation/list")
  if (reply.error !== undefined) throw new Error(JSON.stringify(reply.error))
  return reply.result as Array<Listed>
}

test("subagent-spawn, subagent-model: conversation/list shows each subagent with its lineage, on its parent's model or the one its spawn_agent names, and an unlisted model fails the call", async () => {
  await using server = await runningServer([
    call("spawn_agent", { task_name: "same", message: "go", fork_turns: "none" }),
    call("spawn_agent", { task_name: "other", message: "go", fork_turns: "none", model: "script-code-mode" }),
    call("spawn_agent", { task_name: "nope", message: "go", fork_turns: "none", model: "no-such-model" }),
    { text: "spawned" },
    { text: "same done", agent: "/root/same" },
    { text: "other done", agent: "/root/other" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = (
    await client.call("conversation/start", { cwd: server.home.dir, id: "lead", instructions: "Be brief." })
  ).result.conversation as string
  const view = watchView(client, conversation)
  await submit(client, conversation, "delegate")
  await view.until(settled(1), 20_000)
  const same = watchView(client, spawned(view, "/root/same"))
  const other = watchView(client, spawned(view, "/root/other"))
  await same.until(settled(1), 20_000)
  await other.until(settled(1), 20_000)
  expect(toolResults(view)[2]).toEqual({
    text: expect.stringContaining("no model no-such-model on script"),
    isError: true,
  })
  const calls = view
    .seen()
    .filter((entry) => entry.kind === "pi.assistant")
    .flatMap((entry) => (entry.model![0] as { content: Array<{ type: string; id?: string }> }).content)
    .filter((block) => block.type === "toolCall")
    .map((block) => block.id!)
  const listed = await list(client)
  expect(listed).toEqual([
    {
      id: "lead",
      number: expect.any(Number),
      title: "delegate",
      cwd: server.home.dir,
      model: { provider: "script", model: "script" },
      approvals: "ask",
      instructions: "Be brief.",
      ended: { outcome: "answered", said: "spawned" },
    },
    {
      id: spawned(view, "/root/same"),
      number: Number(spawned(view, "/root/same")),
      title: "same",
      cwd: server.home.dir,
      model: { provider: "script", model: "script" },
      approvals: "ask",
      lineage: { parent: "lead", root: "lead", call: calls[0]!, title: "same", task: "/root/same" },
      ended: { outcome: "answered", said: "same done" },
    },
    {
      id: spawned(view, "/root/other"),
      number: Number(spawned(view, "/root/other")),
      title: "other",
      cwd: server.home.dir,
      model: { provider: "script", model: "script-code-mode" },
      approvals: "ask",
      lineage: { parent: "lead", root: "lead", call: calls[1]!, title: "other", task: "/root/other" },
      ended: { outcome: "answered", said: "other done" },
    },
  ])
  client.close()
}, 30_000)

test("model-switch, model-switch-provider: switching a conversation's model is recorded with who switched it, and the next run answers on it", async () => {
  await using server = await runningServer([{ text: "first" }, { text: "second" }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "one")
  await view.until(settled(1))
  const selection = { provider: "script", model: "script-code-mode", effort: "low" }
  expect((await client.call("conversation/select_model", { conversation, author: "bo", selection })).error).toBe(
    undefined,
  )
  await submit(client, conversation, "two")
  await view.until(settled(2))
  const switched = view.seen().filter((entry) => entry.kind === "nisse.model")
  expect(switched.map((entry) => entry.data)).toEqual([{ author: "bo", selection }])
  const answers = view.seen().filter((entry) => entry.kind === "pi.assistant")
  expect(answers.map((entry) => (entry.model![0] as { model: string }).model)).toEqual(["script", "script-code-mode"])
  expect((await list(client))[0]!.model).toEqual(selection)
  const unknown = await client.call("conversation/select_model", {
    conversation,
    author: "bo",
    selection: { provider: "nowhere" },
  })
  expect(errorTag(unknown)).toBe("UnknownProvider")
  client.close()
})

test("model-switch: a switch made while a run works is recorded at once and answers from the next run, not mid-run", async () => {
  await using server = await runningServer([...ECHO, { text: "next" }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "check it")
  const approval = await waitingApproval(view)
  const selection = { provider: "script", model: "script-code-mode" }
  expect((await client.call("conversation/select_model", { conversation, author: "bo", selection })).error).toBe(
    undefined,
  )
  await view.until((current) => current.seen().some((entry) => entry.kind === "nisse.model"))
  await client.call("approval/resolve", { conversation, approval, author: "ada", allow: true })
  await view.until(settled(1))
  await submit(client, conversation, "again")
  await view.until(settled(2))
  const answers = view.seen().filter((entry) => entry.kind === "pi.assistant")
  expect(answers.map((entry) => (entry.model![0] as { model: string }).model)).toEqual([
    "script",
    "script",
    "script-code-mode",
  ])
  expect((await list(client))[0]!.model).toEqual(selection)
  client.close()
})

test("entries-rpc: a client reads a long transcript a page at a time, newest first or in order from an entry", async () => {
  await using server = await runningServer([{ text: "a" }, { text: "b" }, { text: "c" }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  for (const [index, text] of ["one", "two", "three"].entries()) {
    await submit(client, conversation, text)
    await view.until(settled(index + 1))
  }
  const all = view.seen()
  const page = async (args: Record<string, unknown>) =>
    (await client.call("conversation/entries", { conversation, ...args })).result as {
      entries: typeof all
      next?: unknown
    }
  const pages: Array<typeof all> = []
  let cursor: unknown
  do {
    const read = await page({ limit: 4, ...(cursor === undefined ? {} : { cursor }) })
    pages.push(read.entries)
    cursor = read.next
  } while (cursor !== undefined)
  expect(pages.length).toBe(Math.ceil(all.length / 4))
  expect(pages.flat()).toEqual([...all].reverse())
  const two = all.findIndex((entry) => transcript([entry])[0] === "user: two")
  const middle = await page({ from: all[two]!.id, to: all[two + 2]!.id, order: "ascending", limit: 10 })
  expect(transcript(middle.entries)).toEqual(["user: two", "assistant: b", "run_end: answered"])
  expect(middle.next).toBeUndefined()
  const refused = await client.call("conversation/entries", { conversation, limit: 0 })
  expect(refused.error?.message).toContain("limit")
  expect(errorTag(await client.call("conversation/entries", { conversation: "99", limit: 1 }))).toBe(
    "NoSuchConversation",
  )
  client.close()
})

test("context-rpc: a client reads the exact context the model is sent, now or as it was at an entry", async () => {
  await using server = await runningServer([{ text: "a" }, { text: "b" }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const other = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "one")
  await view.until(settled(1))
  await submit(client, conversation, "two")
  await view.until(settled(2))
  const context = async (at?: number) =>
    (await client.call("conversation/context", { conversation, ...(at === undefined ? {} : { at }) })).result as {
      messages: Array<{ role: string; content: unknown }>
      entries: Array<number>
    }
  const roles = (read: { messages: Array<{ role: string }> }) => read.messages.map((message) => message.role)
  const now = await context()
  expect(roles(now).filter((role) => role !== "system")).toEqual(["user", "assistant", "user", "assistant"])
  const firstAnswer = view.seen().find((entry) => entry.kind === "pi.assistant")!.id
  const then = await context(firstAnswer)
  expect(roles(then).filter((role) => role !== "system")).toEqual(["user", "assistant"])
  expect(then.entries.at(-1)).toBe(firstAnswer)
  const foreign = watchView(client, other)
  await opened(foreign)
  await submit(client, other, "elsewhere")
  await foreign.until(settled(1))
  const notHere = await client.call("conversation/context", { conversation, at: foreign.seen()[0]!.id })
  expect(errorTag(notHere)).toBe("NoSuchEntry")
  client.close()
})

test("wire-malformed: a call missing a field is answered with an error that names it, and the connection goes on", async () => {
  await using server = await runningServer([{ text: "fine" }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const missing = await client.call("conversation/submit", { conversation, requestId: "r", author: "ada" })
  // It names the field in words, not in the cause encoded as JSON.
  expect(missing.error?.message).toContain("text")
  expect(missing.error?.message).not.toContain('"_tag"')
  const view = watchView(client, conversation)
  await submit(client, conversation, "hi")
  await view.until(settled(1))
  expect(transcript(view.view().entries)).toEqual(["user: hi", "assistant: fine", "run_end: answered"])
  client.close()
})

test("wire-errors: every error a call answers says what went wrong in its message, a fault included, and keeps the cause in its data", async () => {
  await using server = await runningServer([{ text: "fine" }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const replies = {
    noConversation: await client.call("conversation/continue", { conversation: "nope" }),
    noSubmission: await client.call("submission/withdraw", { conversation, submission: 9999 }),
    noEntry: await client.call("conversation/fork", { conversation, at: 9999 }),
    badParams: await client.call("conversation/configure", { conversation, author: "ada", maxTurns: 0 }),
    noMethod: await client.call("conversation/frobnicate", {}),
  }
  expect(Object.fromEntries(Object.entries(replies).map(([name, reply]) => [name, reply.error?.message]))).toEqual({
    noConversation: "no conversation nope",
    noSubmission: "the conversation has no submission 9999",
    noEntry: "the conversation's transcript has no entry 9999",
    // The fault's own words, which Effect writes: what nisse promises is that they name the thing, not their wording.
    badParams: expect.stringContaining("maxTurns"),
    noMethod: expect.stringContaining("conversation/frobnicate"),
  })
  for (const reply of [replies.badParams, replies.noMethod]) expect(reply.error?.message).not.toContain('"_tag"')
  expect(errorTag(replies.noConversation)).toBe("NoSuchConversation")
  expect(replies.badParams.error?.data).toEqual([{ _tag: "Die", defect: expect.stringContaining("maxTurns") }])
  client.close()
})

test("approval-ask: a call that changes things waits for a person, and every client sees what it asks and that the tree waits", async () => {
  await using server = await runningServer(ECHO)
  const client = await RawClient.connect(server.home.socket)
  const status = client.watch<Trees>("status/watch")
  await status.until((items) => items.length > 0)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "check it")
  const approval = await waitingApproval(view)
  expect(approvalsOf(view)!.requests[approval]).toMatchObject({ tool: "bash", arguments: { command: "echo approved" } })
  await status.until((items) => treesOf(items, conversation).at(-1)?.status === "waiting")
  await client.call("approval/resolve", { conversation, approval, author: "ada", allow: true })
  await view.until(settled(1))
  client.close()
})

test("conversation-ended: conversation/list tells a client that was not watching how a conversation's last run ended, also after a restart", async () => {
  const home = tempHome()
  try {
    let conversation: string
    {
      await using server = await runningServer(
        [{ text: "all done" }, { text: "Writing the note.", tool: { name: "bash", input: { command: "echo hi" } } }],
        { home },
      )
      const client = await RawClient.connect(server.home.socket)
      conversation = await start(client, home.dir)
      const endedOf = async () => (await list(client)).find((listed) => listed.id === conversation)?.ended
      expect(await endedOf()).toBeUndefined()
      const view = watchView(client, conversation)
      await submit(client, conversation, "go")
      await view.until(settled(1))
      expect(await endedOf()).toEqual({ outcome: "answered", said: "all done" })
      await submit(client, conversation, "write a note")
      await waitingApproval(view)
      expect(await endedOf()).toEqual({ outcome: "answered", said: "all done" })
      await client.call("conversation/interrupt", { conversation })
      await view.until(settled(2))
      expect(await endedOf()).toEqual({ outcome: "interrupted", message: "aborted", said: "Writing the note." })
      client.close()
    }
    await using server = await runningServer([], { home })
    const client = await RawClient.connect(server.home.socket)
    expect((await list(client)).find((listed) => listed.id === conversation)?.ended).toEqual({
      outcome: "interrupted",
      message: "aborted",
      said: "Writing the note.",
    })
    client.close()
  } finally {
    rmSync(home.dir, { recursive: true, force: true })
  }
})

test("reopen-continue: a conversation reopened from a new server and connection goes on with a new prompt", async () => {
  const home = tempHome()
  try {
    let conversation: string
    {
      await using server = await runningServer([{ text: "before" }], { home })
      const client = await RawClient.connect(server.home.socket)
      conversation = await start(client, home.dir)
      const view = watchView(client, conversation)
      await submit(client, conversation, "one")
      await view.until(settled(1))
      client.close()
    }
    await using server = await runningServer([{ text: "after" }], { home })
    const client = await RawClient.connect(server.home.socket)
    const view = watchView(client, conversation)
    await opened(view)
    await submit(client, conversation, "two")
    await view.until(settled(2))
    expect(transcript(view.view().entries)).toEqual([
      "user: one",
      "assistant: before",
      "run_end: answered",
      "user: two",
      "assistant: after",
      "run_end: answered",
    ])
    client.close()
  } finally {
    rmSync(home.dir, { recursive: true, force: true })
  }
})

/** Every state the view went through, in order: the first view and each change applied to it. */
const states = (watch: ViewWatch) => {
  const views: Array<View> = []
  for (const item of watch.items) {
    views.push(item._tag === "view" ? item.view : applyImmutable(views.at(-1), item.ops as ReadonlyArray<Op>))
  }
  return views
}
type Slot = { callId: string; status: string; output?: string }
const liveSlots = (view: View) => (view.docs["pi.live"] as { tools?: Array<Slot> } | undefined)?.tools ?? []
/** Each running call's live output, in every state the view went through. */
const liveOutputs = (watch: ViewWatch) =>
  states(watch).flatMap((view) => liveSlots(view).flatMap((slot) => (slot.output === undefined ? [] : [slot.output])))
/** A shell loop that waits until the test makes `file`, so a command's next step follows what the test saw. */
const waitFor = (file: string) => `while [ ! -e ${file} ]; do sleep 0.01; done`
const workdir = (home: { dir: string }) => {
  const dir = `${home.dir}/work`
  mkdirSync(dir)
  return dir
}

test("tool-output-live: a running command's output streams live and ends as its result", async () => {
  await using server = await runningServer([
    { tool: { name: "bash", input: { command: `echo first; ${waitFor("go")}; echo second` } } },
    { text: "done" },
  ])
  const cwd = workdir(server.home)
  const client = await RawClient.connect(server.home.socket)
  const conversation = await startAuto(client, cwd)
  const view = watchView(client, conversation)
  await submit(client, conversation, "run it")
  await view.until((current) => liveSlots(current.view()).some((slot) => slot.output === "first\n"))
  expect(runEnds(view.seen())).toEqual([])
  writeFileSync(`${cwd}/go`, "")
  await view.until(settled(1))
  expect(toolResults(view)).toEqual([{ text: "first\nsecond\n", isError: false }])
  expect(liveSlots(view.view()).every((slot) => slot.output === undefined)).toBe(true)
  client.close()
})

test("tool-output-live: a command's output keeps characters split across reads and between streams whole", async () => {
  await using server = await runningServer([
    {
      tool: {
        name: "bash",
        input: { command: "printf '\\342'; sleep 0.1; printf 'err\\n' >&2; sleep 0.1; printf '\\202\\254\\n'" },
      },
    },
    { text: "done" },
  ])
  const cwd = workdir(server.home)
  const client = await RawClient.connect(server.home.socket)
  const conversation = await startAuto(client, cwd)
  const view = watchView(client, conversation)
  await submit(client, conversation, "euro")
  await view.until(settled(1))
  expect(toolResults(view)).toEqual([{ text: "err\n€\n", isError: false }])
  expect(liveOutputs(view).some((output) => output.includes("�"))).toBe(false)
  client.close()
})

test("tool-output-live: a verbose command's live output stays a bounded tail", async () => {
  await using server = await runningServer([
    {
      tool: { name: "bash", input: { command: `head -c 2000000 /dev/zero | tr '\\0' x; echo end; ${waitFor("go")}` } },
    },
    { text: "done" },
  ])
  const cwd = workdir(server.home)
  const client = await RawClient.connect(server.home.socket)
  const conversation = await startAuto(client, cwd)
  const view = watchView(client, conversation)
  await submit(client, conversation, "flood")
  await view.until((current) => liveSlots(current.view()).some((slot) => slot.output?.endsWith("end\n")))
  writeFileSync(`${cwd}/go`, "")
  await view.until(settled(1))
  const outputs = liveOutputs(view)
  expect(Math.max(...outputs.map((output) => Buffer.byteLength(output)))).toBeLessThanOrEqual(DEFAULT_MAX_BYTES)
  // The model gets the same tail, and is told how much was dropped.
  expect(toolResults(view)[0]!.text).toMatch(
    /^x+end\n<harness>\n.*\n\[warn\] Output truncated to its end: 0 lines, \d+ bytes dropped\n<\/harness>$/,
  )
  client.close()
})

test("tool-output-live: output a background process writes after its call ends never reaches the conversation", async () => {
  await using server = await runningServer([
    // The call's output pipe is closed once it ends, so the late echo fails (SIGPIPE, ignored here) and the process
    // still marks that it tried.
    {
      tool: {
        name: "bash",
        input: { command: `(trap '' PIPE; ${waitFor("go")}; echo late; touch wrote) & echo now` },
      },
    },
    { tool: { name: "bash", input: { command: waitFor("wrote") } } },
    { text: "done" },
  ])
  const cwd = workdir(server.home)
  const client = await RawClient.connect(server.home.socket)
  const conversation = await startAuto(client, cwd)
  const view = watchView(client, conversation)
  await submit(client, conversation, "background")
  await view.until((current) => toolResults(current).length > 0)
  writeFileSync(`${cwd}/go`, "")
  await view.until(settled(1))
  expect(toolResults(view)).toEqual([
    { text: "now\n", isError: false },
    { text: expect.not.stringContaining("late"), isError: false },
  ])
  expect(liveOutputs(view).some((output) => output.includes("late"))).toBe(false)
  client.close()
})

test("tool-grep-lines: grep reports only the lines a file has, whatever its line endings", async () => {
  await using server = await runningServer([{ tool: { name: "grep", input: { pattern: "^$" } } }, { text: "done" }])
  const cwd = workdir(server.home)
  await Bun.write(`${cwd}/notes.txt`, "alpha\n\nbeta\n")
  await Bun.write(`${cwd}/windows.txt`, "alpha\r\n\r\nbeta\r\n")
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, cwd)
  const view = watchView(client, conversation)
  await submit(client, conversation, "blank lines")
  await view.until(settled(1))
  expect(toolResults(view)).toEqual([{ text: "notes.txt:2:\nwindows.txt:2:", isError: false }])
  client.close()
})

test("approval-interrupt: interrupting while nisse waits for an answer withdraws the question", async () => {
  await using server = await runningServer([{ tool: { name: "bash", input: { command: "touch made" } } }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "make it")
  const approval = await waitingApproval(view)
  await client.call("conversation/interrupt", { conversation })
  await view.until(settled(1))
  expect(approvalsOf(view)!.requests).toEqual({})
  expect(runEnds(view.seen()).map((end) => end.outcome)).toEqual(["interrupted"])
  const late = await client.call("approval/resolve", { conversation, approval, author: "ada", allow: true })
  expect(late.result).toEqual({ accepted: false })
  expect(await Bun.file(`${server.home.dir}/made`).exists()).toBe(false)
  client.close()
})

test("steer-wire, steer-place: a steering prompt reaches nisse during the run instead of after it", async () => {
  await using server = await runningServer([
    { tool: { name: "bash", input: { command: waitFor("go") } } },
    { text: "steered" },
  ])
  const cwd = workdir(server.home)
  const client = await RawClient.connect(server.home.socket)
  const conversation = await startAuto(client, cwd)
  const view = watchView(client, conversation)
  await submit(client, conversation, "start")
  await view.until((current) => liveSlots(current.view()).some((slot) => slot.status === "running"))
  await submit(client, conversation, "also do this", crypto.randomUUID(), "ada", true)
  writeFileSync(`${cwd}/go`, "")
  await view.until(settled(1))
  expect(callsAndToasts(view)).toEqual([expect.stringContaining("call bash"), "result: "])
  expect(transcript(view.view().entries)).toEqual([
    "user: start",
    "assistant: ",
    "user: also do this",
    "assistant: steered",
    "run_end: answered",
  ])
  client.close()
})

test("subagent-answer: a subagent's answer reaches its idle parent as input that starts a run, so the parent acts on it", async () => {
  await using server = await runningServer([
    call("spawn_agent", { task_name: "kid", message: "look around", fork_turns: "none" }),
    { text: "asked the kid" },
    { tool: { name: "bash", input: { command: "echo looked" } }, agent: "/root/kid" },
    { text: "all quiet", agent: "/root/kid" },
    { text: "the kid says all quiet" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "ask the kid")
  // The kid holds on its approval until the parent's run has ended, so its answer reaches an idle parent.
  await view.until(settled(1))
  const child = spawned(view, "/root/kid")
  const approval = await waitingApproval(watchView(client, child))
  await client.call("approval/resolve", { conversation: child, approval, author: "ada", allow: true })
  await view.until(settled(2), 10_000)
  expect(mails(view)).toEqual([{ kind: "final_answer", task: "/root", sender: "/root/kid" }])
  const kinds = view.seen().map((entry) => entry.kind)
  expect(kinds.slice(kinds.lastIndexOf("nisse.mail"))).toEqual(["nisse.mail", "pi.assistant", RUN_END_KIND])
  expect(transcript(view.seen()).slice(-2)).toEqual(["assistant: the kid says all quiet", "run_end: answered"])
  expect(runEnds(view.seen())).toHaveLength(2)
  client.close()
}, 30_000)

/** The text of each message of `conversation`'s context the model is sent, system messages left out. */
const contextOf = async (client: RawClient, conversation: string) => {
  const reply = await client.call("conversation/context", { conversation })
  const messages = (reply.result as { messages: Array<{ role: string; content: unknown }> }).messages
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      const content = message.content
      const text =
        typeof content === "string"
          ? content
          : (content as Array<{ type: string; text?: string }>).map((block) => block.text ?? "").join("")
      return `${message.role}: ${text}`
    })
}

const liveOf = (watch: ViewWatch) =>
  watch.view().docs["pi.live"] as
    | {
        run?: unknown
        generation?: { retry?: { at: number; error: string } }
        compactions?: Array<{ trigger: string }>
        compactionFailure?: { error: string }
      }
    | undefined

test("fork-rpc, fork-shown: a fork goes on from an earlier entry with only what came before it and the settings as they are now, the list says what it forked, and the conversation it left is unchanged", async () => {
  await using server = await runningServer([{ text: "a" }, { text: "b" }, { text: "c" }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "one")
  await view.until(settled(1))
  await submit(client, conversation, "two")
  await view.until(settled(2))
  const firstEnd = view.seen().find((entry) => entry.kind === RUN_END_KIND)!.id
  // Changed after the fork's entry, and still what the fork runs with.
  await client.call("conversation/configure", { conversation, author: "bo", instructions: "be brief", maxTurns: 3 })
  const forked = await client.call("conversation/fork", { conversation, at: firstEnd, id: "other-way" })
  expect(forked.result).toEqual({ conversation: "other-way" })
  const fork = watchView(client, "other-way")
  await opened(fork)
  expect(fork.view().conversation.parent).toEqual({ conversationId: Number(conversation), at: firstEnd })
  expect(fork.view().docs["pi.agent"]).toMatchObject({ instructions: "be brief", maxTurns: 3 })
  const listed = (await client.call("conversation/list")).result as Array<{
    id: string
    fork?: unknown
    title?: string
  }>
  expect(listed.find((each) => each.id === "other-way")).toMatchObject({
    fork: { of: conversation, at: firstEnd },
    title: "one",
  })
  expect(listed.find((each) => each.id === conversation)!.fork).toBe(undefined)
  await submit(client, "other-way", "three")
  await fork.until(settled(2))
  expect(transcript(fork.seen())).toEqual([
    "user: one",
    "assistant: a",
    "run_end: answered",
    "user: three",
    "assistant: c",
    "run_end: answered",
  ])
  expect(await contextOf(client, "other-way")).toEqual(["user: one", "assistant: a", "user: three", "assistant: c"])
  expect(transcript(view.seen())).toEqual([
    "user: one",
    "assistant: a",
    "run_end: answered",
    "user: two",
    "assistant: b",
    "run_end: answered",
  ])
  const unnamed = await client.call("conversation/fork", { conversation, at: firstEnd })
  expect((unnamed.result as { conversation: string }).conversation).toMatch(/^\d+$/)
  expect(errorTag(await client.call("conversation/fork", { conversation, at: firstEnd, id: "other-way" }))).toBe(
    "InvalidConversationId",
  )
  expect(errorTag(await client.call("conversation/fork", { conversation, at: 9999 }))).toBe("NoSuchEntry")
  client.close()
})

test("reset-rpc, reset-handoff: a reset starts an empty context with the handoff as its first message, and the transcript keeps everything", async () => {
  await using server = await runningServer([{ text: "a" }, { text: "b" }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "one")
  await view.until(settled(1))
  expect(
    (await client.call("conversation/reset", { conversation, author: "bo", handoff: "we were counting" })).error,
  ).toBe(undefined)
  await view.until((current) => current.seen().some((entry) => entry.kind === "pi.reset"))
  const reset = view.seen().find((entry) => entry.kind === "pi.reset")!
  expect(reset.data).toEqual({ author: "bo" })
  expect(await contextOf(client, conversation)).toEqual(["user: we were counting"])
  await submit(client, conversation, "two")
  await view.until(settled(2))
  expect(await contextOf(client, conversation)).toEqual(["user: we were counting", "user: two", "assistant: b"])
  expect(transcript(view.seen())).toEqual([
    "user: one",
    "assistant: a",
    "run_end: answered",
    "user: two",
    "assistant: b",
    "run_end: answered",
  ])
  client.close()
})

test("compact-rpc, compaction-live-status: compacting shows live, then a summary replaces the context; a failed one says why", async () => {
  // Past the 20,000 tokens a summary keeps by default, so the run before it is summarized.
  const long = "word ".repeat(20_000)
  await using server = await runningServer([
    { text: "a" },
    { text: "b" },
    { text: "summary of one", delayMs: 100 },
    { text: "c" },
    { fail: "the summary model is gone" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  const compact = (instructions?: string) =>
    client.call("conversation/compact", { conversation, ...(instructions === undefined ? {} : { instructions }) })
  expect((await compact()).result).toEqual({ outcome: "nothing_to_compact" })
  await submit(client, conversation, long)
  await view.until(settled(1))
  await submit(client, conversation, long)
  await view.until(settled(2))
  const compacting = compact()
  await view.until((current) => (liveOf(current)?.compactions ?? []).length > 0)
  expect(liveOf(view)!.compactions!.map((status) => status.trigger)).toEqual(["manual"])
  const summary = view.seen().find((entry) => entry.kind === "pi.compaction")
  expect(summary).toBe(undefined)
  expect((await compacting).result).toEqual({ outcome: "compacted" })
  await view.until((current) => current.seen().some((entry) => entry.kind === "pi.compaction"))
  expect(liveOf(view)?.compactions).toBe(undefined)
  const context = await contextOf(client, conversation)
  expect(context[0]).toContain("summary of one")
  expect(context.slice(1)).toEqual([`user: ${long}`, "assistant: b"])
  await submit(client, conversation, long)
  await view.until(settled(3))
  expect((await compact("keep the numbers")).result).toMatchObject({ outcome: "failed" })
  expect(liveOf(view)!.compactionFailure!.error).toContain("the summary model is gone")
  client.close()
})

test("continue-rpc: a conversation whose run failed goes on with no new input; one that works, never ran or answered is refused by name", async () => {
  await using server = await runningServer([
    { fail: "provider went away" },
    { text: "back on it", tool: { name: "bash", input: { command: "echo held" } } },
    { text: "back on it now" },
  ])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  const go = () => client.call("conversation/continue", { conversation })
  expect(errorTag(await go())).toBe("NothingToContinue")
  await submit(client, conversation, "hi")
  await view.until(settled(1))
  expect((await go()).error).toBe(undefined)
  // The run waits on its approval, so it is still working when continue is asked again.
  const approval = await waitingApproval(view)
  expect(errorTag(await go())).toBe("ConversationBusy")
  await client.call("approval/resolve", { conversation, approval, author: "bo", allow: true })
  await view.until(settled(2))
  expect(errorTag(await go())).toBe("NothingToContinue")
  expect(transcript(view.seen())).toEqual([
    "user: hi",
    "assistant:  [error]",
    "run_end: failed (provider went away)",
    "assistant: back on it",
    "assistant: back on it now",
    "run_end: answered",
  ])
  client.close()
})

test("withdraw-rpc: a queued prompt taken back never runs, and one already run cannot be", async () => {
  await using server = await runningServer(ECHO)
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  const first = (await submit(client, conversation, "one")).result as { submission: number }
  // The run waits on its approval, so "two" waits in the queue.
  const approval = await waitingApproval(view)
  const second = (await submit(client, conversation, "two", "two")).result as { submission: number }
  const inbox = () => (view.view().docs["pi.inbox"] as { items: Array<{ id: number }> }).items.map((item) => item.id)
  await view.until(() => inbox().includes(second.submission))
  const withdraw = (submission: number) => client.call("submission/withdraw", { conversation, submission })
  expect((await withdraw(second.submission)).result).toEqual({ result: "withdrawn" })
  expect(inbox()).not.toContain(second.submission)
  await client.call("approval/resolve", { conversation, approval, author: "bo", allow: true })
  await view.until(settled(1))
  expect(transcript(view.seen())).toEqual([
    "user: one",
    "assistant: checking",
    "withdrawn: two",
    "assistant: all done",
    "run_end: answered",
  ])
  expect((await withdraw(first.submission)).result).toEqual({ result: "settled" })
  expect(errorTag(await withdraw(9999))).toBe("NoSuchSubmission")
  client.close()
})

test("configure-rpc, run-turn-limit: changed instructions reach the model and the transcript says who changed them; a turn limit ends a looping run by name", async () => {
  const echo = { tool: { name: "bash", input: { command: "echo again" } } }
  await using server = await runningServer([{ text: "a" }, echo, echo, echo, { text: "b" }])
  const client = await RawClient.connect(server.home.socket)
  const reply = await client.call("conversation/start", { cwd: server.home.dir, approvals: "auto" })
  const conversation = (reply.result as { conversation: string }).conversation
  const view = watchView(client, conversation)
  const configure = (settings: Record<string, unknown>) =>
    client.call("conversation/configure", { conversation, author: "bo", ...settings })
  /** The instructions the newest system message gives the model. */
  const instructions = async () => {
    const reply = await client.call("conversation/context", { conversation })
    const messages = (reply.result as { messages: Array<{ role: string; sections?: { instructions?: unknown } }> })
      .messages
    return messages.findLast((message) => message.sections !== undefined && "instructions" in message.sections)
      ?.sections?.instructions
  }
  expect((await configure({ instructions: "answer in French" })).error).toBe(undefined)
  await submit(client, conversation, "one")
  await view.until(settled(1))
  expect(await instructions()).toContain("answer in French")
  expect((await configure({ maxTurns: 1 })).error).toBe(undefined)
  await submit(client, conversation, "loop")
  await view.until(settled(2))
  const end = runEnds(view.seen())[1]!
  expect(end).toEqual({ outcome: "failed", message: "reached the turn limit of 1 turn" })
  const configured = view.seen().filter((entry) => entry.kind === "nisse.configured")
  expect(configured.map((entry) => entry.data)).toEqual([
    { author: "bo", instructions: "answer in French" },
    { author: "bo", maxTurns: 1 },
  ])
  expect((await configure({ instructions: null, maxTurns: null })).error).toBe(undefined)
  await submit(client, conversation, "two")
  await view.until(settled(3))
  expect(await instructions()).toBe(null)
  expect((await configure({ maxTurns: 0 })).error?.message).toContain("maxTurns")
  client.close()
})

test("usage-rpc, usage-per-model, usage-total: a client reads the tokens each conversation spent, by model, and the home's total", async () => {
  await using server = await runningServer([
    { text: "a", usage: { input: 100, output: 10 } },
    { text: "b", usage: { input: 200, output: 20 } },
    { text: "c", usage: { input: 50, output: 5 } },
  ])
  const client = await RawClient.connect(server.home.socket)
  const first = await start(client, server.home.dir)
  const second = await start(client, server.home.dir)
  for (const [conversation, prompts] of [
    [first, ["one", "two"]],
    [second, ["three"]],
  ] as const) {
    const view = watchView(client, conversation)
    for (const [index, prompt] of prompts.entries()) {
      await submit(client, conversation, prompt)
      await view.until(settled(index + 1))
    }
  }
  const usage = async (conversation?: string) =>
    (await client.call("usage/get", conversation === undefined ? {} : { conversation })).result as {
      models: Record<string, { input: number; output: number; totalTokens: number }>
    }
  expect((await usage(first)).models["script/script"]).toMatchObject({ input: 300, output: 30, totalTokens: 330 })
  expect((await usage(second)).models["script/script"]).toMatchObject({ input: 50, output: 5, totalTokens: 55 })
  expect((await usage()).models["script/script"]).toMatchObject({ input: 350, output: 35, totalTokens: 385 })
  expect(errorTag(await client.call("usage/get", { conversation: "99" }))).toBe("NoSuchConversation")
  client.close()
})

test("task-graph-rpc: a client watches the home's live work, a run and the call it waits on, until it is done, and the list names the conversation each works in", async () => {
  await using server = await runningServer(ECHO)
  const client = await RawClient.connect(server.home.socket)
  const conversation = (await client.call("conversation/start", { cwd: server.home.dir, id: "talk" })).result
    .conversation as string
  const view = watchView(client, conversation)
  type Graph = { tasks: Record<string, { kind: string; conversationId: number; state: { status: string } }> }
  const watch = client.watch<{ _tag: "graph"; graph: Graph } | { _tag: "change"; ops: ReadonlyArray<Op> }>(
    "tasks/watch",
  )
  let graph: Graph | undefined
  let applied = 0
  const current = () => {
    for (; applied < watch.items.length; applied++) {
      const item = watch.items[applied]!
      graph = item._tag === "graph" ? item.graph : applyImmutable(graph, item.ops)
    }
    return graph!
  }
  await watch.until(() => current() !== undefined)
  expect(current().tasks).toEqual({})
  await submit(client, conversation, "check it")
  await waitingApproval(view)
  await watch.until(() => Object.values(current().tasks).some((task) => task.kind === "pi.tool"))
  const kinds = Object.values(current().tasks).map((task) => [task.kind, task.state.status])
  expect(kinds).toContainEqual(["pi.generation", "waiting"])
  // The graph names a conversation by its number, which the list joins to the id and title a person knows.
  const listed = (await client.call("conversation/list")).result as Array<{
    id: string
    number: number
    title?: string
  }>
  const working = new Set(Object.values(current().tasks).map((task) => task.conversationId))
  expect([...working].map((number) => listed.find((each) => each.number === number))).toEqual([
    expect.objectContaining({ id: "talk", title: "check it" }),
  ])
  const approval = Object.keys((view.view().docs["nisse.approvals"] as { requests: object }).requests)[0]!
  await client.call("approval/resolve", { conversation, approval, author: "ada", allow: true })
  await view.until(settled(1))
  await watch.until(() => Object.keys(current().tasks).length === 0)
  client.close()
})

test("run-retry-live: a provider hiccup shows its retry and when it comes, and stopping it ends the run", async () => {
  await using server = await runningServer([{ fail: "503 service unavailable" }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, server.home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "hi")
  await view.until((current) => liveOf(current)?.generation?.retry !== undefined)
  const retry = liveOf(view)!.generation!.retry!
  expect(retry.error).toContain("503")
  // When the retry comes is still ahead when a client first sees it.
  expect(retry.at).toBeGreaterThan(Date.now())
  await client.call("conversation/interrupt", { conversation })
  await view.until(settled(1))
  expect(runEnds(view.seen()).map((end) => end.outcome)).toEqual(["interrupted"])
  client.close()
})

test("serve-read-only: a read-only server shows a home's conversations without resuming the run left in flight, and refuses every change by name", async () => {
  const home = tempHome()
  const slow = { text: "one two three four five six seven eight", delayMs: 200 }
  let conversation = ""
  try {
    {
      await using writable = await runningServer([slow], { home })
      const client = await RawClient.connect(writable.home.socket)
      conversation = await start(client, home.dir)
      const view = watchView(client, conversation)
      await submit(client, conversation, "count")
      await view.until(speaking)
      client.close()
    }
    {
      // Had the viewer resumed the run, it would answer with this at once.
      await using viewer = await runningServer([{ text: "answered by the viewer" }], { home, readOnly: true })
      const client = await RawClient.connect(viewer.home.socket)
      expect(
        (await client.call("initialize", { client: "test", version: "0", protocol: PROTOCOL_VERSION })).result,
      ).toEqual({
        version: VERSION,
        protocol: PROTOCOL_VERSION,
        readOnly: true,
      })
      const view = watchView(client, conversation)
      await opened(view)
      const said = transcript(view.seen())
      expect(said).toEqual(["user: count"])
      expect((view.view().docs["pi.live"] as { run?: unknown }).run).toBeDefined()
      expect(((await client.call("conversation/list")).result as Array<{ id: string }>).map((each) => each.id)).toEqual(
        [conversation],
      )
      const refused = await Promise.all([
        client.call("conversation/start", { cwd: home.dir }),
        submit(client, conversation, "more"),
        client.call("conversation/interrupt", { conversation }),
        client.call("conversation/reset", { conversation, author: "bo" }),
        client.call("conversation/configure", { conversation, author: "bo", maxTurns: 2 }),
        client.call("conversation/fork", { conversation, at: view.seen()[0]!.id }),
        client.call("conversation/select_model", {
          conversation,
          author: "bo",
          selection: { provider: "script", model: "script" },
        }),
        client.call("conversation/compact", { conversation }),
        client.call("conversation/continue", { conversation }),
        client.call("submission/withdraw", { conversation, submission: 1 }),
        client.call("approval/resolve", { conversation, approval: "1", author: "bo", allow: true }),
        client.call("auth/start", { provider: "openai" }),
        client.call("auth/logout", { provider: "openai" }),
      ])
      expect(refused.map(errorTag)).toEqual(Array(refused.length).fill("ReadOnlyServer"))
      expect(JSON.stringify(refused[0]!.error)).toContain("read-only")
      expect((await client.call("usage/get", {})).error).toBe(undefined)
      client.close()
    }
    {
      await using resumed = await runningServer([slow], { home })
      const client = await RawClient.connect(resumed.home.socket)
      const view = watchView(client, conversation)
      await view.until(settled(1), 10_000)
      // What the first server had said when it closed stays, cut off, before the answer.
      const resumedSaid = transcript(view.seen())
      expect(resumedSaid[0]).toBe("user: count")
      expect(resumedSaid.slice(-2)).toEqual(["assistant: one two three four five six seven eight", "run_end: answered"])
      expect(resumedSaid.join("\n")).not.toContain("answered by the viewer")
      client.close()
    }
  } finally {
    rmSync(home.dir, { recursive: true, force: true })
  }
})
