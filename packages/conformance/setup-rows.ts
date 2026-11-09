// Skips upstream rows that are excluded or replaced by an amended test, so they cost no time.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach } from "vitest";
import { relativeFile, testId } from "./ids.ts";

const root = import.meta.dirname;
const mode = process.env.PI_DURABLE_DOCUMENT_RETENTION_MS === undefined ? "default" : "evict";
type Row = string | { default: string; evict: string };
const rows = JSON.parse(readFileSync(join(root, "expected.json"), "utf8")) as Record<string, Row>;

const stateOf = (row: Row | undefined): string | undefined => (typeof row === "object" ? row[mode] : row);

beforeEach((ctx) => {
	const titles: string[] = [ctx.task.name];
	for (let suite = ctx.task.suite; suite !== undefined; suite = suite.suite) titles.unshift(suite.name);
	const state = stateOf(rows[testId(relativeFile(ctx.task.file.filepath, root), titles)]);
	if (state?.startsWith("excluded ") || state?.startsWith("amended ")) ctx.skip();
});
