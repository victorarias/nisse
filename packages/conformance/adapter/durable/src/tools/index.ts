// Upstream's `tools` module over @nisse/tools: tools in upstream's Promise form, options converted to the Effect form.
import * as T from "@nisse/tools";
import { upstreamExtension } from "./bridge.ts";
import { createReadTool, type ReadToolOptions } from "./read.ts";

export { createBashTool, createPowerShellTool } from "./bash.ts";
export { createEditTool } from "./edit.ts";
export { DEFAULT_IMAGE_LIMITS } from "./image-processor.ts";
export { createReadTool } from "./read.ts";
export { createWriteTool } from "./write.ts";

export function createCodingTools(options: ReadToolOptions = {}) {
	const read = createReadTool(options);
	const extension = T.createCodingTools();
	return upstreamExtension({ ...extension, tools: [read.harness, ...extension.tools!.slice(1)] });
}

export const CodingTools = upstreamExtension(T.CodingTools);
