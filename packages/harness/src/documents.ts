// The built-in conversation documents the creation hook writes (spec 7.1). Their contents belong to the parts of the
// harness that fill them: `pi.live` to runs, `pi.inbox` to submissions, `pi.usage` to generation, `pi.provider` to
// provider requests. Each child that fills one gives it its full type.
import { defineDoc, type JsonObject } from "@nisse/kernel"
import { uuidv7 } from "@nisse/models"

/** Run control and presentation of the conversation's current work. */
export const LiveDoc = defineDoc<JsonObject>({
  kind: "pi.live",
  version: 3,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
  // Version 1 named a compaction's trigger `reason`; versions 1 and 2 may lack `run.turns`.
  migrate: (value) => {
    const { run, compactions, compactionFailure } = value as {
      run?: JsonObject
      compactions?: JsonObject[]
      compactionFailure?: JsonObject
    }
    return {
      ...value,
      ...(run === undefined ? {} : { run: { ...run, turns: typeof run.turns === "number" ? run.turns : 0 } }),
      ...(compactions === undefined ? {} : { compactions: compactions.map(renameReason) }),
      ...(compactionFailure === undefined ? {} : { compactionFailure: renameReason(compactionFailure) }),
    }
  },
  // A complete base whenever nothing runs: no generation and no running tool slot (spec 8.2).
  checkpointWhen: (value) => {
    const running = (slots: unknown) =>
      Array.isArray(slots) && slots.some((slot: { readonly status?: unknown }) => slot.status === "running")
    return value.generation === undefined && !running(value.tools) && !running(value.nestedTools)
  },
})

/** A copy of a version 1 compaction status or failure with `reason` renamed `trigger`, its keys in their order. */
function renameReason(value: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value).map(([key, field]) => [key === "reason" ? "trigger" : key, field]))
}

/** Queued submissions. */
export const InboxDoc = defineDoc<{ items: JsonObject[] }>({
  kind: "pi.inbox",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ items: [] }),
  checkpointWhen: (value) => value.items.length === 0,
})

/** The conversation's own spend, by model and by tool. */
export const UsageDoc = defineDoc<{ models: JsonObject; tools: JsonObject }>({
  kind: "pi.usage",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ models: {}, tools: {} }),
  checkpointWhen: () => true,
})

/** The provider-facing identity; every fork starts with a fresh one. */
export const ProviderDoc = defineDoc<{ sessionId: string }>({
  kind: "pi.provider",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ sessionId: uuidv7() }),
  checkpointWhen: () => true,
})
