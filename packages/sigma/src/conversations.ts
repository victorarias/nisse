// What a client reads of a kernel conversation beside its view: the id it names it by, where a subagent came from,
// and how its last run ended. `conversation/list` answers these for every conversation, and extension hooks see the
// lineage of the conversation they run in.
import { ApprovalsDoc, type Harness, SubagentOriginDoc } from "@sigma/harness"
import { type ConversationId, type ConversationRecord, type Cursor, type EntryId } from "@sigma/kernel"
import { type ConversationInfo, type Lineage, type RunEnd, type TreeStatus, USER_KIND } from "@sigma/protocol"
import { Effect } from "effect"
import { ConversationIdsDoc } from "./ids.ts"
import { selectionOf } from "./providers.ts"
import { LastRunEndDoc } from "./run-end.ts"

const SCAN_PAGE = 256

/** The id clients name a conversation by: the one a client chose, or its number. */
export const wireId = (harness: Harness, id: ConversationId) =>
  Effect.map(Effect.orDie(harness.session.snapshot(ConversationIdsDoc)), (chosen) => {
    const pair = Object.entries(chosen?.ids ?? {}).find(([, number]) => number === Number(id))
    return pair?.[0] ?? String(id)
  })

const record = (harness: Harness, id: ConversationId) =>
  Effect.orDie(harness.session.read((storage) => storage.conversation(id)))

/**
 * Where a subagent came from, or `undefined` for a conversation no call started. Its parent is its owner's
 * conversation, and its root the conversation at the top of the owners.
 */
export const lineageOf = (harness: Harness, id: ConversationId): Effect.Effect<Lineage | undefined> =>
  Effect.gen(function* () {
    const origin = yield* Effect.orDie(harness.session.snapshot(SubagentOriginDoc, id))
    const parent = (yield* record(harness, id))?.owner?.conversationId
    if (origin === undefined || parent === undefined) return undefined
    let root = parent
    for (;;) {
      const owner = (yield* record(harness, root))?.owner?.conversationId
      if (owner === undefined) break
      root = owner
    }
    return {
      parent: yield* wireId(harness, parent),
      root: yield* wireId(harness, root),
      call: origin.call,
      title: origin.title,
      ...(origin.task === undefined ? {} : { task: origin.task }),
      ...(origin.agentType === undefined ? {} : { agentType: origin.agentType }),
    }
  })

type Ended = NonNullable<TreeStatus["ended"]>

const textOf = (model: unknown) =>
  ((model as { content?: Array<{ type: string; text?: string }> } | undefined)?.content ?? [])
    .flatMap((block) => (block.type === "text" ? [block.text ?? ""] : []))
    .join("")

/** The last thing the model wrote in the conversation at or before the entry `end`. */
export const saidBefore = (harness: Harness, id: ConversationId, end: EntryId) =>
  Effect.gen(function* () {
    const conversation = yield* Effect.orDie(harness.conversation(id))
    if (conversation === undefined) return undefined
    let cursor: Cursor | undefined
    do {
      const page = yield* Effect.orDie(conversation.entries({ maxEntryId: end }, SCAN_PAGE, cursor))
      for (const entry of page.items) {
        if (entry.kind !== "pi.assistant") continue
        const text = textOf(entry.model?.[0])
        if (text !== "") return text
      }
      cursor = page.next
    } while (cursor !== undefined)
    return undefined
  })

/**
 * How many entries a read for the first prompt takes at a time. The first prompt is a conversation's first entry
 * (measured: `sigma.started`, `sigma.user`, then `pi.system`), so one page holds it and a list does not parse a page of tool results.
 */
const FIRST_PROMPT_PAGE = 16

