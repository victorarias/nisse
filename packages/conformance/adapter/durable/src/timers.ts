import { unimplemented } from "../../../unimplemented.ts";

// The kernel arms its timers through Effect's Clock, which a host or test replaces as a service.
export const hostTimers = unimplemented("hostTimers", "nobody: the kernel arms timers through Effect's Clock (D5)");
export const nativeTimer = unimplemented("nativeTimer", "nobody: the kernel arms timers through Effect's Clock (D5)");
