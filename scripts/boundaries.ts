// `bun run check` step: fails naming any import that breaks the package dependency direction. The hoisted linker would
// otherwise let a forbidden import resolve.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"

const PACKAGES = resolve(import.meta.dir, "../packages")

// Which workspace packages each package may import. A package missing here fails the check, so a new one is decided.
const ALLOWED: Record<string, string[]> = {
  delta: [],
  schema: [],
  protocol: [],
  wire: [],
  models: ["delta", "schema"],
  env: [],
  kernel: ["delta"],
  harness: ["delta", "schema", "kernel", "models", "env"],
  tools: ["delta", "schema", "kernel", "harness", "models", "env"],
  codemode: ["delta", "schema", "kernel", "harness", "models", "env", "tools"],
  claude: ["delta", "schema", "kernel", "harness", "models", "env"],
  nisse: ["protocol", "wire", "delta", "schema", "kernel", "harness", "models", "env", "tools", "codemode", "claude"],
}
// May import anything, and nothing may import it.
const CONFORMANCE = "conformance"
// Pure code: its source imports no package at all, not Effect and not Node.
const PURE = new Set(["delta", "schema"])

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\(\s*)["']([^"']+)["']/g

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules") return []
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

function targetPackage(specifier: string, file: string): string | undefined {
  if (specifier.startsWith(".")) {
    const inside = relative(PACKAGES, resolve(dirname(file), specifier))
    return inside.startsWith("..") ? undefined : inside.split("/")[0]
  }
  const named = /^@nisse\/([^/]+)/.exec(specifier)?.[1]
  if (named !== undefined) return named
  return specifier === "nisse" || specifier.startsWith("nisse/") ? "nisse" : undefined
}

const problems: string[] = []
const names = readdirSync(PACKAGES).filter((name) => existsSync(join(PACKAGES, name, "package.json")))

for (const name of names) {
  if (name === CONFORMANCE) continue
  const allowed = ALLOWED[name]
  if (allowed === undefined) {
    problems.push(`packages/${name}: not in the allowed direction table in scripts/boundaries.ts`)
    continue
  }
  for (const file of sourceFiles(join(PACKAGES, name))) {
    const at = relative(resolve(PACKAGES, ".."), file)
    for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
      const specifier = match[1]!
      const target = targetPackage(specifier, file)
      if (target === undefined) {
        const external = !specifier.startsWith(".")
        if (external && PURE.has(name) && at.startsWith(`packages/${name}/src/`))
          problems.push(`${at}: pure package ${name} imports ${specifier}`)
        continue
      }
      if (target === name || (ALLOWED[target] === undefined && target !== CONFORMANCE)) continue
      if (!allowed.includes(target)) problems.push(`${at}: ${name} -> ${target} is not allowed (import "${specifier}")`)
    }
  }
}

for (const p of problems) console.error(`boundaries: ${p}`)
console.log(`boundaries: ${names.length} packages, ${problems.length} problems`)
if (problems.length > 0) process.exit(1)
