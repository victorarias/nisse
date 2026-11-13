// JSON-RPC errors a client can read. Effect's JSON-RPC encoding takes an error's message from the failure it carries;
// a call that ends without one, as a defect does (params that do not decode, a method sigma lacks, a server bug), goes
// out with the whole cause as JSON in its message. This gives such an error the defect's own words; `data` keeps the
// cause.
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import { Layer } from "effect"

type EncodedCause = ReadonlyArray<{ readonly _tag: string; readonly defect?: unknown; readonly error?: unknown }>
type JsonRpcReply = { error?: { _tag?: string; message?: string; data?: unknown } }

const said = (value: unknown): string | undefined =>
  typeof value === "string"
    ? value
    : typeof value === "object" && value !== null && "message" in value && typeof value.message === "string"
      ? value.message
      : undefined

/** What went wrong, in the cause's own words. */
const readable = (cause: EncodedCause) =>
  cause
    .map((reason) =>
      reason._tag === "Interrupt"
        ? "the call was interrupted"
        : (said(reason.defect ?? reason.error) ??
          `the server failed: ${JSON.stringify(reason.defect ?? reason.error)}`),
    )
    .join("; ")

/** Gives `reply` a readable message when its error carries only a cause. */
const reword = (reply: JsonRpcReply) => {
  const error = reply.error
  if (error?._tag !== "Cause" || !Array.isArray(error.data)) return
  const failure = (error.data as EncodedCause).find((reason) => reason._tag === "Fail")
  if (said(failure?.error) !== undefined) return
  error.message = readable(error.data as EncodedCause)
}

// Only a frame that holds such an error is parsed again; every other frame goes out as it was encoded.
const rewordLines = (encoded: string) =>
  !encoded.includes('"_tag":"Cause"')
    ? encoded
    : encoded
        .split("\n")
        .map((line) => {
          if (!line.includes('"_tag":"Cause"')) return line
          const parsed = JSON.parse(line) as JsonRpcReply | Array<JsonRpcReply>
          for (const reply of Array.isArray(parsed) ? parsed : [parsed]) reword(reply)
          return JSON.stringify(parsed)
        })
        .join("\n")

/** Newline-delimited JSON-RPC, as `RpcSerialization.layerNdJsonRpc`, whose errors all say what went wrong. */
export const readableNdJsonRpc = Layer.succeed(RpcSerialization.RpcSerialization)(
  (() => {
    const inner = RpcSerialization.ndJsonRpc()
    return RpcSerialization.RpcSerialization.of({
      ...inner,
      makeUnsafe: () => {
        const parser = inner.makeUnsafe()
        return {
          decode: parser.decode,
          encode: (response) => {
            const encoded = parser.encode(response)
            return typeof encoded === "string" ? rewordLines(encoded) : encoded
          },
        }
      },
    })
  })(),
)
