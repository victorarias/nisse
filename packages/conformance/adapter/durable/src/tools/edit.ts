import * as T from "@sigma/tools";
import { upstreamTool } from "./bridge.ts";

export const createEditTool = () => upstreamTool(T.createEditTool());
