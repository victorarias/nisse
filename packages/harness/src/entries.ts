// The harness's entry kinds (spec section 8.1).
import { defineEntry, type JsonObject } from "@sigma/kernel"
import type { Message } from "@sigma/models"
import type { CompactionReason, ToolDiagnostic } from "./types.ts"

/** User input: `model` is `[UserMessage]`. Written by submissions. */
export const UserEntry = defineEntry("pi.user")
/** A provider result with any stop reason: `model` is `[AssistantMessage]`. Written by generation. */
export const AssistantEntry = defineEntry("pi.assistant")
/** A positional prompt and tool change: `model` is `[SystemMessage]` with empty `content` (spec 7.4). */
export const SystemEntry = defineEntry("pi.system")
/** A tool result: `model` is `[ToolResultMessage]`; `data` holds the structured diagnostics. */
export const ToolResultEntry = defineEntry<{ diagnostics: ToolDiagnostic[] }>("pi.tool-result")
/** The start of a new context: `head: "self"`, with the handoff text as `[UserMessage]` when there is one. */
export const ResetEntry = defineEntry("pi.reset")
/** A compaction summary: `model` is `[UserMessage]`, `head` the first kept entry. */
export const CompactionEntry = defineEntry<{ reason: CompactionReason }>("pi.compaction")

/** A model message as an entry's `model` stores it: plain JSON. */
export const stored = (message: Message): JsonObject => message as unknown as JsonObject
