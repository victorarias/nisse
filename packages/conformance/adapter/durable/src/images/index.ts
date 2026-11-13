import { createPhotonImages as create } from "@sigma/tools/images";
import { promiseImages } from "../tools/bridge.ts";

type Any = any;

export const createPhotonImages = (wasm: Any) => promiseImages(create(wasm));
