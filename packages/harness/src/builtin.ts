// The built-in task kinds every registry holds (spec 7.1). They are registered by name so stored tasks of these kinds
// resolve and their names stay reserved. Compaction is filled in by the `harness-compaction` step of the kernel
// rebuild; until then a compaction task fails its phase naming that step.
import { type AnyTask, defineTask } from "@nisse/kernel"
import { Effect } from "effect"
import { GenerationTask } from "./generation.ts"
import type { TaskServices } from "./services.ts"
import { ToolTask } from "./tool.ts"

export { GenerationTask, ToolTask }

const missing = () =>
  Effect.die(new Error("Task pi.compaction runs once the harness-compaction step of the kernel rebuild lands"))

/** One compaction. */
export const CompactionTask = defineTask<unknown, { readonly phase: "pending" }, unknown, TaskServices>({
  name: "pi.compaction",
  version: 1,
  initial: () => ({ phase: "pending" }),
  phases: { pending: missing },
  abort: missing,
})

/** Built-in task definitions every registry holds; they are not an extension and cannot be removed or replaced. */
export const BUILTIN_TASKS: readonly AnyTask<TaskServices>[] = [GenerationTask, ToolTask, CompactionTask]
