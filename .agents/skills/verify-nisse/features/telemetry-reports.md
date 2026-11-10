# Telemetry and reports

Runs, requests and tools emit spans and metrics, and problems nobody asked about reach someone as reports.

## Sub-features

- `telemetry-spans` [kernel] Spans for runs, requests and tools (R78-90, `harness/telemetry`): Diagnose slow or failing runs
- `telemetry-metrics` [kernel] Metrics (R78-90): Dashboards
- `telemetry-trace-carriers` [kernel] Trace carriers across calls (R78-90): One trace crosses tools and subagents
- `telemetry-identity` [kernel, pending chatgpt-provider] Identity on Context (R78-90): Actions are attributed to a user or service
- `report-kinds` [kernel, pending harness-run-core] `onReport` kinds (§2.2, R214-222): Problems nobody asked about still reach someone
- `report-crash-loop` [kernel] Crash-loop reports (R214-222): People learn a run was stopped for crashing
- `harness-client-identity` [kernel] `HarnessOptions.identity` sets how model requests identify the app to providers, and `{ attribution: null }` sends none.

## How to get to it

### People

None.

### Agents

None. These are kernel use cases, with no client path of their own and no `drive.ts` steps.

## Sources

Feature ledger area V: spec §2.2; README Failures and Recovery, Errors; example 15-real-model.

## Tests

`bun run coverage` lists every id here with its test, its mapped upstream rows or its owning child.

## Gotchas

None recorded yet.
