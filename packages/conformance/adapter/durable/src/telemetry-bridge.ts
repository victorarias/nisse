// pi-telemetry fed from Effect's tracer and metrics (D7). The kernel and harness record spans, events and metrics
// through Effect; this bridge gives one Harness an Effect `Tracer` whose spans are spans of the host's
// `TelemetryContext`, a `MetricRegistry` that forwards each update to the host's instruments, and a `TracePropagation`
// over the host's propagation.
import { Cause, Context, Effect, Exit, Metric, Option, Tracer } from "effect";
import { TracePropagation } from "../../../../kernel/src/index.ts";
import {
	createTypedMetrics,
	NOOP_TELEMETRY_CONTEXT,
	NOOP_TELEMETRY_METRICS,
	type SpanAttributes,
	type SpanLink,
	type SpanStatus,
	type TelemetryContext,
	type TelemetrySpan,
} from "../../telemetry/src/index.ts";
import { DURABLE_TELEMETRY_SCHEMA } from "./harness/telemetry.ts";

type Any = any;

const randomHex = (length: number): string => {
	let hex = "";
	while (hex.length < length) hex += Math.floor(Math.random() * 16).toString(16);
	return hex;
};

/**
 * An Effect span over a pi-telemetry context. A span the bridge started settles when Effect ends it; an adopted one (a
 * caller's context, or a parent read from a carrier) belongs to its owner and is never settled here.
 */
class BridgedSpan implements Tracer.Span {
	readonly _tag = "Span";
	readonly spanId = randomHex(16);
	readonly traceId: string;
	readonly annotations = Context.empty();
	readonly attributes = new Map<string, unknown>();
	readonly sampled = true;
	readonly kind = "internal" as const;
	status: Tracer.SpanStatus;

	constructor(
		readonly telemetry: TelemetryContext,
		readonly name: string,
		readonly parent: Option.Option<Tracer.AnySpan>,
		readonly links: Tracer.SpanLink[],
		startTime: bigint,
		readonly settle?: (status: SpanStatus | undefined) => void,
	) {
		this.traceId = Option.getOrUndefined(parent)?.traceId ?? randomHex(32);
		this.status = { _tag: "Started", startTime };
	}

