// The task graph view is @sigma/harness's; the Harness exposes it (`harness.ts`).
import type * as H from "../../../../../harness/src/index.ts";

export type TaskGraph = H.TaskGraph;
export type TaskGraphNode = H.TaskGraphNode;
export type TaskGraphState = H.TaskGraphState;
export type TaskGraphWatch = { readonly value: TaskGraph };
