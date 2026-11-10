// Amends upstream/test/tools-images.test.ts > "createNodePhotonImages > prepares in a worker thread, leaving the event
// loop free" (spec 7.3, amendments.json): the same image and the same two processors, judged by whether the event loop
// turns while the image is prepared instead of by the longest gap between 5 ms timer ticks. Upstream requires that gap
// under 100 ms with the worker and over 200 ms inline. On GitHub's macOS runner (3 cores, virtual Apple M1) the worker's
// gap measured 9-50 ms over 18 runs, and once failed the 100 ms bound in CI; inline measured 664-1114 ms. The worker
// does not block the event loop, but a shared runner's pauses reach the hardware-dependent bound.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { initSync, PhotonImage } from "@silvia-odwyer/photon/photon_rs.js";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_IMAGE_LIMITS, type ImageProcessor } from "../upstream/src/tools/image-processor.ts";

let processor: ImageProcessor;

beforeAll(async () => {
	initSync({
		module: readFileSync(createRequire(import.meta.url).resolve("@silvia-odwyer/photon/photon_rs_bg.wasm")),
	});
	processor = await createNodePhotonImages();
});

/** Noise, which neither PNG nor JPEG compresses well. */
function noisyPng(width: number, height: number): Uint8Array {
	const rgba = new Uint8Array(width * height * 4);
	let seed = 1;
	for (let index = 0; index < rgba.length; index++) {
		seed = (seed * 1103515245 + 12345) >>> 0;
		rgba[index] = index % 4 === 3 ? 255 : seed >>> 24;
	}
	const image = new PhotonImage(rgba, width, height);
	try {
		return image.get_bytes();
	} finally {
		image.free();
	}
}

describe("createNodePhotonImages", () => {
	it("prepares in a worker thread, leaving the event loop free", async () => {
		const photo = noisyPng(3000, 2000);
		// Whether a timer set as the image is handed over fires before the prepared image arrives: only an event loop
		// that is free while the image is prepared can run it.
		const turnsWhilePreparing = async (images: ImageProcessor): Promise<boolean> => {
			let turned = false;
			const timer = setTimeout(() => {
				turned = true;
			}, 0);
			try {
				expect(await images.prepare(photo, "image/png", DEFAULT_IMAGE_LIMITS)).toBeDefined();
				return turned;
			} finally {
				clearTimeout(timer);
			}
		};
		expect(await turnsWhilePreparing(await createNodePhotonImages({ worker: false }))).toBe(false);
		expect(await turnsWhilePreparing(processor)).toBe(true);
	}, 60_000);
});
