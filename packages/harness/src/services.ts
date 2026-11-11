// What a phase or abort handler of a harness task gets beyond the kernel's `TaskRuntime` (spec 5.1): the conversation's
// agent, its hooks, settings, models, environment, context and conversations. The harness provides it per handler.
import type {
  AnyDocToken,
  ConversationId,
  DocumentWatch,
  DocValue,
  EntryId,
  InvocationEnded,
  ReadFailure,
  RewindableAddressArgs,
  DocAddressArgs,
  CommitError,
  ReadError,
  SubmissionId,
  Tx,
} from "@nisse/kernel"
import type { ExecutionEnv } from "@nisse/env"
import type { Models } from "@nisse/models"
import { Context, type Effect, type Scope } from "effect"
import type { RunOwner } from "./live.ts"
import type { AdmissionError, Submission } from "./submissions.ts"
import type { Agent, ContextView, HookApi, Settings, SubmissionDraft } from "./types.ts"

/** Runs one handler of the hooks the task's conversation selects for the task's name. */
export interface HookRunner {
  /**
   * Calls `invoke` with each selected extension's handler `name`, in extension order. A handler that fails is reported
   * as its extension's `extension_error` and the next one runs; once the invocation is signalled, a failure propagates.
   */
  each<H>(name: string, invoke: (handler: H) => Effect.Effect<void, unknown>): Effect.Effect<void, unknown>
}

/** Whose code a reported failure came from, when it is not the task's own. */
export type ReportFrom =
  | { readonly kind: "extension"; readonly extension?: string }
  | { readonly kind: "host"; readonly callback: string }

/**
 * A conversation as a task holds it: its operations fail with `InvocationEnded` once the invocation ended; work they
 * admitted stays durable.
 */
export interface ConversationHandle {
  readonly id: ConversationId
  /** Admits a submission, as `Conversation.submit` does; the handle's operations are bound to the invocation too. */
  submit(draft: SubmissionDraft): Effect.Effect<Submission, InvocationEnded | AdmissionError | ReadError | CommitError>
  submit(tx: Tx, draft: SubmissionDraft): Effect.Effect<SubmissionId, InvocationEnded | AdmissionError | ReadError>
  /** Aborts the conversation's live work, as `Conversation.abort` does. */
  abort(options?: { readonly background?: boolean }): Effect.Effect<void, InvocationEnded | ReadFailure | CommitError>
  waitForIdle: Effect.Effect<void, InvocationEnded | ReadFailure>
}

export interface TaskApi {
  /** The task's conversation's agent, resolved at most once per handler, at first use, and fixed for the handler. */
  readonly agent: Effect.Effect<Agent, InvocationEnded | ReadFailure>
  /** The host's settings, resolved at each call. */
  settings(): Settings
  /** The host's models, read at each call. */
  models(): Models
  /** Builds the environment of the task's conversation; `undefined` without an environment builder. */
  readonly env: Effect.Effect<ExecutionEnv | undefined, unknown>
  /** Handlers of this task's name from the extensions its conversation selects. */
  readonly hooks: HookRunner
  /** What this task's hooks are called with. */
  readonly hookApi: HookApi
  /** The committed context of a conversation, optionally cut off at its visible entry `at`. */
  context(
    conversationId: ConversationId,
    options?: { readonly at?: EntryId },
  ): Effect.Effect<ContextView, InvocationEnded | ReadFailure>
  /** A rewindable document's value as of an entry (spec 3.3). */
  snapshotAsOf<K extends AnyDocToken>(
    token: K,
    ...address: RewindableAddressArgs<K>
  ): Effect.Effect<Readonly<DocValue<K>> | undefined, InvocationEnded | ReadFailure>
  /** Watches a document for as long as the scope and the invocation last (spec 9.2). */
  watchDoc<K extends AnyDocToken>(
    token: K,
    ...address: DocAddressArgs<K>
  ): Effect.Effect<DocumentWatch<DocValue<K>> | undefined, InvocationEnded | ReadFailure, Scope.Scope>
  /** A handle of an existing conversation, bound to this invocation; `undefined` when absent. */
  conversation(id: ConversationId): Effect.Effect<ConversationHandle | undefined, InvocationEnded | ReadFailure>
  /** The task's conversation and the host's `runEnded`, for the commit that ends a run. */
  readonly runOwner: RunOwner
  /** Forwards a non-fatal failure: the task's own `task_error`, or one of extension or host code it called. */
  report(error: unknown, from?: ReportFrom): void
}

/** The harness's services of one task handler. */
export class TaskServices extends Context.Service<TaskServices, TaskApi>()("@nisse/harness/TaskServices") {}
