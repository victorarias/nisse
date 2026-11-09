#!/usr/bin/env bun
// `bun run check` step: runs the suite in both modes and compares every test with its row in expected.json.
//   bun check.ts                 against the Effect kernel through adapter/
//   bun check.ts --target=reference   against the reference copy, compared with the committed baseline
// Exit 1 on a mismatch, an unlisted test, or an exclusion citing an unknown decision.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MODES, type Mode, type RunResult, root, runSuite } from "./run.ts";

type Row = string | Record<Mode, string>;
interface Exclusions {
	reviewed: { count: number };
	decisions: Record<string, string>;
	tests: { test: string; decision: string; reason: string }[];
}

const target = process.argv.find((a) => a.startsWith("--target="))?.split("=")[1] ?? "adapter";
const expected = JSON.parse(readFileSync(join(root, "expected.json"), "utf8")) as Record<string, Row>;
const exclusions = JSON.parse(readFileSync(join(root, "exclusions.json"), "utf8")) as Exclusions;
const platform = process.platform === "linux" ? "linux" : "macos";

const problems: string[] = [];
const stateOf = (row: Row, mode: Mode): string => (typeof row === "string" ? row : row[mode]);
const stateName = (state: string): string => state.split(" ")[0]!;

// The exclusion list must agree with the rows.
const excluded = new Map(exclusions.tests.map((e) => [e.test, e] as const));
for (const entry of exclusions.tests) {
	if (exclusions.decisions[entry.decision] === undefined) {
		problems.push(`exclusion cites unknown decision ${entry.decision}: ${entry.test}`);
	}
}
for (const [id, row] of Object.entries(expected)) {
	for (const mode of MODES) {
		const state = stateOf(row, mode);
		if (state.startsWith("amended ") && !existsSync(join(root, "amended", state.slice("amended ".length)))) {
			problems.push(`row says "${state}" but that file does not exist: ${id}`);
		}
		if (state.startsWith("excluded ") && excluded.get(id)?.decision !== state.slice("excluded ".length)) {
			problems.push(`row says "${state}" but exclusions.json has ${excluded.get(id)?.decision ?? "no entry"}: ${id}`);
		}
	}
}
for (const id of excluded.keys()) {
	if (expected[id] === undefined) problems.push(`exclusion has no row in expected.json: ${id}`);
}

const baseline = (mode: Mode): Record<string, string> => {
	const path = join(root, `baseline/${platform}.json`);
	if (!existsSync(path)) throw new Error(`conformance: no baseline for ${platform}: ${path}`);
	return (JSON.parse(readFileSync(path, "utf8")) as Record<Mode, Record<string, string>>)[mode];
};

function judgeAdapter(mode: Mode, result: RunResult): void {
	for (const [id, status] of result.tests) {
		const row = expected[id];
		if (row === undefined) {
			problems.push(`${mode}: no row for test: ${id}`);
			continue;
		}
		const state = stateName(stateOf(row, mode));
		if (state === "pass" && status !== "passed") problems.push(`${mode}: expected pass, got ${status}: ${id}`);
	}
	for (const [id, row] of Object.entries(expected)) {
		if (stateName(stateOf(row, mode)) === "pass" && !result.tests.has(id)) problems.push(`${mode}: expected pass, test did not run: ${id}`);
	}
}

// A failure outside any test counts against a file that holds a `pass` row.
function judgeRunErrors(mode: Mode, result: RunResult): void {
	for (const [file, message] of result.suiteErrors) {
		if (Object.entries(expected).some(([id, row]) => id.startsWith(`${file} :: `) && stateName(stateOf(row, mode)) === "pass")) {
			problems.push(`${mode}: ${file} failed outside its tests: ${message.split("\n")[0]}`);
		}
	}
}

function judgeReference(mode: Mode, result: RunResult): void {
	const want = baseline(mode);
	for (const [id, status] of result.tests) {
		const row = expected[id];
		if (row === undefined) {
			problems.push(`${mode}: no row for test: ${id}`);
			continue;
		}
		const skippedByRow = ["excluded", "amended", "flaky"].includes(stateName(stateOf(row, mode)));
		const was = want[id];
		if (!skippedByRow && was !== undefined && was !== "varies" && was !== status) problems.push(`${mode}: baseline ${was}, got ${status}: ${id}`);
	}
	for (const [id, was] of Object.entries(want)) {
		if (was === "passed" && !["excluded", "amended", "flaky"].includes(stateName(stateOf(expected[id]!, mode))) && !result.tests.has(id)) problems.push(`${mode}: baseline passed, test did not run: ${id}`);
	}
}

for (const mode of MODES) {
	const result = await runSuite(target, mode, `check-${target}`);
	const counts = new Map<string, number>();
	for (const row of Object.values(expected)) {
		const state = stateName(stateOf(row, mode));
		counts.set(state, (counts.get(state) ?? 0) + 1);
	}
	let pendingPassing = 0;
	for (const [id, status] of result.tests) {
		const row = expected[id];
		if (row !== undefined && stateName(stateOf(row, mode)) === "pending" && status === "passed") pendingPassing++;
	}
	if (target === "reference") judgeReference(mode, result);
	else {
		judgeAdapter(mode, result);
		judgeRunErrors(mode, result);
	}
	const summary = [...counts].sort().map(([s, n]) => `${s}=${n}`).join(" ");
	console.log(`conformance ${target} ${mode}: ${result.tests.size} ran, ${result.unloaded.size} files did not load, ${result.suiteErrors.size} failed outside tests; rows: ${summary}; pending now passing: ${pendingPassing}`);
}
console.log(`conformance exclusions: ${exclusions.tests.length} (reviewed: ${exclusions.reviewed.count})`);

if (problems.length > 0) {
	console.error(`conformance: ${problems.length} problem(s):`);
	for (const problem of problems.slice(0, 50)) console.error(`  ${problem}`);
	if (problems.length > 50) console.error(`  ... and ${problems.length - 50} more`);
	process.exit(1);
}
console.log("conformance: ok");
