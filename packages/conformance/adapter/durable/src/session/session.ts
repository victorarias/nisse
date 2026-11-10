import { unimplemented } from "../../../../unimplemented.ts";

export const ENDED = unimplemented("ENDED", "kernel-documents");
export const SessionImpl = unimplemented("SessionImpl", "kernel-documents");
export const closeEndOf = unimplemented("closeEndOf", "kernel-documents");
export const closeEnds = unimplemented("closeEnds", "kernel-documents");
export const contained = unimplemented("contained", "kernel-documents");
export const createSession = unimplemented("createSession", "kernel-documents");
export const documentRetention = unimplemented("documentRetention", "kernel-documents");
export const guardObserver = unimplemented("guardObserver", "kernel-documents");
export const observation = unimplemented("observation", "kernel-documents");
export const persistWithin = unimplemented("persistWithin", "kernel-documents");
let documentRetentionMs: number | undefined;
export const defaultDocumentRetention = (): number | undefined => documentRetentionMs;
export function setDefaultDocumentRetention(ms: number): void {
	documentRetentionMs = ms;
}
