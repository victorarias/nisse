import { mkdtempSync, readFileSync, rmSync, watch } from "node:fs"
import { join } from "node:path"
import type { ClaudeOptions } from "../../src/drivers/claude/index.ts"
import { deadline } from "./raw.ts"

const FIXTURES = join(import.meta.dir, "../../../../fixtures/claude")

export class FakeClaude {
  readonly dir = mkdtempSync("/tmp/nisse-claude-")

  constructor(readonly fixture: string) {}

  get options(): ClaudeOptions {
    return {
      executable: join(import.meta.dir, "fake-claude"),
      env: { FAKE_CLAUDE_FIXTURE: join(FIXTURES, `${this.fixture}.ndjson`), FAKE_CLAUDE_DIR: this.dir },
    }
  }

  log(): Array<any> {
    try {
      return readFileSync(join(this.dir, "log.ndjson"), "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line))
    } catch {
      return []
    }
  }

  spawns(): Array<Record<string, string | true>> {
    return this.log()
      .filter((entry) => entry.argv)
      .map((entry) =>
        Object.fromEntries(
          (entry.argv as Array<string>).map((arg) => {
            const equals = arg.indexOf("=")
            return equals < 0 ? [arg, true] : [arg.slice(0, equals), arg.slice(equals + 1)]
          }),
        ),
      )
  }

  userTexts(spawn?: number) {
    return this.log()
      .filter((entry) => entry.received?.type === "user" && (spawn === undefined || entry.spawn === spawn))
      .map((entry) => entry.received.message.content.map((block: { text: string }) => block.text))
  }

  logged(predicate: (fake: FakeClaude) => boolean, ms = 10_000) {
    const watcher = watch(this.dir)
    return deadline(
      new Promise<void>((resolve) => {
        const check = () => predicate(this) && resolve()
        watcher.on("change", check)
        check()
      }),
      ms,
      "fake claude log condition",
    ).finally(() => watcher.close())
  }

  permissionAnswers() {
    return this.log()
      .filter((entry) => entry.received?.type === "control_response")
      .map((entry) => entry.received.response.response)
  }

  [Symbol.dispose]() {
    rmSync(this.dir, { recursive: true, force: true })
  }
}
