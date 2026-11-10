import * as T from "@nisse/tools";
import { upstreamExtension, upstreamTool } from "../tools/bridge.ts";

export const TOOL_SEARCH_TOOL_NAME = T.TOOL_SEARCH_TOOL_NAME;
export const DEFAULT_TOOL_SEARCH_LIMIT = T.DEFAULT_TOOL_SEARCH_LIMIT;
export const createToolSearchTool = () => upstreamTool(T.createToolSearchTool());
export const createToolSearchExtension = () => upstreamExtension(T.createToolSearchExtension());
