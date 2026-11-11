// Checks the feature map against the tests. `bun run coverage` prints everything;
// `bun run check` passes --quiet and prints only the summary and any problem.
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const MAP = ".agents/skills/verify-nisse"
const CONFORMANCE = "packages/conformance"

// The plot's child steps a use case may be pending on.
const STEPS = new Set([
  "pure-packages",
  "kernel-storage",
  "kernel-session",
  "kernel-documents",
  "kernel-tasks",
  "models-seam",
  "env-package",
  "harness-shell",
  "harness-run-core",
  "harness-tools",
  "harness-compaction",
  "harness-views",
  "tools-package",
  "kernel-server",
  "provider-registry",
  "chatgpt-provider",
  "codemode-package",
  "nisse-surface",
  "claude-run",
  "wire-complete",
  "cli-kernel",
  "kernel-modes",
  "tui-views",
  "switch-delete",
  "surface-conversations",
  "zero-pending",
])

type UseCase = { id: string; file: string; kind: "client" | "kernel"; pending: string | undefined }
type LedgerRow = { id: string; useCases?: string[]; exclusion?: string }
type Test = { ids: string[]; file: string; title: string }

const problems: string[] = []

const quiet = process.argv.includes("--quiet")
const junitPath = process.argv.slice(2).find((a) => !a.startsWith("--"))
if (!junitPath) throw new Error("usage: coverage.ts [--quiet] <junit.xml>")

function readUseCases(): Map<string, UseCase> {
  const out = new Map<string, UseCase>()
  const dir = join(MAP, "features")
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".md") || name === "README.md") continue
    const file = `features/${name}`
    let inSection = false
    let sawSection = false
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      if (line.startsWith("## ")) {
        inSection = line === "## Sub-features"
        sawSection ||= inSection
        continue
      }
      if (!inSection || !line.startsWith("- ")) continue
      const m = /^- `([a-z0-9-]+)`(?: \[(kernel)?(?:, )?(?:pending ([a-z0-9-]+))?\])?/.exec(line)
      if (!m) {
        problems.push(`${file}: sub-feature line has no id: ${line}`)
        continue
      }
      const [, id, kernel, pending] = m
      if (out.has(id!)) problems.push(`${file}: duplicate use case id ${id}`)
      if (pending !== undefined && !STEPS.has(pending))
        problems.push(`${file}: ${id} is pending on unknown step ${pending}`)
      if (/\[[^\]]*pending\s*\]/.test(line) && pending === undefined)
        problems.push(`${file}: ${id} is pending with no owner`)
      out.set(id!, { id: id!, file, kind: kernel ? "kernel" : "client", pending })
    }
    if (!sawSection) problems.push(`${file}: no ## Sub-features section`)
  }
  return out
}

function unescape(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&")
}

function readTests(useCases: Map<string, UseCase>): Test[] {
  const xml = readFileSync(junitPath!, "utf8")
  const out: Test[] = []
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attrs = m[1]!
    const body = m[3] ?? ""
    const name = /\bname="([^"]*)"/.exec(attrs)
    const file = /\bfile="([^"]*)"/.exec(attrs)
    if (!name || !file) continue
    const title = unescape(name[1]!)
    const prefix = /^([a-z0-9-]+(?:, [a-z0-9-]+)*): /.exec(title)
    if (!prefix) {
      problems.push(`${file[1]}: test title names no use case: ${title}`)
      continue
    }
    const ids = prefix[1]!.split(", ")
    for (const id of ids)
      if (!useCases.has(id)) problems.push(`${file[1]}: test names unknown use case ${id}: ${title}`)
    if (/<skipped\b/.test(body) || /<failure\b/.test(body)) continue
    out.push({ ids, file: file[1]!, title })
  }
  return out
}

const useCases = readUseCases()
const tests = readTests(useCases)
const expected = JSON.parse(readFileSync(join(CONFORMANCE, "expected.json"), "utf8")) as Record<string, string>
const mapping = JSON.parse(readFileSync(join(MAP, "use-cases.json"), "utf8")) as Record<string, string[]>
const ledger = JSON.parse(readFileSync(join(MAP, "ledger.json"), "utf8")) as LedgerRow[]
const decisions = new Set(
  Object.keys(
    (JSON.parse(readFileSync(join(CONFORMANCE, "exclusions.json"), "utf8")) as { decisions: Record<string, string> })
      .decisions,
  ),
)

