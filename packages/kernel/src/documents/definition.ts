// Document definitions and addresses (spec sections 3.1, 3.2 and 3.6).
// Derived from pi-durable's `src/documents.ts` at 7d073328e (MIT, see LICENSE).
import type { Op } from "@sigma/delta"
import { copyJson } from "@sigma/delta/json"
import type {
  ConversationId,
  DocumentAddress,
  EntryId,
  DocumentCreate,
  DocumentId,
  DocumentRecord,
  JsonObject,
  JsonValue,
  StoredDocument,
  TaskId,
} from "../records.ts"

export type LatestConversationSemantics = {
  readonly scope: "conversation"
  readonly history: "latest"
  readonly fork: "current" | "initial"
}

export type RewindableConversationSemantics = {
  readonly scope: "conversation"
  readonly history: "rewindable"
  readonly fork: "asOf" | "current" | "initial"
}

export type DocumentSemantics =
  | { readonly scope: "session" }
  | LatestConversationSemantics
  | RewindableConversationSemantics
  | { readonly scope: "task" }

export type CheckpointInfo = {
  /** Deltas already stored after the newest base, excluding this change. */
  readonly deltasSinceBase: number
}

export type CommonDocDefinition<T extends JsonObject> = {
  readonly kind: string
  readonly version: number
  initial(): T
  /** One callback for every supported older version; returns a complete current-version value. */
  migrate?(value: JsonObject, fromVersion: number): T
  /** Required, no default: whether this change is stored as a complete base (spec 3.5). */
  checkpointWhen(value: Readonly<T>, ops: readonly Op[], info: CheckpointInfo): boolean
}

export type DocDefinition<T extends JsonObject> = CommonDocDefinition<T> & DocumentSemantics

export type DocFamilyDefinition<T extends JsonObject, I extends JsonValue> = Omit<CommonDocDefinition<T>, "initial"> &
  DocumentSemantics & {
    readonly family: true
    initial(seed: I): T
  }

declare const docType: unique symbol

/** A singleton document kind: its definition, and its value type for the compiler. */
export interface DocToken<T extends JsonObject, D extends DocDefinition<T> = DocDefinition<T>> {
  readonly definition: D
  readonly [docType]?: T
}

/** A family document kind, whose members have a key and are created from a seed. */
export interface DocFamilyToken<
  T extends JsonObject,
  I extends JsonValue,
  D extends DocFamilyDefinition<T, I> = DocFamilyDefinition<T, I>,
> {
  readonly definition: D
  readonly [docType]?: T
}

export type SessionDocToken<T extends JsonObject> = DocToken<T, CommonDocDefinition<T> & { readonly scope: "session" }>
export type ConversationDocToken<T extends JsonObject> = DocToken<
  T,
  CommonDocDefinition<T> & (LatestConversationSemantics | RewindableConversationSemantics)
>
export type RewindableConversationDocToken<T extends JsonObject> = DocToken<
  T,
  CommonDocDefinition<T> & RewindableConversationSemantics
>
export type TaskDocToken<T extends JsonObject> = DocToken<T, CommonDocDefinition<T> & { readonly scope: "task" }>

export type SessionDocFamilyToken<T extends JsonObject, I extends JsonValue> = DocFamilyToken<
  T,
  I,
  DocFamilyDefinition<T, I> & { readonly scope: "session" }
>
export type ConversationDocFamilyToken<T extends JsonObject, I extends JsonValue> = DocFamilyToken<
  T,
  I,
  DocFamilyDefinition<T, I> & (LatestConversationSemantics | RewindableConversationSemantics)
>
export type RewindableConversationDocFamilyToken<T extends JsonObject, I extends JsonValue> = DocFamilyToken<
  T,
  I,
  DocFamilyDefinition<T, I> & RewindableConversationSemantics
>
export type TaskDocFamilyToken<T extends JsonObject, I extends JsonValue> = DocFamilyToken<
  T,
  I,
  DocFamilyDefinition<T, I> & { readonly scope: "task" }
>

type FamilyInput<T extends JsonObject, I extends JsonValue> = Omit<CommonDocDefinition<T>, "initial"> & {
  readonly family: true
  initial(seed: I): T
}

