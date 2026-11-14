// The multi-row statements of a commit call, few whatever the number of rows (spec 11.2): rows as one JSON array
// parameter read through `json_each(?)`, and large rows bound column by column in multi-row `VALUES` of a few fixed
// sizes, so their JSON records are not escaped a second time.
// Derived from pi-durable's `src/storage/sqlite/statements.ts` at 7d073328e (MIT, see LICENSE).
import { Effect } from "effect"
import type { StorageError } from "../errors.ts"
import type { SqliteExecutor } from "./database.ts"
import type { Cell } from "./rows.ts"

/** The rows `sql` reads for `values`, given as its one JSON array parameter: one statement per chunk. */
export const readRows = <T extends object>(
  executor: SqliteExecutor,
  sql: string,
  values: readonly (Cell | readonly Cell[])[],
): Effect.Effect<T[], StorageError> =>
  Effect.map(
    Effect.forEach(jsonArrays(values.map((value) => JSON.stringify(value))), (array) => executor.all<T>(sql, array)),
    (chunks) => chunks.flat(),
  )

/** Runs `sql`, a deletion, for `values`, given as its one JSON array parameter: one statement per chunk. */
export const runForEach = (
  executor: SqliteExecutor,
  sql: string,
  values: readonly Cell[],
): Effect.Effect<void, StorageError> =>
  Effect.forEach(jsonArrays(values.map((value) => JSON.stringify(value))), (array) => executor.run(sql, array), {
    discard: true,
  })

// Rows whose string cells hold more characters than this go bound: escaping their records a second time costs more than
// the statements they need. The value is upstream's.
const LARGE_ROW_CHARACTERS = 8 * 1024

/**
 * Inserts `rows` (one cell per column) into `table`, then `conflict`, an upsert clause: rows of little text from one
 * JSON array parameter per chunk, the same SQL whatever their number; large ones bound column by column.
 */
export const insertRows = (
  executor: SqliteExecutor,
  table: string,
  columns: readonly string[],
  rows: readonly (readonly Cell[])[],
  conflict = "",
): Effect.Effect<void, StorageError> =>
  Effect.gen(function* () {
    const small: string[] = []
    const large: (readonly Cell[])[] = []
    for (const row of rows) {
      let text = 0
      for (const cell of row) if (typeof cell === "string") text += cell.length
      if (text > LARGE_ROW_CHARACTERS) large.push(row)
      else small.push(JSON.stringify(row))
    }
    const names = columns.join(", ")
    if (small.length > 0) {
      const cells = columns.map((_, index) => `json_extract(item.value, '$[${index}]')`).join(", ")
      // `WHERE true` keeps SQLite from reading an upsert's `ON` as a join constraint of the `SELECT`.
      const sql = `INSERT INTO ${table} (${names}) SELECT ${cells} FROM json_each(?) AS item WHERE true ${conflict}`
      for (const array of jsonArrays(small)) yield* executor.run(sql, array)
    }
    yield* insertBound(executor, `INSERT INTO ${table} (${names}) VALUES`, columns.length, large, conflict)
  })

// Durable Objects bind at most 100 parameters per statement. Sigma runs on bun:sqlite, whose limit is far higher, but
// the statement shapes upstream's tests count keep this bound.
const MAX_PARAMETERS = 100

/** Inserts `rows`, `width` cells each, in statements of 1, 2, 4 ... rows within `MAX_PARAMETERS` cells. */
const insertBound = (
  executor: SqliteExecutor,
  head: string,
  width: number,
  rows: readonly (readonly Cell[])[],
  conflict: string,
): Effect.Effect<void, StorageError> =>
  Effect.gen(function* () {
    const row = `(${new Array(width).fill("?").join(", ")})`
    let size = 1
    while (size * 2 * width <= MAX_PARAMETERS) size *= 2
    // `size` only shrinks: halved before a chunk to fit the rows left, it is also what the loop then steps over.
    for (let start = 0; start < rows.length; start += size) {
      while (size > rows.length - start) size /= 2
      const chunk = rows.slice(start, start + size)
      yield* executor.run(`${head} ${new Array(size).fill(row).join(", ")} ${conflict}`, ...chunk.flat())
    }
  })

// Durable Objects refuse a string over 2 MB; 512 Ki characters are at most 1.5 MB of UTF-8. Kept for the same reason as
// `MAX_PARAMETERS`: upstream's tests check this split.
const MAX_ARRAY_CHARACTERS = 512 * 1024

/** JSON values `parts`, in order, as JSON arrays of at most `MAX_ARRAY_CHARACTERS` each (a longer value alone). */
function jsonArrays(parts: readonly string[]): string[] {
  const arrays: string[] = []
  let chunk: string[] = []
  // The array's text: its brackets, its parts and the commas between them.
  let length = 2
  for (const part of parts) {
    if (chunk.length > 0 && length + 1 + part.length > MAX_ARRAY_CHARACTERS) {
      arrays.push(`[${chunk.join(",")}]`)
      chunk = []
      length = 2
    }
    length += (chunk.length > 0 ? 1 : 0) + part.length
    chunk.push(part)
  }
  if (chunk.length > 0) arrays.push(`[${chunk.join(",")}]`)
  return arrays
}
