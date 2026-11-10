// The built-in task kinds every registry holds (spec 7.1). They are registered by name so stored tasks of these kinds
// resolve and their names stay reserved.
import type { AnyTask } from "@nisse/kernel"
import { CompactionTask } from "./compaction.ts"
import { GenerationTask } from "./generation.ts"
import type { TaskServices } from "./services.ts"
import { ToolTask } from "./tool.ts"

export { GenerationTask, ToolTask }

/** Built-in task definitions every registry holds; they are not an extension and cannot be removed or replaced. */
export const BUILTIN_TASKS: readonly AnyTask<TaskServices>[] = [GenerationTask, ToolTask, CompactionTask]
