import {
  LIVE_OUTPUT_TAIL,
  UnknownProvider,
  type ApprovalId,
  type Approvals,
  type CallId,
  type Conversation,
  type ConversationId,
  type Entry,
  type LiveChange,
  type ModelSelection,
  type Queued,
  type Skill,
  type NoSuchApproval,
  type NoSuchConversation,
  type Outcome,
  type SubmissionId,
} from "@nisse/protocol"
import { Cause, Context, Deferred, Effect, Fiber, FiberSet, Layer, Option, Ref } from "effect"
import { projectDefaultModel } from "./config.ts"
import { newId } from "./ids.ts"
import { attachedSkills } from "./workspace.ts"
import { Lifetime } from "./lifetime.ts"
import { Providers, type Call, type Driver, type Saved, type Turn } from "./provider.ts"
import { Store, type Change, type NewEntry } from "./store.ts"
import { builtinTools, toolNamed, type ToolOutcome } from "./tools/index.ts"
import { interrupted } from "./tools/tool.ts"

const LIVE_WINDOW = "100 millis"
export const RESTART_LIMIT = 3
const nisse = { _tag: "nisse" } as const

const interruptedResult = (call: CallId): NewEntry => ({
  author: nisse,
  body: { _tag: "tool_result", call, ...interrupted },
})

const withChange = (changes: ReadonlyArray<LiveChange>, change: LiveChange): Array<LiveChange> => {
  const last = changes.at(-1)
  if (change._tag !== "output" || last?._tag !== "output" || last.call !== change.call) return [...changes, change]
  return [...changes.slice(0, -1), { ...change, append: (last.append + change.append).slice(-LIVE_OUTPUT_TAIL) }]
}

interface ProviderState {
  readonly state: unknown
  readonly seq: number
}

const runEnd = (outcome: Outcome, message?: string): NewEntry => ({
  author: nisse,
  body: message === undefined ? { _tag: "run_end", outcome } : { _tag: "run_end", outcome, message },
})

const danglingIn = (transcript: ReadonlyArray<Entry>) => {
  const calls = new Set<CallId>()
  const approvals = new Set<ApprovalId>()
  for (const { body } of transcript) {
    if (body._tag === "tool_call") calls.add(body.call)
    else if (body._tag === "tool_result") calls.delete(body.call)
    else if (body._tag === "approval") approvals.add(body.approval)
    else if (body._tag === "approval_answer") approvals.delete(body.approval)
  }
  return { calls, approvals }
}

export interface StartOptions {
  readonly provider?: string
  readonly model?: string
  readonly effort?: string
  readonly approvals?: Approvals
}

export class Conversations extends Context.Service<
  Conversations,
  {
    readonly start: (cwd: string, options: StartOptions) => Effect.Effect<Conversation, UnknownProvider>
    readonly selectModel: (
      conversation: ConversationId,
      author: string,
      selection: ModelSelection,
    ) => Effect.Effect<void, NoSuchConversation | UnknownProvider>
    readonly submit: (
      conversation: ConversationId,
      requestId: string,
      author: string,
      text: string,
      steer: boolean,
    ) => Effect.Effect<SubmissionId, NoSuchConversation>
    readonly interrupt: (conversation: ConversationId) => Effect.Effect<void, NoSuchConversation>
    readonly resolve: (
      conversation: ConversationId,
      approval: ApprovalId,
      author: string,
      allow: boolean,
    ) => Effect.Effect<boolean, NoSuchConversation | NoSuchApproval>
    readonly skills: (conversation: ConversationId) => Effect.Effect<ReadonlyArray<Skill>, NoSuchConversation>
    readonly settle: Effect.Effect<void>
  }
