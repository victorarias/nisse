import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const fixture = process.env.FAKE_CLAUDE_FIXTURE!
const dir = process.env.FAKE_CLAUDE_DIR!
const argv = process.argv.slice(2)
mkdirSync(dir, { recursive: true })

if (argv[0] === "auth") {
  appendFileSync(join(dir, "log.ndjson"), `${JSON.stringify({ auth: argv.slice(1) })}\n`)
  process.stdout.write(`fake claude ${argv.join(" ")} done\n`)
  process.exit(0)
}

const isProbe = (args: ReadonlyArray<string>) => args.includes("--no-session-persistence")
const probe = isProbe(argv)

const counterFile = join(dir, probe ? "probes" : "spawns")
const spawn = Number(readFileSync(counterFile, { encoding: "utf8", flag: "a+" }) || "0")
writeFileSync(counterFile, String(spawn + 1))

const log = (entry: unknown) =>
  appendFileSync(
    join(dir, "log.ndjson"),
    `${JSON.stringify(probe ? { probe: spawn, ...(entry as object) } : { spawn, ...(entry as object) })}\n`,
  )
log({ argv })

const segments: Array<Array<any>> = []
let playing = false
for (const line of readFileSync(fixture, "utf8").split("\n")) {
  if (line.trim() === "") continue
  const parsed = JSON.parse(line)
  if (parsed.type === "expect_outbound" && parsed.frame.argv) {
    playing = isProbe(parsed.frame.argv) === probe
    if (playing) segments.push([])
  } else if (parsed.type !== "transcript_start" && playing) segments.at(-1)?.push(parsed)
}

const flag = (name: string) => {
  const joined = argv.find((arg) => arg.startsWith(`${name}=`))
  if (joined) return joined.slice(name.length + 1)
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}
const bound = new Map<string, string>([
  ["<session>", flag("--session-id") ?? flag("--resume") ?? crypto.randomUUID()],
  ["<workspace>", process.cwd()],
])
let nextPlaceholder = 1
const bind = (value: string) => bound.set(`<nisse:${nextPlaceholder++}>`, value)
const substitute = (frame: unknown) =>
  JSON.parse(
    JSON.stringify(frame).replace(
      /<session>|<workspace>|<nisse:\d+>/g,
      (placeholder) => bound.get(placeholder) ?? placeholder,
    ),
  )

const inbound: Array<any> = []
let wake: (() => void) | undefined
let ended = false
void (async () => {
  let buffer = ""
  for await (const chunk of Bun.stdin.stream()) {
    buffer += new TextDecoder().decode(chunk)
    let newline: number
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim() !== "") inbound.push(JSON.parse(line))
      wake?.()
    }
  }
  ended = true
  wake?.()
})()

const write = (frame: unknown) => process.stdout.write(`${JSON.stringify(frame)}\n`)

const receive = async (wanted: (frame: any) => boolean) => {
  while (true) {
    const index = inbound.findIndex(wanted)
    if (index >= 0) return inbound.splice(index, 1)[0]
    const stray = inbound.findIndex((frame) => frame.type === "control_request")
    if (stray >= 0) {
      const request = inbound.splice(stray, 1)[0]
      log({ received: request })
      write({
        type: "control_response",
        response: { subtype: "success", request_id: request.request_id, response: {} },
      })
      continue
    }
    if (ended) process.exit(0)
    await new Promise<void>((resolve) => (wake = resolve))
  }
}

const skippedHooks = new Set<string>()
for (const step of segments[spawn] ?? []) {
  const frame = step.frame
  if (step.type === "expect_outbound") {
    if (frame.type === "control_request" && frame.request?.subtype === "initialize") {
      const request = await receive((f) => f.type === "control_request" && f.request?.subtype === "initialize")
      bind(request.request_id)
    } else if (frame.type === "control_request") {
      log({
        received: await receive((f) => f.type === "control_request" && f.request?.subtype === frame.request.subtype),
      })
    } else if (frame.type === "user") {
      const message = await receive((f) => f.type === "user")
      bind(message.uuid)
      log({ received: message })
    } else if (frame.type === "control_response") {
      if (skippedHooks.has(frame.response.request_id)) continue
      log({ received: await receive((f) => f.type === "control_response") })
    }
  } else if (step.type === "emit_inbound") {
    if (frame.type === "control_request" && frame.request?.subtype === "hook_callback") {
      skippedHooks.add(frame.request_id)
      continue
    }
    if (frame.type === "control_response" && skippedHooks.has(frame.response?.request_id)) continue
    write(substitute(frame))
  }
}
await receive(() => false)
