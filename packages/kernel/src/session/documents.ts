// The Session's loaded documents: one tracker per cached incarnation, kept while used (spec sections 3.4 to 3.6).
//
// A document with no observer leaves the cache once it was not read or written for the retention period; the next
// access loads it from Storage again. A document with an observer is pinned and stays. Eviction runs on the mutation
// line (`sweep`), so no transaction ever holds a tracker that leaves.
import type { Tracker } from "@sigma/delta"
import type { DocumentId, DocumentRecord, JsonObject } from "../records.ts"

/** One committed incarnation the cache owns. */
export type LoadedDocument = {
  readonly addressId: string
  readonly record: DocumentRecord
  /** The stored definition version; older while the value is migrated only in memory. */
  storedVersion: number
  /** The definition version whose shape the tracked value has; access with another version reloads from Storage. */
  readonly valueVersion: number
  /** Stored deltas after the newest base, advanced at adoption so `checkpointWhen` needs no read. */
  deltasSinceBase: number
  readonly tracker: Tracker<JsonObject>
}

/** Ten minutes, as upstream keeps documents by default. */
export const DEFAULT_DOCUMENT_RETENTION_MS = 600_000

export type DocumentCacheSizes = {
  readonly cached: number
  readonly idle: number
  readonly attached: number
}

export class DocumentCache {
  readonly #documents = new Map<string, LoadedDocument>()
  /** Cached documents with no observer, by address, oldest use first, with the time of that use. */
  readonly #idle = new Map<string, number>()
  /** Observers per incarnation; a cached incarnation with any is never evicted. */
  readonly #attached = new Map<DocumentId, number>()
  readonly #now: () => number
  readonly #retentionMs: () => number
  /** Asks for a sweep after `delayMs`; the Session runs it on the line. */
  readonly #schedule: (delayMs: number) => void

  constructor(options: {
    readonly now: () => number
    readonly retentionMs: () => number
    readonly schedule: (delayMs: number) => void
  }) {
    this.#now = options.now
    this.#retentionMs = options.retentionMs
    this.#schedule = options.schedule
  }

  get sizes(): DocumentCacheSizes {
    return { cached: this.#documents.size, idle: this.#idle.size, attached: this.#attached.size }
  }

  /** The cached incarnation at an address, noting the use. */
  get(addressId: string): LoadedDocument | undefined {
    const cached = this.#documents.get(addressId)
    if (cached !== undefined) this.touch(addressId)
    return cached
  }

  /** The cached incarnation at an address, without noting a use. */
  peek(addressId: string): LoadedDocument | undefined {
    return this.#documents.get(addressId)
  }

  install(document: LoadedDocument): void {
    this.#documents.set(document.addressId, document)
    this.touch(document.addressId)
  }

  /**
   * An incarnation ended: drops it if it is still the cached one, and releases its value, so a stale reference to its
   * tracker keeps nothing alive.
   */
  retire(addressId: string, recordId: DocumentId): void {
    const cached = this.#documents.get(addressId)
    if (cached?.record.id !== recordId) return
    this.drop(addressId)
    cached.tracker.release()
  }

  drop(addressId: string): void {
    this.#documents.delete(addressId)
    this.#idle.delete(addressId)
  }

  /** Notes a use of a cached document: an unpinned one becomes the newest idle one. */
  touch(addressId: string): void {
    const cached = this.#documents.get(addressId)
    if (cached === undefined || this.#attached.has(cached.record.id)) return
    const now = this.#now()
    const retention = this.#retentionMs()
    const since = this.#idle.get(addressId)
    // A hot document moves to the back at most once per granule, a tenth of the retention up to 1 s: it may leave up to
    // a granule early, which costs a reload, while a commit-heavy workload skips the reordering.
    if (since !== undefined && now - since < Math.min(1_000, retention / 10)) return
    const wasEmpty = this.#idle.size === 0
    this.#idle.delete(addressId)
    this.#idle.set(addressId, now)
    if (wasEmpty) this.#schedule(retention)
  }

  /** Pins an incarnation for one observer; the release unpins it once, and the document is idle after the last. */
  pin(addressId: string, recordId: DocumentId): () => void {
    this.#attached.set(recordId, (this.#attached.get(recordId) ?? 0) + 1)
    this.#idle.delete(addressId)
    let pinned = true
    return () => {
      if (!pinned) return
      pinned = false
      const count = (this.#attached.get(recordId) ?? 1) - 1
      if (count > 0) {
        this.#attached.set(recordId, count)
        return
      }
      this.#attached.delete(recordId)
      if (this.#documents.get(addressId)?.record.id === recordId) this.touch(addressId)
    }
  }

  /** On the line: evicts the idle documents whose retention passed, oldest first, and asks for the next sweep. */
  sweep(): void {
    const retention = this.#retentionMs()
    const expired = this.#now() - retention
    for (const [addressId, since] of this.#idle) {
      if (since > expired) {
        this.#schedule(since - expired)
        return
      }
      this.drop(addressId)
    }
  }

  /** Drops every loaded document; pins stay with their observers, which hold their own values. */
  unload(): void {
    this.#documents.clear()
    this.#idle.clear()
  }

  clear(): void {
    this.#documents.clear()
    this.#idle.clear()
    this.#attached.clear()
  }
}
