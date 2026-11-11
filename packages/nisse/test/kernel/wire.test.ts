// The kernel wire (NISSE_KERNEL=1): a real server in process, driven as a raw JSON-RPC client over its socket.
import { expect, test } from "bun:test"
import { rmSync } from "node:fs"
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
import { KERNEL_PROTOCOL_VERSION } from "@nisse/wire"
import { VERSION } from "../../src/version.ts"

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
  expect(first.result).toEqual({ conversation: id })
  expect(again.result).toEqual({ conversation: id })
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
