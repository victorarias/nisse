// Runs a kernel Effect for the Promise-shaped API the suite calls, failing as pi-durable's storage throws: a
// StorageError as the driver's own error, a StorageRequestError as the adapter's class of that name.
import { Effect } from "effect";
import { StorageError, StorageRequestError } from "../../kernel/src/index.ts";
import { StorageRequestError as UpstreamRequestError } from "./durable/src/errors.ts";

export function run<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
	return Effect.runPromise(
		Effect.mapError(effect, (error) => {
			if (error instanceof StorageError) return error.cause;
			if (error instanceof StorageRequestError) return new UpstreamRequestError(error.message);
			return error;
		}),
	);
}
