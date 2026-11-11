// ChatGPT on the kernel wire (NISSE_KERNEL=1): a real server in process, driven as a raw JSON-RPC client over its
// socket, with ChatGPT played by the fake OpenAI server replaying the recorded exchanges in `fixtures/openai`.
import { expect, test } from "bun:test"
import type { EntryRecord } from "@nisse/wire"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Home } from "../../src/home.ts"
import { homeWithExtensions } from "../support/extensions.ts"
import { accessToken, ACCOUNT, FakeOpenAi, matches, signIn } from "../support/openai.ts"
import { deadline, RawClient } from "../support/raw.ts"
import { runningKernelServer, settled, submit, transcript, type ViewWatch, watchView } from "../support/kernel.ts"
import { png } from "../support/png.ts"
import { tempHome } from "../support/server.ts"
import { imageDimensions } from "@nisse/tools"

// The kernel's tools are named in lower case; the recordings call nisse's shipping tools.
const KERNEL_TOOLS = { Bash: "bash" }

const conversationWith = async (
  fake: FakeOpenAi,
  options: {
    approvals?: "ask" | "auto"
    signedIn?: boolean
    model?: string
    effort?: string
    instructions?: string
    home?: Home
    cwd?: (home: string) => string
  } = {},
) => {
  const server = await runningKernelServer([], {
    openai: fake.options(),
    ...(options.home === undefined ? {} : { home: options.home }),
  })
  if (options.signedIn ?? true) await signIn(server.home)
  const client = await RawClient.connect(server.home.socket)
  const started = await client.call("conversation/start", {
    cwd: options.cwd?.(server.home.dir) ?? server.home.dir,
    ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
    provider: "openai",
    approvals: options.approvals ?? "auto",
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.effort === undefined ? {} : { effort: options.effort }),
  })
  const conversation = started.result.conversation as string
  const view = watchView(client, conversation)
  await view.until(() => true)
  return {
    server,
    client,
    conversation,
    view,
    submit: (text: string) => submit(client, conversation, text),
    said: () => transcript(view.seen()),
    [Symbol.asyncDispose]: async () => {
      client.close()
      await server[Symbol.asyncDispose]()
      if (options.home !== undefined) rmSync(options.home.dir, { recursive: true, force: true })
    },
  }
}

const expectRequests = (fake: FakeOpenAi, expected: ReadonlyArray<unknown>) => {
  const sent = fake.responses().map((request) => JSON.parse(request.body))
  expect(sent).toHaveLength(expected.length)
  sent.forEach((body, i) => {
    if (!matches(body, expected[i])) expect(body).toEqual(expected[i])
  })
}

type Approvals = { requests: Record<string, { tool: string }> }
const approvalsOf = (watch: ViewWatch) => watch.view().docs["nisse.approvals"] as Approvals | undefined
const pending = (watch: ViewWatch) => Object.keys(approvalsOf(watch)?.requests ?? {})

const calls = (entries: ReadonlyArray<EntryRecord>) =>
  entries.flatMap((entry) =>
    entry.kind === "pi.assistant"
      ? ((entry.model?.[0] as { content: Array<any> }).content ?? []).filter((block) => block.type === "toolCall")
      : [],
  )

test("openai-answer, telemetry-identity: a ChatGPT answer is committed, asked for with the sign-in's headers and nisse as the originator", async () => {
  await using fake = new FakeOpenAi()
  const expected = fake.play("text_answer")
  await using session = await conversationWith(fake)
  await session.submit("hello")
  await session.view.until(settled(1))
  expectRequests(fake, expected)
  expect(session.said()).toEqual(["user: hello", "assistant: Hello there", "run_end: answered"])
  const [request] = fake.responses()
  expect(request!.headers.get("authorization")).toBe(`Bearer ${accessToken("first")}`)
  expect(request!.headers.get("chatgpt-account-id")).toBe(ACCOUNT)
  expect(request!.headers.get("originator")).toBe("nisse")
  const body = JSON.parse(request!.body)
  // One id keys the conversation at ChatGPT: its prompt cache and its session.
  expect(request!.headers.get("session-id")).toBe(body.prompt_cache_key)
  expect(body.instructions).toStartWith("You are Nisse")
})

