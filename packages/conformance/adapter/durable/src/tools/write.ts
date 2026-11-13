import * as T from "@sigma/tools";
import { upstreamTool } from "./bridge.ts";

export const createWriteTool = () => upstreamTool(T.createWriteTool());
