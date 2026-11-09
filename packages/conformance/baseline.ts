#!/usr/bin/env bun
// Runs the reference copy several times in both modes and writes baseline/<platform>.json: passed, failed, skipped, or
// "varies" when repeats differ.   bun baseline.ts [repeats]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MODES, root, runSuite } from "./run.ts";

const repeats = Number(process.argv[2] ?? 3);
const platform = process.platform === "linux" ? "linux" : "macos";
const out: Record<string, Record<string, string>> = {};
for (const mode of MODES) {
	const merged: Record<string, string> = {};
	for (let i = 0; i < repeats; i++) {
		const result = await runSuite("reference", mode, `baseline-${i}`);
		for (const [id, status] of result.tests) merged[id] = merged[id] === undefined || merged[id] === status ? status : "varies";
	}
	out[mode] = Object.fromEntries(Object.entries(merged).sort());
	const counts: Record<string, number> = {};
	for (const s of Object.values(merged)) counts[s] = (counts[s] ?? 0) + 1;
	console.log(platform, mode, counts);
}
mkdirSync(join(root, "baseline"), { recursive: true });
writeFileSync(join(root, `baseline/${platform}.json`), `${JSON.stringify(out, null, 1)}\n`);
