#!/usr/bin/env bun
// Writes expected.json, exclusions.json and amendments.json from the derived owners, the committed baselines and the
// classification files. Rerun only when one of those inputs changes.   bun rows.ts [--reviewed=<count>]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STAGES, type Stage } from "./stages.ts";
import { MODES, type Mode, root } from "./run.ts";

const read = <T>(p: string): T => JSON.parse(readFileSync(join(root, p), "utf8")) as T;
const { owners } = read<{ owners: Record<string, Stage> }>("classification/owners.json");
const linux = read<Record<Mode, Record<string, string>>>("baseline/linux.json");
const macos = read<Record<Mode, Record<string, string>>>("baseline/macos.json");
const d5 = read<{ id: string; feature: string; reason: string }[]>("classification/d5.json");
const pinned = read<{ id: string; class: "amend" | "exclude"; reason: string; spec: string | null; private: string }[]>("classification/pinned.json");
const fullIds = readFileSync(join(root, "classification/full-profile-ids.txt"), "utf8").trim().split("\n");

// A brief's test files: a row in one of these belongs to that child or a later one.
const FILES: Partial<Record<Stage, string[]>> = {
	"kernel-storage": ["sqlite-commit", "sqlite-facade", "sqlite-migrations", "sqlite-storage"],
	"kernel-session": ["session-tables", "session-observers", "session-conversation-tails", "session-adoption", "session-definitions", "session-deferred-commits", "session-group-commit"],
	"kernel-documents": ["session-documents", "session-document-retention", "session-forks", "session-checkpoints-migrations", "session-watches"],
	"env-package": ["env-node", "env-node-conformance", "env-line-scan", "env-truncate", "env-node-spill"],
	"harness-shell": ["harness-sleep", "harness-blocked", "harness-cancellation-barrier", "harness-scheduler-indexes", "harness-scheduler-retention", "harness-idle-scopes", "harness-tasks-recovery", "harness-tasks", "harness-conversations", "harness-context", "harness-context-range", "harness-json", "harness-registry", "harness-prompt", "types"],
	"harness-run-core": ["harness-submissions", "harness-inbox", "harness-submit-in-commit", "harness-host-inputs", "harness-failed-run-inbox", "harness-continue", "harness-input-entries", "harness-read-only", "harness-hook-reads", "harness-inspect", "harness-generation", "harness-generation-recovery", "harness-live-deltas", "harness-partial-changes", "harness-run-failure", "harness-turn-limit", "harness-deferred-progress", "harness-group-commit", "harness-ownership", "harness-restart-failure", "harness-lifecycle", "harness-storage-failure", "harness-reports"],
	"harness-tools": ["harness-tools", "harness-tools-recovery", "harness-tool-hooks", "harness-nested-tools", "harness-nested-tools-restart", "harness-structured", "harness-structured-output", "harness-callers", "harness-after-run"],
	"harness-compaction": ["harness-compaction", "harness-telemetry", "harness-telemetry-options"],
	"harness-views": ["harness-view", "harness-view-run", "harness-observers", "harness-task-graph", "conversation-transcript"],
	"tools-package": ["tools", "tools-images", "tools-read-differential", "tool-search", "search", "images-wasm-module", "tool-args-typebox", "spec-usage"],
	"codemode-package": ["codemode", "codemode-checkpoints", "codemode-describe", "codemode-imports", "codemode-models"],
};
const fileOwner = new Map<string, Stage>();
for (const [stage, files] of Object.entries(FILES)) for (const f of files) fileOwner.set(f, stage as Stage);
const baseName = (id: string) => id.split(" :: ")[0]!.split("/").pop()!.replace(/\.test\.ts$/, "");

