// The registry of extensions and the helpers that build what an extension contributes (spec 7.1). A snapshot is
// immutable; install and uninstall publish a new one synchronously.
import type { AnyTask } from "@nisse/kernel"
import { INSTRUCTIONS_KEY } from "./agent.ts"
import { BUILTIN_TASKS } from "./builtin.ts"
import type { TaskServices } from "./services.ts"
import type {
  Extension,
  HookRegistration,
  PromptInput,
  PromptSection,
  Registry,
  RegistrySnapshot,
  ToolRegistration,
  Wrap,
} from "./types.ts"
import type { Effect } from "effect"

const SECTION_KEY = /^[a-z][a-z0-9_-]*$/

/** Types an extension. */
export const defineExtension = <T extends ToolRegistration = ToolRegistration>(extension: Extension<T>): Extension<T> =>
  extension

/** Types a tool. */
export const defineTool = <T extends ToolRegistration>(tool: T): T => tool

/** A prompt section; tagged unless `tag` is false. */
export function section<T extends ToolRegistration = ToolRegistration>(
  key: string,
  render: (input: PromptInput<T>) => Effect.Effect<string | undefined, unknown>,
  options?: { readonly tag?: boolean },
): PromptSection<T> {
  return options?.tag === undefined ? { key, render } : { key, render, tag: options.tag }
}

/** Hook handlers for tasks with `task`'s name. */
export const hook = (task: AnyTask<TaskServices>, handlers: object): HookRegistration => ({
  task: task.definition.name,
  handlers,
})

/** Wraps the tool named like `tool` wherever the wrapping extension is selected. */
export const wrapTool = <T extends ToolRegistration>(
  tool: { readonly name: string },
  wrapper: (tool: T) => T,
): Wrap<T> => ({
  tool: tool.name,
  wrap: wrapper,
})

/** Wraps the section `key` wherever the wrapping extension is selected. */
export const wrapSection = <T extends ToolRegistration = ToolRegistration>(
  key: string,
  wrapper: (section: PromptSection<T>) => PromptSection<T>,
): Wrap<T> => ({ section: key, wrap: wrapper })

/** One published registry state. Building it throws on a task name taken twice. */
class RegistryState<T extends ToolRegistration> implements RegistrySnapshot<T> {
  readonly #extensions: readonly Extension<T>[]
  readonly #byName: ReadonlyMap<string, Extension<T>>
  readonly #tasks: ReadonlyMap<string, AnyTask<TaskServices>>

  constructor(extensions: readonly Extension<T>[]) {
    this.#extensions = extensions
    this.#byName = new Map(extensions.map((extension) => [extension.name, extension]))
    const tasks = new Map<string, AnyTask<TaskServices>>()
    for (const task of BUILTIN_TASKS) tasks.set(task.definition.name, task)
    for (const extension of extensions) {
      for (const task of extension.tasks ?? []) {
        const name = task.definition.name
        if (tasks.has(name)) throw new Error(`Task ${name} of extension ${extension.name} is already installed`)
        tasks.set(name, task)
      }
    }
    this.#tasks = tasks
  }

  installed() {
    return this.#extensions
  }

  extension(name: string) {
    return this.#byName.get(name)
  }

  tools() {
    return this.#extensions.flatMap((extension) => (extension.tools ?? []).map((tool) => ({ extension, tool })))
  }

  sections() {
    return this.#extensions.flatMap((extension) =>
      (extension.sections ?? []).map((section) => ({ extension, section })),
    )
  }

  tasks() {
    return [...this.#tasks.values()]
  }

  task(name: string) {
    return this.#tasks.get(name)
  }
}

class RegistryImpl<T extends ToolRegistration> implements Registry<T> {
  #current = new RegistryState<T>([])
  readonly #listeners = new Set<() => void>()

  snapshot(): RegistrySnapshot<T> {
    return this.#current
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  install(extension: Extension<T>): void {
    validateExtension(extension)
    const current = this.#current.installed()
    const index = current.findIndex((installed) => installed.name === extension.name)
    this.#publish(
      index < 0 ? [...current, extension] : current.map((installed, at) => (at === index ? extension : installed)),
    )
  }

  uninstall(extension: Extension): void {
    const current = this.#current.installed()
    if (!current.some((installed) => installed.name === extension.name)) return
    this.#publish(current.filter((installed) => installed.name !== extension.name))
  }

  /** Builds the next state, which throws on a task name collision, then publishes it. */
  #publish(extensions: readonly Extension<T>[]): void {
    this.#current = new RegistryState(extensions)
    for (const listener of [...this.#listeners]) listener()
  }
}

/** Unique tool names and section keys within one extension; valid, unreserved section keys. */
function validateExtension(extension: Extension): void {
  const tools = new Set<string>()
  for (const tool of extension.tools ?? []) {
    if (tools.has(tool.name)) throw new Error(`Extension ${extension.name} has two tools named ${tool.name}`)
    tools.add(tool.name)
  }
  const sections = new Set<string>()
  for (const { key } of extension.sections ?? []) {
    if (!SECTION_KEY.test(key)) throw new TypeError(`Section key ${JSON.stringify(key)} must match ${SECTION_KEY}`)
    if (key === INSTRUCTIONS_KEY) throw new Error(`Section key ${key} is reserved for the agent's instructions`)
    if (sections.has(key)) throw new Error(`Extension ${extension.name} has two sections with key ${key}`)
    sections.add(key)
  }
}

/** An application-owned registry holding only the built-in tasks. */
export const createRegistry = <T extends ToolRegistration = ToolRegistration>(): Registry<T> => new RegistryImpl<T>()
