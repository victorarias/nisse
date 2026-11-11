import { Effect } from "effect";
import * as C from "../../../../../codemode/src/index.ts";

type Any = any;

export const DEFAULT_MAX_OUTPUT_TOKENS = C.DEFAULT_MAX_OUTPUT_TOKENS;
/** Upstream's form: `write` returns a Promise. */
export const formatResult = (result: Any, options: Any) =>
	Effect.runPromise(
		C.formatResult(result, { ...options, write: (name: string, data: Any) => Effect.promise(() => options.write(name, data)) }),
	);
