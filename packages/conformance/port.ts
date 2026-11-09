#!/usr/bin/env bun
// Regenerates upstream/ (committed: pi-durable's tests and src/testing at COMMIT) and reference/ (gitignored: the
// copy of pi-durable's kernel the suite is measured against). Needs a checkout of earendil-works/pi at COMMIT.
//
//   bun port.ts [--source=<path to the pi checkout>]
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { packageTargets } from "./resolve.ts";

export const COMMIT = "7d073328e";

const OUT = import.meta.dir;
const checkout = process.argv.find((a) => a.startsWith("--source="))?.split("=")[1] ?? join(homedir(), "projects/pi-durable");
const head = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (!head.startsWith(COMMIT)) throw new Error(`port needs ${checkout} at ${COMMIT}, found ${head}`);
const SRC = join(checkout, "packages");

for (const dir of ["upstream", "reference"]) rmSync(join(OUT, dir), { recursive: true, force: true });

function copyTree(from: string, to: string, skip: (rel: string) => boolean = () => false): void {
	for (const entry of readdirSync(from, { recursive: true, encoding: "utf8" })) {
		const absolute = join(from, entry);
		if (statSync(absolute).isDirectory() || skip(entry)) continue;
		const target = join(to, entry);
		mkdirSync(dirname(target), { recursive: true });
		cpSync(absolute, target);
	}
}

// Left out of the reference copy (D5). Their tests are enumerated once from a full run and excluded by name.
const DROP_SRC = [
	"storage/jsonl/",
	"storage/indexeddb.ts",
	"storage/sqlite/cloudflare.ts",
	"storage/store/",
	"images/cloudflare.ts",
	"harness/registry-reader.ts",
];
const DROP_TEST = [
	"jsonl-storage.test.ts",
	"indexeddb-storage.test.ts",
	"sqlite-cloudflare.test.ts",
	"store-storage.test.ts",
	"store-storage-commit.test.ts",
	"store-storage-node.ts",
	"store-storage-support.ts",
	"storage-runtime-boundary.test.ts",
	"harness-registry-reader.test.ts",
	"examples/35-durable-on-the-store.ts",
	"examples/36-durable-views.ts",
	"examples/37-harness-registry.ts",
];
const dropped = (rel: string, list: string[]) => list.some((p) => (p.endsWith("/") ? rel.startsWith(p) : rel === p));

copyTree(join(SRC, "durable/test"), join(OUT, "upstream/test"), (rel) => dropped(rel, DROP_TEST));
copyTree(join(SRC, "durable/src/testing"), join(OUT, "upstream/src/testing"));
cpSync(join(SRC, "../LICENSE"), join(OUT, "upstream/LICENSE"));
writeFileSync(join(OUT, "upstream/COMMIT"), `${head}\n`);

copyTree(join(SRC, "durable/src"), join(OUT, "reference/durable/src"), (rel) => dropped(rel, DROP_SRC));
copyTree(join(SRC, "schema/src"), join(OUT, "reference/schema/src"));
copyTree(join(SRC, "telemetry/src"), join(OUT, "reference/telemetry/src"));
copyTree(join(SRC, "codemode/src"), join(OUT, "reference/codemode/src"), (rel) => rel === "cloudflare.ts" || rel === "cloudflare-modules.d.ts");
cpSync(join(OUT, "reference-support/ai"), join(OUT, "reference/ai"), { recursive: true });

// Chord: the closure over relative imports of the entry points durable uses.
const chordSrc = join(SRC, "chord/src");
const importRe = /(?:from\s+|import\s+|import\()["']([^"']+)["']/g;
const seen = new Set<string>();
const stack = ["context/index.ts", "json.ts", "delta/index.ts", "sqlite/index.ts", "sqlite/node.ts", "watch.ts", "output.ts"].map((e) => join(chordSrc, e));
while (stack.length > 0) {
	const file = stack.pop()!;
	if (seen.has(file)) continue;
	seen.add(file);
	for (const match of readFileSync(file, "utf8").matchAll(importRe)) {
		const spec = match[1]!;
		if (!spec.startsWith(".")) continue;
		const target = resolve(dirname(file), spec);
		const candidate = existsSync(target) && statSync(target).isFile() ? target : `${target}.ts`;
		if (!existsSync(candidate)) throw new Error(`unresolved ${spec} from ${file}`);
		stack.push(candidate);
	}
}
for (const file of seen) {
	const target = join(OUT, "reference/chord/src", relative(chordSrc, file));
	mkdirSync(dirname(target), { recursive: true });
	cpSync(file, target);
}
cpSync(join(OUT, "reference-support/overlay"), join(OUT, "reference"), { recursive: true });

// The reference tree's own imports become relative, so it needs no resolver. Tests keep their specifiers.
const targets = packageTargets();
let rewritten = 0;
for (const dir of ["durable", "chord", "schema", "telemetry", "codemode", "ai"]) {
	const root = join(OUT, "reference", dir);
	for (const entry of readdirSync(root, { recursive: true, encoding: "utf8" })) {
		const absolute = join(root, entry);
		if (!/\.(ts|tsx|mts)$/.test(entry) || statSync(absolute).isDirectory()) continue;
		const text = readFileSync(absolute, "utf8");
		const next = text.replace(/(["'])(@earendil-works\/[^"'\s]+)\1/g, (whole, quote: string, spec: string) => {
			const target = targets(spec);
			if (target === undefined) return whole;
			rewritten++;
			let rel = relative(dirname(absolute), join(OUT, "reference", target));
			if (!rel.startsWith(".")) rel = `./${rel}`;
			return `${quote}${rel}${quote}`;
		});
		if (next !== text) writeFileSync(absolute, next);
	}
}

// F2's two kinds of edit. Bun reaches no global `gc` through a new vm context.
let gc = 0;
for (const entry of readdirSync(join(OUT, "upstream/test"))) {
	if (!entry.endsWith(".ts")) continue;
	const path = join(OUT, "upstream/test", entry);
	const text = readFileSync(path, "utf8");
	const next = text.replace(/runInNewContext\("gc"\)/g, () => {
		gc++;
		return "((() => (globalThis as unknown as { Bun: { gc(sync: boolean): void } }).Bun.gc(true)) as unknown)";
	});
	if (next !== text) writeFileSync(path, next);
}
type Patch = { file: string; find: string; replace: string };
const patches = JSON.parse(readFileSync(join(OUT, "patches.json"), "utf8")) as Patch[];
for (const patch of patches) {
	const path = join(OUT, patch.file);
	const text = readFileSync(path, "utf8");
	if (!text.includes(patch.find)) throw new Error(`patch did not apply: ${patch.file}: ${patch.find}`);
	writeFileSync(path, text.replace(patch.find, () => patch.replace));
}
console.log(`ported ${head}: ${seen.size} chord files, ${rewritten} specifiers, ${gc} gc lookups, ${patches.length} patches`);
