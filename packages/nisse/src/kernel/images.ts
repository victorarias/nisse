// The images a person attaches to their input, prepared on the server to what the conversation's model takes: a
// screenshot larger than its limits is resized, a BMP converted, before it is committed.
import type { ImageContent, Models } from "@nisse/models"
import { type ImageProcessor, imageLimitsOf } from "@nisse/tools"
import { UnreadableImage, type Image } from "@nisse/wire"
import { Effect } from "effect"

/** Each of `images` as the model `agent` runs on can take it, in order; the first it cannot prepare fails the input. */
export const attachedImages = (
  images: ReadonlyArray<Image>,
  processor: ImageProcessor,
  models: Models,
  agent: { readonly model?: { readonly provider: string; readonly modelId: string } },
): Effect.Effect<ReadonlyArray<ImageContent>, UnreadableImage> => {
  const ref = agent.model
  const limits = imageLimitsOf(ref === undefined ? undefined : models.getModel(ref.provider, ref.modelId))
  return Effect.forEach(images, (image) =>
    Effect.flatMap(
      Effect.orDie(processor.prepare(Buffer.from(image.data, "base64"), image.mimeType, limits)),
      (prepared) =>
        prepared === undefined
          ? Effect.fail(
              new UnreadableImage({
                name: image.name,
                message: `${image.name} (${image.mimeType}) cannot be decoded, or made to fit ${limits.maxWidth}x${limits.maxHeight} pixels and ${limits.maxBytes} bytes of base64`,
              }),
            )
          : Effect.succeed({ type: "image" as const, data: prepared.data, mimeType: prepared.mimeType }),
    ),
  )
}
