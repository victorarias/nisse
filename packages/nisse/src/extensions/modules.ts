import { dirname } from "node:path"
import * as api from "./api.ts"

const effectModules = () => {
  const dist = `${dirname(Bun.resolveSync("effect/package.json", import.meta.dir))}/dist`
  return [...new Bun.Glob("**/*.js").scanSync({ cwd: dist })]
    .filter((file) => !file.split("/").includes("internal"))
    .map((file) => {
      const name = file.slice(0, -".js".length)
      return { specifier: name === "index" ? "effect" : `effect/${name}`, path: `${dist}/${file}` }
    })
}

let served = false

export const serveSharedModules = () => {
  if (served) return
  served = true
  Bun.plugin({
    name: "nisse-extension-modules",
    setup(build) {
      build.module("@nisse/extension", () => ({ exports: { ...api }, loader: "object" }))
      for (const { specifier, path } of effectModules()) {
        build.module(specifier, () => ({ exports: { ...require(path) }, loader: "object" }))
      }
    },
  })
}
