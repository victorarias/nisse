// The kernel wire (NISSE_KERNEL=1): a real server in process, driven as a raw JSON-RPC client over its socket.
import { expect, test } from "bun:test"
import { rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homeWithExtensions } from "../support/extensions.ts"
import { deadline, errorTag, RawClient } from "../support/raw.ts"
import {
  runEnds,
  runningKernelServer,
  servingKernelUntilIdle,
  settled,
  start,
  submit,
  transcript,
  type ViewWatch,
  watchView,
} from "../support/kernel.ts"
import { tempHome } from "../support/server.ts"
import { KERNEL_PROTOCOL_VERSION, STATUS_LINES_KIND, TOAST_KIND, USER_KIND } from "@nisse/wire"
import { VERSION } from "../../src/version.ts"

type Tree = { _tag: "tree"; conversation: string; seq: number; status: string; ended?: Record<string, string> }
type Trees = { _tag: "trees"; seq: number; trees: Array<Tree> } | Tree
const opened = (watch: ViewWatch) => watch.until(() => true)

/** The model has said something the view shows live, before the run ends. */
const speaking = (watch: ViewWatch) => {
  const live = watch.view().docs["pi.live"] as { generation?: { message?: { content?: unknown[] } } } | undefined
  return (live?.generation?.message?.content?.length ?? 0) > 0
}

