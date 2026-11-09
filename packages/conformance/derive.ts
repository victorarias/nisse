#!/usr/bin/env bun
// Builds a target tree for each child, in the order children deliver: everything that child and earlier ones own is
// the reference copy's real module, everything later is a throwing stub. The earliest stage where a test passes
// names the row's owner (the plot's "two measures").
//
//   bun derive.ts adapter        regenerate adapter/ from the shape of the reference copy
//   bun derive.ts owners [--stages]   run every stage and write classification/owners.json
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { root, runSuite } from "./run.ts";
import { STAGES, type Stage } from "./stages.ts";

// Longest match wins. Paths are relative to the reference tree. Module assignment is coarse where Harness.open needs a
// module to run at all (submissions, inbox, views, compaction, usage, telemetry, task graph): those stay with harness-shell, and a test
// file a brief names can only move later than the stage here (see rows.ts).
const OWNERS: [string, Stage][] = [
	["chord/src/context/", "conformance-harness"],
	["durable/src/storage/memory.ts", "conformance-harness"],
	["durable/src/storage/scan.ts", "conformance-harness"],
	["durable/src/errors.ts", "conformance-harness"],
	["durable/src/ids.ts", "conformance-harness"],
	["durable/src/index.ts", "conformance-harness"],
	["chord/src/delta/", "pure-packages"],
	["chord/src/json.ts", "pure-packages"],
	["chord/src/output.ts", "pure-packages"],
	["schema/", "pure-packages"],
	["chord/src/sqlite/", "kernel-storage"],
	["durable/src/storage/", "kernel-storage"],
	["durable/src/session/", "kernel-session"],
	["durable/src/types.ts", "kernel-session"],
	["durable/src/session/forks.ts", "kernel-documents"],
	["durable/src/documents.ts", "kernel-documents"],
	["chord/src/watch.ts", "kernel-documents"],
	["durable/src/harness/scheduler.ts", "kernel-tasks"],
	["durable/src/tasks.ts", "kernel-tasks"],
	["durable/src/timers.ts", "kernel-session"],
	["ai/", "models-seam"],
	["durable/src/env/", "env-package"],
	["durable/src/truncate.ts", "env-package"],
	["durable/src/harness/", "harness-shell"],
	
	["durable/src/entries.ts", "harness-shell"],
	["telemetry/", "harness-shell"],
	["durable/src/harness/generation.ts", "harness-run-core"],
	["durable/src/harness/live.ts", "harness-run-core"],
	["durable/src/harness/partial-changes.ts", "harness-run-core"],
	["durable/src/harness/tool.ts", "harness-run-core"],
	["durable/src/harness/transcript.ts", "harness-views"],
	["durable/src/tools/", "tools-package"],
	["durable/src/tool-search/", "tools-package"],
	["durable/src/search.ts", "tools-package"],
	["durable/src/images/", "tools-package"],
	["durable/src/codemode/", "codemode-package"],
	["codemode/", "codemode-package"],
];

function ownerOf(path: string): Stage {
	let best: [string, Stage] | undefined;
	for (const entry of OWNERS) {
		if (path.startsWith(entry[0]) && (best === undefined || entry[0].length > best[0].length)) best = entry;
	}
	if (best === undefined) throw new Error(`derive: no owner for ${path}`);
	return best[1];
}

const reference = join(root, "reference");

function modules(): string[] {
	return readdirSync(reference, { recursive: true, encoding: "utf8" })
		.filter((f) => /\.ts$/.test(f) && !f.endsWith(".d.ts") && !f.startsWith("durable/src/testing/") && statSync(join(reference, f)).isFile())
		.sort();
}

async function stubText(path: string, owner: Stage, helper: string): Promise<string> {
	// The image worker throws when imported outside a worker thread, and exports nothing.
	const names = path.endsWith("images/node-worker.ts") ? [] : Object.keys(await import(join(reference, path)));
	if (names.length === 0) return "export {};\n";
	const lines = names.map((n) =>
		n === "default"
			? `export default unimplemented(${JSON.stringify(n)}, ${JSON.stringify(owner)});`
			: `export const ${n} = unimplemented(${JSON.stringify(n)}, ${JSON.stringify(owner)});`,
	);
	return `import { unimplemented } from ${JSON.stringify(helper)};\n\n${lines.join("\n")}\n`;
}

