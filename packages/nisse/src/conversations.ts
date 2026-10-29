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
  type Mail,
  type ModelSelection,
  type Queued,
  type Skill,
  type NoSuchApproval,
  type NoSuchConversation,
  type Outcome,
  type SubmissionId,
  TakesNoInput,
} from "@nisse/protocol"
import { Cause, Context, Deferred, Effect, Fiber, FiberSet, Layer, Option, Ref, type Scope } from "effect"
import { agentTools, errored, taskOf, type AgentContext, type Child, type Woken } from "./agents.ts"
import { projectDefaultModel } from "./config.ts"
import { newId } from "./ids.ts"
import { attachedSkills } from "./workspace.ts"
import { Lifetime } from "./lifetime.ts"
import { Providers, type Call, type Driver, type Hosted, type HostedChild, type Saved, type Turn } from "./provider.ts"
import { Store, type Change, type NewEntry } from "./store.ts"
import { builtinTools, toolEnv, type ToolOutcome } from "./tools/index.ts"
import { interrupted } from "./tools/tool.ts"

const LIVE_WINDOW = "100 millis"
export const RESTART_LIMIT = 3
const INTERRUPTED_BY_A_PERSON =
  "A person interrupted this agent. If you still need it, use the available collaboration tools to give it another task."
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

const agentAuthor = (conversation: ConversationId) => ({ _tag: "agent" as const, conversation })

const isHosted = (conversation: Conversation) =>
  conversation.lineage !== undefined && conversation.lineage.task === undefined

const subagentEntry = (
  call: CallId,
  conversation: ConversationId,
  title: string,
  agentType: string | undefined,
): NewEntry => ({
  author: nisse,
  body: {
    _tag: "subagent",
    call,
    conversation,
    title,
    ...(agentType === undefined ? {} : { agentType }),
  },
})

interface Made {
  readonly turn: Turn
  readonly close: (outcome: Outcome, message?: string) => Effect.Effect<Ended>
}

interface Ended {
  readonly entries: ReadonlyArray<NewEntry>
  readonly answer?: string
}

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
  readonly id?: ConversationId
  readonly provider?: string
  readonly model?: string
  readonly effort?: string
  readonly approvals?: Approvals
  readonly instructions?: string
}