// F2: tests that fail on the reference only because of its stand-ins stay pending for the real module's owner.
const STAND_IN_OWNER: [RegExp, Stage][] = [
	[/harness-view-run\.test\.ts :: streamed partials > (commits a growing text|keeps a watcher's memory)/, "models-seam"],
	[/harness-telemetry\.test\.ts :: Durable telemetry > records content-free submit/, "harness-compaction"],
];
// Bun and JavaScriptCore differences: the behavior holds, one assertion names V8's or Node's exact result.
const ENGINE_AMEND: [RegExp, Stage, string, string][] = [
	[/sqlite-storage\.test\.ts :: .*rolls SQL rows and sequence allocation back/, "kernel-storage", "section 10", "assert the transaction rolled back without matching V8's error text"],
	[/env-node\.test\.ts :: .*creates temporary directories and files/, "env-package", "section 10.1", "assert the call resolves without requiring undefined, Bun's fs.promises.access resolves null"],
];
const REMOVED_FILES: Record<string, string> = { "indexeddb-storage": "IndexedDB", "jsonl-storage": "JSONL backend", "store-storage": "key-value store adapter", "store-storage-commit": "key-value store adapter" };
const D14_FILES: Record<string, string> = {
	"storage-runtime-boundary": "reads pi-durable's source files to check its import graph; scripts/boundaries.ts is nisse's version",
	"harness-registry-reader": "needs chord's root host and facets, which D5's removal of the store adapter takes out",
};
const E2E: Record<string, string> = {
	"upstream/test/provider-session-cache-e2e.test.ts :: Durable provider session cache e2e > reuses the Codex prompt cache across Durable turns": "real ChatGPT token and pi-ai's provider code (D8)",
	"upstream/test/system-order-cache-e2e.test.ts :: Durable system message order e2e > keeps the prompt cache across a tool change only when the system message leads": "real Anthropic token and pi-ai's provider code (D8)",
};

// F2: WeakRef retention under JavaScriptCore varies by run; any disagreement in any baseline marks the test in both modes.
const RETENTION_FILES = ["session-watches", "harness-observers", "session-observers"];
const retentionVaries = (id: string): boolean =>
	RETENTION_FILES.includes(baseName(id)) && [linux, macos].some((b) => MODES.some((m) => b[m][id] !== undefined && b[m][id] !== "passed"));

const ownerFor = (id: string): Stage => {
	const derived = owners[id] ?? "harness-run-core";
	const listed = fileOwner.get(baseName(id));
	if (listed === undefined) return derived;
	return STAGES.indexOf(listed) > STAGES.indexOf(derived) ? listed : derived;
};

const exclusions = new Map<string, { test: string; decision: string; reason: string }>();
const exclude = (test: string, decision: string, reason: string) => exclusions.set(test, { test, decision, reason });
for (const e of d5) exclude(e.id, "D5", `${e.feature}: ${e.reason}`);
for (const id of fullIds) {
	const base = baseName(id);
	if (REMOVED_FILES[base]) exclude(id, "D5", REMOVED_FILES[base]!);
	if (D14_FILES[base]) exclude(id, "D14", D14_FILES[base]!);
}
for (const p of pinned) if (p.class === "exclude" && !exclusions.has(p.id)) exclude(p.id, "D14", `pinned, no spec section backs it: ${p.private}: ${p.reason}`);
for (const [id, reason] of Object.entries(E2E)) exclude(id, "D8", reason);

const amendments: { test: string; owner: Stage; spec: string; rewrite: string; private: string }[] = [];
const allIds = [...new Set([...fullIds, ...Object.keys(linux.default), ...Object.keys(E2E)])].sort();
const rows: Record<string, string | Record<Mode, string>> = {};
const unexplained: string[] = [];

for (const id of allIds) {
	const decided = exclusions.get(id);
	if (decided) {
		rows[id] = `excluded ${decided.decision}`;
		continue;
	}
	const perMode = {} as Record<Mode, string>;
	for (const mode of MODES) {
		const l = linux[mode][id];
		const m = macos[mode][id];
		const owner = ownerFor(id);
		const standIn = STAND_IN_OWNER.find(([re]) => re.test(id))?.[1];
		const engine = ENGINE_AMEND.some(([re]) => re.test(id));
		if (retentionVaries(id)) perMode[mode] = "flaky WeakRef retention varies by run under JavaScriptCore (F2)";
		else if (standIn) perMode[mode] = `pending ${STAGES.indexOf(standIn) > STAGES.indexOf(owner) ? standIn : owner}`;
		else if (engine) perMode[mode] = `pending ${owner}`;
		else if (l === "varies" || m === "varies" || l !== m) perMode[mode] = `flaky varies by run or platform on the reference (linux ${l}, macos ${m})`;
		else if (l === "skipped") perMode[mode] = "flaky skipped upstream on macOS and Linux";
		else if (l === "failed") {
			perMode[mode] = `pending ${owner}`;
			unexplained.push(`${mode} ${id}`);
		} else perMode[mode] = owner === "conformance-harness" ? "pass" : `pending ${owner}`;
	}
	rows[id] = perMode.default === perMode.evict ? perMode.default : perMode;
}
for (const p of pinned) {
	if (p.class === "amend" && !exclusions.has(p.id)) amendments.push({ test: p.id, owner: ownerFor(p.id), spec: p.spec ?? "", rewrite: p.reason, private: p.private });
}
for (const [re, owner, spec, rewrite] of ENGINE_AMEND) {
	for (const id of allIds) if (re.test(id)) amendments.push({ test: id, owner, spec, rewrite, private: "engine-specific assertion" });
}

const reviewed = Number(process.argv.find((a) => a.startsWith("--reviewed="))?.split("=")[1] ?? exclusions.size);
const sortedExclusions = [...exclusions.values()].sort((a, b) => a.test.localeCompare(b.test));
writeFileSync(join(root, "expected.json"), `${JSON.stringify(rows, null, 1)}\n`);
writeFileSync(
	join(root, "exclusions.json"),
	`${JSON.stringify(
		{
			reviewed: { count: reviewed, ask: "a-1dy4mf" },
			decisions: {
				D5: "Left-out features: deferred commits, group commit, IndexedDB, Cloudflare, alarms, JSONL, key-value store, table prefix, read cache.",
				D8: "pi-ai is not brought over; tests needing real providers and tokens do not run.",
				D14: "Pinned tests with no spec section behind them, and tests of pi-durable's own source layout.",
			},
			tests: sortedExclusions,
		},
		null,
		1,
	)}\n`,
);
writeFileSync(join(root, "amendments.json"), `${JSON.stringify(amendments.sort((a, b) => a.test.localeCompare(b.test)), null, 1)}\n`);
const counts: Record<string, number> = {};
for (const row of Object.values(rows)) {
	const s = (typeof row === "string" ? row : row.default).split(" ").slice(0, 2).join(" ");
	counts[s] = (counts[s] ?? 0) + 1;
}
console.log(counts);
const by: Record<string, number> = {};
for (const e of exclusions.values()) by[e.decision] = (by[e.decision] ?? 0) + 1;
console.log("exclusions", exclusions.size, by, "amendments", amendments.length);
console.log("failing on both platforms with no explanation:");
for (const u of unexplained) console.log(" ", u);
