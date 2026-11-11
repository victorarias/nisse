// A provider kind: one way to reach models, such as ChatGPT, Claude Code or the script. Each instance a home names is
// opened from its kind with that instance's settings, and answers how it is signed in, which models it has, and how
// to sign in and out. An instance whose conversations the harness runs also gives the `Provider` behind the `Models`
// seam; Claude Code runs its own loop and gives none.
import { Effect, Schema, type Scope } from "effect"
import type { Provider } from "./models.ts"

export type ProviderStatus = "ready" | "signed_out" | "unavailable"

export interface Health {
  readonly status: ProviderStatus
  readonly version?: string
  /** Who it is signed in as, and on what plan. */
  readonly account?: string
  /** Why it is not ready, or what to do about it. */
  readonly message?: string
}

export interface ModelInfo {
  readonly id: string
  readonly name: string
  readonly description?: string
  /** The reasoning efforts it takes, least first. */
  readonly efforts: ReadonlyArray<string>
  readonly defaultEffort?: string
  readonly contextWindow?: number
}

/**
 * browser: a browser on the server's machine signs in and calls back to it. device_code: any device signs in with a
 * short code. terminal: the provider's own sign-in command runs in a terminal on the server's machine.
 */
export type SignInMethod = "browser" | "device_code" | "terminal"

export type SignInInteraction =
  | { readonly _tag: "browser"; readonly url: string }
  | { readonly _tag: "device_code"; readonly url: string; readonly code: string }
  | {
      readonly _tag: "terminal"
      readonly command: ReadonlyArray<string>
      readonly env: { readonly [name: string]: string }
    }

export type SignInResponse =
  | { readonly _tag: "callback"; readonly url: string }
  | { readonly _tag: "terminal_exited"; readonly success: boolean }

/** How a sign-in reaches the person: what to show them, and what they answered. */
export interface SignInFlow {
  readonly show: (interaction: SignInInteraction) => Effect.Effect<void>
  readonly response: Effect.Effect<SignInResponse>
}

export class ProviderError extends Schema.TaggedError<ProviderError>()("ProviderError", { message: Schema.String }) {}

/** What every instance answers, whatever runs its conversations. */
export interface ProviderAccount {
  /** The kind it was opened from: the `driver` a home's config names. */
  readonly kind: string
  /** What a selection naming no model gets; absent when the provider picks. */
  readonly defaultModel?: string
  readonly health: (refresh: boolean) => Effect.Effect<Health>
  /** Best first. */
  readonly models: (refresh: boolean) => Effect.Effect<ReadonlyArray<ModelInfo>>
  /** The first one preferred; empty when there is nothing to sign in to. */
  readonly signInMethods: ReadonlyArray<SignInMethod>
  readonly signIn: (method: SignInMethod, flow: SignInFlow) => Effect.Effect<void, ProviderError>
  readonly signOut: Effect.Effect<void, ProviderError>
}

export interface ProviderInstance extends ProviderAccount {
  /** The name conversations select it by, such as `openai-work`. */
  readonly id: string
  /** The `Models` seam's provider for this instance, named by `id`; absent when the provider runs its own loop. */
  readonly provider?: Provider
}

export interface ProviderKind<Settings> {
  readonly kind: string
  readonly open: (id: string, settings: Settings) => Effect.Effect<ProviderInstance, never, Scope.Scope>
}

export const nothingToSignIn = {
  signInMethods: [],
  signIn: () => Effect.fail(new ProviderError({ message: "there is nothing to sign in to" })),
  signOut: Effect.fail(new ProviderError({ message: "there is nothing to sign out of" })),
} satisfies Pick<ProviderAccount, "signInMethods" | "signIn" | "signOut">
