// Runs the suite on a target and returns one status per test. A tripwire ends a run that hangs: a run on the reference
// copy takes about 25 s and one on the adapter 30 to 75 s, so 600 s means something is stuck. The run then fails naming
// the test files and tests that started and never ended.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { relativeFile, testId } from "./ids.ts";

export const root = import.meta.dir;
export const MODES = ["default", "evict"] as const;
export type Mode = (typeof MODES)[number];
export type Status = "passed" | "failed" | "skipped";
export interface RunResult {
	tests: Map<string, Status>;
	unloaded: Map<string, string>;
	// Files whose tests ran but which failed outside any test, such as in an afterAll.
	suiteErrors: Map<string, string>;
	// The failure message of each failed test, so a problem can say why.
	failures: Map<string, string>;
}

const VITEST = join(root, "../../node_modules/vitest/vitest.mjs");
const DEADLINE_MS = 600_000;

// Fixtures that tests spawn import ../../src directly, outside vitest's resolver.
function linkSource(target: string): void {
	const links = join(root, "upstream/src");
	for (const entry of readdirSync(links)) {
		if (entry !== "testing") rmSync(join(links, entry), { recursive: true, force: true });
	}
	const source = join(target, "durable/src");
	for (const entry of readdirSync(source)) {
		if (entry !== "testing") symlinkSync(join(source, entry), join(links, entry));
	}
}

export async function runSuite(targetPath: string, mode: Mode, label: string): Promise<RunResult> {
	const target = resolve(root, targetPath);
	if (!existsSync(join(target, "durable/src"))) throw new Error(`conformance: no durable/src under ${target}`);
	linkSource(target);
	mkdirSync(join(root, "results"), { recursive: true });
	const outputFile = join(root, "results", `${label}-${mode}.json`);
	const progressFile = join(root, "results", `${label}-${mode}.progress`);
	rmSync(outputFile, { force: true });
	rmSync(progressFile, { force: true });
	const env: Record<string, string | undefined> = {
		...process.env,
		CONFORMANCE_TARGET: target,
		CONFORMANCE_PROGRESS: progressFile,
	};
	if (mode === "evict") env.PI_DURABLE_DOCUMENT_RETENTION_MS = "0";
	else delete env.PI_DURABLE_DOCUMENT_RETENTION_MS;
	const reporters = ["--reporter=json", `--outputFile.json=${outputFile}`, "--reporter=./progress-reporter.ts"];
	const proc = Bun.spawn(["bun", "--bun", VITEST, "run", ...reporters], {
		cwd: root,
		env,
		stdout: Bun.file(join(root, "results", `${label}-${mode}.log`)),
		stderr: Bun.file(join(root, "results", `${label}-${mode}.err`)),
	});
	let killed = false;
	const deadline = setTimeout(() => {
		killed = true;
		proc.kill("SIGKILL");
	}, DEADLINE_MS);
	const code = await proc.exited;
	clearTimeout(deadline);
	if (!existsSync(outputFile) || lstatSync(outputFile).size === 0) {
		const why = killed ? `still running after ${DEADLINE_MS} ms, killed` : `exit ${code}`;
		throw new Error(
			`conformance: ${mode}: vitest wrote no report (${why}), see results/${label}-${mode}.err; unfinished:${unfinished(progressFile)}`,
		);
	}
	return readReport(outputFile);
}

/** The test files and tests progress-reporter.ts saw start and not end, one per line. */
function unfinished(progressFile: string): string {
	if (!existsSync(progressFile)) return " nothing started";
	const running = new Set<string>();
	for (const line of readFileSync(progressFile, "utf8").split("\n")) {
		const [event, what] = line.split("\t");
		if (event === "start") running.add(what!);
		else if (event === "end") running.delete(what!);
	}
	return running.size === 0 ? " none" : [...running].map((what) => `\n  ${what}`).join("");
}

function readReport(path: string): RunResult {
	const report = JSON.parse(readFileSync(path, "utf8")) as {
		testResults: {
			name: string;
			status: string;
			message?: string;
			assertionResults: { ancestorTitles: string[]; title: string; status: string; failureMessages?: string[] }[];
		}[];
	};
	const tests = new Map<string, Status>();
	const unloaded = new Map<string, string>();
	const suiteErrors = new Map<string, string>();
	const failures = new Map<string, string>();
	for (const file of report.testResults) {
		const name = relativeFile(file.name, root);
		if (file.assertionResults.length === 0 && file.status !== "passed") unloaded.set(name, file.message ?? "");
		else if (file.message) suiteErrors.set(name, file.message);
		for (const test of file.assertionResults) {
			const id = testId(name, [...test.ancestorTitles.filter((t) => t !== ""), test.title]);
			if (tests.has(id)) throw new Error(`conformance: two tests share the id ${id}`);
			tests.set(id, test.status === "passed" ? "passed" : test.status === "failed" ? "failed" : "skipped");
			if (test.status === "failed") failures.set(id, (test.failureMessages ?? []).join("\n"));
		}
	}
	return { tests, unloaded, suiteErrors, failures };
}
