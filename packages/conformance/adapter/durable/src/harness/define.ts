// Upstream's identity helpers; the registry converts what they build at install (`convert.ts`).

type Any = any;

export const defineExtension = <T>(extension: T): T => extension;
export const defineTool = <T>(tool: T): T => tool;
export const section = (key: string, render: Any, options?: { readonly tag?: boolean }) =>
	options?.tag === undefined ? { key, render } : { key, render, tag: options.tag };
export const hook = (task: Any, handlers: object) => ({ task: task.definition.name, handlers });
export const wrapTool = (tool: { readonly name: string }, wrapper: Any) => ({ tool: tool.name, wrap: wrapper });
export const wrapSection = (key: string, wrapper: Any) => ({ section: key, wrap: wrapper });
/** A task an `afterRun` hook asks for; the harness resolves it by name among the installed tasks. */
export const runEndTask = (task: Any, input: Any) => ({ task, input });
