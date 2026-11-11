// Whole-app patterns built only from the harness's public API, after pi-durable's examples 26 (plan mode), 27 (a
// reviewer) and 28 (a sandbox per conversation). Each runs a real Harness over SQLite with the faux model and a local
// environment in a temporary directory.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, type Scope } from "effect"
import { LocalExecutionEnv } from "@nisse/env/local"
import { defineDoc, openSqliteStorage } from "@nisse/kernel"
import { type AssistantMessage, fromProviders, type Message, type SystemMessage } from "@nisse/models"
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@nisse/models/faux"
import {
  type Conversation,
  createRegistry,
  defineExtension,
  defineTool,
  type EnvTarget,
  GenerationTask,
  type Harness,
  hook,
  openHarness,
  type Registry,
  section,
  type ToolExecutionApi,
} from "../src/index.ts"

const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

const directory = (prefix: string): string => {
  const path = mkdtempSync(join(tmpdir(), prefix))
  directories.push(path)
  return path
}

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> => Effect.runPromise(Effect.scoped(effect))

const text = (content: string) => [{ type: "text" as const, text: content }]

const pathArgument = { path: { type: "string" } }

// Minimal file tools over the call's environment; `@nisse/tools` builds on this package and cannot be imported here.
const readTool = defineTool({
  name: "read",
  description: "Read a file.",
  parameters: { type: "object", properties: pathArgument, required: ["path"] },
  execute: ({ path }: { path: string }, api: ToolExecutionApi) =>
    api.env === undefined
      ? Effect.succeed({ output: text("No environment."), isError: true })
      : Effect.map(api.env.readTextFile(path), (content) => ({ output: text(content) })),
})

const writeTool = defineTool({
  name: "write",
  description: "Write a file.",
  parameters: {
    type: "object",
    properties: { ...pathArgument, content: { type: "string" } },
    required: ["path", "content"],
  },
  execute: ({ path, content }: { path: string; content: string }, api: ToolExecutionApi) =>
    api.env === undefined
      ? Effect.succeed({ output: text("No environment."), isError: true })
      : Effect.as(api.env.writeFile(path, content), { output: text(`Wrote ${path}.`) }),
})

const Files = defineExtension({ name: "files", tools: [readTool, writeTool] })

type Model = { readonly modelId: string; readonly messages: Message[] }

/**
 * A Harness over a fresh database whose faux model answers with `responses` in order, recording each request's model
 * and messages. It is closed with the scope.
 */
const openApp = (options: {
  readonly registry: Registry
  readonly responses: readonly FauxResponseStep[]
  readonly models?: readonly string[]
  readonly settings?: { readonly extensions: readonly { readonly name: string }[] }
  readonly env: (target: EnvTarget) => Effect.Effect<LocalExecutionEnv | undefined, unknown>
}): Effect.Effect<{ harness: Harness; requests: Model[] }, unknown, Scope.Scope> =>
  Effect.gen(function* () {
    const requests: Model[] = []
    const faux = fauxProvider({ models: (options.models ?? ["faux-1"]).map((id) => ({ id })) })
    faux.setResponses(
      options.responses.map((step) => (context, requestOptions, state, model) => {
        requests.push({ modelId: model.id, messages: structuredClone(context.messages) })
        return typeof step === "function" ? step(context, requestOptions, state, model) : step
      }),
    )
    const storage = yield* openSqliteStorage(join(directory("nisse-modes-home-"), "kernel.sqlite"))
    const harness = yield* Effect.acquireRelease(
      openHarness(storage, {
        registry: options.registry,
        models: fromProviders([faux.provider]),
        ...(options.settings === undefined ? {} : { settings: options.settings }),
        env: options.env,
      }),
      (harness) => Effect.ignore(harness.close),
    )
    return { harness, requests }
  })

