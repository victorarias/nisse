# Wire protocol

Every client speaks newline-delimited JSON-RPC 2.0 over the home's
`nisse.sock`. A new client starts from the schema Nisse prints and says hello
with `initialize`. A watch whose client stops reading is ended so it can
never slow the server, and a client that hangs up, even mid-answer, just
leaves: the server logs no error for it.

## Sub-features

- `wire-schema` prints the protocol's JSON Schema and version.
- `wire-initialize` answers a client with the server's version and protocol.
- `wire-malformed` answers a call with missing fields with an error that names
  the field.
- `wire-dropped` ends a watch that leaves 4096 changes unread with a
  `FellBehind` error and its `limit`; the connection stays open.
- `wire-hangup` ends the connection of a client that hangs up while the
  server is still writing to it the way a clean close does: no error in the
  server's log, and other clients carry on.
- `wire-unknown` says so when a client watches a conversation that does not
  exist.

## How to get to it

### People

- Run `nisse schema`.

### Agents

- Call `initialize` on the home's socket.
- Build a client from `schema/nisse.schema.json`.

### Triggers

- A client closes its socket, as the TUI does when it quits, while the server
  is still sending it something.

## Driving it with drive.ts

Preconditions:

- A fresh run with no script.

- **Schema.** Run `drive.ts r nisse schema`: exit 0, and stdout is JSON titled
  `Nisse protocol` with its `protocol` number and `methods`. No server starts
  (`doctor` still shows `none running`), and the saved stdout, between
  `--- stdout` and `--- stderr`, is the same text as
  `schema/nisse.schema.json`.
- **Initialize.** Run `drive.ts r serve`, then
  `drive.ts r rpc initialize '{"client": "verify", "version": "1", "protocol": 1}'`:
  a result with the server's `version` and the `protocol` that `nisse schema`
  printed, `1`.
- **Malformed.** Run `drive.ts r rpc initialize '{"client": "verify"}'`: exit
  1, and an `error` whose message names `version`.
- **Hang up.** In a run made with `--script` whose one step is a long `text`
  with `"delayMs": 10` (400 words), run `drive.ts r serve`,
  `drive.ts r tui start`, `drive.ts r tui wait READY`, `drive.ts r tui type go`,
  `drive.ts r tui key Enter`, `drive.ts r tui wait word20`, then
  `drive.ts r tui stop` while the answer still streams, and
  `drive.ts r rpc server/stop --timeout 20000`. Save the server's window with
  `tmux -L nisse-verify-r capture-pane -p -J -S - -t serve`: it holds only
  `nisse 0.1.0 serving ...`, no `ERROR` line.
- **Proof.** Keep the saved `nisse schema` output and both `rpc` answers from
  `steps.log`, and the saved server window.

## Contexts

None.

## Tests

Wire, `packages/nisse/test/wire.test.ts`:

- wire-dropped: a client that stops reading is dropped while the others keep up
- wire-hangup: a client that hangs up while the server still writes to it is not logged as an error
- wire-unknown: watching a conversation that does not exist says so
- wire-initialize: a client is answered with the server's version and the protocol
- wire-malformed: a call missing a field is answered with an error that names it, and the connection goes on

Stack, `packages/nisse/test/stack.test.ts`:

- wire-schema: nisse schema prints the protocol's schema, the one committed beside the code
- answer-exec, wire-dropped: a nisse exec whose prompt waits, runs and ends while exec is dropped still prints the answer and exits 0
- answer-exec, wire-dropped: a nisse exec too slow for the run watches again when dropped, prints every call it missed, and exits 0

## Gotchas

- `drive.ts` has no way to make a client stop reading, so `wire-dropped` is
  covered by its wire test only.
- On macOS a TUI quitting mid-answer rarely makes the server write to a closed
  socket: it reads the hang-up first, so the **Hang up** drive is clean even
  without the fix. The `wire-hangup` tests make the server write after the
  client is gone, and are the proof that tells the two apart.
- `initialize` does not refuse a client that sends another protocol number; a
  client has to compare the answer itself. Nisse's own TUI and `exec` do not
  call `initialize`.
- A client handles `FellBehind` by watching again with `window.from` set to
  the entry after the last it holds. The socket does not close, so waiting
  for it to close never notices.
- After a protocol change, run `bun run schema` and commit
  `schema/nisse.schema.json`.
