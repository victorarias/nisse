// A client's transcript (spec 9.3): what a client has of one conversation, every entry it got from a view or fetched,
// and the gaps between. A layer over any `ConversationView`, wherever it comes from: a watch, or a replica of one.
import type { EntryId, EntryQuery, EntryRecord, Page } from "@sigma/kernel"
import { Effect, Fiber } from "effect"
import type { ConversationView, ConversationWindow } from "./view.ts"

/** One row of a client's transcript. */
export type TranscriptItem =
  | { readonly kind: "entry"; readonly entry: EntryRecord }
  /** Entries strictly between `after` and `upTo` are missing: render "load more" and call `fillGap()`. */
  | { readonly kind: "gap"; readonly after: EntryId; readonly upTo: EntryId }
  /** The transcript continues above: render "load earlier" and call `loadEarlier()`. Always the first item. */
  | { readonly kind: "earlier" }

/** The conversation view as a renderer sees it: `items`, the client's whole transcript, instead of the window. */
export type TranscriptView = Omit<ConversationView, "entries" | "before"> & {
  readonly items: readonly TranscriptItem[]
}

/** Pages a conversation's entries, as `Conversation.entries()` does without a cursor. */
export type EntryLoader<E> = (
  query: Omit<EntryQuery, "conversationId">,
  limit: number,
) => Effect.Effect<Page<EntryRecord>, E>

export type ConversationTranscriptOptions = {
  /** Entries `loadEarlier()` and `fillGap()` load per call; default 50. */
  readonly pageSize?: number
}

export type TranscriptGap = Extract<TranscriptItem, { kind: "gap" }>
type EntryItem = Extract<TranscriptItem, { kind: "entry" }>

const EARLIER: TranscriptItem = Object.freeze({ kind: "earlier" })

/**
 * Entries never change once committed, so the transcript only grows: a window that dropped its oldest entries keeps
 * them here. A window whose `before` lies past the newest entry held does not continue it, after a stall, an overflow,
 * or a reconnect: the entries in between become a gap. Nothing counts entries or computes ranges from entry IDs, which
 * have holes; only exclusive bounds become the inclusive bounds of `EntryQuery`.
 *
 * A merge costs O(items) and never re-sorts or re-fetches; one that adds nothing returns the previous `items` array.
 * Concurrent `loadEarlier()` calls, or `fillGap()` calls for one gap, share one load; a load that fails is not kept.
 */
export class ConversationTranscript<E = never> {
  readonly #load: EntryLoader<E>
  readonly #pageSize: number
  /** Every entry held, in ID order, as items. */
  #entries: EntryItem[] = []
  readonly #ids = new Set<EntryId>()
  /** Gaps in ID order; each is an immutable item, replaced when it shrinks. */
  #gaps: TranscriptGap[] = []
  #started = false
  /** Exclusive lower bound of the known range: entries at or below it are not loaded; `-Infinity` at the start. */
  #low = Number.NEGATIVE_INFINITY
  /** Inclusive upper bound of the known range: the newest entry, or a later empty window's `before`. */
  #tail = Number.NEGATIVE_INFINITY
  #items: readonly TranscriptItem[] = []
  #last: ConversationView | undefined
  #view: TranscriptView | undefined
  #earlier: Load<E> | undefined
  readonly #filling = new Map<string, Load<E>>()

