// The kernel wire (NISSE_KERNEL=1): a real server in process, driven as a raw JSON-RPC client over its socket.
import { expect, test } from "bun:test"
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
  expect(entries).toHaveLength(9)

  const newest = watchView(client, conversation, { min: 3, max: 6 })
  await newest.until(() => true)
  expect(transcript(newest.view().entries)).toEqual(["user: three", "assistant: c", "run_end: answered"])
  expect(newest.view().before).toBe(entries[5]!.id)

  const resumed = watchView(client, conversation, { from: entries[3]!.id })
  await resumed.until(() => true)
  expect(resumed.view().entries.map((entry) => entry.id)).toEqual(entries.slice(3).map((entry) => entry.id))
  client.close()
})