test("openai-answer: a recorded ChatGPT exchange replays into the same answer", async () => {
  await using fake = new FakeOpenAi()
  const expected = fake.play("recorded_text_answer")
  await using session = await conversationWith(fake)
  await session.submit("what does `echo hi` print?")
  await session.view.until(settled(1))
  expectRequests(fake, expected)
  expect(session.said()).toEqual([
    "user: what does `echo hi` print?",
    "assistant: `echo hi` prints:\n\n```text\nhi\n```",
    "run_end: answered",
  ])
})

test("openai-tools: nisse offers its tools, runs the call the model asks for and sends back the result", async () => {
  await using fake = new FakeOpenAi()
  const expected = fake.play("tool_call", KERNEL_TOOLS)
  await using session = await conversationWith(fake)
  await session.submit("what does echo say?")
  await session.view.until(settled(1))
  expectRequests(fake, expected)
  expect(session.said()).toEqual([
    "user: what does echo say?",
    "assistant: Let me look.",
    "assistant: It printed hi.",
    "run_end: answered",
  ])
  expect(calls(session.view.seen())).toEqual([
    expect.objectContaining({ id: "call_1", name: "bash", arguments: { command: "echo hi" } }),
  ])
  const tools = JSON.parse(fake.responses()[0]!.body).tools
  expect(tools.map((tool: { name: string }) => tool.name)).toEqual(
    expect.arrayContaining(["read", "write", "edit", "bash", "grep", "glob", "spawn_agent", "wait_agent"]),
  )
  expect(tools.find((tool: { name: string }) => tool.name === "bash")).toMatchObject({
    type: "function",
    strict: false,
    parameters: { type: "object", required: ["command"] },
  })
})

test("openai-tools, telemetry-identity: a call the person denies reaches the model as denied, and the answer names who gave it", async () => {
  await using fake = new FakeOpenAi()
  const expected = fake.play("tool_denied", KERNEL_TOOLS)
  await using session = await conversationWith(fake, { approvals: "ask" })
  await session.submit("what does echo say?")
  await session.view.until((watch) => pending(watch).length > 0)
  const [approval] = pending(session.view)
  await session.client.call("approval/resolve", {
    conversation: session.conversation,
    approval,
    author: "ada",
    allow: false,
  })
  await session.view.until(settled(1))
  // The recording's result is the shipping server's wording; the kernel's harness words a denial its own way.
  const denied = (expected[1] as { input: Array<{ output?: string }> }).input[3]!
  denied.output = "<harness>\n[error] denied by ada: the person did not allow this call\n</harness>"
  expectRequests(fake, expected)
  expect(session.said().at(-2)).toBe("assistant: I was not allowed to run it.")
  const answer = session.view.seen().find((entry) => entry.kind === "nisse.approval")
  expect(answer?.data).toMatchObject({ approval, author: "ada", allow: false })
})

test("openai-refresh: a turned-down token is refreshed once, saved, and used from then on", async () => {
  await using fake = new FakeOpenAi()
  const expected = fake.play("refresh")
  fake.issueTokens("second", 3600)
  await using session = await conversationWith(fake)
  await session.submit("hello")
  await session.view.until(settled(1))
  await session.submit("again")
  await session.view.until(settled(2))
  expectRequests(fake, expected)
  const refreshes = fake.received.filter((request) => request.path === "/oauth/token")
  expect(refreshes).toHaveLength(1)
  expect(new URLSearchParams(refreshes[0]!.body).get("refresh_token")).toBe("first-refresh")
  expect(fake.responses().map((request) => request.headers.get("authorization"))).toEqual([
    `Bearer ${accessToken("first")}`,
    `Bearer ${accessToken("second")}`,
    `Bearer ${accessToken("second")}`,
  ])
  const saved = JSON.parse(readFileSync(join(session.server.home.dir, "auth", "openai.json"), "utf8"))
  expect(saved).toMatchObject({ access_token: accessToken("second"), refresh_token: "second-refresh" })
})

