import { unimplemented } from "../../../../unimplemented.ts";

export const ENDED = unimplemented("ENDED", "kernel-session");
export const SessionImpl = unimplemented("SessionImpl", "kernel-session");
export const closeEndOf = unimplemented("closeEndOf", "kernel-session");
export const closeEnds = unimplemented("closeEnds", "kernel-session");
export const contained = unimplemented("contained", "kernel-session");
export const createSession = unimplemented("createSession", "kernel-session");
export const documentRetention = unimplemented("documentRetention", "kernel-session");
export const guardObserver = unimplemented("guardObserver", "kernel-session");
export const observation = unimplemented("observation", "kernel-session");
export const persistWithin = unimplemented("persistWithin", "kernel-session");
let documentRetentionMs: number | undefined;
export const defaultDocumentRetention = (): number | undefined => documentRetentionMs;
export function setDefaultDocumentRetention(ms: number): void {
	documentRetentionMs = ms;
}
