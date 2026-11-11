import type { ProviderAccount, ProviderError } from "@nisse/models"
import type { CallId, Conversation, Entry, ModelSelection, Outcome, Skill } from "@nisse/protocol"
import { Context, type Effect, type Scope } from "effect"
import type { AgentLimits } from "./agents.ts"
import type { RequestShape } from "./extensions/index.ts"
import type { Tool, ToolOutcome } from "./tools/index.ts"
import type { AgentType } from "./workspace.ts"

export { nothingToSignIn, ProviderError, type Health, type SignInFlow } from "@nisse/models"

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
  readonly addedTools: ReadonlyArray<Tool>
  readonly removedTools: ReadonlyArray<string>
  readonly before: (call: Call) => Effect.Effect<Call | { readonly refused: string }>
  readonly after: (call: Call, outcome: ToolOutcome, changeable: boolean) => Effect.Effect<ToolOutcome>
  readonly request: (tools: ReadonlyArray<string>) => Effect.Effect<RequestShape>
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

/** A provider as the shipping server runs it: its account, and the loop it runs a turn with. */
export interface Driver extends ProviderAccount {
  readonly run: (turn: Turn) => Effect.Effect<void, ProviderError>
  readonly skills: (cwd: string) => ReadonlyArray<Skill>
  readonly agentTypes: (cwd: string) => ReadonlyArray<AgentType>
  readonly tools: (conversation: Conversation) => ReadonlyArray<Tool>
}

export const nothingOfItsOwn = { skills: () => [], agentTypes: () => [], tools: () => [] } satisfies Pick<
  Driver,
  "skills" | "agentTypes" | "tools"
>

export class Providers extends Context.Service<
  Providers,
  {
    readonly drivers: ReadonlyMap<string, Driver>
    readonly preferred: string
    readonly defaultModel?: ModelSelection
    readonly agents: AgentLimits
  }
>()("nisse/Providers") {}