for (const row of Object.keys(expected)) {
  if (expected[row]!.startsWith("excluded")) continue
  if (!mapping[row]) problems.push(`upstream row maps to no use case: ${row}`)
}

const upstream = new Map<string, string[]>()
for (const [row, ids] of Object.entries(mapping)) {
  const status = expected[row]
  if (status === undefined) {
    problems.push(`use-cases.json names a row expected.json does not have: ${row}`)
    continue
  }
  if (status.startsWith("excluded")) problems.push(`use-cases.json maps an excluded row: ${row}`)
  for (const id of ids) {
    if (!useCases.has(id)) problems.push(`use-cases.json maps ${row} to unknown use case ${id}`)
    const list = upstream.get(id) ?? []
    list.push(status)
    upstream.set(id, list)
  }
}

for (const row of ledger) {
  const hasIds = row.useCases !== undefined && row.useCases.length > 0
  if (hasIds === (row.exclusion !== undefined)) {
    problems.push(`ledger ${row.id}: needs exactly one of useCases or exclusion`)
    continue
  }
  for (const id of row.useCases ?? []) if (!useCases.has(id)) problems.push(`ledger ${row.id}: unknown use case ${id}`)
  if (row.exclusion !== undefined && !decisions.has(row.exclusion))
    problems.push(`ledger ${row.id}: unknown decision ${row.exclusion}`)
}

// A use case's mapped upstream rows are settled when none is still pending and at least one passes.
function upstreamCovers(id: string): boolean {
  const rows = upstream.get(id) ?? []
  return rows.some((s) => s === "pass") && rows.every((s) => !s.startsWith("pending"))
}

function coverage(useCase: UseCase): { covered: boolean; detail: string } {
  const own = tests.filter((t) => t.ids.includes(useCase.id))
  const rows = upstream.get(useCase.id) ?? []
  const nisseTests = own.filter((t) => t.file.startsWith("packages/nisse/test/"))
  const covered =
    useCase.kind === "kernel"
      ? own.length > 0 || upstreamCovers(useCase.id)
      : nisseTests.length > 0 && (rows.length === 0 || upstreamCovers(useCase.id))
  const parts = [`${own.length} test${own.length === 1 ? "" : "s"}`]
  if (rows.length > 0) parts.push(`${rows.filter((s) => s === "pass").length}/${rows.length} upstream rows pass`)
  return { covered, detail: parts.join(", ") }
}

const lines: string[] = []
let coveredCount = 0
let pendingCount = 0
for (const useCase of useCases.values()) {
  const { covered, detail } = coverage(useCase)
  if (useCase.pending !== undefined) {
    pendingCount++
    // A client test may depend on a binary installed on this machine, so only a kernel use case can go stale.
    if (covered && useCase.kind === "kernel")
      problems.push(`${useCase.id} is covered (${detail}): remove its pending ${useCase.pending} from ${useCase.file}`)
    lines.push(`${useCase.id} ${useCase.kind} pending ${useCase.pending} (${detail})`)
  } else if (covered) {
    coveredCount++
    lines.push(`${useCase.id} ${useCase.kind} covered (${detail})`)
  } else {
    problems.push(`${useCase.id} (${useCase.kind}) in ${useCase.file} has no coverage and no pending owner (${detail})`)
    lines.push(`${useCase.id} ${useCase.kind} UNCOVERED (${detail})`)
  }
}

if (!quiet) {
  for (const row of ledger)
    console.log(`${row.id} ${row.exclusion ? `excluded ${row.exclusion}` : (row.useCases ?? []).join(" ")}`)
  for (const line of lines) console.log(line)
}
for (const p of problems) console.error(`coverage: ${p}`)
console.log(
  `coverage: ${useCases.size} use cases, ${coveredCount} covered, ${pendingCount} pending, ${ledger.length} ledger rows, ${problems.length} problems`,
)
if (problems.length > 0) process.exit(1)
