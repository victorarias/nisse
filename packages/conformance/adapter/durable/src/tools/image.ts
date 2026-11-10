import * as T from "@nisse/tools";
import { Effect } from "effect";

type Any = any;

export const detectSupportedImageMimeType = T.detectSupportedImageMimeType;
export const imageDimensions = T.imageDimensions;
export const detectSupportedImageMimeTypeOf = (source: { size: number; read(offset: number, length: number): Promise<Uint8Array> }) =>
	Effect.runPromise(
		T.detectSupportedImageMimeTypeOf<Any>({
			size: source.size,
			read: (offset, length) => Effect.tryPromise({ try: () => source.read(offset, length), catch: (error) => error }),
		}),
	);