>()("nisse/Conversations") {
  static readonly layer = Layer.effect(
    Conversations,
    Effect.gen(function* () {
      const store = yield* Store
      const providers = yield* Providers
      const lifetime = yield* Lifetime
      const runners = yield* FiberSet.make<void>()
      const active = new Set<ConversationId>()
      const runs = new Map<ConversationId, Fiber.Fiber<void, unknown>>()
      const waiting = new Map<ApprovalId, Deferred.Deferred<boolean>>()
      let settling = false

      const placed = (conversation: Conversation, queued: Queued): NewEntry => {
        const driver = providers.drivers.get(conversation.model.provider)
        const skills = driver ? attachedSkills(queued.text, driver.skills(conversation.cwd)) : []
        return {
          author: queued.author,
          body: {
            _tag: "user",
            submission: queued.submission,
            text: queued.text,
            ...(skills.length > 0 ? { skills } : {}),
          },
        }
      }

      const expire = (conversation: ConversationId, approvals: Iterable<ApprovalId>) =>
        Effect.forEach(approvals, (approval) =>
          Effect.ignore(store.resolveApproval(conversation, approval, nisse, false)),
        )

      const makeTurn = Effect.fnUntraced(function* (conversation: Conversation, provider: ProviderState) {
        const id = conversation.id
        const spoken = yield* Ref.make("")
        const pending = yield* Ref.make<Array<LiveChange>>([])
        const openCalls = new Set<CallId>()
        const openApprovals = new Set<ApprovalId>()

        const flush = Effect.flatMap(Ref.getAndSet(pending, []), (changes) =>
          Effect.sync(() => (changes.length > 0 ? void store.commit(id, { live: changes }) : undefined)),
        )
        const scope = yield* Effect.scope
        const flushSoon = Effect.forkIn(Effect.andThen(Effect.sleep(LIVE_WINDOW), flush), scope)

        const live = (change: LiveChange) =>
          Effect.flatMap(
            Ref.modify(pending, (changes) => [changes.length === 0, withChange(changes, change)]),
            (first) => (first ? Effect.asVoid(flushSoon) : Effect.void),
          )
        const withState = (change: Change, saved: Saved | undefined): Change =>
          saved?.state === undefined ? change : { ...change, providerState: saved.state }
        const dropPendingText = Ref.update(pending, (changes) => changes.filter((c) => c._tag !== "text"))

        const recordCall = (call: Call, saved?: Saved) =>
          Effect.andThen(
            flush,
            Effect.sync(() => {
              openCalls.add(call.call)
              store.commit(
                id,
                withState(
                  {
                    entries: [
                      {
                        author: nisse,
                        body: {
                          _tag: "tool_call",
                          call: call.call,
                          tool: call.tool,
                          input: call.input,
                          ...(call.parent === undefined ? {} : { parent: call.parent }),
                        },
                      },
                    ],
                  },
                  saved,
                ),
              )
            }),
          )

        const recordResult = (call: CallId, outcome: ToolOutcome, saved?: Saved) =>
          Effect.andThen(
            flush,
            Effect.sync(() => {
              openCalls.delete(call)
              store.commit(
                id,
                withState(
                  {
                    entries: [
                      {
                        author: nisse,
                        body: { _tag: "tool_result", call, output: outcome.output, error: outcome.error },
                      },
                    ],
                    live: [{ _tag: "output_end", call }],
                  },
                  saved,
                ),
              )
            }),
          )

        const approve = (call: Call) =>
          Effect.gen(function* () {
            if (conversation.approvals === "auto") return true
            const approval = newId() as ApprovalId
            const answered = yield* Deferred.make<boolean>()
            waiting.set(approval, answered)
            openApprovals.add(approval)
            yield* flush
            store.commit(id, {
              entries: [
                {
                  author: nisse,
                  body: { _tag: "approval", approval, call: call.call, tool: call.tool, input: call.input },
                },
              ],
              approval: { id: approval, call: call.call },
              status: "waiting",
            })
            const settled = Effect.sync(() => {
              waiting.delete(approval)
              openApprovals.delete(approval)
              if (openApprovals.size === 0) store.commit(id, { status: "working" })
            })
            return yield* Deferred.await(answered).pipe(
              Effect.onInterrupt(() => Effect.andThen(expire(id, [approval]), settled)),
              Effect.tap(() => settled),
            )
          })

        const turn: Turn = {
          conversation,
          transcript: Effect.sync(() => store.transcript(id)),
          providerState: provider.state,
          providerSeq: provider.seq,
          tools: builtinTools.map((tool) => tool.spec),
          say: (text) =>
            text === ""
              ? Effect.void
              : Effect.andThen(
                  Ref.update(spoken, (s) => s + text),
                  live({ _tag: "text", append: text }),
                ),
          message: (text, saved) =>
            Effect.gen(function* () {
              yield* dropPendingText
              yield* flush
              yield* Ref.set(spoken, "")
              store.commit(
                id,
                withState(
                  {
                    entries: text === "" ? [] : [{ author: nisse, body: { _tag: "message", text } }],
                    live: [{ _tag: "text_end" }],
                  },
                  saved,
                ),
              )
            }),
          recordCall,
          recordResult,
          approve,
          toolOutput: (call, text) => (text === "" ? Effect.void : live({ _tag: "output", call, append: text })),
          runTool: (call, tool = toolNamed(call.tool)) =>
            Effect.gen(function* () {
              yield* recordCall(call)
              const outcome: ToolOutcome = !tool
                ? { output: `no tool named ${call.tool}`, error: true }
                : !tool.readOnly && !(yield* approve(call))
                  ? { output: "denied: the person did not allow this call", error: true }
                  : yield* tool.run(call.input, {
                      cwd: conversation.cwd,
                      output: (text) =>
                        text === "" ? Effect.void : live({ _tag: "output", call: call.call, append: text }),
                    })
              yield* recordResult(call.call, outcome)
              return outcome
            }).pipe(
              Effect.onInterrupt(() => (openCalls.has(call.call) ? recordResult(call.call, interrupted) : Effect.void)),
            ),
          steers: Effect.andThen(
            flush,
            Effect.sync(() => {
              const steers = store.queuedSteers(id)
              if (steers.length === 0) return []
              store.commit(id, {
                place: steers.map((steer) => steer.submission),
                entries: steers.map((steer) => placed(conversation, steer)),
              })
              return steers.map((steer) => steer.text)
            }),
          ),
        }

        const close = (outcome: Outcome, message?: string) =>
          Effect.gen(function* () {
            yield* expire(id, openApprovals)
            const said = yield* Ref.get(spoken)
            return [
              ...(said === "" ? [] : [{ author: nisse, body: { _tag: "message" as const, text: said } }]),
              ...[...openCalls].map(interruptedResult),
              runEnd(outcome, message),
            ]
          })

        return { turn, close }
      })

      const run = Effect.fnUntraced(function* (id: ConversationId, resumed: boolean) {
        const { conversation, attempts, providerState, providerSeq } = yield* Effect.orDie(store.state(id))
        if (resumed) {
          const dangling = danglingIn(store.transcript(id))
          yield* expire(id, dangling.approvals)
          store.commit(id, {
            entries: [...dangling.calls].map(interruptedResult),
            live: [{ _tag: "clear" }],
            status: "working",
            attempts: attempts + 1,
          })
        }
        if (attempts >= RESTART_LIMIT) {
          return [runEnd("restart_limit", `the server stopped during this run ${attempts} times in a row`)]
        }
        const driver = providers.drivers.get(conversation.model.provider)
        if (!driver) return [runEnd("failed", `no provider named ${conversation.model.provider}`)]
        return yield* Effect.scoped(drive(conversation, { state: providerState, seq: providerSeq }, driver))
      })

      const drive = Effect.fnUntraced(function* (conversation: Conversation, provider: ProviderState, driver: Driver) {
        const { turn, close } = yield* makeTurn(conversation, provider)
        const fiber = yield* Effect.forkChild(driver.run(turn), { startImmediately: true })
        runs.set(conversation.id, fiber)
        const exit = yield* Fiber.await(fiber)
        runs.delete(conversation.id)
        if (exit._tag === "Success") return yield* close("answered")
        const error = Cause.findErrorOption(exit.cause)
        if (Option.isSome(error)) return yield* close("failed", error.value.message)
        if (Cause.hasInterruptsOnly(exit.cause)) return yield* close("interrupted")
        return yield* close("failed", Cause.pretty(exit.cause))
      })

      const next = (conversation: ConversationId): Change => {
        const queued = settling ? undefined : store.nextQueued(conversation)
        return queued
          ? {
              place: [queued.submission],
              entries: [placed(Effect.runSync(Effect.orDie(store.state(conversation))).conversation, queued)],
              status: "working",
            }
          : { status: "idle" }
      }

      const proceed = (conversation: ConversationId, ended: ReadonlyArray<NewEntry> = []) =>
        Effect.sync(() => {
          const after = next(conversation)
          if (ended.length > 0 || after.status === "working") {
            store.commit(conversation, {
              ...after,
              entries: [...ended, ...(after.entries ?? [])],
              ...(ended.length > 0 ? { live: [{ _tag: "clear" as const }] } : {}),
              attempts: after.status === "working" ? 1 : 0,
            })
          }
          if (after.status === "idle") active.delete(conversation)
          return after.status === "working"
        })

      const runner = Effect.fnUntraced(function* (conversation: ConversationId) {
        const state = yield* Effect.orDie(store.state(conversation))
        let resumed = state.status !== "idle"
        let working = resumed || (yield* proceed(conversation))
        while (working) {
          working = yield* proceed(conversation, yield* run(conversation, resumed))
          resumed = false
        }
      })

      const wake = (conversation: ConversationId) =>
        Effect.suspend(() => {
          if (settling || active.has(conversation)) return Effect.void
          active.add(conversation)
          return FiberSet.run(runners, Effect.andThen(lifetime.hold, runner(conversation)).pipe(Effect.scoped), {
            startImmediately: true,
          }).pipe(Effect.asVoid)
        })

      const chosenModel = (cwd: string, options: StartOptions): ModelSelection => {
        const given = {
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.effort === undefined ? {} : { effort: options.effort }),
        }
        if (options.provider !== undefined) return { provider: options.provider, ...given }
        const fallback = [projectDefaultModel(cwd), providers.defaultModel, store.lastModel()].find(
          (candidate) => candidate !== undefined && providers.drivers.has(candidate.provider),
        ) ?? { provider: providers.preferred }
        if (options.model === undefined) return { ...fallback, ...given }
        return { provider: fallback.provider, ...given }
      }

      for (const conversation of new Set([...store.openRuns(), ...store.pending()])) {
        yield* wake(conversation)
      }

      return Conversations.of({
        start: (cwd, options) =>
          Effect.suspend(() => {
            const model = chosenModel(cwd, options)
            if (!providers.drivers.has(model.provider)) {
              return Effect.fail(new UnknownProvider({ provider: model.provider }))
            }
            return Effect.succeed(store.start(cwd, model, options.approvals ?? "ask"))
          }),
        selectModel: (conversation, author, selection) =>
          Effect.gen(function* () {
            yield* store.state(conversation)
            if (!providers.drivers.has(selection.provider)) {
              return yield* new UnknownProvider({ provider: selection.provider })
            }
            store.commit(conversation, {
              entries: [{ author: { _tag: "person", name: author }, body: { _tag: "model", selection } }],
              model: selection,
            })
          }),
        submit: (conversation, requestId, author, text, steer) =>
          Effect.gen(function* () {
            yield* store.state(conversation)
            const existing = store.submissionFor(conversation, requestId)
            if (existing) return existing
            const id = newId() as SubmissionId
            store.commit(conversation, {
              submit: { id, requestId, author: { _tag: "person", name: author }, text, steer },
            })
            yield* wake(conversation)
            return id
          }),
        interrupt: (conversation) =>
          Effect.gen(function* () {
            yield* store.state(conversation)
            const fiber = runs.get(conversation)
            if (fiber) yield* Fiber.interrupt(fiber)
          }),
        resolve: (conversation, approval, author, allow) =>
          Effect.gen(function* () {
            yield* store.state(conversation)
            const accepted = yield* store.resolveApproval(
              conversation,
              approval,
              { _tag: "person", name: author },
              allow,
            )
            const answered = waiting.get(approval)
            if (accepted && answered) yield* Deferred.succeed(answered, allow)
            return accepted
          }),
        skills: (id) =>
          Effect.map(
            store.state(id),
            ({ conversation }) => providers.drivers.get(conversation.model.provider)?.skills(conversation.cwd) ?? [],
          ),
        settle: Effect.suspend(() => {
          settling = true
          return FiberSet.awaitEmpty(runners)
        }),
      })
    }),
  )
}
