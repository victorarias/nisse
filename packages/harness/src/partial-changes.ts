// What a streamed answer changed in its partial message between two partial commits, so a commit costs the new text.
// From pi-durable's `src/harness/partial-changes.ts` at 7d073328e (MIT, see LICENSE).
import { appendText, type Draft } from "@sigma/delta"
import type { JsonValue } from "@sigma/delta/json"
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type JsonChange,
  type JsonRepresentation,
  StreamingJsonParser,
  type ToolCall,
} from "@sigma/models"
import { type AssignPlan, assignJson } from "./json.ts"
import type { LiveState, Stored } from "./live.ts"

type JsonContainer = Record<string, JsonValue> | JsonValue[]

/** A partial message as `pi.live.generation.message` holds it. */
export type PartialMessage = Stored<JsonRepresentation<AssistantMessage>>

/** Committed arguments of a streamed tool call. */
type Arguments = PartialMessage["content"][number] extends infer B
  ? B extends { type: "toolCall"; arguments: infer A }
    ? A
    : never
  : never

/** What one partial commit writes besides the partial message itself; from `PartialChanges.take()`. */
export type PartialCommit = {
  /** The plan `assignJson()` writes the message with: text appends, and the arguments it leaves to `changes`. */
  readonly plan: AssignPlan
  /** Each tracked tool call by content index: its argument changes since the last commit, in order, and its snapshot. */
  readonly toolCalls: ReadonlyMap<number, { readonly changes: readonly JsonChange[]; readonly snapshot: Arguments }>
}

/** What a tracked tool call changed since the last commit, and whether any commit took its changes yet. */
type ToolCallState = { readonly parser: StreamingJsonParser; changes: JsonChange[]; committed: boolean }

/**
 * Collects, from a response's events, what changed in its partial message since the last commit, so the commit appends
 * new text instead of reassigning growing strings, which costs a compare of the whole string per commit.
 *
 * - Text and thinking: the `text_delta` and `thinking_delta` events. The commit appends them where the committed string
 *   plus the deltas has the new string's length, and compares otherwise. A block's `*_end` event drops them, because
 *   providers may replace the text when a block ends.
 * - Tool-call arguments: a `StreamingJsonParser` per call, fed with the raw argument text of each `toolcall_delta`,
 *   reports what each piece changed. The commit applies those changes to the committed arguments in order and leaves
 *   the arguments out of the message assignment, so the committed arguments are exactly the parsed text so far.
 *   `toolcall_end` ends the tracking; the call's last commit assigns its final arguments.
 */
export class PartialChanges {
  #text = new Map<number, { readonly field: "text" | "thinking"; text: string }>()
  readonly #toolCalls = new Map<number, ToolCallState>()

  /** Records what `event` changed. */
  observe(event: AssistantMessageEvent): void {
    switch (event.type) {
      case "text_delta":
      case "thinking_delta": {
        const field = event.type === "text_delta" ? "text" : "thinking"
        const pending = this.#text.get(event.contentIndex)
        if (pending?.field === field) pending.text += event.delta
        else this.#text.set(event.contentIndex, { field, text: event.delta })
        return
      }
      case "toolcall_start":
        this.#toolCalls.set(event.contentIndex, { parser: new StreamingJsonParser(), changes: [], committed: false })
        return
      case "toolcall_delta": {
        const call = this.#toolCalls.get(event.contentIndex)
        if (call === undefined) return
        for (const change of call.parser.append(event.delta)) {
          // Arguments are an object: any other root shows as no arguments, so the snapshot is committed instead.
          if (change.path.length === 0 && !isRecord(change.kind === "set" ? change.value : null)) {
            this.#toolCalls.delete(event.contentIndex)
            return
          }
          call.changes.push(change)
        }
        return
      }
      case "text_end":
      case "thinking_end":
        this.#text.delete(event.contentIndex)
        return
      case "toolcall_end":
        this.#toolCalls.delete(event.contentIndex)
        return
    }
  }