  constructor(load: EntryLoader<E>, options?: ConversationTranscriptOptions) {
    const pageSize = options?.pageSize ?? 50
    if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
      throw new RangeError(`Page size must be an integer >= 1, got ${pageSize}`)
    }
    this.#load = load
    this.#pageSize = pageSize
  }

  /** The ID the transcript reaches: its newest entry, or a later empty window's `before`. */
  get newest(): EntryId | undefined {
    return this.#tail === Number.NEGATIVE_INFINITY ? undefined : (this.#tail as EntryId)
  }

  /**
   * The window that resumes this transcript after a drop: `{ from }` right after `newest`, `{}` for an empty
   * transcript, undefined before the first merge.
   */
  get resume(): ConversationWindow | undefined {
    if (!this.#started) return undefined
    const newest = this.newest
    return newest === undefined ? {} : { from: (newest + 1) as EntryId }
  }

  /** Takes one value of the view: its window's entries join the transcript. */
  merge(view: ConversationView): TranscriptView {
    this.#last = view
    const { entries, before } = view
    const hi = entries.at(-1)?.id ?? before ?? Number.NEGATIVE_INFINITY
    this.#cover(before ?? Number.NEGATIVE_INFINITY, hi, entries)
    return this.#result()
  }

  /** Loads the page before the oldest entry held. Without anything earlier, the current view. */
  get loadEarlier(): Effect.Effect<TranscriptView, E> {
    return Effect.suspend(() => {
      if (this.#last === undefined) return Effect.die(new Error("ConversationTranscript: merge a view first"))
      if (this.#low === Number.NEGATIVE_INFINITY) return Effect.succeed(this.#result())
      let load = this.#earlier
      if (load === undefined) {
        const low = this.#low
        load = {}
        this.#earlier = load
        const started = load
        shared(
          started,
          Effect.map(
            // Suspended, so a loader that throws building its Effect fails this load and its cleanup still runs.
            Effect.suspend(() => this.#load({ maxEntryId: low as EntryId, order: "descending" }, this.#pageSize)),
            (page) => {
              const items = [...page.items].reverse()
              const oldest = items[0]
              // No next page, or an empty one: the transcript starts here.
              if (page.next === undefined || oldest === undefined) this.#cover(Number.NEGATIVE_INFINITY, low, items)
              else this.#cover(oldest.id - 1, low, items)
              return this.#result()
            },
          ),
          () => {
            if (this.#earlier === started) this.#earlier = undefined
          },
        )
      }
      return Fiber.join(load.fiber!)
    })
  }

  /**
   * Loads the next page of `gap`, shrinking it from its start, or removing it once nothing is missing. A gap that has
   * shrunk since loads the gap it became; one that is gone gives the current view.
   */
  fillGap(gap: TranscriptGap): Effect.Effect<TranscriptView, E> {
    return Effect.suspend(() => {
      const current =
        this.#gaps.find((each) => each.after === gap.after && each.upTo === gap.upTo) ??
        this.#gaps.find((each) => each.after < gap.upTo && gap.after < each.upTo)
      if (current === undefined) {
        if (this.#last === undefined) return Effect.die(new Error("ConversationTranscript: merge a view first"))
        return Effect.succeed(this.#result())
      }
      // Keyed by the gap the call resolved to, so a stale descriptor and the current one share the load.
      const key = `${current.after}:${current.upTo}`
      let load = this.#filling.get(key)
      if (load === undefined) {
        const query = {
          minEntryId: (current.after + 1) as EntryId,
          maxEntryId: (current.upTo - 1) as EntryId,
          order: "ascending",
        } as const
        load = {}
        this.#filling.set(key, load)
        const started = load
        shared(
          started,
          Effect.map(
            Effect.suspend(() => this.#load(query, this.#pageSize)),
            (page) => {
              const newest = page.items.at(-1)
              // No next page, or an empty one: nothing else is missing.
              if (page.next === undefined || newest === undefined)
                this.#cover(current.after, current.upTo - 1, page.items)
              else this.#cover(current.after, newest.id, page.items)
              return this.#result()
            },
          ),
          () => {
            if (this.#filling.get(key) === started) this.#filling.delete(key)
          },
        )
      }
      return Fiber.join(load.fiber!)
    })
  }

  /**
   * Records that every entry with an ID in (`lo`, `hi`] is known, `added` being those entries in ID order: holds the
   * new ones, shrinks the gaps they fill, extends the known range, and opens a gap where the range does not continue it.
   */
  #cover(lo: number, hi: number, added: readonly EntryRecord[]): void {
    const fresh = added.filter((entry) => !this.#ids.has(entry.id))
    for (const entry of fresh) this.#ids.add(entry.id)
    const held = this.#entries
    // New entries past every held one: the items grow at their end.
    const appended = fresh.length === 0 || held.length === 0 || fresh[0]!.id > held.at(-1)!.entry.id
    const items = fresh.map((entry): EntryItem => ({ kind: "entry", entry }))
    if (items.length > 0) this.#entries = appended ? held.concat(items) : mergeById(held, items)
    let rebuild = false
    if (!this.#started || (held.length === 0 && this.#gaps.length === 0 && lo >= this.#tail)) {
      // The first range, or one after an empty transcript: it is all the client knows.
      rebuild = !this.#started || lo !== this.#low
      this.#started = true
      this.#low = lo
      this.#tail = Math.max(this.#tail, hi)
    } else if (lo > this.#tail) {
      // Past the newest known ID: what lies between is missing.
      const upTo = added[0]?.id ?? lo + 1
      this.#gaps = [...this.#gaps, gapOf(this.#tail, upTo)]
      this.#tail = hi
      rebuild = true
    } else if (hi !== Number.NEGATIVE_INFINITY && hi < this.#low) {
      // Below the oldest known ID: what lies between is missing.
      const upTo = held.find((item) => item.entry.id > hi)?.entry.id ?? this.#low + 1
      this.#gaps = [gapOf(hi, upTo), ...this.#gaps]
      this.#low = lo
      rebuild = true
    } else {
      const gaps = this.#subtract(lo, hi)
      if (gaps !== this.#gaps) {
        this.#gaps = gaps
        rebuild = true
      }
      if (lo < this.#low) {
        this.#low = lo
        rebuild = true
      }
      if (hi > this.#tail) this.#tail = hi
    }
    if (rebuild || !appended) this.#items = this.#build()
    else if (items.length > 0) this.#items = this.#items.concat(items)
  }

  /** The gaps without (`lo`, `hi`]; the same array when none changes, as when the range is empty. */
  #subtract(lo: number, hi: number): TranscriptGap[] {
    if (hi <= lo) return this.#gaps
    let changed = false
    const gaps: TranscriptGap[] = []
    for (const gap of this.#gaps) {
      // Missing: IDs in (after, upTo); known now: IDs in (lo, hi].
      if (hi <= gap.after || lo + 1 >= gap.upTo) {
        gaps.push(gap)
        continue
      }
      changed = true
      if (lo > gap.after) {
        const firstKnown = this.#entries.find((item) => item.entry.id > lo)?.entry.id ?? lo + 1
        gaps.push(gapOf(gap.after, Math.min(gap.upTo, firstKnown)))
      }
      if (hi + 1 < gap.upTo) gaps.push(gapOf(hi, gap.upTo))
    }
    return changed ? gaps : this.#gaps
  }

  /** Items in ID order: "earlier" until the start is known, then entries with each gap before the entry after it. */
  #build(): TranscriptItem[] {
    const items: TranscriptItem[] = this.#low === Number.NEGATIVE_INFINITY ? [] : [EARLIER]
    const gaps = this.#gaps
    let next = 0
    for (const item of this.#entries) {
      while (next < gaps.length && gaps[next]!.after < item.entry.id) items.push(gaps[next++]!)
      items.push(item)
    }
    while (next < gaps.length) items.push(gaps[next++]!)
    return items
  }

  /** The view with the current items; the previous one when nothing changed. */
  #result(): TranscriptView {
    const last = this.#last!
    const previous = this.#view
    if (
      previous !== undefined &&
      previous.items === this.#items &&
      previous.docs === last.docs &&
      previous.conversation === last.conversation
    ) {
      return previous
    }
    this.#view = { conversation: last.conversation, docs: last.docs, items: this.#items }
    return this.#view
  }
}

/** One shared load: set before its fiber starts, so a load that ends at once still forgets itself. */
type Load<E> = { fiber?: Fiber.Fiber<TranscriptView, E> }

/**
 * Runs `effect` in a fiber of its own, so every caller joins one load and a caller that stops waiting does not stop it
 * for the others; `settled` forgets it once it ends, so a failed load is not kept.
 */
function shared<E>(load: Load<E>, effect: Effect.Effect<TranscriptView, E>, settled: () => void): void {
  load.fiber = Effect.runFork(Effect.ensuring(effect, Effect.sync(settled)))
}

function gapOf(after: number, upTo: number): TranscriptGap {
  return Object.freeze({ kind: "gap", after: after as EntryId, upTo: upTo as EntryId })
}

/** Two ID-ordered item lists merged in one pass. */
function mergeById(left: readonly EntryItem[], right: readonly EntryItem[]): EntryItem[] {
  const merged: EntryItem[] = []
  let i = 0
  let j = 0
  while (i < left.length && j < right.length)
    merged.push(left[i]!.entry.id < right[j]!.entry.id ? left[i++]! : right[j++]!)
  while (i < left.length) merged.push(left[i++]!)
  while (j < right.length) merged.push(right[j++]!)
  return merged
}
