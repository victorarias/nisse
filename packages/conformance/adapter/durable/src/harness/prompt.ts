import * as H from "../../../../../harness/src/index.ts";
import type { Context } from "../../../chord/src/context/index.ts";
import { run } from "../session/session.ts";
import { harnessInput, harnessSection, upstreamSection } from "./convert.ts";

type Any = any;

export { planSystemEntries, replaySections } from "../../../../../harness/src/index.ts";

export const renderSections = (
	sections: readonly Any[],
	input: Any,
	shown: ReadonlyMap<string, string>,
	report: (error: unknown, section: Any) => void,
	context: Context,
): Promise<Map<string, string>> =>
	run(
		H.renderSections(sections.map(harnessSection), harnessInput(input), shown, (error, section) =>
			report(error, upstreamSection(section)),
		),
		context,
	);
