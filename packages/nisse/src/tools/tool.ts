import type { CallId } from "@nisse/protocol"
import { Effect, Schema } from "effect"

export interface ToolOutcome {
  readonly output: string
  readonly error: boolean
}

export interface ToolContext {
  readonly call: CallId
  readonly parent?: CallId
  readonly cwd: string
  readonly output: (text: string) => Effect.Effect<void>
}

export interface ToolSpec {
  readonly name: string
  readonly description: string
  readonly parameters: unknown
}

export interface Tool {
  readonly spec: ToolSpec
  readonly readOnly: boolean
  readonly run: (input: unknown, context: ToolContext) => Effect.Effect<ToolOutcome>
}

export const ok = (output: string): ToolOutcome => ({ output, error: false })
export const failed = (output: string): ToolOutcome => ({ output, error: true })
export const interrupted = failed("interrupted; it may or may not have taken effect")

export const tool = <S extends Schema.Top & { readonly DecodingServices: never }>(options: {
  readonly name: string
  readonly description: string
  readonly input: S
  readonly readOnly: boolean
  readonly run: (input: S["Type"], context: ToolContext) => Effect.Effect<ToolOutcome>
}): Tool => ({
  spec: {
    name: options.name,
    description: options.description,
    parameters: Schema.toJsonSchemaDocument(options.input).schema,
  },
  readOnly: options.readOnly,
  run: (input, context) =>
    Schema.decodeUnknownEffect(options.input)(input).pipe(
      Effect.matchEffect({
        onFailure: (error) => Effect.succeed(failed(`bad arguments for ${options.name}: ${error.message}`)),
        onSuccess: (decoded) => options.run(decoded, context),
      }),
      Effect.catchDefect((defect) =>
        Effect.succeed(failed(`${options.name} failed: ${defect instanceof Error ? defect.message : String(defect)}`)),
      ),
    ),
})
