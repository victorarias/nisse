import * as T from "@nisse/tools";
import { upstreamTool } from "./bridge.ts";

export const createEditTool = () => upstreamTool(T.createEditTool());
