import * as T from "@nisse/tools";
import { harnessPrepare, upstreamTool } from "./bridge.ts";

type Any = any;

const options = (given: Any): Any =>
	given?.prepare === undefined ? given : { ...given, prepare: harnessPrepare(given.prepare) };

export const createBashTool = (given?: Any) => upstreamTool(T.createBashTool(options(given)));
export const createPowerShellTool = (given?: Any) => upstreamTool(T.createPowerShellTool(options(given)));
