import { BUILTIN_TASKS as HARNESS_BUILTIN_TASKS } from "../../../../../harness/src/index.ts";
import { Registry } from "./convert.ts";

export const BUILTIN_TASKS = HARNESS_BUILTIN_TASKS;

/** Upstream's registry over @nisse/harness's; installs convert upstream's extensions once. */
export const createRegistry = (): Registry => new Registry();