test("openai-failed: a cut stream, a reached usage limit and an empty error each end the run with the reason", async () => {
  for (const [fixture, message, kept] of [
    ["stream_cut", "the response stream ended before the response finished", "Hel"],
    ["usage_limit", "You have hit your ChatGPT usage limit (plus plan).", ""],
    ["empty_400", "ChatGPT answered 400 with an empty body", ""],
  ] as const) {
    await using fake = new FakeOpenAi()
    fake.play(fixture)
    await using session = await conversationWith(fake)
    await session.submit("hello")
    await session.view.until(settled(1))
    expect(fake.responses()).toHaveLength(1)
    expect(session.said()).toEqual(["user: hello", `assistant: ${kept} [error]`, `run_end: failed (${message})`])
  }
})

test("openai-failed, run-error-classes: a response that failed on ChatGPT's side is tried again, and the next answer is the run's", async () => {
  await using fake = new FakeOpenAi()
  fake.play("response_failed")
  fake.play("text_answer")
  await using session = await conversationWith(fake)
  await session.submit("hello")
  // The harness waits its first backoff, 2 s, before trying again.
  await session.view.until(settled(1), 10_000)
  expect(fake.responses()).toHaveLength(2)
  expect(session.said()).toEqual(["user: hello", "assistant:  [error]", "assistant: Hello there", "run_end: answered"])
  const failed = session.view.seen().find((entry) => entry.kind === "pi.assistant")!.model![0] as {
    errorMessage: string
  }
  expect(failed.errorMessage).toBe("the response failed (server_error): The model crashed.")
})

test("openai-signed-out, provider-signed-out: a conversation with ChatGPT before signing in says how to fix it", async () => {
  await using fake = new FakeOpenAi()
  await using session = await conversationWith(fake, { signedIn: false })
  await session.submit("hello")
  await session.view.until(settled(1))
  expect(fake.responses()).toHaveLength(0)
  expect(session.said().at(-1)).toContain("not signed in to ChatGPT")
})

test("interrupt-wire: a ChatGPT answer streams live, and interrupting it closes the request and keeps what was said", async () => {
  await using fake = new FakeOpenAi()
  fake.reply({
    events: [
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_text.delta", delta: "Thinking about" },
    ],
    hold: true,
  })
  await using session = await conversationWith(fake)
  await session.submit("hello")
  await session.view.until((watch) => JSON.stringify(watch.view().docs["pi.live"] ?? {}).includes("Thinking about"))
  await session.client.call("conversation/interrupt", { conversation: session.conversation })
  await session.view.until(settled(1))
  await deadline(fake.heldStreamAbandoned, 5000, "the request closed")
  expect(session.said()).toEqual([
    "user: hello",
    "assistant: Thinking about [aborted]",
    "run_end: interrupted (aborted)",
  ])
})

test("openai-answer: an answer whose CRLF event separators arrive split across reads is read whole", async () => {
  await using fake = new FakeOpenAi()
  fake.reply({
    events: [
      { type: "response.created", response: { id: "resp_1" } },
      {
        type: "response.output_item.done",
        item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Split but whole" }] },
      },
      { type: "response.completed", response: { id: "resp_1" } },
    ],
    crlfSplit: true,
  })
  await using session = await conversationWith(fake)
  await session.submit("hello")
  await session.view.until(settled(1))
  expect(session.said()).toEqual(["user: hello", "assistant: Split but whole", "run_end: answered"])
})

test("openai-model: the conversation's model and effort reach ChatGPT", async () => {
  await using fake = new FakeOpenAi()
  fake.play("text_answer")
  await using session = await conversationWith(fake, { model: "gpt-6-luna", effort: "high" })
  await session.submit("hello")
  await session.view.until(settled(1))
  expect(JSON.parse(fake.responses()[0]!.body)).toMatchObject({ model: "gpt-6-luna", reasoning: { effort: "high" } })
})

