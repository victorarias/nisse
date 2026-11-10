// Amends upstream/test/env-node.test.ts > "creates temporary directories and files" (spec section 10.1,
// amendments.json): the same calls and checks, with each path's existence asserted by `access` resolving, since
// Bun's `fs.promises.access` resolves `null` where Node's resolves `undefined`.
import { rmSync } from "node:fs";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it } from "vitest";
import { getOrThrow } from "../upstream/src/env/index.ts";
import { NodeExecutionEnv } from "../upstream/src/env/node.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("NodeExecutionEnv filesystem", () => {
	it("creates temporary directories and files", async () => {
		const env = new NodeExecutionEnv({ cwd: tmpdir() });
		const tempDir = getOrThrow(await env.createTempDir("node-env-test-", BACKGROUND_CONTEXT));
		tempDirs.push(tempDir);
		await expect(access(tempDir)).resolves.not.toThrow();
		const tempFile = getOrThrow(await env.createTempFile({ prefix: "prefix-", suffix: ".txt" }, BACKGROUND_CONTEXT));
		tempDirs.push(join(tempFile, ".."));
		await expect(access(tempFile)).resolves.not.toThrow();
		expect(tempFile.endsWith(".txt")).toBe(true);
		expect(getOrThrow(await env.readTextFile(tempFile, BACKGROUND_CONTEXT))).toBe("");
	});
});
