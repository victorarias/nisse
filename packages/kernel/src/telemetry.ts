// The kernel's content-free telemetry, on Effect's tracer and metrics (D7): span, event and metric names follow
// pi-durable's `DURABLE_TELEMETRY_SCHEMA`. Spans and metrics go to the `Tracer` and `MetricRegistry` of the context a
// Session opens in. Records name spans across processes only through a host's `TracePropagation`.
import { Context, Exit, Fiber, Metric, Option, Tracer } from "effect"
import type { TelemetryCarrier } from "./records.ts"

/**
 * How a record names a span so a later process can continue its trace: the `trace` and `links` of tasks and
 * submissions. Without one, records carry no trace and every phase span starts a trace of its own.
 */
export interface TracePropagation {
  /** The carrier naming `span`; `undefined` when it has none. */
  inject(span: Tracer.AnySpan): TelemetryCarrier | undefined
  /** The span a carrier names; `undefined` when the carrier is not one this propagation reads. */
  extract(carrier: TelemetryCarrier): Tracer.AnySpan | undefined
}

/** The host's trace propagation, read from the context a Session opens in. */
export const TracePropagation = Context.Reference<TracePropagation | undefined>("@sigma/kernel/TracePropagation", {
  defaultValue: () => undefined,
})

/** Phase durations range from a sub-millisecond commit to a tool running for hours; buckets double from 1 ms. */
const PHASE_DURATION_BOUNDARIES = Metric.exponentialBoundaries({ start: 1, factor: 2, count: 24 })

export const DurableMetrics = {
  /** Reports raised, by their fixed kind (`type`). */
  reports: Metric.counter("pi.durable.reports", { description: "Reports raised, grouped by their fixed kind." }),
  /** One measurement per phase invocation and its decision commit, in ms, by `task`, `phase` and `outcome`. */
  phaseDuration: Metric.histogram("pi.durable.phase.duration", {
    description: "Duration of a phase invocation and its decision commit, in ms.",
    boundaries: PHASE_DURATION_BOUNDARIES,
  }),
  /** Up and down by one per live task a scheduler holds, by `task`: at load or creation, at terminal or close. */
  tasksActive: Metric.counter("pi.durable.tasks.active", {
    description: "Live tasks held by this Harness; decremented at terminal settlement or close.",
  }),
} as const

/** The span of `context`, when it is one this process records: an external span takes no events. */
export const spanOf = (context: Context.Context<never>): Tracer.Span | undefined => {
  const span = Option.getOrUndefined(Context.getOption(context, Tracer.ParentSpan))
  return span?._tag === "Span" ? span : undefined
}

/** The span of the fiber running now, for a report raised synchronously inside a phase or a commit. */
export const currentSpan = (): Tracer.Span | undefined => {
  const fiber = Fiber.getCurrent()
  return fiber === undefined ? undefined : spanOf(fiber.context)
}

/**
 * Adds `value` to `metric` with `attributes` in the metric registry of `context`. Telemetry must not fail what records
 * it, so a throwing registry is passed to `failed`.
 */
export const updateMetric = (
  metric: Metric.Metric<number, unknown>,
  value: number,
  attributes: Readonly<Record<string, string>>,
  context: Context.Context<never>,
  failed: (error: unknown) => void,
): void => {
  try {
    Metric.withAttributes(metric, attributes).updateUnsafe(value, context)
  } catch (error) {
    failed(error)
  }
}

/** Nanoseconds of the wall clock, as span events take them. */
export const spanTime = (): bigint => BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6))

/**
 * Ends a span with an error status and no error: what failed may carry caller content. Telemetry bridges read a failure
 * that is not an `Error` as a bare error status.
 */
export const CONTENT_FREE_FAILURE: Exit.Exit<never, undefined> = Exit.fail(undefined)