	/** Whether the bridge started this span, so its events and attributes are its own to record. */
	get #owned(): boolean {
		return this.settle !== undefined;
	}

	end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
		if (this.status._tag === "Ended") return;
		this.status = { _tag: "Ended", startTime: this.status.startTime, endTime, exit };
		this.settle?.(statusOf(exit));
	}

	attribute(key: string, value: unknown): void {
		this.attributes.set(key, value);
		if (this.#owned) (this.telemetry as TelemetrySpan).setAttributes({ [key]: value } as SpanAttributes);
	}

	event(name: string, _startTime: bigint, attributes?: Record<string, unknown>): void {
		// Events on an adopted context land on the caller's span, as upstream records commit events on `context.telemetry`.
		const span = this.telemetry as Partial<TelemetrySpan>;
		span.addEvent?.(name, attributes as SpanAttributes | undefined);
	}

	addLinks(links: ReadonlyArray<Tracer.SpanLink>): void {
		this.links.push(...links);
		if (!this.#owned) return;
		for (const link of links) {
			const context = telemetryOf(link.span);
			if (context !== undefined) (this.telemetry as TelemetrySpan).addLink(linkOf(context, link));
		}
	}
}

/** A failed exit is an error status, named and described when it failed with an `Error`; content-free otherwise. */
function statusOf(exit: Exit.Exit<unknown, unknown>): SpanStatus | undefined {
	if (Exit.isSuccess(exit)) return undefined;
	const error = Cause.squash(exit.cause);
	return error instanceof Error
		? { status: "error", error: { name: error.name, message: error.message } }
		: { status: "error" };
}

const telemetryOf = (span: Tracer.AnySpan): TelemetryContext | undefined =>
	span instanceof BridgedSpan ? span.telemetry : undefined;

const linkOf = (context: TelemetryContext, link: Tracer.SpanLink): SpanLink =>
	Object.keys(link.attributes).length === 0
		? { context }
		: { context, attributes: link.attributes as SpanAttributes };

/** The Effect span standing for `context`, owned by its caller. */
export function adopt(context: TelemetryContext): Tracer.Span {
	return new BridgedSpan(context, "adopted", Option.none(), [], 0n);
}

/** A pi-telemetry span under `parent`, opened now and settled with the status `end` passes. */
function start(parent: TelemetryContext, name: string, links: readonly SpanLink[]): {
	readonly span: TelemetryContext;
	readonly settle: (status: SpanStatus | undefined) => void;
} {
	let span: TelemetrySpan | undefined;
	let settle: (status: SpanStatus | undefined) => void = () => {};
	try {
		// Adapters create the span and call the callback synchronously, so `span` is set when this returns.
		void Promise.resolve(
			parent.startSpan({ name, ...(links.length === 0 ? {} : { links }) }, (opened) => {
				span = opened;
				return new Promise<void>((resolve) => {
					settle = (status) => {
						if (status !== undefined) opened.setStatus(status);
						resolve();
					};
				});
			}),
		).catch(() => {});
	} catch {
		// A throwing adapter records nothing for this span; the work it would trace goes on.
	}
	return span === undefined ? { span: NOOP_TELEMETRY_CONTEXT, settle: () => {} } : { span, settle };
}

/** The Effect tracer whose spans are spans of `root` and of the contexts their parents stand for. */
function tracerOf(root: TelemetryContext): Tracer.Tracer {
	return Tracer.make({
		span(options) {
			const parent = options.root ? undefined : Option.getOrUndefined(options.parent);
			const context = (parent === undefined ? undefined : telemetryOf(parent)) ?? root;
			const links: SpanLink[] = [];
			for (const link of options.links) {
				const linked = telemetryOf(link.span);
				if (linked !== undefined) links.push(linkOf(linked, link));
			}
			const opened = start(context, options.name, links);
			return new BridgedSpan(
				opened.span,
				options.name,
				options.root ? Option.none() : options.parent,
				[...options.links],
				options.startTime,
				opened.settle,
			);
		},
	});
}

/**
 * A metric registry that forwards each update of the durable metrics to `telemetry.metrics`, with the span of the
 * updating context as the measurement's context. Other metrics stay in Effect's registry only.
 */
function registryOf(telemetry: TelemetryContext): Metric.MetricRegistry {
	const instruments = createTypedMetrics(telemetry.metrics ?? NOOP_TELEMETRY_METRICS, [DURABLE_TELEMETRY_SCHEMA]);
	const forward: Record<string, (value: number, attributes: SpanAttributes, context?: TelemetryContext) => void> = {
		"pi.durable.reports": (value, attributes) => instruments.counter("pi.durable.reports").add(value, attributes as Any),
		"pi.durable.tasks.active": (value, attributes) =>
			instruments.upDownCounter("pi.durable.tasks.active").add(value, attributes as Any),
		"pi.durable.phase.duration": (value, attributes, context) =>
			instruments.histogram("pi.durable.phase.duration").record(value, attributes as Any, context),
	};
	const registry = new Map<string, Any>();
	const set = registry.set.bind(registry);
	// Effect updates a new series through the hooks object it stores, so the forwarding goes on that object.
	registry.set = (key, metadata) => {
		const send = forward[metadata.id];
		if (send !== undefined) {
			const update = metadata.hooks.update;
			const attributes = { ...(metadata.attributes ?? {}) } as SpanAttributes;
			metadata.hooks.update = (input: number, context: Context.Context<never>) => {
				update(input, context);
				const span = Option.getOrUndefined(Context.getOption(context, Tracer.ParentSpan));
				send(input, attributes, span === undefined ? undefined : telemetryOf(span));
			};
		}
		return set(key, metadata);
	};
	return registry;
}

/**
 * Runs the opening of one Harness against the host's telemetry: its tracer, metric registry and propagation are what
 * the kernel and harness capture at open and record through for the Harness's life.
 */
export function withTelemetry<A, E, R>(
	effect: Effect.Effect<A, E, R>,
	telemetry: TelemetryContext | undefined,
): Effect.Effect<A, E, R> {
	const root = telemetry ?? NOOP_TELEMETRY_CONTEXT;
	const host = root.propagation;
	const propagation: TracePropagation | undefined =
		host === undefined
			? undefined
			: {
					inject: (span) => {
						const context = telemetryOf(span);
						return context === undefined ? undefined : host.inject(context);
					},
					extract: (carrier) => {
						const context = host.extract(carrier);
						return context === undefined ? undefined : adopt(context);
					},
				};
	return effect.pipe(
		Effect.withTracer(tracerOf(root)),
		Effect.provideService(Metric.MetricRegistry, registryOf(root)),
		Effect.provideService(TracePropagation, propagation),
	);
}

/** The pi-telemetry context an Effect span stands for: what upstream code reads as `context.telemetry`. */
export const telemetryOfSpan = (span: Tracer.AnySpan | undefined): TelemetrySpan | undefined => {
	const context = span === undefined ? undefined : telemetryOf(span);
	return context === undefined || typeof (context as Partial<TelemetrySpan>).addEvent !== "function"
		? undefined
		: (context as TelemetrySpan);
};
