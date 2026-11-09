// The children that own rows, in delivery order.
export const STAGES = [
	"conformance-harness",
	"pure-packages",
	"kernel-storage",
	"kernel-session",
	"kernel-documents",
	"kernel-tasks",
	"models-seam",
	"env-package",
	"harness-shell",
	"harness-run-core",
	"harness-tools",
	"harness-compaction",
	"harness-views",
	"tools-package",
	"codemode-package",
] as const;
export type Stage = (typeof STAGES)[number];