test("subagent-fork: a spawned agent's requests carry its own conversation, and its last answer reaches the parent", async () => {
  await using fake = new FakeOpenAi()
  const expected = fake.play("subagent")
  await using session = await conversationWith(fake)
  await session.submit("Ask a scout where the gnome lives.")
  await session.view.until(settled(1), 20_000)
  expectRequests(fake, expected)
  const [parent, child, parentAgain] = fake.responses().map((request) => JSON.parse(request.body))
  expect(child.prompt_cache_key).not.toBe(parent.prompt_cache_key)
  expect(parentAgain.prompt_cache_key).toBe(parent.prompt_cache_key)
  expect(JSON.stringify(parentAgain.input)).toContain("Under the floor.")
  expect(session.said().at(-2)).toBe("assistant: The scout says: under the floor.")
})

test("compaction-overflow, models-overflow: ChatGPT's context-window error compacts the conversation, and the request goes again", async () => {
  await using fake = new FakeOpenAi()
  const expected = fake.play("context_overflow")
  await using session = await conversationWith(fake, { model: "gpt-6-luna" })
  await session.submit("hello")
  await session.view.until(settled(1))
  // Past the 20,000 tokens a compaction keeps, so the first exchange is what a summary replaces.
  const long = "the quick brown fox jumps over the lazy dog\n".repeat(2500)
  await session.submit(long)
  await session.view.until(settled(2))
  await session.submit("again")
  await session.view.until(settled(3))
  expectRequests(fake, expected)

  const said = session.said()
  expect(said.slice(-3)).toEqual(["assistant:  [error]", "assistant: Again, hello.", "run_end: answered"])
  const failed = session.view
    .seen()
    .flatMap((entry) => (entry.kind === "pi.assistant" ? [entry.model![0] as { errorMessage?: string }] : []))
    .find((message) => message.errorMessage !== undefined)
  expect(failed?.errorMessage).toBe(
    "the response failed (context_length_exceeded): Your input exceeds the context window of this model. Please adjust your input and try again.",
  )
  const [, , , summary, retried] = fake.responses().map((request) => JSON.parse(request.body))
  expect(JSON.stringify(summary.input)).toContain("hello")
  const retriedText = JSON.stringify(retried.input)
  expect(retriedText).toContain("The person said hello and was greeted.")
  expect(retriedText).not.toContain("Hello there")
  expect(retried.input.at(-1)).toEqual({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "again" }],
  })
})

const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, text)
}

/** A repository under `home` with AGENTS.md files and skills at several levels; answers the folder to work in. */
const project = (home: string) => {
  const repo = join(home, "repo")
  mkdirSync(join(repo, ".git"), { recursive: true })
  write(join(home, "AGENTS.md"), "Home rules.")
  write(join(repo, "AGENTS.md"), "Repo rules.")
  write(join(repo, "app", "AGENTS.md"), "App rules.")
  write(join(repo, "app", "AGENTS.override.md"), "App override rules.")
  write(
    join(repo, ".agents", "skills", "review", "SKILL.md"),
    "---\nname: review\ndescription: Review a diff\n---\nLook hard.",
  )
  write(
    join(repo, "app", ".claude", "skills", "review", "SKILL.md"),
    "---\nname: review\ndescription: Nearer review\n---\nLook nearer.",
  )
  write(join(repo, ".claude", "skills", "plain", "SKILL.md"), "No frontmatter.")
  write(join(home, "skills", "ship", "SKILL.md"), "---\nname: ship\ndescription: >\n  Ship it\n  carefully\n---\nShip.")
  return join(repo, "app")
}

const instructionsOf = (fake: FakeOpenAi, request: number): string =>
  JSON.parse(fake.responses()[request]!.body).instructions

