// Upstream's code mode over @nisse/codemode: the tool and extension in upstream's Promise form, and globals given as
// upstream's `execute(args, api, context)` converted to the Effect form.
import { Effect } from "effect";
import * as C from "../../../../../codemode/src/index.ts";
import { signalled, upstream, upstreamSection, upstreamToolApi } from "../harness/convert.ts";
import { upstreamTool } from "../tools/bridge.ts";

type Any = any;

export const CODEMODE_MODULE_VERSION = C.CODEMODE_MODULE_VERSION;
export const CODEMODE_TOOL_NAME = C.CODEMODE_TOOL_NAME;
export const CodemodeJournalDoc = C.CodemodeJournalDoc;
export const CodemodeRunDoc = C.CodemodeRunDoc;
export const CodemodeStoreDoc = C.CodemodeStoreDoc;

/**
 * A global's Promise as an Effect whose interruption aborts its context and does not wait for it: upstream's call ends
 * without waiting for a global still running, and drops its late result.
 */
const harnessGlobal = (global: Any): C.CodemodeGlobal => ({
	name: global.name,
	...(global.spread === undefined ? {} : { spread: global.spread }),
	execute: (args, api) =>
		Effect.callback((resume) => {
			const controller = new AbortController();
			Promise.resolve()
				.then(() => global.execute(args, upstreamToolApi(api), signalled(controller.signal)))
				.then(
					(value) => resume(Effect.succeed(value)),
					(error: unknown) => resume(Effect.fail(error)),
				);
			return Effect.sync(() => controller.abort());
		}),
});

const harnessOptions = (options: Any): C.CodemodeToolOptions => ({
	...options,
	...(options.globals === undefined ? {} : { globals: options.globals.map(harnessGlobal) }),
});

export const createCodemodeTool = (options: Any): Any => upstreamTool(C.createCodemodeTool(harnessOptions(options)));

export const createCodemodeExtension = (options: Any): Any =>
	upstream(C.createCodemodeExtension(harnessOptions(options)), (extension: Any) => ({
		...extension,
		tools: extension.tools.map(upstreamTool),
		sections: extension.sections.map(upstreamSection),
	}));