  /**
   * Takes what changed since the last call, for a commit of `message`, a copy of the partial. Clears the arguments of
   * tracked tool calls in `message`: the commit writes them from the changes. Call `restore()` if the commit fails.
   */
  take(message: PartialMessage): PartialCommit {
    const blocks = new Map<string | number, AssignPlan>()
    for (const [index, { field, text }] of this.#text) {
      blocks.set(index, { kind: "fields", fields: new Map([[field, { kind: "append", text }]]) })
    }
    this.#text = new Map()
    const toolCalls = new Map<number, { readonly changes: readonly JsonChange[]; readonly snapshot: Arguments }>()
    for (const [index, call] of this.#toolCalls) {
      const block = message.content[index]
      // A tracked call is the tool call its `toolcall_start` named; the narrowing only tells TypeScript.
      if (block?.type !== "toolCall") continue
      toolCalls.set(index, { changes: call.changes, snapshot: block.arguments })
      block.arguments = {}
      blocks.set(index, { kind: "fields", fields: new Map([["arguments", { kind: "keep" }]]) })
      call.changes = []
    }
    return { plan: { kind: "fields", fields: new Map([["content", { kind: "fields", fields: blocks }]]) }, toolCalls }
  }

  /**
   * Writes `message` with what `commit` took into `generation.message`: the message leaf by leaf with the plan, then the
   * argument changes. A tracked call whose block is new here gets its arguments from its changes, which then start at
   * its first piece; when the committed message lost a call whose changes were already committed (another writer reset
   * it), the call falls back to its snapshot from now on.
   */
  commit(
    generation: Draft<NonNullable<LiveState["generation"]>>,
    message: PartialMessage,
    commit: PartialCommit,
  ): void {
    const committedBlocks = generation.message?.content.length ?? 0
    const apply: [number, readonly JsonChange[]][] = []
    // Calls whose arguments this commit assigns from their snapshot instead of applying changes.
    const assigned = new Set<number>()
    for (const [index, { changes, snapshot }] of commit.toolCalls) {
      const call = this.#toolCalls.get(index)
      const block = message.content[index]
      if (call === undefined) {
        // The call ended after `take()`: its changes may no longer fit, so its snapshot is what this commit writes.
        if (block?.type === "toolCall") block.arguments = snapshot
        assigned.add(index)
        continue
      }
      if (index >= committedBlocks && call.committed && block?.type === "toolCall") {
        // The earlier changes are not in the committed message: commit the snapshot and stop tracking the call.
        this.#toolCalls.delete(index)
        block.arguments = snapshot
        assigned.add(index)
        continue
      }
      call.committed = true
      apply.push([index, changes])
    }
    assignJson(generation, "message", message as Draft<PartialMessage> & JsonValue, withoutKeep(commit.plan, assigned))
    const content = generation.message?.content ?? []
    for (const [index, changes] of apply) {
      const block = content[index]
      if (block?.type !== "toolCall") continue
      for (const change of changes) applyChange(block, change)
    }
  }

  /** Puts back what a failed commit took, so the next commit applies it first. */
  restore(commit: PartialCommit): void {
    for (const [index, { changes }] of commit.toolCalls) {
      const call = this.#toolCalls.get(index)
      if (call !== undefined) call.changes = [...changes, ...call.changes]
    }
  }
}

/** `plan` with the arguments of the blocks in `assigned` written by `assignJson()` rather than kept for changes. */
function withoutKeep(plan: AssignPlan, assigned: ReadonlySet<number>): AssignPlan {
  if (assigned.size === 0 || plan.kind !== "fields") return plan
  const content = plan.fields.get("content")
  if (content?.kind !== "fields") return plan
  const blocks = new Map(content.fields)
  for (const index of assigned) blocks.delete(index)
  return { kind: "fields", fields: new Map([...plan.fields, ["content", { kind: "fields", fields: blocks }]]) }
}

/** Applies one argument change to the committed arguments of `block`. */
function applyChange(block: Draft<JsonRepresentation<ToolCall>>, change: JsonChange): void {
  const key = change.path.at(-1)
  if (key === undefined) {
    // Only an object root is tracked (`observe()` drops any other), and only `set` starts it.
    const root = change.kind === "set" ? change.value : undefined
    if (isRecord(root)) block.arguments = root as Draft<Arguments>
    return
  }
  // The path follows the parsed argument text, not a type: each segment names a container `observe()` saw set.
  let parent = block.arguments as unknown as JsonContainer
  for (const segment of change.path.slice(0, -1)) {
    parent = (parent as Record<string | number, JsonContainer>)[segment]!
  }
  const slots = parent as Record<string | number, JsonValue>
  if (change.kind === "set") slots[key] = change.value as JsonValue
  // appendText() takes object members; a string in an array is reassigned, which compares it whole.
  else if (Array.isArray(parent)) slots[key] = `${slots[key] as string}${change.text}`
  else appendText(parent as unknown as Draft<Record<string, string>>, String(key), change.text)
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
