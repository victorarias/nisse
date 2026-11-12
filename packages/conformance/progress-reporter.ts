// A vitest reporter that appends each test file's and test's start and end to CONFORMANCE_PROGRESS, so a run that
// never finishes can name what was still running (run.ts reads it when the run writes no report). A file starts when
// its worker begins collecting it, which the worker reports before importing the file, so a worker that then blocks
// still shows its file. Test starts arrive in batches, so a test that blocks right away may not be listed.
import { appendFileSync } from "node:fs";
import type { Reporter, TestCase, TestModule } from "vitest/node";

const path = process.env.CONFORMANCE_PROGRESS;
const log = (event: string, what: string): void => {
	if (path !== undefined) appendFileSync(path, `${event}\t${what}\n`);
};
const testName = (test: TestCase): string => `${test.module.relativeModuleId} :: ${test.fullName}`;

export default class ProgressReporter implements Reporter {
	onTestModuleQueued(module: TestModule): void {
		log("start", module.relativeModuleId);
	}
	onTestModuleEnd(module: TestModule): void {
		log("end", module.relativeModuleId);
	}
	onTestCaseReady(test: TestCase): void {
		log("start", testName(test));
	}
	onTestCaseResult(test: TestCase): void {
		log("end", testName(test));
	}
}
