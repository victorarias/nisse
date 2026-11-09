# Wire protocol

Every client speaks newline-delimited JSON-RPC 2.0 over the home's
`nisse.sock`. A new client starts from the schema Nisse prints and says hello
with `initialize`. A subscription whose client stops reading is ended so it can
never slow the server.

## Sub-features

- `wire-schema` [pending wire-complete] prints the protocol's JSON Schema and version.
- `wire-initialize` [pending wire-complete] answers a client with the server's version and protocol.
- `wire-malformed` [pending wire-complete] answers a call with missing fields with an error that names
  the field.
- `wire-dropped` ends a subscription that falls 4096 commits behind with a
  `FellBehind` error; the connection stays open.
- `wire-unknown` says so when a client subscribes to a conversation that does
  not exist.

## How to get to it

### People

- Run `nisse schema`.

### Agents

- Call `initialize` on the home's socket.
- Build a client from `schema/nisse.schema.json`.

## Driving it with drive.ts

Preconditions:

- A fresh run with no script.

- **Schema.** Run `drive.ts r nisse schema`: exit 0, and stdout is JSON titled
  `Nisse protocol` with its `protocol` number and `methods`. No server starts
  (`doctor` still shows `none running`), and the saved stdout, between
  `--- stdout` and `--- stderr`, is the same text as
  `schema/nisse.schema.json`.
- **Initialize.** Run `drive.ts r serve`, then
  `drive.ts r rpc initialize '{"client": "verify", "version": "1", "protocol": 8}'`:
  a result with the server's `version` and the `protocol` that `nisse schema`
  printed.
- **Malformed.** Run `drive.ts r rpc initialize '{"client": "verify"}'`: exit
  1, and an `error` with `"_tag": "Cause"` whose message says `Missing key` at
  `version`.
- **Proof.** Keep the saved `nisse schema` output and both `rpc` answers from
  `steps.log`.

## Tests

Wire, `packages/nisse/test/wire.test.ts`:

- wire-dropped: a client that stops reading is dropped while the others keep up
- wire-unknown: subscribing to a conversation that does not exist says so

## Gotchas

- `drive.ts` has no way to make a client stop reading, so `wire-dropped` is
  covered by its wire test only.
- `initialize` does not refuse a client that sends another protocol number; a
  client has to compare the answer itself. Nisse's own TUI and `exec` do not
  call `initialize`.
- A client handles `FellBehind` by subscribing again with `sinceSeq` set to the
  last commit it received. The socket does not close, so waiting for it to
  close never notices.
- After a protocol change, run `bun run schema` and commit
  `schema/nisse.schema.json`.