/** Defines a singleton document kind. Its scope decides who owns it and how long it lives (spec 3.1). */
export function defineDoc<T extends JsonObject>(
  definition: CommonDocDefinition<T> & { readonly scope: "session" },
): SessionDocToken<T>
export function defineDoc<T extends JsonObject>(
  definition: CommonDocDefinition<T> & LatestConversationSemantics,
): ConversationDocToken<T>
export function defineDoc<T extends JsonObject>(
  definition: CommonDocDefinition<T> & RewindableConversationSemantics,
): RewindableConversationDocToken<T>
export function defineDoc<T extends JsonObject>(
  definition: CommonDocDefinition<T> & { readonly scope: "task" },
): TaskDocToken<T>
export function defineDoc<T extends JsonObject>(definition: DocDefinition<T>): DocToken<T> {
  validateDefinition(definition as unknown as AnyDocDefinition)
  return { definition }
}

/** Defines a family document kind: members at one scope, each with a key and created from a seed. */
export function defineDocFamily<T extends JsonObject, I extends JsonValue>(
  definition: FamilyInput<T, I> & { readonly scope: "session" },
): SessionDocFamilyToken<T, I>
export function defineDocFamily<T extends JsonObject, I extends JsonValue>(
  definition: FamilyInput<T, I> & LatestConversationSemantics,
): ConversationDocFamilyToken<T, I>
export function defineDocFamily<T extends JsonObject, I extends JsonValue>(
  definition: FamilyInput<T, I> & RewindableConversationSemantics,
): RewindableConversationDocFamilyToken<T, I>
export function defineDocFamily<T extends JsonObject, I extends JsonValue>(
  definition: FamilyInput<T, I> & { readonly scope: "task" },
): TaskDocFamilyToken<T, I>
export function defineDocFamily<T extends JsonObject, I extends JsonValue>(
  definition: DocFamilyDefinition<T, I>,
): DocFamilyToken<T, I> {
  validateDefinition(definition as unknown as AnyDocDefinition)
  return { definition }
}

/** The value type of a document token. */
export type DocValue<K> = K extends { readonly [docType]?: infer T } ? (T extends JsonObject ? T : never) : never

type OwnerArgs<D> = D extends { readonly scope: "conversation" }
  ? [conversationId: ConversationId]
  : D extends { readonly scope: "task" }
    ? [taskId: TaskId]
    : []

/** The arguments after a token that select one address: the owner the scope needs, then a family's key. */
export type DocAddressArgs<K> = K extends { readonly definition: infer D }
  ? D extends { readonly family: true }
    ? [...OwnerArgs<D>, key: string]
    : OwnerArgs<D>
  : never

/** A rewindable conversation document's address and the entry to read it at. */
export type RewindableAddressArgs<K> = K extends {
  readonly definition: infer D extends { readonly scope: "conversation"; readonly history: "rewindable" }
}
  ? D extends { readonly family: true }
    ? [conversationId: ConversationId, key: string, at: EntryId]
    : [conversationId: ConversationId, at: EntryId]
  : never

/** A definition with its types erased, as the Session handles it after overload resolution. */
export type AnyDocDefinition = DocumentSemantics & {
  readonly kind: string
  readonly version: number
  readonly family?: true
  initial(seed?: JsonValue): JsonObject
  migrate?(value: JsonObject, fromVersion: number): JsonObject
  checkpointWhen(value: Readonly<JsonObject>, ops: readonly Op[], info: CheckpointInfo): boolean
}

/** A singleton or family token with its types erased. */
export type AnyDocToken = { readonly definition: AnyDocDefinition }

function validateDefinition(definition: AnyDocDefinition): void {
  if (!Number.isSafeInteger(definition.version) || definition.version < 1) {
    throw new TypeError(`Document ${definition.kind} version must be a positive integer`)
  }
}

/** A logical address, its string identity for maps, and the index of the argument after the owner and family key. */
export type ResolvedAddress = {
  readonly address: DocumentAddress
  readonly id: string
  readonly nextArgument: number
}

/** Resolves an overloaded argument list: the owner ID the scope needs, then a family's key. */
export function resolveAddress(definition: AnyDocDefinition, args: readonly unknown[]): ResolvedAddress {
  let index = 0
  let scope: DocumentAddress["scope"]
  switch (definition.scope) {
    case "session":
      scope = { kind: "session" }
      break
    case "conversation":
      scope = { kind: "conversation", conversationId: ownerId<ConversationId>(args[index++], definition) }
      break
    case "task":
      scope = { kind: "task", taskId: ownerId<TaskId>(args[index++], definition) }
      break
  }
  const key = definition.family === true ? familyKey(args[index++], definition) : undefined
  const address: DocumentAddress =
    key === undefined ? { kind: definition.kind, scope } : { kind: definition.kind, scope, key }
  return { address, id: addressId(address), nextArgument: index }
}

