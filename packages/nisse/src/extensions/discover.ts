// What both extension hosts share: finding a home's extensions on disk, deciding which load and with what options,
// and importing one. The shipping host (`index.ts`) and the kernel's (`../kernel/extensions.ts`) run what this finds.
import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { Cause, Effect } from "effect"
import { readHomeConfig } from "../config.ts"
import type { Extension } from "./api.ts"

/** How long an extension may take to load, and a hook to run, before it fails. */
export const LOAD_LIMIT = "10 seconds"
export const HOOK_LIMIT = "10 seconds"

const NAME = /^[A-Za-z0-9_-]+$/

export type ExtensionState = "loaded" | "failed" | "disabled"

export interface ExtensionInfo {
  readonly name: string
  readonly path: string
  readonly state: ExtensionState
  readonly message?: string
}

/** One extension found on disk: its listing if it does not load, or the options it loads with. */
export type Planned =
  | { readonly info: ExtensionInfo }
  | { readonly name: string; readonly path: string; readonly options: Record<string, unknown> }

interface Found {
  readonly name: string
  readonly path: string
}

/** `<name>.ts` and `<name>/index.ts` under `dir`, in name order. */
const found = (dir: string): ReadonlyArray<Found> =>
  existsSync(dir)
    ? readdirSync(dir)
        .sort()
        .flatMap((entry) => {
          const path = join(dir, entry)
          if (entry.endsWith(".ts") && statSync(path).isFile()) return [{ name: entry.slice(0, -".ts".length), path }]
          const index = join(path, "index.ts")
          return statSync(path).isDirectory() && existsSync(index) ? [{ name: entry, path: index }] : []
        })
    : []

/**
 * Every extension in `extensions`, in load order, with `[extensions.<name>]` from the home's `config.toml` as its
 * options. A `config.toml` that does not read fails every one with `<path>: <why>`.
 */
export const planExtensions = (homeDir: string, extensions: string): Effect.Effect<ReadonlyArray<Planned>> =>
  Effect.map(Effect.result(readHomeConfig(homeDir)), (config) => {
    const planned: Array<Planned> = []
    const names = new Set<string>()
    for (const extension of found(extensions)) {
      const info = { name: extension.name, path: extension.path }
      const taken = names.has(extension.name)
      names.add(extension.name)
      if (config._tag === "Failure") {
        planned.push({
          info: { ...info, state: "failed", message: `${config.failure.path}: ${config.failure.message}` },
        })
        continue
      }
      const { enabled, ...options } = config.success.extensions?.[extension.name] ?? {}
      if (enabled === false) {
        planned.push({ info: { ...info, state: "disabled" } })
        continue
      }
      if (!NAME.test(extension.name) || taken) {
        const message = NAME.test(extension.name)
          ? `another extension is named ${extension.name}`
          : "an extension's name may use only letters, digits, - and _"
        planned.push({ info: { ...info, state: "failed", message } })
        continue
      }
      planned.push({ ...info, options })
    }
    return planned
  })

/** Drops the extensions' modules from the module cache, so the next imports run the code as it is on disk now. */
export const forgetExtensions = (extensions: string) => {
  for (const path of Object.keys(require.cache)) if (path.startsWith(`${extensions}/`)) delete require.cache[path]
}

/** Imports an extension's file and finds its definition. */
export const importExtension = (path: string): Effect.Effect<Extension, unknown> =>
  Effect.gen(function* () {
    const module = yield* Effect.tryPromise({ try: () => import(path), catch: (error) => error })
    const define = module.default as Extension | undefined
    if (typeof define !== "function") {
      return yield* Effect.fail(new Error("it exports no extension; export default Extension.define(...)"))
    }
    return define
  })

/** Why an extension or hook failed, in one line. */
export const failureReason = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  return error instanceof Error ? error.message : String(error)
}
