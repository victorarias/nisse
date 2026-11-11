// The constants are the package's; `catalogCall` and the model tools take upstream's Promise forms.
import * as C from "../../../../../codemode/src/index.ts";
import { toSeam } from "../../../ai/index.ts";
import { run } from "../session/session.ts";
import { upstreamTool } from "../tools/bridge.ts";

type Any = any;

export const CATALOG_GLOBALS = C.CATALOG_GLOBALS;
export const CLASSIFY_TOOL = C.CLASSIFY_TOOL;
export const CODEMODE_INTERNAL_PREFIX = C.CODEMODE_INTERNAL_PREFIX;
export const GENERATE_IMAGES_TOOL = C.GENERATE_IMAGES_TOOL;
export const MAX_CONCURRENT_MODEL_CALLS = C.MAX_CONCURRENT_MODEL_CALLS;
export const MODELS_DESCRIPTION = C.MODELS_DESCRIPTION;
export const MODEL_CALLS = C.MODEL_CALLS;
export const catalogCall = (name: string, args: unknown, models: Any, context: Any) =>
	run(C.catalogCall(name, args, toSeam(models)), context);
export const createModelTools = () => C.createModelTools().map(upstreamTool);
