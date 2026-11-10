// Where a scan starts and how it continues (spec section 10): a cursor keeps the order its scan started with.
import { Effect } from "effect"
import { StorageRequestError } from "./errors.ts"
import type { Cursor, Id, Page, ScanOrder } from "./records.ts"

/** A scan's order and the last ID a previous page returned. */
export type ScanStart = { readonly order: ScanOrder; readonly after: number | undefined }

/**
 * A scan's order and position. A cursor continues in its own order whether the query repeats it or omits it; a query
 * asking for the other order fails. A cursor without an order continues in the scan's default.
 */
export function scanStart(
  requested: ScanOrder | undefined,
  cursor: Cursor | undefined,
  fallback: ScanOrder,
): Effect.Effect<ScanStart, StorageRequestError> {
  const invalid = (message: string) => Effect.fail(new StorageRequestError({ message }))
  if (requested !== undefined && requested !== "ascending" && requested !== "descending") {
    return invalid(`Invalid scan order: ${String(requested)}`)
  }
  if (cursor === undefined) return Effect.succeed({ order: requested ?? fallback, after: undefined })
  const { after, order: stored } = cursor
  if (typeof after !== "number" || !Number.isSafeInteger(after)) {
    return invalid("Invalid storage cursor")
  }
  if (stored !== undefined && stored !== "ascending" && stored !== "descending") {
    return invalid("Invalid storage cursor")
  }
  const order = stored ?? fallback
  if (requested !== undefined && requested !== order) {
    return invalid(`The cursor continues a ${order} scan; the query asks for ${requested}`)
  }
  return Effect.succeed({ order, after })
}

/** The first `limit` of `values`, read one past the limit, and the cursor after the last one when more remain. */
export function page<T extends { readonly id: Id<string> }>(
  values: readonly T[],
  limit: number,
  order: ScanOrder,
): Page<T> {
  const items = values.slice(0, limit)
  if (values.length <= limit) return { items }
  return { items, next: { after: items.at(-1)!.id, order } }
}