function ownerId<I extends number>(value: unknown, definition: AnyDocDefinition): I {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`Document ${definition.kind} requires a ${definition.scope} ID`)
  }
  return value as I
}

function familyKey(value: unknown, definition: AnyDocDefinition): string {
  if (typeof value !== "string") throw new TypeError(`Document family ${definition.kind} requires a string key`)
  return value
}

/** The stable string identity of one logical address. */
export function addressId(address: DocumentAddress): string {
  const scope = address.scope
  const owner = scope.kind === "session" ? null : scope.kind === "conversation" ? scope.conversationId : scope.taskId
  return JSON.stringify([address.kind, scope.kind, owner, address.key ?? null])
}

/** Whether `record` is an incarnation at `address`. */
export function atAddress(record: DocumentRecord | DocumentCreate, address: DocumentAddress): boolean {
  if (record.kind !== address.kind || record.key !== address.key) return false
  const scope = address.scope
  switch (record.scope.kind) {
    case "session":
      return scope.kind === "session"
    case "conversation":
      return scope.kind === "conversation" && scope.conversationId === record.scope.conversationId
    case "task":
      return scope.kind === "task" && scope.taskId === record.scope.taskId
  }
}

/** The storage create record of a new incarnation at `address`. */
export function documentCreate(definition: AnyDocDefinition, address: DocumentAddress, id: DocumentId): DocumentCreate {
  const key = address.key === undefined ? {} : { key: address.key }
  if (address.scope.kind !== "conversation")
    return { id, kind: address.kind, ...key, scope: address.scope } as DocumentCreate
  const semantics = definition as LatestConversationSemantics | RewindableConversationSemantics
  return {
    id,
    kind: address.kind,
    ...key,
    scope: address.scope,
    history: semantics.history,
    fork: semantics.fork,
  } as DocumentCreate
}

/** Rejects typed access whose token disagrees with the persisted scope, history or fork semantics. */
export function checkRecordScope(definition: AnyDocDefinition, record: DocumentCreate | DocumentRecord): void {
  const semantics = definition as Partial<RewindableConversationSemantics>
  if (
    record.scope.kind !== definition.scope ||
    (record.scope.kind === "conversation" && (record.history !== semantics.history || record.fork !== semantics.fork))
  ) {
    throw new TypeError(`Document ${record.id} (${record.kind}) does not match the supplied definition semantics`)
  }
}

/** Rejects typed access to a stored version the definition cannot use: a newer one, or an older one without `migrate`. */
export function checkRecordVersion(
  definition: AnyDocDefinition,
  record: DocumentCreate | DocumentRecord,
  version: number,
): void {
  if (version > definition.version) {
    throw new Error(`Document ${record.id} (${record.kind}) has newer version ${version} than ${definition.version}`)
  }
  if (version < definition.version && definition.migrate === undefined) {
    throw new Error(`Document ${record.id} (${record.kind}) requires migration from version ${version}`)
  }
}

/** Checks a detached stored value against the definition and migrates it to the definition's version. */
export function materializeDocument(definition: AnyDocDefinition, stored: StoredDocument): JsonObject {
  return materializeDocumentValue(definition, stored.record, stored.version, stored.value)
}

/** As `materializeDocument`, for a value whose incarnation may not be stored yet, such as a fork copy. */
export function materializeDocumentValue(
  definition: AnyDocDefinition,
  record: DocumentCreate | DocumentRecord,
  version: number,
  value: JsonObject,
): JsonObject {
  checkRecordScope(definition, record)
  checkRecordVersion(definition, record, version)
  if (version === definition.version) return value
  return ownedObject(definition.migrate!(value, version), `Document ${record.kind} migrate()`)
}

/** A caller-made root copied into kernel ownership; anything but a strict JSON object is rejected (spec 3.4). */
export function ownedObject(value: unknown, what: string): JsonObject {
  const copied = copyJson(value)
  if (typeof copied !== "object" || copied === null || Array.isArray(copied)) {
    throw new TypeError(`${what} must return a JSON object`)
  }
  return copied
}
