// Puts a timed-out test's own message back into its stack, which is what the JSON report keeps. Vitest 4.1 builds a
// timeout error's stack from the test's "STACK_TRACE_ERROR" placeholder but swaps the arguments of the replace that
// should put the message in, so check.ts would print only `Error: STACK_TRACE_ERROR` for a timeout.
import { afterEach } from "vitest";

const PLACEHOLDER = "Error: STACK_TRACE_ERROR";

afterEach((ctx) => {
	for (const error of ctx.task.result?.errors ?? []) {
		if (error.stack?.startsWith(PLACEHOLDER)) error.stack = `Error: ${error.message}${error.stack.slice(PLACEHOLDER.length)}`;
	}
});
