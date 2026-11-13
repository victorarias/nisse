import { defineExtension } from "@sigma/harness"
import { createBashTool } from "./bash.ts"
import { createEditTool } from "./edit.ts"
import { createReadTool, type ReadToolOptions } from "./read.ts"
import { createWriteTool } from "./write.ts"

export {
  type BashExecution,
  type BashPrepare,
  type BashToolInput,
  type BashToolOptions,
  createBashTool,
  createPowerShellTool,
  type PowerShellToolInput,
  type PowerShellToolOptions,
  type ShellStructuredOutput,
} from "./bash.ts"
export { type ApplyPatchToolInput, createApplyPatchTool } from "./apply-patch.ts"
export { createEditTool, type EditToolDetails, type EditToolInput } from "./edit.ts"
export { requireEnv, resolveReadToolPath, resolveToolPath, withFileMutationQueue } from "./environment.ts"
export { detectSupportedImageMimeType, detectSupportedImageMimeTypeOf, imageDimensions } from "./image.ts"
export {
  base64Length,
  DEFAULT_IMAGE_LIMITS,
  type ImageLimits,
  type ImageProcessor,
  imageLimitsOf,
  INLINE_IMAGE_TYPES,
  type PreparedImage,
  toBase64,
} from "./image-processor.ts"
export { createGlobTool, type GlobToolInput } from "./glob.ts"
export { createGrepTool, type GrepToolInput } from "./grep.ts"
export { createReadTool, type ReadToolDetails, type ReadToolInput, type ReadToolOptions } from "./read.ts"
export { rootConversation, rootConversationEnv } from "./root.ts"
export { rankDocuments, type SearchDocument, tokenize } from "./search.ts"
export {
  createToolSearchExtension,
  createToolSearchTool,
  DEFAULT_TOOL_SEARCH_LIMIT,
  resolveSchemaRef,
  TOOL_SEARCH_TOOL_NAME,
  type ToolSearchToolDetails,
} from "./tool-search.ts"
export { createWriteTool, type WriteToolInput } from "./write.ts"

/**
 * The `coding-tools` extension: `read`, `write`, `edit`, and `bash`; nothing installs it automatically.
 * `createPowerShellTool()` adds `powershell`. `images` prepares the images `read` returns (see `ReadToolOptions`).
 */
export function createCodingTools(options: ReadToolOptions = {}) {
  return defineExtension({
    name: "coding-tools",
    tools: [createReadTool(options), createWriteTool(), createEditTool(), createBashTool()],
  })
}

/** `createCodingTools()` without an image processor. */
export const CodingTools = createCodingTools()
