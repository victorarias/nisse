import * as T from "@nisse/tools";
import { Effect } from "effect";
import { effectEnv, promiseEnv } from "./bridge.ts";

type Any = any;

/** The call's execution environment; throws without one. */
export const requireEnv = (api: Any): Any => promiseEnv(Effect.runSync(T.requireEnv({ env: effectEnv(api.env) })));
