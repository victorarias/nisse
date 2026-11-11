import { NisseRpcs, PROTOCOL_VERSION } from "@nisse/protocol"
import { Schema } from "effect"
import type * as Rpc from "effect/rpc/Rpc"
import type * as RpcGroup from "effect/rpc/RpcGroup"
import * as RpcSchema from "effect/rpc/RpcSchema"

/** The JSON Schema of the protocol clients speak to the server. */
export const protocolSchema = () => groupSchema(NisseRpcs, "Nisse protocol", PROTOCOL_VERSION)

const groupSchema = <R extends Rpc.AnyWithProps>(group: RpcGroup.RpcGroup<R>, title: string, protocol: number) => {
  const definitions: Record<string, unknown> = {}
  const document = (schema: Schema.Top) => {
    const doc = Schema.toJsonSchemaDocument(schema)
    Object.assign(definitions, doc.definitions)
    return doc.schema
  }
  const methods: Record<string, unknown> = {}
  for (const [name, rpc] of group.requests) {
    const stream = RpcSchema.isStreamSchema(rpc.successSchema)
    const success = stream ? (rpc.successSchema as unknown as { success: Schema.Top }).success : rpc.successSchema
    const error = stream ? (rpc.successSchema as unknown as { error: Schema.Top }).error : rpc.errorSchema
    methods[name] = {
      params: document(rpc.payloadSchema),
      result: document(success),
      error: document(error),
      stream,
    }
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title,
    protocol,
    methods,
    $defs: definitions,
  }
}
