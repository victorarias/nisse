// Entry drafts and typed entry kinds (spec sections 2 and 8.1).
import type { EntryId, EntryRecord, JsonValue } from "../records.ts"

/** What a commit appends; the Session assigns the ID, the conversation and the task. `head: "self"` is the new ID. */
export type EntryDraft = Omit<EntryRecord, "id" | "conversationId" | "byTaskId" | "head"> & {
  readonly head?: EntryId | "self"
}

/** An entry whose `data` has type `D`; `never` means the kind carries no data. */
export type TypedEntry<D extends JsonValue> = Omit<EntryRecord, "data"> &
  ([D] extends [never] ? { readonly data?: never } : { readonly data: D })

/** A draft of a typed entry: its token supplies `kind`. */
export type TypedEntryDraft<D extends JsonValue> = Omit<EntryDraft, "kind" | "data"> &
  ([D] extends [never] ? { readonly data?: never } : { readonly data: D })

/** A typed entry kind: appends set its `kind`, and `is` narrows a read entry to its `data`. */
export interface Entry<D extends JsonValue = never> {
  readonly kind: string
  is(entry: EntryRecord | undefined): entry is TypedEntry<D>
}

/** Defines an entry kind whose `data` has type `D`. The type is the caller's promise; the kind is what is checked. */
export function defineEntry<D extends JsonValue = never>(kind: string): Entry<D> {
  return { kind, is: (entry): entry is TypedEntry<D> => entry?.kind === kind }
}
