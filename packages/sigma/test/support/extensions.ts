// A home with extensions written into it, and the extensions the extension tests load.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tempHome } from "./server.ts"

/** A fresh home holding `files` under its `extensions` folder, and `config` as its `config.toml`. */
export const homeWithExtensions = (files: Record<string, string>, config = "") => {
  const home = tempHome()
  mkdirSync(home.extensions, { recursive: true })
  for (const [name, source] of Object.entries(files)) {
    mkdirSync(join(home.extensions, name, ".."), { recursive: true })
    writeFileSync(join(home.extensions, name), source)
  }
  if (config !== "") writeFileSync(join(home.dir, "config.toml"), config)
  return home
}