const ask = (conversation: Conversation, input: string) =>
  Effect.gen(function* () {
    const submission = yield* conversation.submit({ type: "input", content: input })
    yield* submission.wait
    yield* conversation.waitForIdle
  })

const textOf = (message: AssistantMessage): string =>
  message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")

/** The tools the model holds after `messages`, replaying each system message's additions and removals. */
const toolsOffered = (messages: readonly Message[]): string[] => {
  const tools = new Set<string>()
  for (const message of messages) {
    if (message.role !== "system") continue
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name)
    for (const tool of message.toolsAdded ?? []) tools.add(tool.name)
  }
  return [...tools].sort()
}

/** The section values the model holds after `messages`; `null` removes one. */
const sectionsShown = (messages: readonly Message[]): Record<string, string> => {
  const shown: Record<string, string> = {}
  for (const message of messages) {
    if (message.role !== "system") continue
    for (const [key, value] of Object.entries((message as SystemMessage).sections ?? {})) {
      if (value === null) delete shown[key]
      else shown[key] = value
    }
  }
  return shown
}

describe("modes", () => {
  test("mode-plan: plan mode offers only reading and submitting a plan, stores the plan, and leaving it gives every tool back", async () => {
    const workspace = directory("nisse-plan-")
    writeFileSync(join(workspace, "server.ts"), "app.listen(3000);\n")

    // The current plan of a conversation; a fork keeps the plan it had at the fork entry.
    const PlanDoc = defineDoc<{ steps: string[] }>({
      kind: "app.plan",
      version: 1,
      scope: "conversation",
      history: "rewindable",
      fork: "asOf",
      initial: () => ({ steps: [] }),
      checkpointWhen: () => false,
    })
    const submitPlan = defineTool({
      name: "submit_plan",
      description: "Submit the plan as a list of steps.",
      parameters: {
        type: "object",
        properties: { steps: { type: "array", items: { type: "string" } } },
        required: ["steps"],
      },
      execute: ({ steps }: { steps: string[] }, api: ToolExecutionApi) =>
        Effect.as(
          api.commit((tx) =>
            Effect.map(tx.doc(PlanDoc, api.conversationId), (plan) => {
              plan.steps = steps
            }),
          ),
          { output: text("Plan submitted."), control: { terminate: true } },
        ),
    })
    const Plan = defineExtension({
      name: "plan",
      tools: [submitPlan],
      sections: [
        section("plan_mode", () =>
          Effect.succeed("You are in plan mode. Read the code, then call submit_plan. Change nothing."),
        ),
      ],
    })
    const registry = createRegistry()
    registry.install(Files)
    registry.install(Plan)
    const steps = ["Read PORT from the environment", "Default to 3000"]

    await run(
      Effect.gen(function* () {
        const { harness, requests } = yield* openApp({
          registry,
          // Installed, but only the file tools are selected by default: a conversation opts into plan mode.
          settings: { extensions: [{ name: "files" }] },
          env: () => Effect.succeed(new LocalExecutionEnv({ cwd: workspace })),
          responses: [
            fauxAssistantMessage(fauxToolCall("read", { path: "server.ts" }), { stopReason: "toolUse" }),
            fauxAssistantMessage(fauxToolCall("submit_plan", { steps }), { stopReason: "toolUse" }),
            fauxAssistantMessage("Implementing step 1."),
          ],
        })
        const root = yield* harness.root({ agent: { model: { provider: "faux", modelId: "faux-1" } } })
        const tools = Effect.map(root.agent, (agent) => agent.tools.map((tool) => tool.name))
        expect(yield* tools).toEqual(["read", "write"])

        yield* root.configure({
          extensions: { add: [{ name: "plan" }] },
          tools: [{ name: "read" }, { name: "submit_plan" }],
        })
        expect(yield* tools).toEqual(["read", "submit_plan"])
        yield* ask(root, "Make the port configurable.")
        expect((yield* harness.session.snapshot(PlanDoc, root.id))?.steps).toEqual(steps)
        // `submit_plan` ended the run: two requests, both in plan mode, and the file is untouched.
        expect(requests).toHaveLength(2)
        for (const request of requests) {
          expect(toolsOffered(request.messages)).toEqual(["read", "submit_plan"])
          expect(sectionsShown(request.messages).plan_mode).toContain("You are in plan mode.")
        }
        expect(readFileSync(join(workspace, "server.ts"), "utf8")).toBe("app.listen(3000);\n")

        yield* root.configure({ extensions: null, tools: null })
        expect(yield* tools).toEqual(["read", "write"])
        yield* ask(root, "Go ahead.")
        // The model saw the switch back as a system prompt change: write returns, submit_plan and the section go.
        const last = requests.at(-1)!.messages
        expect(toolsOffered(last)).toEqual(["read", "write"])
        expect(sectionsShown(last).plan_mode).toBeUndefined()
        // The plan stays the conversation's after plan mode ends.
        expect((yield* harness.session.snapshot(PlanDoc, root.id))?.steps).toEqual(steps)
      }),
    )
  })

  test("mode-reviewer: a reviewer conversation runs its own model, extensions, read-only tools and checkout, and its loop asks again until the review is done", async () => {
    const worktree = directory("nisse-review-")
    writeFileSync(join(worktree, "user.ts"), "export const name = (user) => user.name;\n")

    const DONE = "No further findings."
    const nudge = `Look again for anything you missed. Say "${DONE}" when there is nothing left.`
    // A role and a review loop: every answer that still has findings gets a second pass.
    const Reviewer = defineExtension({
      name: "reviewer",
      sections: [
        section("role", () => Effect.succeed("You review diffs. Report problems as a list. Never edit files.")),
      ],
      hooks: [
        hook(GenerationTask, {
          onYield: (answer: AssistantMessage) =>
            Effect.succeed(textOf(answer).includes(DONE) ? undefined : { continue: nudge }),
        }),
      ],
    })
    const registry = createRegistry()
    registry.install(Files)
    registry.install(Reviewer)

    await run(
      Effect.gen(function* () {
        const { harness, requests } = yield* openApp({
          registry,
          models: ["big", "small"],
          // The main agent selects only the file tools; the reviewer opts in.
          settings: { extensions: [{ name: "files" }] },
          env: ({ cwd }) => Effect.succeed(cwd === undefined ? undefined : new LocalExecutionEnv({ cwd })),
          responses: [
            fauxAssistantMessage(fauxToolCall("read", { path: "user.ts" }), { stopReason: "toolUse" }),
            fauxAssistantMessage("1. `name` does not handle a missing user."),
            fauxAssistantMessage(`2. \`user\` has no type. ${DONE}`),
          ],
        })
        const root = yield* harness.root({ agent: { model: { provider: "faux", modelId: "big" } } })
        expect((yield* root.agent).extensions.map((extension) => extension.name)).toEqual(["files"])

        // Everything the reviewer is, stored on its conversation: model, extensions in order, only `read`, its checkout.
        const reviewer = yield* harness.createConversation({
          ownership: { kind: "ownerless" },
          agent: {
            model: { provider: "faux", modelId: "small" },
            extensions: [{ name: "files" }, { name: "reviewer" }],
            tools: [{ name: "read" }],
            cwd: worktree,
          },
        })
        const agent = yield* reviewer.agent
        expect(agent.model).toEqual({ provider: "faux", modelId: "small" })
        expect(agent.extensions.map((extension) => extension.name)).toEqual(["files", "reviewer"])
        expect(agent.tools.map((tool) => tool.name)).toEqual(["read"])
        expect(agent.cwd).toBe(worktree)

        yield* ask(reviewer, "Review user.ts.")
        // Every request went to the reviewer's model with its role and only `read`.
        expect(requests.map((request) => request.modelId)).toEqual(["small", "small", "small"])
        for (const request of requests) {
          expect(toolsOffered(request.messages)).toEqual(["read"])
          expect(sectionsShown(request.messages).role).toContain("You review diffs.")
        }
        // `read` ran in the reviewer's checkout, and the loop asked once more after the answer with findings left.
        const { messages } = yield* reviewer.context()
        const results = messages.flatMap((message) => (message.role === "toolResult" ? [message] : []))
        expect(results.map((result) => result.content)).toEqual([text("export const name = (user) => user.name;\n")])
        const users = messages.flatMap((message) => (message.role === "user" ? [message.content] : []))
        expect(users).toEqual(["Review user.ts.", nudge])
        const answers = messages.flatMap((message) =>
          message.role === "assistant" && textOf(message) !== "" ? [textOf(message)] : [],
        )
        expect(answers).toEqual(["1. `name` does not handle a missing user.", `2. \`user\` has no type. ${DONE}`])
      }),
    )
  })

  test("mode-sandbox: each conversation's tools work in the sandbox its creating commit recorded, and a conversation without one gets no environment", async () => {
    // Which sandbox a conversation runs in. A fork gets none until the app assigns one.
    const Sandbox = defineDoc<{ path?: string }>({
      kind: "app.sandbox",
      version: 1,
      scope: "conversation",
      history: "latest",
      fork: "initial",
      initial: () => ({}),
      checkpointWhen: () => false,
    })
    const registry = createRegistry()
    registry.install(Files)
    const note = (content: string) =>
      fauxAssistantMessage(fauxToolCall("write", { path: "note.txt", content }), { stopReason: "toolUse" })

    await run(
      Effect.gen(function* () {
        const { harness } = yield* openApp({
          registry,
          // Committed reads only: a conversation without a sandbox gets no environment, so its tools fail cleanly.
          env: ({ conversationId, read }) =>
            Effect.map(read.snapshot(Sandbox, conversationId), (sandbox) =>
              sandbox?.path === undefined ? undefined : new LocalExecutionEnv({ cwd: sandbox.path }),
            ),
          responses: [
            note("from alice"),
            fauxAssistantMessage("Saved."),
            note("from bob"),
            fauxAssistantMessage("Saved."),
            note("from the fork"),
            fauxAssistantMessage("Could not save."),
          ],
        })
        const model = { provider: "faux", modelId: "faux-1" }
        // Each user's conversation gets a fresh sandbox in its creating commit.
        const conversationFor = (user: string) =>
          Effect.gen(function* () {
            const path = directory(`nisse-sandbox-${user}-`)
            const conversation = yield* harness.createConversation({
              ownership: { kind: "ownerless" },
              agent: { model },
              init: (tx, id) =>
                Effect.map(tx.doc(Sandbox, id), (sandbox) => {
                  sandbox.path = path
                }),
            })
            return { conversation, path }
          })

        const alice = yield* conversationFor("alice")
        const bob = yield* conversationFor("bob")
        yield* ask(alice.conversation, "Leave a note.")
        yield* ask(bob.conversation, "Leave a note.")
        expect(readFileSync(join(alice.path, "note.txt"), "utf8")).toBe("from alice")
        expect(readFileSync(join(bob.path, "note.txt"), "utf8")).toBe("from bob")

        const latest = (yield* alice.conversation.entries({}, 1)).items[0]!
        const fork = yield* alice.conversation.fork(latest.id, { ownership: { kind: "ownerless" } })
        expect((yield* harness.session.snapshot(Sandbox, fork.id))?.path).toBeUndefined()
        yield* ask(fork, "Leave a note.")
        const results = (yield* fork.context()).messages.flatMap((message) =>
          message.role === "toolResult" ? [message] : [],
        )
        expect(results.at(-1)).toMatchObject({ isError: true, content: text("No environment.") })
        expect(readFileSync(join(alice.path, "note.txt"), "utf8")).toBe("from alice")
      }),
    )
  })
})
