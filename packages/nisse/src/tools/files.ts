import { mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { Effect, Schema } from "effect"
import { failed, ok, tool } from "./tool.ts"

const READ_LINES = 2000
const READ_BYTES = 64 * 1024
const LINE_CHARS = 2000

const filePath = Schema.String.annotate({
  description: "The file; relative paths resolve against the working directory.",
})

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const Read = tool({
  name: "Read",
  description:
    "Read a text file. Returns each line prefixed with its 1-based number and a tab, up to 2000 lines from `offset`; very long lines are cut. When more lines remain, the output ends with the offset to continue from.",
  readOnly: true,
  input: Schema.Struct({
    file_path: filePath,
    offset: Schema.optionalKey(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
        description: "The first line to read, counting from 1. Default 1.",
      }),
    ),
    limit: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: READ_LINES })).annotate({
        description: "How many lines to read. Default 2000.",
      }),
    ),
  }),
  run: (input, { cwd }) =>
    Effect.promise(async () => {
      const file = Bun.file(resolve(cwd, input.file_path))
      const stat = await file.stat().catch((error) => error as Error)
      if (stat instanceof Error) return failed(`could not open ${input.file_path}: ${stat.message}`)
      if (stat.isDirectory()) return failed(`${input.file_path} is a directory; use Glob or Bash to list it`)
      const text = await file.text().catch((error) => error as Error)
      if (text instanceof Error) return failed(`could not read ${input.file_path}: ${text.message}`)
      if (text === "") return ok("(empty file)")
      const lines = text.split("\n")
      if (lines.at(-1) === "") lines.pop()
      const first = input.offset ?? 1
      const limit = input.limit ?? READ_LINES
      if (first > lines.length) {
        return failed(`offset ${first} is past the end of ${input.file_path}, which has ${lines.length} lines`)
      }
      let output = ""
      let number = first
      for (; number <= lines.length && number < first + limit && output.length < READ_BYTES; number++) {
        const line = lines[number - 1]!.replace(/\r$/, "")
        const cut = line.length > LINE_CHARS
        output += `${String(number).padStart(6)}\t${cut ? line.slice(0, LINE_CHARS) : line}${cut ? " [line cut]" : ""}\n`
      }
      if (number <= lines.length) output += `[more lines follow; continue with offset ${number}]\n`
      return ok(output)
    }),
})

export const Write = tool({
  name: "Write",
  description:
    "Write `content` to a file, replacing the file if it exists and creating missing parent directories. To change part of an existing file, use `Edit`.",
  readOnly: false,
  input: Schema.Struct({
    file_path: filePath,
    content: Schema.String.annotate({ description: "The file's whole new content." }),
  }),
  run: (input, { cwd }) =>
    Effect.promise(async () => {
      const path = resolve(cwd, input.file_path)
      try {
        await mkdir(dirname(path), { recursive: true })
        const bytes = await Bun.write(path, input.content)
        return ok(`Wrote ${bytes} bytes to ${input.file_path}.`)
      } catch (error) {
        return failed(`could not write ${input.file_path}: ${errorText(error)}`)
      }
    }),
})

export const replace = (
  content: string,
  old: string,
  replacement: string,
  all: boolean,
): { readonly content: string; readonly count: number } | string => {
  if (old === "") return "old_string is empty; give the exact text to replace"
  if (old === replacement) return "old_string and new_string are the same; nothing to do"
  const first = content.indexOf(old)
  if (first < 0) return "old_string was not found; it must match exactly, whitespace included"
  if (all) {
    const parts = content.split(old)
    return { content: parts.join(replacement), count: parts.length - 1 }
  }
  let count = 0
  for (let at = first; at >= 0; at = content.indexOf(old, at + 1)) count++
  if (count > 1) {
    return `old_string appears ${count} times; include more surrounding text to pick one, or set replace_all`
  }
  return { content: content.slice(0, first) + replacement + content.slice(first + old.length), count: 1 }
}

export const Edit = tool({
  name: "Edit",
  description:
    "Replace exact text in a file. `old_string` must match the file exactly, whitespace and indentation included, and appear exactly once; include surrounding lines to make it unique, or set `replace_all` to replace every occurrence.",
  readOnly: false,
  input: Schema.Struct({
    file_path: filePath,
    old_string: Schema.String.annotate({ description: "The exact text to replace." }),
    new_string: Schema.String.annotate({ description: "The text to put in its place; must differ from old_string." }),
    replace_all: Schema.optionalKey(
      Schema.Boolean.annotate({ description: "Replace every occurrence instead of exactly one. Default false." }),
    ),
  }),
  run: (input, { cwd }) =>
    Effect.promise(async () => {
      const path = resolve(cwd, input.file_path)
      let content: string
      try {
        content = await Bun.file(path).text()
      } catch (error) {
        return failed(`could not read ${input.file_path}: ${errorText(error)}`)
      }
      const edited = replace(content, input.old_string, input.new_string, input.replace_all ?? false)
      if (typeof edited === "string") return failed(`${edited} in ${input.file_path}`)
      await Bun.write(path, edited.content)
      return ok(
        edited.count === 1
          ? `Replaced 1 occurrence in ${input.file_path}.`
          : `Replaced ${edited.count} occurrences in ${input.file_path}.`,
      )
    }),
})