test("openai-instructions, agents-md, skills-found, skills-nearest, skills-frontmatter: ChatGPT is told its working directory, the AGENTS.md files from home down to it, and the skills it can use", async () => {
  await using fake = new FakeOpenAi()
  fake.play("text_answer")
  fake.play("text_answer")
  await using session = await conversationWith(fake, { cwd: project })
  await session.submit("hello")
  await session.view.until(settled(1))

  const home = session.server.home.dir
  const app = join(home, "repo", "app")
  const skills = (review: string) =>
    [
      "# Skills",
      "",
      "A skill is a folder of instructions for one kind of task, in a `SKILL.md` file. When a task matches a skill's description, `read` its `SKILL.md` before you start, and follow it. When a message names a skill with `/name` or `$name`, the skill's `SKILL.md` comes with the message; follow it. Relative paths in a skill are relative to its folder.",
      "",
      `- plain:  (file: ${join(home, "repo", ".claude", "skills", "plain", "SKILL.md")})`,
      review,
      `- ship: Ship it carefully (file: ${join(home, "skills", "ship", "SKILL.md")})`,
    ].join("\n")
  expect(instructionsOf(fake, 0)).toEndWith(
    [
      "",
      `The working directory is ${app}.`,
      `# AGENTS.md instructions from ${join(home, "AGENTS.md")}\n\nHome rules.`,
      `# AGENTS.md instructions from ${join(home, "repo", "AGENTS.md")}\n\nRepo rules.`,
      `# AGENTS.md instructions from ${join(app, "AGENTS.override.md")}\n\nApp override rules.`,
      skills(`- review: Nearer review (file: ${join(app, ".claude", "skills", "review", "SKILL.md")})`),
    ].join("\n\n"),
  )

  // What the folders hold is read again for each request.
  rmSync(join(app, ".claude"), { recursive: true })
  write(join(home, "repo", "AGENTS.md"), "New repo rules.")
  await session.submit("again")
  await session.view.until(settled(2))
  const again = instructionsOf(fake, 1)
  expect(again).toContain("\n\nNew repo rules.\n")
  expect(again).not.toContain("\n\nRepo rules.\n")
  expect(again).toEndWith(
    skills(`- review: Review a diff (file: ${join(home, "repo", ".agents", "skills", "review", "SKILL.md")})`),
  )
})

