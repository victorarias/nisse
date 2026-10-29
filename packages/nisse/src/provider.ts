import type {
  AuthInteraction,
  AuthMethod,
  AuthResponse,
  CallId,
  Conversation,
  Entry,
  ModelInfo,
  ModelSelection,
  Outcome,
  ProviderHealth,
  Skill,
} from "@nisse/protocol"
import { Context, Effect, Schema, type Scope } from "effect"
import type { AgentLimits } from "./agents.ts"
import type { Tool, ToolOutcome } from "./tools/index.ts"
import type { AgentType } from "./workspace.ts"

export class ProviderError extends Schema.TaggedError<ProviderError>()("ProviderError", { message: Schema.String }) {}

export interface Call {
  readonly call: CallId
  readonly tool: string
  readonly input: unknown
  readonly parent?: CallId
}

export interface Saved {
  readonly state?: unknown
}

export interface HostedChild {
  readonly call: CallId
  readonly title: string
  readonly agentType?: string
  readonly prompt: string
  readonly stop: Effect.Effect<void>
}

export interface Hosted {
  readonly turn: Turn
  readonly end: (outcome: Outcome, text: string) => Effect.Effect<void>
}

export interface Turn {
  readonly conversation: Conversation
  readonly transcript: Effect.Effect<ReadonlyArray<Entry>>
  readonly providerState: unknown
  readonly providerSeq: number
  readonly tools: ReadonlyArray<Tool>
  readonly say: (text: string) => Effect.Effect<void>
  readonly message: (text: string, saved?: Saved) => Effect.Effect<void>
  readonly runTool: (call: Call, tool?: Tool) => Effect.Effect<ToolOutcome>
  readonly recordCall: (call: Call, saved?: Saved) => Effect.Effect<void>
  readonly approve: (call: Call) => Effect.Effect<boolean>
  readonly recordResult: (call: CallId, outcome: ToolOutcome, saved?: Saved) => Effect.Effect<void>
  readonly toolOutput: (call: CallId, text: string) => Effect.Effect<void>
  readonly steers: Effect.Effect<ReadonlyArray<string>>
  readonly host: (child: HostedChild) => Effect.Effect<Hosted, never, Scope.Scope>
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
  readonly skills: (cwd: string) => ReadonlyArray<Skill>
  readonly agentTypes: (cwd: string) => ReadonlyArray<AgentType>
  readonly tools: (conversation: Conversation) => ReadonlyArray<Tool>
}

export const nothingOfItsOwn = { skills: () => [], agentTypes: () => [], tools: () => [] } satisfies Pick<
  Driver,
  "skills" | "agentTypes" | "tools"
>

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
    readonly agents: AgentLimits
  }
>()("nisse/Providers") {}
