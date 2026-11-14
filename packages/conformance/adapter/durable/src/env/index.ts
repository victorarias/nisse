// The Promise-and-Result surface the suite expects, over @sigma/env's Effect surface.
export { ExecutionError, FileError, LineScanner, StreamDecoder, rangeDecoder, startsWithBom, toError } from "@sigma/env";

export type Result<TValue, TError> = { ok: true; value: TValue } | { ok: false; error: TError };

export function ok<TValue, TError>(value: TValue): Result<TValue, TError> {
	return { ok: true, value };
}

export function err<TValue, TError>(error: TError): Result<TValue, TError> {
	return { ok: false, error };
}

export function getOrThrow<TValue, TError>(result: Result<TValue, TError>): TValue {
	if (!result.ok) throw result.error;
	return result.value;
}

export function getOrUndefined<TValue extends object, TError>(result: Result<TValue, TError>): TValue | undefined {
	return result.ok ? result.value : undefined;
}