test("openai-instructions: every tool ChatGPT's instructions name is one its request offers, by the same name", async () => {
  await using fake = new FakeOpenAi()
  fake.play("text_answer")
  await using session = await conversationWith(fake, { cwd: project })
  await session.submit("hello")
  await session.view.until(settled(1))
  const { instructions, tools } = JSON.parse(fake.responses()[0]!.body)
  const offered: Array<string> = tools.map((tool: { name: string }) => tool.name)
  const named = [...(instructions as string).matchAll(/`([^`]+)`/g)].map((match) => match[1]!)
  // A name that differs from an offered tool's only in case is a tool the model is told of but not offered.
  const toolLike = named.filter((name) => offered.some((tool) => tool.toLowerCase() === name.toLowerCase()))
  expect(toolLike).toEqual(expect.arrayContaining(["read", "grep", "glob", "write", "edit", "apply_patch", "bash"]))
  expect(toolLike.filter((name) => !offered.includes(name))).toEqual([])
})

test("skills-found: a conversation outside any repository is told only its own folder's skills and the home's", async () => {
  await using fake = new FakeOpenAi()
  fake.play("text_answer")
  await using session = await conversationWith(fake, {
    cwd: (home) => {
      project(home)
      write(join(home, "loose", ".agents", "skills", "near", "SKILL.md"), "---\ndescription: Here\n---\n")
      return join(home, "loose")
    },
  })
  await session.submit("hello")
  await session.view.until(settled(1))
  const instructions = instructionsOf(fake, 0)
  expect(instructions).toContain("- near: Here")
  expect(instructions).toContain("- ship: Ship it carefully")
  expect(instructions).not.toContain("- review:")
  expect(instructions).not.toContain("Repo rules.")
  expect(instructions).toContain("Home rules.")
})

test("start-instructions: ChatGPT is told the instructions its conversation started with, after the AGENTS.md files, and a subagent is not", async () => {
  await using fake = new FakeOpenAi()
  const expected = fake.play("subagent")
  await using session = await conversationWith(fake, { cwd: project, instructions: "Report with attn when done." })
  await session.submit("Ask a scout where the gnome lives.")
  await session.view.until(settled(1), 20_000)
  expectRequests(fake, expected)
  const [parent, child] = [instructionsOf(fake, 0), instructionsOf(fake, 1)]
  expect(parent).toEndWith("\n\n<instructions>\nReport with attn when done.\n</instructions>")
  expect(parent.indexOf("Report with attn when done.")).toBeGreaterThan(parent.indexOf("App override rules."))
  expect(child).toContain("App override rules.")
  expect(child).not.toContain("Report with attn when done.")
})

test("subagent-types: an agent of a type gets its instructions and its model, and fork_turns none leaves the parent's history out", async () => {
  await using fake = new FakeOpenAi()
  const expected = fake.play("subagent_of_a_type")
  await using session = await conversationWith(fake, {
    cwd: (home) => {
      // The fake's Claude Code config directory is the home's `claude` folder.
      write(
        join(home, "claude", "agents", "reviewer.md"),
        "---\nname: reviewer\ndescription: Reviews diffs\nmodel: gpt-6-luna\n---\nBe strict about tests.",
      )
      return home
    },
  })
  await session.submit("Get the diff reviewed.")
  await session.view.until(settled(1), 20_000)
  // The type names a model ChatGPT lists, so the reviewer runs on it.
  expectRequests(fake, expected.with(1, { ...(expected[1] as object), model: "gpt-6-luna" }))

  const [parent, child] = [instructionsOf(fake, 0), instructionsOf(fake, 1)]
  expect(parent).toContain(
    "# Agent types\n\nThe agent types `spawn_agent` takes as `agent_type`:\n- reviewer: Reviews diffs",
  )
  expect(child).toContain("# You are a reviewer agent\n\nBe strict about tests.")
  expect(child).not.toContain("# Agent types")
  expect(JSON.parse(fake.responses()[1]!.body).input).toHaveLength(1)
  const listed = (await session.client.call("conversation/list")).result as Array<{ lineage?: unknown }>
  expect(listed.map((conversation) => conversation.lineage).filter(Boolean)).toEqual([
    expect.objectContaining({ task: "/root/review", title: "review", agentType: "reviewer" }),
  ])
})

const focus = `import { Extension } from "@nisse/extension"
import { Effect } from "effect"
let asked = 0
export default Extension.define((ctx) =>
  ctx.request.hook((request) =>
    Effect.sync(() => {
      asked += 1
      request.instructions.push("Request " + asked + " in " + request.conversation.cwd + ".")
      request.tools = request.tools.filter((name) => name === "bash" || name === "made_up")
      request.tools.push("made_up")
    }),
  ),
)`

test("request-hook: an extension's request hook adds instructions and narrows the tools of each request to the model", async () => {
  await using fake = new FakeOpenAi()
  const expected = fake.play("tool_call", KERNEL_TOOLS)
  const home = homeWithExtensions({ "focus.ts": focus })
  await using session = await conversationWith(fake, { home })
  await session.submit("what does echo say?")
  await session.view.until(settled(1))
  expectRequests(fake, expected)
  expect(session.said().at(-2)).toBe("assistant: It printed hi.")
  const requests = fake.responses().map((response) => JSON.parse(response.body))
  expect(requests.map((request) => request.instructions)).toEqual([
    expect.stringMatching(new RegExp(`^You are Nisse[^]*\\nRequest 1 in ${home.dir}\\.\\n$`)),
    expect.stringMatching(new RegExp(`^You are Nisse[^]*\\nRequest 2 in ${home.dir}\\.\\n$`)),
  ])
  expect(requests.map((request) => request.tools.map((tool: { name: string }) => tool.name))).toEqual([
    ["bash"],
    ["bash"],
  ])
})

test("hook-failure: a request hook that fails is skipped with a toast, and the model gets the request as it was", async () => {
  await using fake = new FakeOpenAi()
  fake.play("text_answer")
  const home = homeWithExtensions({
    "broken.ts": `import { Extension } from "@nisse/extension"
import { Effect } from "effect"
export default Extension.define((ctx) =>
  ctx.request.hook((request) => {
    request.tools = []
    request.instructions.push("Never sent.")
    return Effect.fail("no network")
  }),
)`,
  })
  await using session = await conversationWith(fake, { home })
  await session.submit("hello")
  await session.view.until(settled(1))
  const toasts = session.view.seen().filter((entry) => entry.kind === "nisse.toast")
  expect(toasts.map((entry) => entry.data)).toEqual([{ extension: "broken", text: "request failed: no network" }])
  const { instructions, tools } = JSON.parse(fake.responses()[0]!.body)
  expect(instructions).not.toContain("Never sent.")
  expect(tools.map((tool: { name: string }) => tool.name)).toEqual(
    expect.arrayContaining(["read", "write", "edit", "bash", "grep", "glob", "spawn_agent", "wait_agent"]),
  )
})

test("code-mode-models, openai-code-mode, codemode-grammar, codemode-tool: a model ChatGPT marks code-mode-only is offered codemode alone, writes raw JavaScript for it, and gets the script's result", async () => {
  await using fake = new FakeOpenAi()
  const expected = fake.play("codemode_script")
  await using session = await conversationWith(fake, { model: "gpt-6.1-sol" })
  await session.submit("compute 2 + 2")
  await session.view.until(settled(1))
  expectRequests(fake, expected)
  // F10's recorded call is `text(2 + 2);`, which the sandbox ran.
  const input = JSON.parse(fake.responses()[1]!.body).input as Array<{ type: string; output?: unknown }>
  const output = input.find((item) => item.type === "custom_tool_call_output")?.output
  expect(output).toMatch(/^Script completed\nWall time \d+\.\d seconds\nOutput:\n\n4$/)
  expect(session.said()).toEqual(["user: compute 2 + 2", "assistant: ", "assistant: Hello there", "run_end: answered"])
})

test("code-mode-models: a model that takes nisse's tools directly is offered them, and not codemode", async () => {
  await using fake = new FakeOpenAi()
  fake.play("text_answer")
  await using session = await conversationWith(fake)
  await session.submit("hello")
  await session.view.until(settled(1))
  const { tools } = JSON.parse(fake.responses()[0]!.body) as { tools: Array<{ name: string }> }
  expect(tools.map((tool) => tool.name)).toContain("bash")
  expect(tools.map((tool) => tool.name)).not.toContain("codemode")
})

const userEntries = (watch: ViewWatch) => watch.seen().filter((entry) => entry.kind === "nisse.user")

test("skills-list, skills-attach, skills-snapshot: a skill named in a message comes with it as SKILL.md read then, for the model and every client", async () => {
  await using fake = new FakeOpenAi()
  fake.play("text_answer")
  fake.play("text_answer")
  const home = tempHome()
  const cwd = project(home.dir)
  await using session = await conversationWith(fake, { home, cwd: () => cwd })
  const listed = await session.client.call("skills/list", { conversation: session.conversation })
  expect(listed.result.map((skill: { name: string; description: string }) => [skill.name, skill.description])).toEqual([
    ["plain", ""],
    ["review", "Nearer review"],
    ["ship", "Ship it carefully"],
  ])
  await session.submit("/review this, then $ship and $nothing.")
  await session.view.until(settled(1))
  const nearer = join(home.dir, "repo", "app", ".claude", "skills", "review", "SKILL.md")
  writeFileSync(nearer, "---\nname: review\ndescription: Nearer review\n---\nLook again.")
  await session.submit("$review once more")
  await session.view.until(settled(2))
  const [first, second] = userEntries(session.view).map((entry) => entry.data as { skills?: Array<any> })
  expect(first!.skills).toEqual([
    { name: "review", path: nearer, text: expect.stringContaining("Look nearer.") },
    { name: "ship", path: join(home.dir, "skills", "ship", "SKILL.md"), text: expect.stringContaining("Ship.") },
  ])
  expect(second!.skills).toEqual([{ name: "review", path: nearer, text: expect.stringContaining("Look again.") }])
  const sent = fake.responses().map((request) => JSON.stringify(JSON.parse(request.body).input))
  expect(sent[0]).toContain("<name>review</name>")
  expect(sent[0]).toContain("Look nearer.")
  expect(sent[0]).toContain("<name>ship</name>")
  // The second request carries the first message as it was placed, and the second with the file as it is now.
  expect(sent[1]).toContain("Look nearer.")
  expect(sent[1]).toContain("Look again.")
})

test("image-attach: images sent with a prompt reach the model after its text, one past its limits resized, and every client sees their names", async () => {
  await using fake = new FakeOpenAi()
  fake.play("text_answer")
  await using session = await conversationWith(fake)
  const image = (name: string, bytes: Uint8Array) => ({
    name,
    data: Buffer.from(bytes).toString("base64"),
    mimeType: "image/png",
  })
  const sent = await session.client.call("conversation/submit", {
    conversation: session.conversation,
    requestId: crypto.randomUUID(),
    author: "ada",
    text: "what differs?",
    images: [image("small.png", png(4, 4)), image("wide.png", png(3000, 40))],
  })
  expect(sent.error).toBeUndefined()
  await session.view.until(settled(1))
  expect(userEntries(session.view).map((entry) => (entry.data as { images?: Array<string> }).images)).toEqual([
    ["small.png", "wide.png"],
  ])
  const input = JSON.parse(fake.responses()[0]!.body).input as Array<{ role?: string; content?: Array<any> }>
  const content = input.find((item) => item.role === "user")!.content!
  expect(content.map((part) => part.type)).toEqual(["input_text", "input_image", "input_image"])
  expect(content[0].text).toBe("what differs?")
  const [small, wide] = content.slice(1).map((part) => {
    const [, mimeType, data] = /^data:(.+);base64,(.+)$/.exec(part.image_url)!
    return imageDimensions(Buffer.from(data!, "base64"), mimeType!)
  })
  expect(small).toEqual({ width: 4, height: 4 })
  expect(wide!.width).toBeLessThanOrEqual(2000)
})

test("image-attach: an image the server cannot decode is refused by name, and nothing is submitted", async () => {
  await using fake = new FakeOpenAi()
  await using session = await conversationWith(fake)
  const refused = await session.client.call("conversation/submit", {
    conversation: session.conversation,
    requestId: crypto.randomUUID(),
    author: "ada",
    text: "look",
    images: [{ name: "broken.png", data: Buffer.from("not a picture").toString("base64"), mimeType: "image/png" }],
  })
  expect(refused.error?.data[0]?.error).toMatchObject({
    _tag: "UnreadableImage",
    name: "broken.png",
    message: expect.stringContaining("broken.png (image/png) cannot be decoded"),
  })
  expect(userEntries(session.view)).toEqual([])
  expect(fake.responses()).toHaveLength(0)
})

test("skills-list: a conversation on a provider that finds its own skills lists none, and an unknown one is refused", async () => {
  await using server = await runningKernelServer([])
  const client = await RawClient.connect(server.home.socket)
  const conversation = (await client.call("conversation/start", { cwd: project(server.home.dir) })).result
    .conversation as string
  expect((await client.call("skills/list", { conversation })).result).toEqual([])
  const unknown = await client.call("skills/list", { conversation: "nowhere" })
  expect(unknown.error?.data[0]?.error?._tag).toBe("NoSuchConversation")
  client.close()
})

test("openai-invalid: a sign-in file that is not one fails the run, naming the file", async () => {
  await using fake = new FakeOpenAi()
  await using session = await conversationWith(fake, { signedIn: false })
  const path = join(session.server.home.dir, "auth", "openai.json")
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, JSON.stringify({ hello: "there" }))
  await session.submit("hello")
  await session.view.until(settled(1))
  expect(session.said().at(-1)).toBe(`run_end: failed (${path} is not valid)`)
  expect(fake.responses()).toHaveLength(0)
})

test("openai-expired: a sign-in whose refresh is turned down fails the run and lists ChatGPT signed out, saying why", async () => {
  await using fake = new FakeOpenAi()
  await using session = await conversationWith(fake, { signedIn: false })
  await signIn(session.server.home, "first", Date.now() - 1000)
  await session.submit("hello")
  await session.view.until(settled(1))
  const expired = "the ChatGPT sign-in expired; sign in again (token refresh failed (400: invalid_grant))"
  expect(session.said().at(-1)).toBe(`run_end: failed (${expired})`)
  const providers = (await session.client.call("providers/list", { refresh: true })).result as Array<any>
  expect(providers.find((provider) => provider.id === "openai").health).toMatchObject({
    status: "signed_out",
    message: expired,
  })
})