/** The first line of the conversation's first prompt, inherited ones included; `undefined` before one. */
const firstPrompt = (harness: Harness, id: ConversationId) =>
  Effect.gen(function* () {
    const conversation = yield* Effect.orDie(harness.conversation(id))
    if (conversation === undefined) return undefined
    let cursor: Cursor | undefined
    do {
      const page = yield* Effect.orDie(conversation.entries({ order: "ascending" }, FIRST_PROMPT_PAGE, cursor))
      for (const entry of page.items) {
        // A person's prompt is a sigma.user; a subagent's, which a fork of it inherits, a pi.user.
        if (entry.kind !== USER_KIND && entry.kind !== "pi.user") continue
        // What the person typed is the first text; the skills it named follow as text of their own.
        const content = (entry.model?.[0] as { content?: string | Array<{ type: string; text?: string }> } | undefined)
          ?.content
        const typed = typeof content === "string" ? content : content?.find((block) => block.type === "text")?.text
        return (typed ?? "").trim().split("\n")[0]
      }
      cursor = page.next
    } while (cursor !== undefined)
    return undefined
  })

/** What a person knows the conversation by: a subagent's title, or else the first line of its first prompt. */
const titled = (harness: Harness, id: ConversationId, lineage: Lineage | undefined) =>
  Effect.map(lineage === undefined ? firstPrompt(harness, id) : Effect.succeed(lineage.title), (title) =>
    title === "" ? undefined : title,
  )

/** The conversation's title, as `conversation/list` shows it; `undefined` before its first prompt. */
export const titleOf = (harness: Harness, id: ConversationId) =>
  Effect.flatMap(lineageOf(harness, id), (lineage) => titled(harness, id, lineage))

/** How the run ended at the `sigma.run_end` entry `end`, with the last thing the model said. */
export const endedAt = (harness: Harness, id: ConversationId, end: { id: EntryId; data?: unknown }) =>
  Effect.gen(function* () {
    const data = end.data as RunEnd
    const said = yield* saidBefore(harness, id, end.id)
    const ended: Ended = {
      outcome: data.outcome,
      ...(data.message === undefined ? {} : { message: data.message }),
      ...(said === undefined ? {} : { said }),
    }
    return ended
  })

/** How the conversation's last run ended, or `undefined` before its first run ends. */
const lastEnded = (harness: Harness, id: ConversationId) =>
  Effect.flatMap(Effect.orDie(harness.session.snapshot(LastRunEndDoc, id)), (last) =>
    last?.end === undefined ? Effect.succeed(undefined) : endedAt(harness, id, last.end),
  )

const info = (harness: Harness, conversation: ConversationRecord): Effect.Effect<ConversationInfo> =>
  Effect.gen(function* () {
    const agent = yield* Effect.orDie(harness.resolveAgent(conversation.id))
    const approvals = yield* Effect.orDie(harness.session.snapshot(ApprovalsDoc, conversation.id))
    const lineage = yield* lineageOf(harness, conversation.id)
    const ended = yield* lastEnded(harness, conversation.id)
    // A subagent's instructions are sigma's, naming its task; only those a client started a conversation with show.
    const instructions = lineage === undefined ? agent.instructions : undefined
    const title = yield* titled(harness, conversation.id, lineage)
    const parent = conversation.parent
    return {
      id: yield* wireId(harness, conversation.id),
      number: Number(conversation.id),
      ...(title === undefined ? {} : { title }),
      ...(parent === undefined
        ? {}
        : { fork: { of: yield* wireId(harness, parent.conversationId), at: Number(parent.at) } }),
      cwd: agent.cwd ?? "",
      model: selectionOf(agent),
      approvals: approvals?.auto === true ? "auto" : "ask",
      ...(lineage === undefined ? {} : { lineage }),
      ...(instructions === undefined ? {} : { instructions }),
      ...(ended === undefined ? {} : { ended }),
    }
  })

/** Every conversation, subagents included, oldest first. */
export const listConversations = (harness: Harness) =>
  Effect.gen(function* () {
    const records: ConversationRecord[] = []
    let cursor: Cursor | undefined
    do {
      const page = yield* Effect.orDie(
        harness.session.read((storage) => storage.scanConversations({}, SCAN_PAGE, cursor)),
      )
      records.push(...page.items)
      cursor = page.next
    } while (cursor !== undefined)
    return yield* Effect.forEach(records, (conversation) => info(harness, conversation))
  })
