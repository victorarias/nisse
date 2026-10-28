import { NisseRpcs, PROTOCOL_VERSION } from "@nisse/protocol"
import { Schema } from "effect"
import * as RpcSchema from "effect/rpc/RpcSchema"

export const protocolSchema = () => {
  const definitions: Record<string, unknown> = {}
  const document = (schema: Schema.Top) => {
    const doc = Schema.toJsonSchemaDocument(schema)
    Object.assign(definitions, doc.definitions)
    return doc.schema
  }
  const methods: Record<string, unknown> = {}
  for (const [name, rpc] of NisseRpcs.requests) {
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
    title: "Nisse protocol",
    protocol: PROTOCOL_VERSION,
    methods,
    $defs: definitions,
  }
}