test("answer-wire, answer-shared: every client of a conversation sees the prompt, the answer and how the run ended", async () => {
  await using server = await runningKernelServer([{ text: "hello ada" }])
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
  await using server = await runningKernelServer([{ text: "once" }])
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
  await using server = await runningKernelServer([
    { text: "the first answer", delayMs: 100 },
    { text: "second answer" },
  ])
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

test("interrupt-wire: interrupting keeps what nisse already said and marks the run interrupted", async () => {
  await using server = await runningKernelServer([{ text: "one two three four five six seven eight", delayMs: 100 }])
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

test("answer-failed: a model failure is recorded after what was said and the conversation goes idle", async () => {
  await using server = await runningKernelServer([{ text: "half", fail: "provider went away" }])
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
  const prompts = 1500
  await using server = await runningKernelServer(Array.from({ length: prompts }, () => ({ text: "ok" })))
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
  await live.until(settled(prompts), 30_000)
  stalled.resumeAcks(behind.id)
  const dropped = await deadline(behind.ended, 5000, "stalled client told it fell behind")
  expect(errorTag(dropped)).toBe("FellBehind")
  expect(behind.items).toHaveLength(1)
  reader.close()
  stalled.close()
}, 60_000)

test("wire-unknown: watching a conversation that does not exist says so", async () => {
  await using server = await runningKernelServer()
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
  const served = await deadline(servingKernelUntilIdle(home, "200 millis"), 5000, "server listening")
  const client = await RawClient.connect(home.socket)
  const conversation = await start(client)
  await opened(watchView(client, conversation))
  client.close()
  await deadline(served.exited, 5000, "server exit")
})

test("server-idle-exit: a submission's run keeps the server up after its client leaves, past the idle grace", async () => {
  const home = tempHome()
  const served = await deadline(
    servingKernelUntilIdle(home, "50 millis", [{ text: "one two three four", delayMs: 100 }]),
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
  await using again = await runningKernelServer([], { home })
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
    servingKernelUntilIdle(home, "50 millis", [
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
  await using again = await runningKernelServer([], { home })
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
    servingKernelUntilIdle(home, "1 hour", [
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
  await using again = await runningKernelServer([], { home })
  client = await RawClient.connect(again.home.socket)
  const after = watchView(client, conversation)
  await after.until(() => true)
  expect(mails(after)).toEqual([{ kind: "final_answer", task: "/root", sender: "/root/writer" }])
  client.close()
  rmSync(home.dir, { recursive: true, force: true })
}, 30_000)

test("server-stop: stopping the server answers the caller, then the server exits", async () => {
  const home = tempHome()
  const served = await deadline(servingKernelUntilIdle(home, "1 hour"), 5000, "server listening")
  const client = await RawClient.connect(home.socket)
  expect(await client.call("server/stop", null)).toMatchObject({ result: null })
  await deadline(served.exited, 5000, "server exit")
  client.close()
})

test("wire-initialize: a client is answered with the server's version and the kernel protocol", async () => {
  await using server = await runningKernelServer()
  const client = await RawClient.connect(server.home.socket)
  const reply = await client.call("initialize", { client: "test", version: "0", protocol: KERNEL_PROTOCOL_VERSION })
  expect(reply.result).toEqual({ version: VERSION, protocol: KERNEL_PROTOCOL_VERSION })
  client.close()
})

test("watch-rpc: a watch through a window opens on the newest entries, and from a position gets only what followed", async () => {
  await using server = await runningKernelServer([{ text: "a" }, { text: "b" }, { text: "c" }])
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
  await using server = await runningKernelServer([{ text: "still here" }])
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
    servingKernelUntilIdle(home, "1 hour", [{ text: "one two three four", delayMs: 100 }]),
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
  await using again = await runningKernelServer([], { home })
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
  await using server = await runningKernelServer(ECHO)
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
  await using server = await runningKernelServer([
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

test("tool-read-only, approval-auto: reading calls and conversations started with auto approvals run without asking", async () => {
  await using server = await runningKernelServer([
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
  await using server = await runningKernelServer([{ text: "hello" }])
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
  await using server = await runningKernelServer([{ text: "hello" }])
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

test("child-tools: the model spawns a subagent, waits for it, and its final answer is mailed back", async () => {
  await using server = await runningKernelServer([
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
  await using server = await runningKernelServer([
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
  await using server = await runningKernelServer([
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
  await using server = await runningKernelServer([spawnSeven, { text: "spawned them" }, ...holding])
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
  await using server = await runningKernelServer([
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
  await using server = await runningKernelServer([
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
  await using server = await runningKernelServer([
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

test("child-tools: a subagent takes messages and follow-up tasks, and cannot start subagents past the depth limit", async () => {
  await using server = await runningKernelServer([
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

test("child-tools: interrupting a subagent stops its turn and reports what it was doing", async () => {
  await using server = await runningKernelServer([
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
  await using server = await runningKernelServer(
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
        yield* call.conversation.status("ran " + call.tool + " in " + call.conversation.id)
        yield* call.conversation.toast(call.tool + " finished")
      }),
    )
  }),
)
`

test("execute-before, execute-after, toast, status-line: an extension can refuse a call, change what runs and what the model sees, and tell every client", async () => {
  const home = homeWithExtensions({ "guard.ts": guard })
  await using server = await runningKernelServer(
    [
      { tool: { name: "bash", input: { command: "rm -rf precious" } } },
      { tool: { name: "bash", input: { command: "echo hello" } } },
      { text: "done" },
    ],
    { home },
  )
  const client = await RawClient.connect(server.home.socket)
  const conversation = await startAuto(client, home.dir, "guarded")
  const view = watchView(client, conversation)
  await submit(client, conversation, "clean up")
  await view.until(settled(1))
  expect(callsAndToasts(view)).toEqual([
    `call bash {"command":"rm -rf precious"}`,
    notRun("Tool call blocked: guard refused this call: that deletes too much"),
    `call bash {"command":"echo hello"}`,
    "toast guard: bash finished",
    "result: HEJ\n",
  ])
  expect(statusLines(view)).toEqual({ guard: "ran bash in guarded" })
  const other = await RawClient.connect(server.home.socket)
  const late = watchView(other, conversation)
  await opened(late)
  expect(statusLines(late)).toEqual({ guard: "ran bash in guarded" })
  client.close()
  other.close()
  rmSync(home.dir, { recursive: true })
})

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
    yield* ctx.tool.transform(() => { throw new Error("no such tool") })
    yield* ctx.tool.hook("execute.before", () => Effect.die(new Error("a failed extension never runs")))
  }),
)`,
      "bad name.ts": `export default 1`,
    },
    `[extensions.off]\nenabled = false\n`,
  )
  await using server = await runningKernelServer(
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
    await using server = await runningKernelServer([...READ, ...READ], { home })
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
    await using server = await runningKernelServer([], { home })
    const client = await RawClient.connect(server.home.socket)
    expect(await statusIn(client, conversation)).toEqual({})
    client.close()
  }
  rmSync(home.dir, { recursive: true })
})

const refusingAfter = (reason: string, loadsOnceExists = "") => `import { Extension, Tool } from "@nisse/extension"
import { existsSync } from "node:fs"
import { Effect } from "effect"
export default Extension.define((ctx) =>
  Effect.gen(function* () {
    while (${JSON.stringify(loadsOnceExists)} !== "" && !existsSync(${JSON.stringify(loadsOnceExists)})) yield* Effect.sleep("10 millis")
    yield* ctx.tool.hook("execute.before", () => Tool.refuse("${reason}"))
  }),
)`

test("reload: while extensions reload, the loaded ones keep guarding calls until their replacements are ready", async () => {
  const home = homeWithExtensions({ "guard.ts": refusingAfter("the old guard says no") })
  const script = [{ tool: { name: "bash", input: { command: "echo hi" } } }, { text: "done" }]
  await using server = await runningKernelServer([...script, ...script], { home })
  const client = await RawClient.connect(server.home.socket)
  const conversation = await startAuto(client, home.dir)
  const view = watchView(client, conversation)

  const ready = join(home.dir, "new-guard-ready")
  writeFileSync(join(home.extensions, "guard.ts"), refusingAfter("the new guard says no", ready))
  const reloading = client.call("extensions/reload")
  await submit(client, conversation, "say hi")
  await view.until(settled(1))
  expect(whyNotRun(view)).toEqual([notRun("Tool call blocked: guard refused this call: the old guard says no")])

  writeFileSync(ready, "")
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
  const released = join(home.dir, "released")
  writeFileSync(
    join(home.extensions, "slow.ts"),
    `import { Extension } from "@nisse/extension"
import { existsSync } from "node:fs"
import { Effect } from "effect"
export default Extension.define((ctx) =>
  ctx.tool.hook("execute.after", (call) =>
    Effect.gen(function* () {
      while (!existsSync(${JSON.stringify(released)})) yield* Effect.sleep("10 millis")
      yield* call.conversation.status("stale")
    }),
  ),
)`,
  )
  await using server = await runningKernelServer(READ, { home })
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client, home.dir)
  const view = watchView(client, conversation)
  await submit(client, conversation, "read it")
  await view.until((watch) => watch.seen().some((entry) => entry.kind === "pi.assistant"))

  rmSync(join(home.extensions, "slow.ts"))
  expect((await client.call("extensions/reload")).result).toEqual([])
  writeFileSync(released, "")
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
    await using server = await runningKernelServer(
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
    await using server = await runningKernelServer([{ text: "done" }], { home })
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
  await using server = await runningKernelServer([], { home })
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
  await using server = await runningKernelServer([{ text: "all done" }, { text: "again" }])
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
  await using server = await runningKernelServer([
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
  // Interrupting the root's run leaves its subagent waiting, so the tree waits until the subagent is stopped too.
  await client.call("conversation/interrupt", { conversation })
  await watch.until((items) => treesOf(items, conversation).some((tree) => tree.ended))
  expect(treesOf(watch.items, conversation).at(-1)?.status).toBe("waiting")
  const view = watchView(client, conversation)
  await view.until((current) => toolResults(current).length > 0)
  await client.call("conversation/interrupt", { conversation: spawned(view, "/root/writer") })
  await watch.until((items) => treesOf(items, conversation).at(-1)?.status === "idle", 20_000)
  const ended = treesOf(watch.items, conversation).filter((tree) => tree.ended)
  expect(ended.map((tree) => tree.ended)).toEqual([{ outcome: "interrupted", message: "aborted" }])
  client.close()
  late.close()
}, 30_000)

test("submit-author, queue-shared: every client sees who wrote each prompt, while it waits and once it runs", async () => {
  await using server = await runningKernelServer([
    { text: "the first answer", delayMs: 100 },
    { text: "second answer" },
  ])
  const ada = await RawClient.connect(server.home.socket)
  const bo = await RawClient.connect(server.home.socket)
  const conversation = await start(ada)
  const view = watchView(bo, conversation)
  await submit(ada, conversation, "one", undefined, "ada")
  await view.until(speaking)
  await submit(bo, conversation, "two", undefined, "bo")
  await view.until((watch) => ((watch.view().docs["pi.inbox"] as { items?: unknown[] })?.items ?? []).length > 0)
  expect((view.view().docs["pi.inbox"] as { items: unknown[] }).items).toEqual([
    expect.objectContaining({ entry: { kind: USER_KIND, data: { author: "bo" } } }),
  ])
  await view.until(settled(2))
  const users = view.seen().filter((entry) => entry.kind === USER_KIND)
  expect(users.map((entry) => entry.data)).toEqual([{ author: "ada" }, { author: "bo" }])
  expect(transcript(view.seen()).filter((line) => line.startsWith("user: "))).toEqual(["user: one", "user: two"])
  ada.close()
  bo.close()
})

test("subagent-limits: a tree runs at most as many subagents at once as config.toml allows", async () => {
  await using server = await runningKernelServer([spawnSeven, { text: "spawned them" }, ...holding], {
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
