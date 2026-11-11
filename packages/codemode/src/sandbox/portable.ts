// From pi-codemode's `src/portable.ts` (earendil-works/pi, packages/codemode, commit 7d073328e), under the MIT license in
// this package's LICENSE (Copyright 2025 Mario Zechner).
/**
 * The sandbox without Node built-ins: `InlineCodemodeSandbox` runs the VM on the calling thread and imports no
 * `node:*` module. `CodemodeSandbox`, which uses worker threads, stays in the main entry.
 */
export { toCodemodeIdentifier } from "./identifier.ts"
export { CodemodeSandboxBase } from "./runtime/execution.ts"
export { DEFAULT_INTERRUPT_BUDGET, InlineCodemodeSandbox, type InlineCodemodeSandboxOptions } from "./runtime/inline.ts"
export {
  MAX_OUTPUT_CHARS,
  MAX_OUTPUT_ITEMS,
  MAX_STORE_TOTAL_CHARS,
  MAX_STORE_VALUE_CHARS,
} from "./runtime/prelude-source.ts"
export type { HostToWorkerMessage, VmStartData, WorkerToHostMessage } from "./runtime/protocol.ts"
export type {
  CodemodeCall,
  CodemodeCallStatus,
  CodemodeDeclaredGlobal,
  CodemodeDeclaredTool,
  CodemodeDuring,
  CodemodeError,
  CodemodeErrorKind,
  CodemodeExecuteOptions,
  CodemodeHostCall,
  CodemodeJsonSchema,
  CodemodeOutcome,
  CodemodeOutputItem,
  CodemodeResult,
  CodemodeRun,
  CodemodeRunOptions,
  CodemodeSandboxBaseOptions,
  CodemodeStoreWrites,
  CodemodeTool,
  CodemodeToolContext,
} from "./types.ts"
export type { CodemodeWasmModule } from "./wasm.ts"
