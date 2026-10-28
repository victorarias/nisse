import type { CallId, Conversation, Entry } from "@nisse/protocol"
import { Context, type Effect, Schema } from "effect"
import type { ToolOutcome, ToolSpec } from "./tools/index.ts"

export class ProviderError extends Schema.TaggedError<ProviderError>()("ProviderError", { message: Schema.String }) {}

export interface Call {
  readonly call: CallId
  readonly tool: string
  readonly input: unknown
}

export interface Saved {
  readonly state?: unknown
}

export interface Turn {
  readonly conversation: Conversation
  readonly transcript: Effect.Effect<ReadonlyArray<Entry>>
  readonly providerState: unknown
  readonly tools: ReadonlyArray<ToolSpec>
  readonly say: (text: string) => Effect.Effect<void>
  readonly message: (text: string, saved?: Saved) => Effect.Effect<void>
  readonly runTool: (call: Call, saved?: Saved) => Effect.Effect<ToolOutcome>
  readonly recordCall: (call: Call, saved?: Saved) => Effect.Effect<void>
  readonly approve: (call: Call) => Effect.Effect<boolean>
  readonly recordResult: (call: CallId, outcome: ToolOutcome, saved?: Saved) => Effect.Effect<void>
  readonly toolOutput: (call: CallId, text: string) => Effect.Effect<void>
  readonly steers: Effect.Effect<ReadonlyArray<string>>
}

export interface Driver {
  readonly run: (turn: Turn) => Effect.Effect<void, ProviderError>
}

export class Providers extends Context.Service<
  Providers,
  { readonly drivers: ReadonlyMap<string, Driver>; readonly preferred: string }
>()("nisse/Providers") {}
