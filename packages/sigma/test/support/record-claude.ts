// Records a real Claude Code as a `fixtures/claude` journey: a server given this as its Claude executable runs the
// SDK's bundled Claude Code, and every frame sigma sends (`expect_outbound`) and Claude Code answers (`emit_inbound`) is
// appended to RECORD_CLAUDE_TO, one segment per spawn. The fake `claude` replays it: the session id becomes
// `<session>`, the conversation's directory `<workspace>`, and the ids sigma chose `<sigma:N>`, numbered in the order
// the fake binds them. What describes the recording machine's own setup, its skills, commands, plugins, MCP servers
// and hooks, is left out, and its home directory becomes /home/person. Claude Code still loads the recording user's own
// settings and CLAUDE.md, and what Claude writes may quote them: read a recording before committing it.
import { appendFileSync } from "node:fs"
import { homedir } from "node:os"

const to = process.env.RECORD_CLAUDE_TO!
const real = Bun.resolveSync(
  `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`,
  `${import.meta.dir}/../../../claude/src`,
)
const argv = process.argv.slice(2)
const flag = (name: string) => {
  const joined = argv.find((arg) => arg.startsWith(`${name}=`))
  if (joined) return joined.slice(name.length + 1)
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}
let session = flag("--session-id") ?? flag("--resume")
const workspace = process.cwd()
const chosen = new Map<string, string>()

const replace = (text: string) => {
  let out = text
  for (const [id, placeholder] of chosen) out = out.split(id).join(placeholder)
  if (session) out = out.split(session).join("<session>")
  return out.split(workspace).join("<workspace>").split(homedir()).join("/home/person")
}

/** The frame without the recording machine's own setup; `undefined` for a frame that is only about it. */
const scrub = (frame: any): unknown => {
  if (frame.type === "system" && /^hook_|^commands_changed$/.test(frame.subtype)) return undefined
  if (frame.type === "system" && frame.subtype === "init") {
    const { tools: _t, mcp_servers: _m, slash_commands: _s, skills: _k, plugins: _p, agents: _a, ...rest } = frame
    return rest
  }
  const response = frame.type === "control_response" ? frame.response?.response : undefined
  if (response?.claude_code_version !== undefined) {
    return {
      ...frame,
      response: { ...frame.response, response: { claude_code_version: response.claude_code_version } },
    }
  }
  return frame
}
const record = (type: "expect_outbound" | "emit_inbound", frame: unknown) =>
  appendFileSync(to, `${replace(JSON.stringify({ frame, type }))}\n`)

record("expect_outbound", { argv })
const child = Bun.spawn([real, ...argv], { stdin: "pipe", stdout: "pipe", stderr: "inherit" })

const lines = async (stream: ReadableStream<Uint8Array>, each: (line: string) => void) => {
  let buffer = ""
  for await (const chunk of stream) {
    buffer += new TextDecoder().decode(chunk)
    let newline: number
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim() !== "") each(line)
    }
  }
}

const outbound = lines(Bun.stdin.stream(), (line) => {
  const frame = JSON.parse(line)
  // The fake binds each control request's id and each user message's uuid as it receives them.
  const id = frame.type === "control_request" ? frame.request_id : frame.type === "user" ? frame.uuid : undefined
  if (typeof id === "string" && !chosen.has(id)) chosen.set(id, `<sigma:${chosen.size + 1}>`)
  record("expect_outbound", frame)
  child.stdin.write(`${line}\n`)
}).then(() => child.stdin.end())

const inbound = lines(child.stdout, (line) => {
  const frame = JSON.parse(line)
  // `/clear` moves the session to a new id; later frames carry it.
  if (session === undefined && typeof frame.session_id === "string") session = frame.session_id
  const kept = scrub(frame)
  if (kept !== undefined) record("emit_inbound", kept)
  process.stdout.write(`${line}\n`)
})

await inbound
void outbound
process.exit(await child.exited)
