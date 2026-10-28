import { expect, test } from "bun:test"
import { bodies, deadline, errorTag, RawClient } from "./support/raw.ts"
import { runningServer, servingUntilIdle, tempHome } from "./support/server.ts"

const start = async (client: RawClient) => (await client.call("conversation/start", { cwd: "/work" })).result.id

const submit = (client: RawClient, conversation: string, text: string, requestId: string = crypto.randomUUID()) =>
  client.call("conversation/submit", { conversation, requestId, author: "ada", text })

const answered = (count: number) => (deliveries: ReadonlyArray<any>) =>
  bodies(deliveries).filter((body) => body._tag === "answer").length >= count

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
  await adaView.until(answered(1))
  await graceView.until(answered(1))
  expect(bodies(adaView.deliveries)).toMatchObject([
    { _tag: "user", text: "hi" },
    { _tag: "answer", text: "hello ada", interrupted: false },
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
  await view.until(answered(1))
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
  await view.until(answered(1))
  const resumeAt = view.deliveries.at(-1)!.seq
  await submit(client, conversation, "two")
  await view.until(answered(2))
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
  await view.until((deliveries) => deliveries.some((delivery) => delivery._tag === "commit" && delivery.live))
  await submit(client, conversation, "second")
  await view.until((deliveries) =>
    deliveries.some((delivery) => delivery._tag === "commit" && delivery.enqueued?.text === "second"),
  )
  await view.until(answered(2))
  expect(bodies(view.deliveries).map((body) => body._tag === "run_failed" || body.text)).toEqual([
    "first",
    "slow answer here",
    "second",
    "quick",
  ])
  client.close()
})

test("interrupting keeps what nisse already said and marks the answer interrupted", async () => {
  await using server = await runningServer([{ text: "one two three four five six seven eight", delayMs: 150 }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client)
  const view = client.subscribe({ conversation })
  await submit(client, conversation, "count")
  await view.until((deliveries) => deliveries.some((delivery) => delivery._tag === "commit" && delivery.live))
  await client.call("conversation/interrupt", { conversation })
  await view.until(answered(1))
  const answer = bodies(view.deliveries).find((body) => body._tag === "answer")!
  expect(answer).toMatchObject({ interrupted: true })
  expect("one two three four five six seven eight".startsWith((answer as { text: string }).text)).toBe(true)
  expect(view.deliveries.at(-1)).toMatchObject({ status: "idle" })
  client.close()
})

test("a model failure is recorded after what was said and the conversation goes idle", async () => {
  await using server = await runningServer([{ text: "partial", fail: "provider went away" }])
  const client = await RawClient.connect(server.home.socket)
  const conversation = await start(client)
  const view = client.subscribe({ conversation })
  await submit(client, conversation, "go")
  await view.until((deliveries) => bodies(deliveries).some((body) => body._tag === "run_failed"))
  expect(bodies(view.deliveries).slice(1)).toEqual([
    { _tag: "answer", text: "partial", interrupted: false },
    { _tag: "run_failed", message: "provider went away" },
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
  await live.until(answered(1500), 20_000)
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
