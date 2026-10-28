import type { Entry } from "@nisse/protocol"
import { Context, Effect, Layer, Schema, Stream } from "effect"

export class ModelError extends Schema.TaggedError<ModelError>()("ModelError", { message: Schema.String }) {}

export class Model extends Context.Service<
  Model,
  { readonly respond: (transcript: ReadonlyArray<Entry>) => Stream.Stream<string, ModelError> }
>()("nisse/Model") {}

const Step = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  fail: Schema.optionalKey(Schema.String),
  delayMs: Schema.optionalKey(Schema.Int),
})
type Step = typeof Step.Type

const words = (text: string) => text.match(/\S+\s*|\s+/g) ?? []

const lastUserText = (transcript: ReadonlyArray<Entry>) =>
  transcript.findLast((entry) => entry.body._tag === "user")?.body as { text: string } | undefined

const speak = (step: Step) => {
  const chunks = Stream.fromIterable(words(step.text ?? ""))
  const paced = step.delayMs ? chunks.pipe(Stream.tap(() => Effect.sleep(step.delayMs!))) : chunks
  return step.fail === undefined ? paced : Stream.concat(paced, Stream.fail(new ModelError({ message: step.fail })))
}

export const scriptedModel = (steps: ReadonlyArray<Step>) =>
  Layer.sync(Model, () => {
    let next = 0
    return Model.of({
      respond: (transcript) =>
        Stream.suspend(() =>
          speak(steps[next++] ?? { text: `You said: ${lastUserText(transcript)?.text ?? ""}`, delayMs: 30 }),
        ),
    })
  })

export const modelFromScript = (path: string | undefined) =>
  path === undefined
    ? scriptedModel([])
    : Layer.unwrap(
        Effect.promise(() => Bun.file(path).json()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Step))),
          Effect.orDie,
          Effect.map(scriptedModel),
        ),
      )
