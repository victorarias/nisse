// The one pipeline tool arguments go through: JSON Schema, coercion, validation. An Effect Schema enters through
// `projectParameters`, so this package needs no Effect import: `Schema.toStandardJSONSchemaV1(schema)` is the input.

import { formats } from "./formats/index.ts";
import type { JsonSchema } from "./types.ts";
import { type CoercingValidator, compile } from "./validator.ts";

/** The part of the Standard JSON Schema interface a projection reads. Effect's `toStandardJSONSchemaV1` returns one. */
export interface StandardJsonSchema {
	readonly "~standard": {
		readonly jsonSchema: {
			readonly input: (options: { readonly target: "draft-2020-12" }) => Record<string, unknown>;
		};
	};
}

export type ToolArguments = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly message: string };

/**
 * The JSON Schema a model is told for a tool whose parameters are an Effect Schema. Throws when the schema accepts a
 * value JSON cannot carry: `Schema.Number` admits NaN and the infinities, which it projects as strings, so a model
 * would be told it may send "NaN". Use `Schema.Finite`.
 */
export function projectParameters(schema: StandardJsonSchema): JsonSchema {
	const projected = schema["~standard"].jsonSchema.input({ target: "draft-2020-12" });
	refuseNonFinite(projected, "");
	return projected as JsonSchema;
}

function refuseNonFinite(node: unknown, path: string): void {
	if (Array.isArray(node)) {
		node.forEach((item, index) => refuseNonFinite(item, `${path}/${index}`));
		return;
	}
	if (typeof node !== "object" || node === null) return;
	const members = (node as { enum?: unknown }).enum;
	if (Array.isArray(members) && members.includes("NaN")) {
		throw new Error(`tool parameters at "${path || "/"}" accept NaN and the infinities; use Schema.Finite`);
	}
	for (const [key, value] of Object.entries(node)) refuseNonFinite(value, `${path}/${key}`);
}

// One compiled validator per schema object: tool schemas are long-lived, so the WeakMap drops entries with their tools.
const validators = new WeakMap<object, CoercingValidator>();

function validatorOf(parameters: JsonSchema & object): CoercingValidator {
	const cached = validators.get(parameters);
	if (cached !== undefined) return cached;
	// A $ref that names nothing (a dangling definition in an MCP server's schema) rejects only values at its place,
	// instead of making every call of the tool fail.
	const validator = compile(parameters, { formats, coerce: true, unresolvedRefs: "reject" });
	validators.set(parameters, validator);
	return validator;
}

/** A JSON Pointer as the dotted path a model sees: `/edits/0/oldText` becomes `edits.0.oldText`. */
function dottedPath(pointer: string): string {
	if (pointer === "") return "root";
	return pointer
		.slice(1)
		.split("/")
		.map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
		.join(".");
}

/**
 * Coerces then validates a tool call's arguments: models send `"42"` for a number, a single value for an array and
 * `null` for an omitted optional. The input is never modified. The failure message is written for the model to read.
 */
export function checkToolArguments(toolName: string, parameters: JsonSchema & object, args: unknown): ToolArguments {
	const result = validatorOf(parameters).parse(args);
	if (result.ok) return { ok: true, value: result.value };
	const errors = result.errors.map((error) => `  - ${dottedPath(error.path)}: ${error.message}`).join("\n");
	return {
		ok: false,
		message: `Validation failed for tool "${toolName}":\n${errors}\n\nReceived arguments:\n${JSON.stringify(args, null, 2)}`,
	};
}
