import type { AuthState, ModelSelection, ProviderModels, ProviderSnapshot } from "@nisse/protocol"
import { useTerminalDimensions } from "@opentui/solid"
import { For, Show } from "solid-js"
import { color, KeyCap } from "./theme.tsx"

export interface Choice {
  readonly provider: string
  readonly model: string | undefined
  readonly name: string
  readonly efforts: ReadonlyArray<string>
}

export interface Picker {
  readonly choices: ReadonlyArray<Choice>
  row: number
  effort: number
}

export interface SetupView {
  providers: Array<ProviderSnapshot>
  signIn: AuthState | undefined
  picker: Picker | undefined
}

export const emptySetup = (): SetupView => ({ providers: [], signIn: undefined, picker: undefined })

export const modelLabel = (model: ModelSelection) =>
  [model.provider, model.model, model.effort].filter((part) => part !== undefined).join(" · ")

export const choicesOf = (lists: ReadonlyArray<ProviderModels>): Array<Choice> =>
  lists.flatMap((list) => [
    ...(list.defaultModel === undefined
      ? [{ provider: list.provider, model: undefined, name: "its own choice", efforts: [] }]
      : []),
    ...list.models.map((model) => ({
      provider: list.provider,
      model: model.id,
      name: model.name,
      efforts: model.efforts,
    })),
  ])

export const pickerAt = (choices: ReadonlyArray<Choice>, current: ModelSelection | undefined): Picker => {
  const row = Math.max(
    0,
    choices.findIndex((choice) => choice.provider === current?.provider && choice.model === current?.model),
  )
  const effort = current?.effort === undefined ? 0 : (choices[row]?.efforts.indexOf(current.effort) ?? -1) + 1
  return { choices, row, effort: Math.max(0, effort) }
}

export const chosen = (picker: Picker): ModelSelection | undefined => {
  const choice = picker.choices[picker.row]
  if (!choice) return undefined
  const effort = picker.effort === 0 ? undefined : choice.efforts[picker.effort - 1]
  return {
    provider: choice.provider,
    ...(choice.model === undefined ? {} : { model: choice.model }),
    ...(effort === undefined ? {} : { effort }),
  }
}

const statusText = (provider: ProviderSnapshot) => {
  const health = provider.health
  switch (health.status) {
    case "ready":
      return health.account ?? "ready"
    case "signed_out":
      return "signed out"
    default:
      return health.message ?? "unavailable"
  }
}

export const ProviderList = (props: { providers: ReadonlyArray<ProviderSnapshot> }) => {
  const width = () => Math.max(0, ...props.providers.map((provider) => provider.id.length))
  return (
    <box flexDirection="column" marginTop={1} alignItems="flex-start">
      <For each={props.providers}>
        {(provider) => (
          <box flexDirection="row" gap={1}>
            <text fg={provider.health.status === "ready" ? color.cyan : color.yellow}>
              {provider.health.status === "ready" ? "●" : "○"}
            </text>
            <text fg={color.ink}>{provider.id.padEnd(width())}</text>
            <text fg={color.dim}>{statusText(provider)}</text>
          </box>
        )}
      </For>
      <Show when={props.providers.some((provider) => provider.health.status === "signed_out")}>
        <box marginTop={1}>
          <KeyCap cap="^L" what="sign in" />
        </box>
      </Show>
    </box>
  )
}

export const SignInPanel = (props: { state: AuthState }) => {
  const interaction = () => props.state.interaction
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={color.yellow}
      title={` SIGN IN · ${props.state.provider} `}
      titleColor={color.yellow}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      <Show when={interaction()} fallback={<text fg={color.dim}>{`${props.state.phase}…`}</text>}>
        {(shown) => {
          const now = shown()
          switch (now._tag) {
            case "browser":
              return (
                <box flexDirection="column">
                  <text fg={color.ink}>Open this address to sign in:</text>
                  <text fg={color.cyan}>{now.url}</text>
                  <text fg={color.dim}>
                    A browser on another machine can't reach this one: paste the address it ends on and press ⏎.
                  </text>
                </box>
              )
            case "device_code":
              return (
                <box flexDirection="column">
                  <text fg={color.ink}>{`Open ${now.url} on any device and enter the code`}</text>
                  <text fg={color.yellow}>{now.code}</text>
                </box>
              )
            case "terminal":
              return <text fg={color.dim}>{`running ${now.command.join(" ")}…`}</text>
          }
        }}
      </Show>
      <KeyCap cap="esc" what="cancel" />
    </box>
  )
}

const PICKER_CHROME = 12

export const ModelPicker = (props: { picker: Picker }) => {
  const dimensions = useTerminalDimensions()
  const window = () => {
    const rows = Math.max(1, dimensions().height - PICKER_CHROME)
    const first = Math.max(0, Math.min(props.picker.row - Math.floor(rows / 2), props.picker.choices.length - rows))
    return { first, shown: props.picker.choices.slice(first, first + rows) }
  }
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={color.cyan}
      title=" MODEL "
      titleColor={color.cyan}
      flexDirection="column"
      flexGrow={1}
      paddingLeft={1}
      paddingRight={1}
    >
      <For each={window().shown}>
        {(choice, index) => {
          const selected = () => window().first + index() === props.picker.row
          const effort = () =>
            !selected() || choice.efforts.length === 0
              ? ""
              : ` ‹ ${props.picker.effort === 0 ? "default" : choice.efforts[props.picker.effort - 1]} ›`
          return (
            <text fg={selected() ? color.background : color.ink} bg={selected() ? color.cyan : color.background}>
              {` ${choice.provider} · ${choice.name}${effort()} `}
            </text>
          )
        }}
      </For>
      <box flexDirection="row" gap={2} marginTop={1}>
        <KeyCap cap="↑↓" what="model" />
        <KeyCap cap="←→" what="effort" />
        <KeyCap cap="⏎" what="switch" />
        <KeyCap cap="esc" what="close" />
      </box>
    </box>
  )
}
