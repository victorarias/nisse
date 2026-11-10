import { createNodePhotonImages as create, type NodePhotonImagesOptions } from "@nisse/tools/images/node";
import { promiseImages } from "../tools/bridge.ts";

export const createNodePhotonImages = async (options: NodePhotonImagesOptions = {}) => promiseImages(create(options));
