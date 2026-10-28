import { relative, resolve, sep } from "node:path"
import { Effect, Schema } from "effect"
import { failed, ok, tool } from "./tool.ts"

const MATCH_LIMIT = 200
const GLOB_LIMIT = 200
const LINE_CHARS = 500
const BINARY_PROBE = 8192

const listed = async (root: string): Promise<Array<string>> => {
  const git = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    stdout: "pipe",
    stderr: "ignore",
  })
  if (git.exitCode === 0) {
    const files = git.stdout.toString().split("\0").filter(Boolean)
    const present = await Promise.all(files.map((file) => Bun.file(resolve(root, file)).exists()))
    return files.filter((_, i) => present[i])
  }
  const files: Array<string> = []
  for await (const file of new Bun.Glob("**/*").scan({ cwd: root, dot: false, onlyFiles: true })) files.push(file)
  return files
}

const filesUnder = async (cwd: string, path: string | undefined) => {
  const root = resolve(cwd, path ?? ".")
  const stat = await Bun.file(root)
    .stat()
    .catch(() => undefined)
  if (!stat) return undefined
  if (!stat.isDirectory()) return [root]
  return (await listed(root)).map((file) => resolve(root, file)).sort()
}

const matcher = (pattern: string) => {
  const glob = new Bun.Glob(pattern)
  return pattern.includes("/")
    ? (path: string) => glob.match(path)
    : (path: string) => glob.match(path.split(sep).at(-1)!)
}

const pathInput = Schema.optionalKey(
  Schema.String.annotate({ description: "The file or directory to search. Default the working directory." }),
)

export const Grep = tool({
  name: "Grep",
  description:
    "Search file contents for a regular expression (JavaScript syntax). Returns `path:line:text` for each matching line, in path order, up to 200 matches; very long lines are cut. Skips binary files and, inside a git repository, files that git ignores.",
  readOnly: true,
  input: Schema.Struct({
    pattern: Schema.String.annotate({ description: "The regular expression to search for." }),
    path: pathInput,
    glob: Schema.optionalKey(
      Schema.String.annotate({
        description: "Only search files whose path matches this glob, such as `*.ts` or `src/**/*.ts`.",
      }),
    ),
    case_insensitive: Schema.optionalKey(Schema.Boolean.annotate({ description: "Ignore case. Default false." })),
  }),
  run: (input, { cwd }) =>
    Effect.promise(async () => {
      let regex: RegExp
      try {
        regex = new RegExp(input.pattern, input.case_insensitive ? "i" : "")
      } catch (error) {
        return failed(`bad pattern: ${(error as Error).message}`)
      }
      const files = await filesUnder(cwd, input.path)
      if (!files) return failed(`${input.path} does not exist`)
      const wanted = input.glob ? matcher(input.glob) : () => true
      const matches: Array<string> = []
      for (const file of files) {
        const shown = relative(cwd, file) || file
        if (!wanted(shown)) continue
        const bytes = new Uint8Array(await Bun.file(file).arrayBuffer())
        if (bytes.subarray(0, BINARY_PROBE).includes(0)) continue
        const lines = new TextDecoder().decode(bytes).split("\n")
        for (let i = 0; i < lines.length; i++) {
          if (!regex.test(lines[i]!)) continue
          const line = lines[i]!.replace(/\r$/, "")
          matches.push(
            `${shown}:${i + 1}:${line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)} [line cut]` : line}`,
          )
          if (matches.length === MATCH_LIMIT) {
            return ok(`${matches.join("\n")}\n[stopped at ${MATCH_LIMIT} matches; narrow the pattern or path]`)
          }
        }
      }
      return ok(matches.length === 0 ? "No matches." : matches.join("\n"))
    }),
})

export const Glob = tool({
  name: "Glob",
  description:
    "Find files whose path matches a glob, such as `**/*.ts` or `src/*.json`. Returns paths, newest first, up to 200. Inside a git repository, skips files that git ignores.",
  readOnly: true,
  input: Schema.Struct({
    pattern: Schema.String.annotate({ description: "The glob to match paths against." }),
    path: pathInput,
  }),
  run: (input, { cwd }) =>
    Effect.promise(async () => {
      const root = resolve(cwd, input.path ?? ".")
      const files = await filesUnder(cwd, input.path)
      if (!files) return failed(`${input.path} does not exist`)
      const wanted = matcher(input.pattern)
      const found = files.filter((file) => wanted(relative(root, file)))
      const stamped = await Promise.all(
        found.map(async (file) => ({ file, mtime: (await Bun.file(file).stat()).mtimeMs })),
      )
      stamped.sort((a, b) => b.mtime - a.mtime)
      const shown = stamped.slice(0, GLOB_LIMIT).map(({ file }) => relative(cwd, file) || file)
      if (shown.length === 0) return ok("No files found.")
      return ok(
        stamped.length > GLOB_LIMIT
          ? `${shown.join("\n")}\n[${stamped.length - GLOB_LIMIT} more not shown]`
          : shown.join("\n"),
      )
    }),
})
