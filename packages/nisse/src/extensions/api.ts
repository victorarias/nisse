import type { CallId, Conversation } from "@nisse/protocol"
import { Effect, Schema, type Scope } from "effect"
import { failed, ok, tool, type Tool as NisseTool, type ToolOutcome } from "../tools/tool.ts"

export class Refused extends Schema.TaggedError<Refused>()("Refused", { message: Schema.String }) {}

export interface ConversationHandle extends Pick<Conversation, "id" | "cwd" | "model" | "lineage"> {
  readonly status: (text?: string) => Effect.Effect<void>
  readonly toast: (text: string) => Effect.Effect<void>
}

export interface ToolCall {
  readonly conversation: ConversationHandle
  readonly call: CallId
  readonly tool: string
  input: unknown
}

export interface ToolResult {
  readonly conversation: ConversationHandle
  readonly call: CallId
  readonly tool: string
  readonly input: unknown
  outcome: { output: string; error: boolean }
}

export interface ModelRequest {
  readonly conversation: ConversationHandle
  instructions: Array<string>
  tools: Array<string>
}

export interface ToolHooks {
  readonly "execute.before": ToolCall
  readonly "execute.after": ToolResult
}

export interface ToolFailures {
  readonly "execute.before": Refused
  readonly "execute.after": never
}

export interface ToolEdit {
  description: string
  readOnly: boolean
}

export interface ToolEditor {
  readonly list: () => ReadonlyArray<NisseTool>
  readonly get: (name: string) => NisseTool | undefined
  readonly add: (tool: NisseTool) => void
  readonly update: (name: string, edit: (tool: ToolEdit) => void) => void
  readonly remove: (name: string) => void
}

export interface Context {
  readonly name: string
  readonly options: Readonly<Record<string, unknown>>
  readonly tool: {
    readonly transform: (edit: (tools: ToolEditor) => void) => Effect.Effect<void, never, Scope.Scope>
    readonly hook: <Name extends keyof ToolHooks>(
      name: Name,
      run: (event: ToolHooks[Name]) => Effect.Effect<void, ToolFailures[Name]>,
    ) => Effect.Effect<void, never, Scope.Scope>
  }
  readonly request: {
    readonly hook: (
      run: (request: ModelRequest) => Effect.Effect<void, unknown>,
    ) => Effect.Effect<void, never, Scope.Scope>
  }
}

export type Extension = (context: Context) => Effect.Effect<void, unknown, Scope.Scope>

export const Extension = {
  define: (extension: Extension): Extension => extension,
}

export const Tool = {
  make: tool,
  ok,
  fail: failed,
  refuse: (message: string): Effect.Effect<never, Refused> => Effect.fail(new Refused({ message })),
}

export type Tool = NisseTool
export type { ToolOutcome }
