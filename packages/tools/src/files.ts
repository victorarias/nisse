// The files below a directory, as `grep` and `glob` search them, through the call's environment.
import type { ExecutionEnv, FileError } from "@sigma/env"
import { Effect } from "effect"

/**
 * Paths of the files below `root`, relative to it with `/` separators, sorted. Inside a git work tree, what git
 * tracks or would track (`git ls-files --cached --others --exclude-standard`), so ignored files are skipped; elsewhere
 * a walk that skips names starting with `.`. `undefined` when `root` does not exist; a file lists itself as `""`.
 */
export const filesBelow = (env: ExecutionEnv, root: string): Effect.Effect<string[] | undefined, FileError> =>
  Effect.gen(function* () {
    // `fileInfo` does not follow symlinks, so a symlinked root is classified by what it points to.
    const info = yield* Effect.option(Effect.flatMap(env.canonicalPath(root), (target) => env.fileInfo(target)))
    if (info._tag === "None") return undefined
    if (info.value.kind !== "directory") return [""]
    const tracked = yield* gitFiles(env, root)
    return (tracked ?? (yield* walk(env, root, ""))).sort()
  })

const gitFiles = (env: ExecutionEnv, root: string) =>
  Effect.gen(function* () {
    let output = ""
    const exit = yield* Effect.exit(
      env.exec(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
        cwd: root,
        onOutput: (text, info) => {
          if (info.stream === "stdout") output += text
        },
      }),
    )
    if (exit._tag === "Failure" || exit.value.exitCode !== 0) return undefined
    return output.split("\0").filter((path) => path !== "")
  })

const walk = (env: ExecutionEnv, root: string, prefix: string): Effect.Effect<string[], FileError> =>
  Effect.gen(function* () {
    const directory = prefix === "" ? root : yield* env.joinPath([root, prefix])
    const files: string[] = []
    for (const entry of yield* env.listDir(directory)) {
      if (entry.name.startsWith(".")) continue
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`
      if (entry.kind === "directory") files.push(...(yield* walk(env, root, path)))
      else if (entry.kind === "file") files.push(path)
    }
    return files
  })

/** A glob test of a path relative to the searched directory: a pattern without `/` matches the file name alone. */
export const globMatcher = (pattern: string): ((path: string) => boolean) => {
  const glob = new Bun.Glob(pattern)
  return pattern.includes("/") ? (path) => glob.match(path) : (path) => glob.match(path.split("/").at(-1)!)
}
