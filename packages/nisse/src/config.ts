import { ModelSelection } from "@nisse/protocol"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Effect, Schema } from "effect"

const Instance = Schema.Struct({
  driver: Schema.Literals(["claude", "openai"]),
  config_dir: Schema.optionalKey(Schema.String),
  binary: Schema.optionalKey(Schema.String),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type Instance = typeof Instance.Type

const AgentsConfig = Schema.Struct({
  max_depth: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  max_threads: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
})

const HomeConfig = Schema.Struct({
  default_model: Schema.optionalKey(ModelSelection),
  agents: Schema.optionalKey(AgentsConfig),
  providers: Schema.optionalKey(Schema.Record(Schema.String, Instance)),
})
export type HomeConfig = typeof HomeConfig.Type

const ProjectConfig = Schema.Struct({ default_model: Schema.optionalKey(ModelSelection) })

export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  path: Schema.String,
  message: Schema.String,
}) {}

const parse = <S extends Schema.Top>(schema: S, path: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema as never)(Bun.TOML.parse(readFileSync(path, "utf8"))) as S["Type"],
    catch: (error) => new ConfigError({ path, message: error instanceof Error ? error.message : String(error) }),
  })

export const readHomeConfig = (dir: string): Effect.Effect<HomeConfig, ConfigError> => {
  const path = join(dir, "config.toml")
  return existsSync(path) ? parse(HomeConfig, path) : Effect.succeed({})
}

export const projectDefaultModel = (cwd: string): ModelSelection | undefined => {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const path = join(dir, ".nisse", "config.toml")
    if (existsSync(path)) {
      return Effect.runSync(
        parse(ProjectConfig, path).pipe(
          Effect.map((config) => config.default_model),
          Effect.orElseSucceed(() => undefined),
        ),
      )
    }
    if (dirname(dir) === dir) return undefined
  }
}

export const expandHome = (path: string) =>
  path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path
