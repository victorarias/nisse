import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ClaudeOptions } from "../../src/drivers/claude/index.ts"
import { deadline } from "./raw.ts"

const FIXTURES = join(import.meta.dir, "../../../../fixtures/claude")

export class FakeClaude {
  readonly dir = mkdtempSync("/tmp/nisse-claude-")
  readonly #waiters = new Set<() => void>()
  /**
   * The fake claude pings this socket after each line it logs, and its connection closes when it exits. `fs.watch` on
   * macOS drops changes, so it cannot tell a test that a line arrived.
   */
  readonly #pings = Bun.listen({
    unix: join(this.dir, "log.sock"),
    socket: { data: () => this.#wake(), close: () => this.#wake() },
  })

  readonly #fixture: string

  /** Plays the fixtures' Claude Code processes one per spawn, in order: several chain one journey after another. */
  constructor(...fixtures: [string, ...string[]]) {
    const paths = fixtures.map((fixture) => join(FIXTURES, `${fixture}.ndjson`))
    if (paths.length === 1) this.#fixture = paths[0]!
    else {
      this.#fixture = join(this.dir, "fixture.ndjson")
      writeFileSync(this.#fixture, paths.map((path) => readFileSync(path, "utf8")).join("\n"))
    }
  }

  get options(): ClaudeOptions {
    return {
      executable: join(import.meta.dir, "fake-claude"),
      env: { FAKE_CLAUDE_FIXTURE: this.#fixture, FAKE_CLAUDE_DIR: this.dir },
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
      .filter((entry) => entry.argv && entry.probe === undefined)
      .map((entry) =>
        Object.fromEntries(
          (entry.argv as Array<string>).map((arg) => {
            const equals = arg.indexOf("=")
            return equals < 0 ? [arg, true] : [arg.slice(0, equals), arg.slice(equals + 1)]
          }),
        ),
      )
  }

  probes() {
    return this.log().filter((entry) => entry.argv && entry.probe !== undefined).length
  }

  userTexts(spawn?: number) {
    return this.log()
      .filter(
        (entry) =>
          entry.received?.type === "user" &&
          entry.probe === undefined &&
          (spawn === undefined || entry.spawn === spawn),
      )
      .map((entry) => entry.received.message.content.map((block: { text: string }) => block.text))
  }

  #wake() {
    for (const waiter of this.#waiters) waiter()
  }

  logged(predicate: (fake: FakeClaude) => boolean, ms = 10_000) {
    let check = () => {}
    return deadline(
      new Promise<void>((resolve) => {
        check = () => predicate(this) && resolve()
        this.#waiters.add(check)
        check()
      }),
      ms,
      "fake claude log condition",
    ).finally(() => this.#waiters.delete(check))
  }

  permissionAnswers() {
    return this.log()
      .filter((entry) => entry.answered === "can_use_tool")
      .map((entry) => entry.received.response.response)
  }

  hookAnswers() {
    return this.log()
      .filter((entry) => entry.answered === "hook_callback")
      .map((entry) => entry.received.response.response.hookSpecificOutput)
      .filter((output) => output !== undefined)
  }

  mcpAnswers() {
    return this.log()
      .filter((entry) => entry.answered === "mcp_message")
      .map((entry) => entry.received.response.response.mcp_response)
  }

  [Symbol.dispose]() {
    this.#pings.stop(true)
    rmSync(this.dir, { recursive: true, force: true })
  }
}
