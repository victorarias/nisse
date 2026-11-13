import * as T from "@sigma/tools";
import type { Context } from "../../../chord/src/context/index.ts";
import { promised } from "../harness/convert.ts";
import { run } from "../session/session.ts";
import { effectEnv } from "./bridge.ts";

type Any = any;

export const withFileMutationQueue = <A>(env: Any, path: string, fn: () => Promise<A>, context: Context): Promise<A> =>
	run(T.withFileMutationQueue(effectEnv(env)!, path, promised(fn)), context);
