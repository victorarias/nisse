// pi-durable's Promise ConversationTranscript over @nisse/harness's: the loader takes the context of the call that
// started the load, as upstream's does.
import { Effect } from "effect";
import * as H from "../../../../../harness/src/index.ts";
import type { Context } from "../../../chord/src/context/index.ts";
import { run } from "../session/session.ts";

type Any = any;

export type TranscriptItem = H.TranscriptItem;
export type TranscriptView = H.TranscriptView;
export type ConversationTranscriptOptions = H.ConversationTranscriptOptions;
export type EntryLoader = (query: Any, limit: number, context: Context) => Promise<Any>;

export class ConversationTranscript {
	readonly #transcript: H.ConversationTranscript<unknown>;
	/** The context of the call that is starting a load; the loader runs inside that call. */
	#context: Context | undefined;

	constructor(load: EntryLoader, options?: ConversationTranscriptOptions) {
		this.#transcript = new H.ConversationTranscript((query, limit) => {
			const context = this.#context!;
			return Effect.tryPromise({ try: () => load(query, limit, context), catch: (error) => error });
		}, options);
	}

	get newest() {
		return this.#transcript.newest;
	}

	get resume() {
		return this.#transcript.resume;
	}

	merge(view: Any): TranscriptView {
		return this.#transcript.merge(view);
	}

	loadEarlier(context: Context): Promise<TranscriptView> {
		return this.#calling(context, () => run(this.#transcript.loadEarlier));
	}

	fillGap(gap: Any, context: Context): Promise<TranscriptView> {
		return this.#calling(context, () => run(this.#transcript.fillGap(gap)));
	}

	#calling<T>(context: Context, call: () => Promise<T>): Promise<T> {
		this.#context = context;
		try {
			return call();
		} finally {
			this.#context = undefined;
		}
	}
}
