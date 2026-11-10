import * as T from "@nisse/tools";
import type { Context } from "../../../chord/src/context/index.ts";
import { run } from "../session/session.ts";
import { effectEnv } from "./bridge.ts";

type Any = any;

export const resolveToolPath = (env: Any, path: string, context: Context) => run(T.resolveToolPath(effectEnv(env)!, path), context);
export const resolveReadToolPath = (env: Any, path: string, context: Context) =>
	run(T.resolveReadToolPath(effectEnv(env)!, path), context);
