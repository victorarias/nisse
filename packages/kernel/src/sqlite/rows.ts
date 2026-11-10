// How records map to SQLite: JSON text, indexed strings, and a document's scope and address columns.
// Derived from pi-durable's `src/storage/sqlite/rows.ts` at 7d073328e (MIT, see LICENSE).
import type { DocumentAddress, DocumentCreate, DocumentRecord } from "../records.ts"

/** A stored cell. */
export type Cell = string | number | null

/** Parses a stored JSON column. */
export const parseJson = <T>(value: string): T => JSON.parse(value) as T

/** Encodes a value as a stored JSON column. Throws for a value JSON cannot hold, such as a cycle. */
export const encodeJson = (value: unknown): string => JSON.stringify(value) as string

/** Encodes an indexed string column. Some bindings replace lone UTF-16 surrogates; JSON keeps the string lossless. */
export const encodeIndexedString = (value: string): string => JSON.stringify(value)

/** A document scope as its `scope_kind` and `owner_id` columns. */
export const scopeColumns = (
  scope: DocumentRecord["scope"],
): { readonly scopeKind: DocumentRecord["scope"]["kind"]; readonly ownerId: number } => {
  switch (scope.kind) {
    case "session":
      return { scopeKind: "session", ownerId: 0 }
    case "conversation":
      return { scopeKind: "conversation", ownerId: scope.conversationId }
    case "task":
      return { scopeKind: "task", ownerId: scope.taskId }
  }
}

/** A document address's columns, as `documents` stores and indexes them. */
export const addressParts = (address: DocumentAddress | DocumentCreate | DocumentRecord) => ({
  kind: encodeIndexedString(address.kind),
  ...scopeColumns(address.scope),
  family: address.key === undefined ? 0 : 1,
  keyValue: encodeIndexedString(address.key ?? ""),
})

/** One string per document address, from its stored columns. */
export const addressColumnsKey = (
  kind: string,
  scopeKind: string,
  ownerId: number,
  family: number,
  keyValue: string,
): string => JSON.stringify([kind, scopeKind, ownerId, family, keyValue])

/** One string per document address. */
export const addressKey = (address: DocumentAddress | DocumentCreate | DocumentRecord): string => {
  const parts = addressParts(address)
  return addressColumnsKey(parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue)
}

/** Whether a document keeps only its current state: its revisions go at each new base and at retirement. */
export const isCurrentOnly = (record: DocumentRecord): boolean =>
  record.scope.kind !== "conversation" || record.history === "latest"

/** A document record's `documents` row. */
export function documentRow(record: DocumentRecord): Cell[] {
  const parts = addressParts(record)
  return [
    record.id,
    parts.kind,
    parts.family,
    parts.keyValue,
    parts.scopeKind,
    parts.ownerId,
    record.createdAt,
    record.retiredAt ?? null,
    encodeJson(record),
  ]
}
