// The built-in task kinds every registry holds (spec 7.1). They are registered by name so stored tasks of these kinds
// resolve and their names stay reserved. The kernel rebuild fills them in its later steps: generation in
// `harness-run-core`, tool tasks in `harness-tools`, compaction in `harness-compaction`. Until then a task of one of
// them fails its phase naming that step.
import { defineTask, type Task } from "@nisse/kernel"
import { Effect } from "effect"
import type { TaskServices } from "./services.ts"

type Pending = Task<unknown, { readonly phase: "pending" }, unknown, TaskServices>

const pending = (name: string, version: number, step: string): Pending => {
  const missing = () => Effect.die(new Error(`Task ${name} runs once the ${step} step of the kernel rebuild lands`))
  return defineTask<unknown, { readonly phase: "pending" }, unknown, TaskServices>({
    name,
    version,
    initial: () => ({ phase: "pending" }),
    phases: { pending: missing },
    abort: missing,
  })
}

/** One model request and its tool round. */
export const GenerationTask = pending("pi.generation", 2, "harness-run-core")
/** One tool call. */
export const ToolTask = pending("pi.tool", 3, "harness-tools")
/** One compaction. */
export const CompactionTask = pending("pi.compaction", 1, "harness-compaction")

/** Built-in task definitions every registry holds; they are not an extension and cannot be removed or replaced. */
export const BUILTIN_TASKS: readonly Pending[] = [GenerationTask, ToolTask, CompactionTask]
