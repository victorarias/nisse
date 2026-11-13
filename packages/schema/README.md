# @sigma/schema

JSON Schema compiler, coercion, formats, resolver and builders, copied from
pi-schema (`packages/schema/src`) in earendil-works/pi at commit `7d073328e`, under
the MIT license in `LICENSE`. `THIRD_PARTY_NOTICES` holds TypeBox's license for
the code under `src/formats/typebox`.

`src/tool.ts` is sigma's: `checkToolArguments` runs coercion and validation for
a tool call, and `projectParameters` turns an Effect Schema into the JSON Schema
a model is told. Effect callers pass `Schema.toStandardJSONSchemaV1(schema)`, so
the package itself imports nothing. Use `Schema.Finite` for numbers, and
`Schema.optionalKey` for optional fields: `Schema.optional` projects `null` as
allowed.
