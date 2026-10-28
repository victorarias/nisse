import type { ConversationId, NoSuchConversation, SubmissionId } from "@nisse/protocol"
import { Cause, Context, Effect, Fiber, FiberSet, Layer, Option, Stream } from "effect"
import { newId } from "./ids.ts"
import { Lifetime } from "./lifetime.ts"
import { Model } from "./model.ts"
import { Store, type Change } from "./store.ts"

const LIVE_WINDOW = "100 millis"
const nisse = { _tag: "nisse" } as const

export class Conversations extends Context.Service<
  Conversations,
  {
    readonly submit: (
      conversation: ConversationId,
      requestId: string,
      author: string,
      text: string,
    ) => Effect.Effect<SubmissionId, NoSuchConversation>
    readonly interrupt: (conversation: ConversationId) => Effect.Effect<void, NoSuchConversation>
    readonly settle: Effect.Effect<void>
  }
>()("nisse/Conversations") {
  static readonly layer = Layer.effect(
    Conversations,
    Effect.gen(function* () {
      const store = yield* Store
      const model = yield* Model
      const lifetime = yield* Lifetime
      const runners = yield* FiberSet.make<void>()
      const active = new Set<ConversationId>()
      const runs = new Map<ConversationId, Fiber.Fiber<void, unknown>>()
      let settling = false

      const respond = (conversation: ConversationId, said: Array<string>) =>
        model.respond(store.transcript(conversation)).pipe(
          Stream.tap((text) => Effect.sync(() => said.push(text))),
          Stream.groupedWithin(Number.MAX_SAFE_INTEGER, LIVE_WINDOW),
          Stream.runForEach((parts) =>
            Effect.sync(() => {
              const text = parts.join("")
              if (text !== "") store.commit(conversation, { live: { _tag: "append", text } })
            }),
          ),
        )

      const run = Effect.fnUntraced(function* (conversation: ConversationId) {
        const said: Array<string> = []
        const answer = (interrupted: boolean) => ({
          author: nisse,
          body: { _tag: "answer" as const, text: said.join(""), interrupted },
        })
        const fiber = yield* Effect.forkChild(respond(conversation, said), { startImmediately: true })
        runs.set(conversation, fiber)
        const exit = yield* Fiber.await(fiber)
        runs.delete(conversation)
        if (exit._tag === "Success") return [answer(false)]
        const error = Cause.findErrorOption(exit.cause)
        if (Option.isNone(error)) return [answer(true)]
        const failed = { author: nisse, body: { _tag: "run_failed" as const, message: error.value.message } }
        return said.length > 0 ? [answer(false), failed] : [failed]
      })

      const next = (conversation: ConversationId): Change => {
        const queued = settling ? undefined : store.nextQueued(conversation)
        return queued
          ? {
              place: queued.submission,
              entries: [
                { author: queued.author, body: { _tag: "user", submission: queued.submission, text: queued.text } },
              ],
              status: "working",
            }
          : { status: "idle" }
      }

      const proceed = (conversation: ConversationId, ended: Change["entries"] = []) =>
        Effect.sync(() => {
          const after = next(conversation)
          if (ended.length > 0 || after.status === "working") {
            store.commit(conversation, {
              ...after,
              entries: [...ended, ...(after.entries ?? [])],
              live: { _tag: "clear" },
            })
          }
          if (after.status === "idle") active.delete(conversation)
          return after.status === "working"
        })

      const runner = Effect.fnUntraced(function* (conversation: ConversationId) {
        const resumed = store.status(conversation) === "working"
        if (resumed) store.commit(conversation, { live: { _tag: "clear" } })
        let working = resumed || (yield* proceed(conversation))
        while (working) working = yield* proceed(conversation, yield* run(conversation))
      }, Effect.scoped)

      const wake = (conversation: ConversationId) =>
        Effect.suspend(() => {
          if (settling || active.has(conversation)) return Effect.void
          active.add(conversation)
          return FiberSet.run(runners, Effect.andThen(lifetime.hold, runner(conversation)).pipe(Effect.scoped), {
            startImmediately: true,
          }).pipe(Effect.asVoid)
        })

      for (const conversation of new Set([...store.openRuns(), ...store.pending()])) {
        yield* wake(conversation)
      }

      return Conversations.of({
        submit: (conversation, requestId, author, text) =>
          Effect.gen(function* () {
            yield* store.exists(conversation)
            const existing = store.submissionFor(conversation, requestId)
            if (existing) return existing
            const id = newId() as SubmissionId
            store.commit(conversation, {
              submit: { id, requestId, author: { _tag: "person", name: author }, text },
            })
            yield* wake(conversation)
            return id
          }),
        interrupt: (conversation) =>
          Effect.gen(function* () {
            yield* store.exists(conversation)
            const fiber = runs.get(conversation)
            if (!fiber) return
            yield* Fiber.interrupt(fiber)
          }),
        settle: Effect.suspend(() => {
          settling = true
          return FiberSet.awaitEmpty(runners)
        }),
      })
    }),
  )
}
