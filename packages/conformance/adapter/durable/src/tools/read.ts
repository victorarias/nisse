import * as T from "@sigma/tools";
import { effectImages, upstreamTool } from "./bridge.ts";

type Any = any;
export type ReadToolOptions = { readonly images?: Any };

/** Upstream's `read`; `harness` is the tool it stands for. */
export function createReadTool(options: ReadToolOptions = {}) {
	const images = effectImages(options.images);
	const harness = T.createReadTool(images === undefined ? {} : { images });
	return Object.assign(upstreamTool(harness), { harness });
}
