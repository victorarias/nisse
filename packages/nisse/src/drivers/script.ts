import type { CallId, Entry } from "@nisse/protocol"
import { Effect, Schema } from "effect"
import { newId } from "../ids.ts"
import { nothingToSignIn, ProviderError, type Driver, type Turn } from "../provider.ts"

const Step = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  tool: Schema.optionalKey(Schema.Struct({ name: Schema.String, input: Schema.Unknown })),
  fail: Schema.optionalKey(Schema.String),
  delayMs: Schema.optionalKey(Schema.Int),
})
type Step = typeof Step.Type

const words = (text: string) => text.match(/\S+\s*|\s+/g) ?? []

const lastUserText = (transcript: ReadonlyArray<Entry>) => {
  const body = transcript.findLast((entry) => entry.body._tag === "user")?.body
  return body?._tag === "user" ? body.text : ""
}

const speak = (turn: Turn, step: Step) =>
  Effect.gen(function* () {
    const text = step.text ?? ""
    for (const word of words(text)) {
      if (step.delayMs) yield* Effect.sleep(step.delayMs)
      yield* turn.say(word)
    }
    return text
  })

export const scriptDriver = (steps: ReadonlyArray<Step>): Driver => {
  let next = 0
  return {
    kind: "script",
    defaultModel: "script",
    health: () => Effect.succeed({ status: "ready" }),
    models: () => Effect.succeed([{ id: "script", name: "Script", efforts: [] }]),
    ...nothingToSignIn,
    run: (turn) =>
      Effect.gen(function* () {
        while (true) {
          const step = steps[next++] ?? { text: `You said: ${lastUserText(yield* turn.transcript)}`, delayMs: 30 }
          const text = yield* speak(turn, step)
          if (step.fail !== undefined) return yield* new ProviderError({ message: step.fail })
          yield* turn.message(text)
          if (!step.tool) return
          yield* turn.runTool({ call: newId() as CallId, tool: step.tool.name, input: step.tool.input })
          yield* turn.steers
        }
      }),
  }
}

export type Script = ReadonlyArray<Step>

export const readScript = (path: string | undefined): Effect.Effect<Script> =>
  path === undefined
    ? Effect.succeed([])
    : Effect.promise(() => Bun.file(path).json()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Step))),
        Effect.orDie,
      )
