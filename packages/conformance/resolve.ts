// Where a package specifier lands inside a target tree. A pi-ai subpath lands on the stand-in barrel.
const TABLE: Record<string, string> = {
	"@earendil-works/chord": "chord/src/index.ts",
	"@earendil-works/chord/context": "chord/src/context/index.ts",
	"@earendil-works/chord/delta": "chord/src/delta/index.ts",
	"@earendil-works/chord/json": "chord/src/json.ts",
	"@earendil-works/chord/watch": "chord/src/watch.ts",
	"@earendil-works/chord/output": "chord/src/output.ts",
	"@earendil-works/chord/sqlite": "chord/src/sqlite/index.ts",
	"@earendil-works/chord/sqlite/node": "chord/src/sqlite/node.ts",
	"@earendil-works/pi-schema": "schema/src/index.ts",
	"@earendil-works/pi-schema/formats": "schema/src/formats/index.ts",
	"@earendil-works/pi-telemetry": "telemetry/src/index.ts",
	"@earendil-works/pi-telemetry/render": "telemetry/src/render.ts",
	"@earendil-works/pi-telemetry/testing": "telemetry/src/testing/index.ts",
	"@earendil-works/pi-codemode": "codemode/src/index.ts",
	"@earendil-works/pi-codemode/declarations": "codemode/src/declarations.ts",
	"@earendil-works/pi-codemode/source": "codemode/src/source.ts",
	"@earendil-works/pi-codemode/portable": "codemode/src/portable.ts",
	"@earendil-works/pi-durable": "durable/src/index.ts",
	"@earendil-works/pi-durable/env": "durable/src/env/index.ts",
	"@earendil-works/pi-durable/env/node": "durable/src/env/node.ts",
	"@earendil-works/pi-durable/codemode": "durable/src/codemode/index.ts",
	"@earendil-works/pi-durable/tool-search": "durable/src/tool-search/index.ts",
	"@earendil-works/pi-durable/tools": "durable/src/tools/index.ts",
	"@earendil-works/pi-durable/images": "durable/src/images/index.ts",
	"@earendil-works/pi-durable/images/node": "durable/src/images/node.ts",
	"@earendil-works/pi-durable/storage/memory": "durable/src/storage/memory.ts",
	"@earendil-works/pi-durable/storage/sqlite": "durable/src/storage/sqlite/index.ts",
	"@earendil-works/pi-durable/storage/sqlite/node": "durable/src/storage/sqlite/node.ts",
	"@earendil-works/pi-durable/testing": "durable/src/testing/index.ts",
};

export function packageTargets(): (spec: string) => string | undefined {
	return (spec) => (spec.startsWith("@earendil-works/pi-ai") ? "ai/index.ts" : TABLE[spec]);
}
