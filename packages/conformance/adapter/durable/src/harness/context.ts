import * as H from "../../../../../harness/src/index.ts";
import type { Context } from "../../../chord/src/context/index.ts";
import { unimplemented } from "../../../../unimplemented.ts";
import { run } from "../session/session.ts";

type Any = any;

export { orderToolResults } from "../../../../../harness/src/index.ts";

/** Committed context of one conversation; @sigma/harness reads it through the Session alone. */
export const readContext = (session: Any, _storage: unknown, conversationId: Any, context: Context, at?: Any) =>
	run(H.readContext(session.kernel, conversationId, at), context);

// The kept-context range belongs to upstream's derivation cache, which @sigma/harness does not keep (D14).
export const advanceRange = unimplemented("advanceRange", "harness-shell");
export const captureContextBounds = unimplemented("captureContextBounds", "harness-shell");
export const deriveContext = unimplemented("deriveContext", "harness-shell");
export const rangeEntry = unimplemented("rangeEntry", "harness-shell");
export const readContextFrom = unimplemented("readContextFrom", "harness-shell");
