export const color = {
  background: "#0B0817",
  panel: "#16122B",
  cyan: "#00F0FF",
  magenta: "#FF2E88",
  yellow: "#F3E600",
  violet: "#B46CFF",
  ink: "#E8E6FF",
  dim: "#8A86B8",
  faint: "#3D366E",
}

export const KeyCap = (props: { cap: string; what: string }) => (
  <box flexDirection="row" gap={1}>
    <text fg={color.cyan} bg={color.faint}>{` ${props.cap} `}</text>
    <text fg={color.dim}>{props.what}</text>
  </box>
)
