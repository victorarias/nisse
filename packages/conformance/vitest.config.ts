import { join, resolve } from "node:path";
import { defineConfig } from "vitest/config";
import { packageTargets } from "./resolve.ts";

// CONFORMANCE_TARGET is the tree behind the suite's @earendil-works imports. run.ts also links the same tree's
// durable/src into upstream/src, because some tests spawn fixtures that import ../../src directly.
const root = import.meta.dirname;
const targetRoot = resolve(root, process.env.CONFORMANCE_TARGET ?? "adapter");
const targets = packageTargets();

export default defineConfig({
	root,
	plugins: [
		{
			name: "conformance-resolve",
			enforce: "pre",
			resolveId(source, importer) {
				if (source === "@earendil-works/pi-durable/testing") return join(root, "upstream/src/testing/index.ts");
				if (source.startsWith("@earendil-works/")) {
					const mapped = targets(source);
					if (mapped === undefined) throw new Error(`conformance: no target for ${source}`);
					return join(targetRoot, mapped);
				}
				return undefined;
			},
		},
	],
	test: {
		include: ["upstream/test/**/*.test.ts", "amended/**/*.test.ts"],
		environment: "node",
		setupFiles: ["./upstream/test/setup-document-retention.ts", "./setup-rows.ts"],
	},
});