export class Conversations extends Context.Service<
  Conversations,
  {
    readonly start: (cwd: string, options: StartOptions) => Effect.Effect<Conversation, UnknownProvider>
    readonly selectModel: (
      conversation: ConversationId,
      author: string,
      selection: ModelSelection,
    ) => Effect.Effect<void, NoSuchConversation | UnknownProvider | TakesNoInput>
    readonly submit: (
      conversation: ConversationId,
      requestId: string,
      author: string,
      text: string,
      steer: boolean,
    ) => Effect.Effect<SubmissionId, NoSuchConversation | TakesNoInput>
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
      const hostedStops = new Map<ConversationId, Effect.Effect<void>>()
      const waiting = new Map<ApprovalId, Deferred.Deferred<boolean>>()
      let settling = false

      const placed = (conversation: Conversation, queued: Queued): NewEntry => {
        const driver = providers.drivers.get(conversation.model.provider)
        const skills =
          driver && queued.mail === undefined ? attachedSkills(queued.text, driver.skills(conversation.cwd)) : []
        return {
          author: queued.author,
          body: {
            _tag: "user",
            submission: queued.submission,
            text: queued.text,
            ...(skills.length > 0 ? { skills } : {}),
            ...(queued.mail === undefined ? {} : { mail: queued.mail }),
          },
        }
      }

      const placedForNextRun = (id: ConversationId, queued: Queued) =>
        placed(Effect.runSync(Effect.orDie(store.state(id))).conversation, queued)

      const expire = (conversation: ConversationId, approvals: Iterable<ApprovalId>) =>
        Effect.forEach(approvals, (approval) =>
          Effect.ignore(store.resolveApproval(conversation, approval, nisse, false)),
        )

      const makeTurn = Effect.fnUntraced(function* (
        conversation: Conversation,
        provider: ProviderState,
        driver: Driver,
      ): Effect.fn.Return<Made, never, Scope.Scope> {
        const id = conversation.id
        const spoken = yield* Ref.make("")
        const lastSaid = yield* Ref.make("")
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
            const withdrawn = Effect.sync(() => {
              waiting.delete(approval)
              openApprovals.delete(approval)
            })
            const answeredAll = Effect.andThen(
              withdrawn,
              Effect.sync(() => (openApprovals.size === 0 ? void store.commit(id, { status: "working" }) : undefined)),
            )
            return yield* Deferred.await(answered).pipe(
              Effect.onInterrupt(() => Effect.andThen(expire(id, [approval]), withdrawn)),
              Effect.tap(() => answeredAll),
            )
          })

        const tools = [...builtinTools, ...agentTools(agentContext(conversation, driver))]

        const host = (child: HostedChild) =>
          Effect.gen(function* () {
            yield* flush
            const { effort: _, ...model } = conversation.model
            const started = store.start(conversation.cwd, model, conversation.approvals, {
              lineage: {
                parent: id,
                root: conversation.lineage?.root ?? id,
                call: child.call,
                title: child.title,
                ...(child.agentType === undefined ? {} : { agentType: child.agentType }),
              },
            })
            store.commit(id, { entries: [subagentEntry(child.call, started.id, child.title, child.agentType)] })
            store.commit(started.id, {
              entries: [
                {
                  author: agentAuthor(id),
                  body: { _tag: "user", submission: newId() as SubmissionId, text: child.prompt },
                },
              ],
              status: "working",
            })
            const made = yield* makeTurn(started, { state: undefined, seq: 0 }, driver)
            hostedStops.set(started.id, child.stop)
            let ended = false
            const end = (outcome: Outcome, text: string) =>
              Effect.gen(function* () {
                if (ended) return
                ended = true
                hostedStops.delete(started.id)
                const lastSaid = store.transcript(started.id).findLast((entry) => entry.body._tag === "message")?.body
                if (
                  outcome === "answered" &&
                  text !== "" &&
                  !(lastSaid?._tag === "message" && lastSaid.text === text)
                ) {
                  yield* made.turn.message(text)
                }
                const { entries } = yield* made.close(outcome, outcome === "failed" ? text : undefined)
                store.commit(started.id, { entries, live: [{ _tag: "clear" }], status: "idle" })
              })
            yield* Effect.addFinalizer(() => end("interrupted", ""))
            return { turn: made.turn, end } satisfies Hosted
          })

        const turn: Turn = {
          conversation,
          transcript: Effect.sync(() => providerTranscript(conversation)),
          providerState: provider.state,
          providerSeq: provider.seq,
          tools,
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
              if (text !== "") yield* Ref.set(lastSaid, text)
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
          host,
          toolOutput: (call, text) => (text === "" ? Effect.void : live({ _tag: "output", call, append: text })),
          runTool: (call, tool = tools.find((known) => known.spec.name === call.tool)) =>
            Effect.gen(function* () {
              yield* recordCall(call)
              const outcome: ToolOutcome = !tool
                ? { output: `no tool named ${call.tool}`, error: true }
                : !tool.readOnly && !(yield* approve(call))
                  ? { output: "denied: the person did not allow this call", error: true }
                  : yield* tool.run(call.input, {
                      call: call.call,
                      ...(call.parent === undefined ? {} : { parent: call.parent }),
                      cwd: conversation.cwd,
                      env: toolEnv(conversation),
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
            const answer =
              outcome === "answered"
                ? said || (yield* Ref.get(lastSaid))
                : outcome === "interrupted"
                  ? undefined
                  : errored(message ?? outcome)
            const entries = [
              ...(said === "" ? [] : [{ author: nisse, body: { _tag: "message" as const, text: said } }]),
              ...[...openCalls].map(interruptedResult),
              runEnd(outcome, message),
            ]
            return answer === undefined ? { entries } : { entries, answer }
          })

        return { turn, close }
      })

      const run = Effect.fnUntraced(function* (id: ConversationId, resumed: boolean): Effect.fn.Return<Ended> {
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
          const message = `the server stopped during this run ${attempts} times in a row`
          return { entries: [runEnd("restart_limit", message)], answer: errored(message) }
        }
        const driver = providers.drivers.get(conversation.model.provider)
        if (!driver) {
          const message = `no provider named ${conversation.model.provider}`
          return { entries: [runEnd("failed", message)], answer: errored(message) }
        }
        return yield* Effect.scoped(drive(conversation, { state: providerState, seq: providerSeq }, driver))
      })

      const drive = Effect.fnUntraced(function* (conversation: Conversation, provider: ProviderState, driver: Driver) {
        const { turn, close } = yield* makeTurn(conversation, provider, driver)
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
              entries: [placedForNextRun(conversation, queued)],
              status: "working",
            }
          : { status: "idle" }
      }

      const proceed = (conversation: ConversationId, ended: ReadonlyArray<NewEntry> = []) =>
        Effect.sync(() => {
          const mail = store.queuedMail(conversation)
          const after = next(conversation)
          if (ended.length > 0 || mail.length > 0 || after.status === "working") {
            store.commit(conversation, {
              ...after,
              place: [...mail.map((queued) => queued.submission), ...(after.place ?? [])],
              entries: [
                ...ended,
                ...mail.map((queued) => placedForNextRun(conversation, queued)),
                ...(after.entries ?? []),
              ],
              ...(ended.length > 0 ? { live: [{ _tag: "clear" as const }] } : {}),
              attempts: after.status === "working" ? 1 : 0,
            })
          }
          if (after.status === "idle") active.delete(conversation)
          return after.status === "working"
        })

      const reportToParent = (id: ConversationId, answer: string | undefined): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (answer === undefined) return
          const { conversation } = yield* Effect.orDie(store.state(id))
          const lineage = conversation.lineage
          if (lineage?.task === undefined) return
          const parent = yield* Effect.orDie(store.state(lineage.parent))
          yield* deliver(id, lineage.parent, answer, {
            kind: "final_answer",
            task: taskOf(parent.conversation),
            sender: lineage.task,
          })
        })

      const runner = Effect.fnUntraced(function* (conversation: ConversationId) {
        const state = yield* Effect.orDie(store.state(conversation))
        let resumed = state.status !== "idle"
        let working = resumed || (yield* proceed(conversation))
        while (working) {
          const ended = yield* run(conversation, resumed)
          working = yield* proceed(conversation, ended.entries)
          yield* reportToParent(conversation, ended.answer)
          resumed = false
        }
      })

      const wake = (conversation: ConversationId): Effect.Effect<void> =>
        Effect.suspend(() => {
          if (settling || active.has(conversation)) return Effect.void
          active.add(conversation)
          return FiberSet.run(runners, Effect.andThen(lifetime.hold, runner(conversation)).pipe(Effect.scoped), {
            startImmediately: true,
          }).pipe(Effect.asVoid)
        })

      const nudges = new Map<ConversationId, Set<() => void>>()
      const nudge = (conversation: ConversationId) => {
        for (const wakeUp of nudges.get(conversation) ?? []) wakeUp()
      }

      const woken = (conversation: ConversationId): Woken | undefined => {
        const steers = store.queuedSteers(conversation)
        if (steers.some((steer) => steer.mail !== undefined)) return "mail"
        return steers.length > 0 ? "input" : undefined
      }

      const nextInput = (conversation: ConversationId, timeoutMs: number) =>
        Effect.callback<Woken>((resume) => {
          const now = woken(conversation)
          if (now) return resume(Effect.succeed(now))
          let waiters = nudges.get(conversation)
          if (!waiters) nudges.set(conversation, (waiters = new Set()))
          const done = (result: Woken) => {
            clearTimeout(timer)
            waiters.delete(check)
            if (waiters.size === 0) nudges.delete(conversation)
            resume(Effect.succeed(result))
          }
          const check = () => {
            const result = woken(conversation)
            if (result) done(result)
          }
          const timer = setTimeout(() => done("timeout"), timeoutMs)
          waiters.add(check)
          return Effect.sync(() => {
            clearTimeout(timer)
            waiters.delete(check)
            if (waiters.size === 0) nudges.delete(conversation)
          })
        })

      const post = (from: ConversationId, to: ConversationId, text: string, mail: Mail) => {
        const author = agentAuthor(from)
        if (mail.kind !== "new_task" && !active.has(to)) {
          store.commit(to, {
            entries: [{ author, body: { _tag: "user", submission: newId() as SubmissionId, text, mail } }],
          })
          return Effect.void
        }
        store.commit(to, {
          submit: { id: newId() as SubmissionId, requestId: newId(), author, text, steer: true, mail },
        })
        nudge(to)
        return mail.kind === "new_task" ? wake(to) : Effect.void
      }

      const deliver = (from: ConversationId, to: ConversationId, text: string, mail: Mail): Effect.Effect<void> =>
        Effect.suspend(() => post(from, to, text, mail))

      const crowded = (conversation: Conversation) => {
        const running = familyOf(conversation).filter(
          (member) =>
            member.conversation.lineage?.task !== undefined &&
            (member.status !== "idle" ||
              active.has(member.conversation.id) ||
              store.nextQueued(member.conversation.id) !== undefined),
        ).length
        return running < providers.agents.maxThreads
          ? undefined
          : `this tree already runs ${running} subagents, the most it may run at once; wait for one to finish`
      }

      const assign = (caller: Conversation, to: ConversationId, text: string, mail: Mail) =>
        Effect.suspend(() => {
          const refused = mail.kind === "new_task" && !active.has(to) ? crowded(caller) : undefined
          return refused === undefined ? Effect.as(post(caller.id, to, text, mail), undefined) : Effect.succeed(refused)
        })

      const spawn = (parent: Conversation, child: Child, message: string) =>
        Effect.suspend(() => {
          if (familyOf(parent).some((member) => member.conversation.lineage?.task === child.task)) {
            return Effect.succeed(`an agent named ${child.task} already exists`)
          }
          const refused = crowded(parent)
          if (refused !== undefined) return Effect.succeed(refused)
          const lineage = {
            parent: parent.id,
            root: parent.lineage?.root ?? parent.id,
            call: child.call,
            task: child.task,
            title: child.title,
            ...(child.agentType === undefined ? {} : { agentType: child.agentType }),
            ...(child.forkedAt === undefined ? {} : { forkedAt: child.forkedAt }),
          }
          const started = store.start(parent.cwd, child.model, parent.approvals, { lineage })
          store.commit(parent.id, {
            entries: [subagentEntry(child.call, started.id, child.title, child.agentType)],
          })
          return Effect.as(
            post(parent.id, started.id, message, { kind: "new_task", task: child.task, sender: taskOf(parent) }),
            undefined,
          )
        })

      const familyOf = (conversation: Conversation) => store.family(conversation.lineage?.root ?? conversation.id)

      const descendants = (conversation: Conversation): Array<ConversationId> => {
        const family = familyOf(conversation)
        const found: Array<ConversationId> = []
        const parents = [conversation.id]
        while (parents.length > 0) {
          const parent = parents.pop()!
          for (const member of family) {
            if (member.conversation.lineage?.parent !== parent) continue
            found.push(member.conversation.id)
            parents.push(member.conversation.id)
          }
        }
        return found
      }

      const interruptTree = (conversation: Conversation) =>
        Effect.forEach(
          [conversation.id, ...descendants(conversation)],
          (id) => {
            const fiber = runs.get(id)
            if (fiber) return Fiber.interrupt(fiber)
            return id === conversation.id ? (hostedStops.get(id) ?? Effect.void) : Effect.void
          },
          { concurrency: "unbounded", discard: true },
        )

      const providerTranscript = (conversation: Conversation): ReadonlyArray<Entry> => {
        const own = store.transcript(conversation.id)
        const lineage = conversation.lineage
        if (lineage?.forkedAt === undefined) return own
        const parent = Effect.runSync(Effect.option(store.state(lineage.parent)))
        if (Option.isNone(parent)) return own
        const inherited = providerTranscript(parent.value.conversation).filter((entry) => entry.seq < lineage.forkedAt!)
        const { calls } = danglingIn(inherited)
        return [...inherited.filter((entry) => entry.body._tag !== "tool_call" || !calls.has(entry.body.call)), ...own]
      }

      const agentContext = (caller: Conversation, driver: Driver): AgentContext => ({
        caller,
        limits: providers.agents,
        types: driver.agentTypes(caller.cwd),
        models: driver.models(false),
        family: () => familyOf(caller).filter((member) => !isHosted(member.conversation)),
        hasWork: (id) => store.nextQueued(id) !== undefined,
        transcript: (id) => store.transcript(id),
        spawn: (child, message) => spawn(caller, child, message),
        deliver: (to, text, mail) => assign(caller, to, text, mail),
        interrupt: (id) =>
          Effect.flatMap(Effect.orDie(store.state(id)), ({ conversation }) => interruptTree(conversation)),
        nextInput: (timeoutMs) => nextInput(caller.id, timeoutMs),
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

      const strand = (id: ConversationId) =>
        Effect.gen(function* () {
          const dangling = danglingIn(store.transcript(id))
          yield* expire(id, dangling.approvals)
          store.commit(id, {
            entries: [...[...dangling.calls].map(interruptedResult), runEnd("interrupted")],
            live: [{ _tag: "clear" }],
            status: "idle",
          })
        })

      for (const conversation of new Set([...store.openRuns(), ...store.pending()])) {
        const { conversation: found } = yield* Effect.orDie(store.state(conversation))
        yield* isHosted(found) ? strand(conversation) : wake(conversation)
      }

      return Conversations.of({
        start: (cwd, options) =>
          Effect.suspend(() => {
            const existing = options.id === undefined ? undefined : store.find(options.id)
            if (existing) return Effect.succeed(existing)
            const model = chosenModel(cwd, options)
            if (!providers.drivers.has(model.provider)) {
              return Effect.fail(new UnknownProvider({ provider: model.provider }))
            }
            return Effect.succeed(
              store.start(cwd, model, options.approvals ?? "ask", {
                ...(options.id === undefined ? {} : { id: options.id }),
                ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
              }),
            )
          }),
        selectModel: (conversation, author, selection) =>
          Effect.gen(function* () {
            const found = yield* store.state(conversation)
            if (isHosted(found.conversation)) return yield* new TakesNoInput({ conversation })
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
            const found = yield* store.state(conversation)
            if (isHosted(found.conversation)) return yield* new TakesNoInput({ conversation })
            const existing = store.submissionFor(conversation, requestId)
            if (existing) return existing
            const id = newId() as SubmissionId
            store.commit(conversation, {
              submit: { id, requestId, author: { _tag: "person", name: author }, text, steer },
            })
            if (steer) nudge(conversation)
            yield* wake(conversation)
            return id
          }),
        interrupt: (id) =>
          Effect.gen(function* () {
            const { conversation } = yield* store.state(id)
            const running = runs.has(id)
            yield* interruptTree(conversation)
            const lineage = conversation.lineage
            if (!running || lineage?.task === undefined) return
            const parent = yield* Effect.orDie(store.state(lineage.parent))
            yield* deliver(id, lineage.parent, INTERRUPTED_BY_A_PERSON, {
              kind: "final_answer",
              task: taskOf(parent.conversation),
              sender: lineage.task,
            })
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
