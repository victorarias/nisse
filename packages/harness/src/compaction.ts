// What generation asks of compaction (spec 8.3): the policy that applies, the context's size, where a cut would go,
// and a compaction task. Until the `harness-compaction` step fills it, no cut is ever found, so a generation never
// starts a compaction and a context overflow fails its run.
import type { ConversationId, StorageError, TaskId, Tx } from "@nisse/kernel"
import type { Message } from "@nisse/models"
import { Effect } from "effect"
import type {
  CompactionPolicy,
  CompactionReason,
  CompactionResult,
  CompactionSettings,
  ContextView,
  ModelRef,
  Settings,
} from "./types.ts"

/** The compaction policy for a request to `model`: per-model overrides, then the conversation's, then the host's. */
export function compactionPolicy(
  settings: Settings,
  model: ModelRef,
  conversation: CompactionSettings | undefined,
): CompactionPolicy {
  const key = `${model.provider}/${model.modelId}`
  const { modelOverrides, ...harness } = settings.compaction
  const conversationModel = conversation?.modelOverrides?.[key]
  const layers: readonly (Partial<CompactionPolicy> | undefined)[] = [
    conversationModel,
    modelOverrides?.[key],
    conversation,
  ]
  const field = <K extends keyof CompactionPolicy>(name: K): CompactionPolicy[K] =>
    layers.find((layer) => layer?.[name] !== undefined)?.[name] ?? harness[name]
  return {
    enabled: conversationModel?.enabled ?? (conversation?.enabled === false ? false : field("enabled")),
    reserveTokens: field("reserveTokens"),
    keepRecentTokens: field("keepRecentTokens"),
    backgroundTokens: field("backgroundTokens"),
  }
}

/** The estimated tokens of `view`'s context with `planned` messages appended. */
export const estimateContext = (_view: ContextView, _planned: readonly Message[]): number => 0

/** Where a compaction keeping `keepRecentTokens` would cut `view`; `undefined` when nothing can be compacted. */
export const selectCut = (_view: ContextView, _keepRecentTokens: number): EntryCut | undefined => undefined

/** A cut `selectCut` found. */
export type EntryCut = never

/** Creates a compaction task, owned by `owner` when given, else by the conversation. */
export const createCompaction = (
  _tx: Tx,
  _conversationId: ConversationId,
  _options: { readonly reason: CompactionReason },
  _owner?: TaskId,
): Effect.Effect<TaskId<CompactionResult>, StorageError> =>
  Effect.die(new Error("Compaction runs once the harness-compaction step of the kernel rebuild lands"))
