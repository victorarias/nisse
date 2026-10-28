import type {
  AuthInteraction,
  AuthMethod,
  AuthResponse,
  CallId,
  Conversation,
  Entry,
  ModelInfo,
  ModelSelection,
  ProviderHealth,
} from "@nisse/protocol"
import { Context, Effect, Schema } from "effect"
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
  readonly providerSeq: number
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

export interface SignInFlow {
  readonly show: (interaction: AuthInteraction) => Effect.Effect<void>
  readonly response: Effect.Effect<AuthResponse>
}

export type Health = Omit<ProviderHealth, "checkedAt">

export interface Driver {
  readonly kind: string
  readonly defaultModel?: string
  readonly run: (turn: Turn) => Effect.Effect<void, ProviderError>
  readonly health: (refresh: boolean) => Effect.Effect<Health>
  readonly models: (refresh: boolean) => Effect.Effect<ReadonlyArray<ModelInfo>>
  readonly signInMethods: ReadonlyArray<AuthMethod>
  readonly signIn: (method: AuthMethod, flow: SignInFlow) => Effect.Effect<void, ProviderError>
  readonly signOut: Effect.Effect<void, ProviderError>
}

export const nothingToSignIn = {
  signInMethods: [],
  signIn: () => Effect.fail(new ProviderError({ message: "there is nothing to sign in to" })),
  signOut: Effect.fail(new ProviderError({ message: "there is nothing to sign out of" })),
} satisfies Pick<Driver, "signInMethods" | "signIn" | "signOut">

export class Providers extends Context.Service<
  Providers,
  {
    readonly drivers: ReadonlyMap<string, Driver>
    readonly preferred: string
    readonly defaultModel?: ModelSelection
  }
>()("nisse/Providers") {}