async function buildTree(out: string, keep: (owner: Stage) => boolean, helperFile: string): Promise<void> {
	rmSync(out, { recursive: true, force: true });
	for (const path of modules()) {
		const owner = ownerOf(path);
		const target = join(out, path);
		mkdirSync(dirname(target), { recursive: true });
		if (keep(owner)) {
			cpSync(join(reference, path), target);
		} else {
			let rel = relative(dirname(target), helperFile);
			if (!rel.startsWith(".")) rel = `./${rel}`;
			writeFileSync(target, await stubText(path, owner, rel));
		}
	}
	// Non-module files the kept modules read at runtime (a worker, wasm paths).
	for (const entry of readdirSync(reference, { recursive: true, encoding: "utf8" })) {
		const absolute = join(reference, entry);
		const target = join(out, entry);
		if (!statSync(absolute).isDirectory() && !existsSync(target) && !entry.endsWith(".d.ts") && !entry.startsWith("durable/src/testing/")) {
			mkdirSync(dirname(target), { recursive: true });
			cpSync(absolute, target);
		}
	}
}

const command = process.argv[2];
if (command === "adapter") {
	await buildTree(join(root, "adapter"), (o) => o === "conformance-harness", join(root, "unimplemented.ts"));
	// The suite's setup file calls this in every run, before any kernel exists.
	const session = join(root, "adapter/durable/src/session/session.ts");
	const line = 'export const setDefaultDocumentRetention = unimplemented("setDefaultDocumentRetention", "kernel-session");';
	const text = readFileSync(session, "utf8");
	if (!text.includes(line)) throw new Error("derive: session.ts has no setDefaultDocumentRetention stub");
	writeFileSync(session, text.replace(line, "let documentRetentionMs: number | undefined;\nexport const defaultDocumentRetention = (): number | undefined => documentRetentionMs;\nexport function setDefaultDocumentRetention(ms: number): void {\n\tdocumentRetentionMs = ms;\n}"));
	console.log("adapter/ regenerated from the reference copy");
} else if (command === "owners") {
	const stagesRoot = join(root, "results/stages");
	const helper = join(root, "unimplemented.ts");
	const owners: Record<string, Stage> = {};
	const failedEverywhere = new Set<string>();
	for (let i = 0; i < STAGES.length; i++) {
		const stage = STAGES[i]!;
		const dir = join(stagesRoot, stage);
		await buildTree(dir, (o) => STAGES.indexOf(o) <= i, helper);
		const result = await runSuite(dir, "default", `stage-${stage}`);
		let newly = 0;
		for (const [id, status] of result.tests) {
			if (status === "passed" && owners[id] === undefined) {
				owners[id] = stage;
				newly++;
			}
			if (i === STAGES.length - 1 && status !== "passed") failedEverywhere.add(id);
		}
		console.log(`${stage}: ${result.tests.size} tests seen, ${newly} first pass here, ${result.unloaded.size} files did not load`);
		rmSync(dir, { recursive: true, force: true });
		blockers(stage);
	}
	writeFileSync(join(root, "classification/owners.json"), JSON.stringify({ owners, failedEverywhere: [...failedEverywhere] }, null, 1));
} else {
	throw new Error("usage: bun derive.ts adapter|owners");
}

// Which stubs stopped tests at a stage, for checking the module assignment above.
function blockers(stage: string): void {
	const report = JSON.parse(readFileSync(join(root, `results/stage-${stage}-default.json`), "utf8")) as {
		testResults: { message?: string; assertionResults: { failureMessages: string[] }[] }[];
	};
	const counts = new Map<string, number>();
	const add = (text: string | undefined) => {
		for (const match of text?.matchAll(/adapter: (\S+) is not implemented yet; (\S+) owns/g) ?? []) {
			const key = `${match[1]} (${match[2]})`;
			counts.set(key, (counts.get(key) ?? 0) + 1);
			break;
		}
	};
	for (const file of report.testResults) {
		add(file.message);
		for (const test of file.assertionResults) add(test.failureMessages.join("\n"));
	}
	console.log([...counts].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => `    ${n} ${k}`).join("\n"));
}
