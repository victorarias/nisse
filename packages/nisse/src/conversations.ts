import type { ConversationId, NoSuchConversation, SubmissionId } from "@nisse/protocol"
import { Context, Effect, Fiber, FiberSet, Layer, Stream } from "effect"
import { newId } from "./ids.ts"
import { Lifetime } from "./lifetime.ts"
import { Model } from "./model.ts"
import { Store } from "./store.ts"

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
      const runs = new Map<ConversationId, Fiber.Fiber<void>>()
      const interruptedByPerson = new Set<ConversationId>()
      let settling = false

      const run = (conversation: ConversationId) => {
        const said: Array<string> = []
        const answer = (interrupted: boolean) =>
          said.join("") !== ""
            ? [{ author: nisse, body: { _tag: "answer" as const, text: said.join(""), interrupted } }]
            : []
        return model.respond(store.transcript(conversation)).pipe(
          Stream.tap((text) => Effect.sync(() => said.push(text))),
          Stream.groupedWithin(Number.MAX_SAFE_INTEGER, LIVE_WINDOW),
          Stream.runForEach((parts) =>
            Effect.sync(() => {
              const text = parts.join("")
              if (text !== "") store.commit(conversation, { live: { _tag: "append", text } })
            }),
          ),
          Effect.matchEffect({
            onSuccess: () =>
              Effect.sync(() => store.commit(conversation, { entries: answer(false), live: { _tag: "clear" } })),
            onFailure: (error) =>
              Effect.sync(() =>
                store.commit(conversation, {
                  entries: [...answer(false), { author: nisse, body: { _tag: "run_failed", message: error.message } }],
                  live: { _tag: "clear" },
                }),
              ),
          }),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              if (interruptedByPerson.delete(conversation)) {
                store.commit(conversation, { entries: answer(true), live: { _tag: "clear" } })
              }
            }),
          ),
          Effect.asVoid,
        )
      }

      const runTracked = Effect.fnUntraced(function* (conversation: ConversationId) {
        const fiber = yield* Effect.forkChild(run(conversation), { startImmediately: true })
        runs.set(conversation, fiber)
        yield* Fiber.await(fiber)
        runs.delete(conversation)
      })

      const nextOrRelease = (conversation: ConversationId) =>
        Effect.sync(() => {
          const next = settling ? undefined : store.nextQueued(conversation)
          if (!next) {
            if (store.status(conversation) === "working") store.commit(conversation, { status: "idle" })
            active.delete(conversation)
          }
          return next
        })

      const runner = Effect.fnUntraced(function* (conversation: ConversationId) {
        if (store.status(conversation) === "working") {
          store.commit(conversation, { live: { _tag: "clear" } })
          yield* runTracked(conversation)
        }
        while (true) {
          const next = yield* nextOrRelease(conversation)
          if (!next) return
          store.commit(conversation, {
            place: next.submission,
            entries: [{ author: next.author, body: { _tag: "user", submission: next.submission, text: next.text } }],
            status: "working",
          })
          yield* runTracked(conversation)
        }
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
            interruptedByPerson.add(conversation)
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
