import { createNodePhotonImages as create, type NodePhotonImagesOptions } from "@sigma/tools/images/node";
import { promiseImages } from "../tools/bridge.ts";

export const createNodePhotonImages = async (options: NodePhotonImagesOptions = {}) => promiseImages(create(options));
