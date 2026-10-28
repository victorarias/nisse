import { join } from "node:path"

const ROOT = join(import.meta.dir, "../../../..")

export const installedCodeModeHost = (): string | undefined => {
  if (process.env.NISSE_CODE_MODE_HOST) return process.env.NISSE_CODE_MODE_HOST
  const installed = Bun.spawnSync(
    [join(ROOT, "scripts/code-mode-host.sh"), join(ROOT, "node_modules/.cache/nisse/code-mode-host")],
    { stdout: "pipe", stderr: "pipe" },
  )
  return installed.success ? installed.stdout.toString().trim() : undefined
}
