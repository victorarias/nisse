# Reopen and resume

Quitting the TUI prints the command that reopens the conversation, and
reopening shows the same transcript. A client that loses its connection
watches again from the newest entry it held and misses nothing.

## Sub-features

- `reopen-hint` prints `resume with: sigma --conversation <id>` on `^C`.
- `reopen-tui` reopens the conversation with its transcript.
- `reopen-continue` continues a reopened conversation with a new prompt.
- `chosen-id` opens the TUI on an id that names no conversation yet, starting
  one with that id, and sends a prompt given on the command line; `sigma exec --conversation <id>` does the
  same.

## How to get to it

### People

- Press `^C` in the TUI, then run `sigma --conversation <id>`, or `sigma -c <id>`.

### Agents

- Run `sigma exec --conversation <id> '<prompt>'`, or `-c <id>`.
- Call `conversation/watch` with a `window` whose `from` is the newest entry the client holds.
- Run `sigma --conversation <new id> '<prompt>'`, as attn does.

## Driving it with drive.ts

Preconditions:

- A fresh run with no script.

- **Quit.** Run `drive.ts r tui start`, `drive.ts r tui wait READY`,
  `drive.ts r tui type 'remember me'`, `drive.ts r tui key Enter`,
  `drive.ts r tui wait 'You said: remember me'`, `drive.ts r tui wait READY`,
  `drive.ts r tui stop`. The
  printed screen holds `resume with: sigma --conversation <id>` and ends with
  `Pane is dead (status 0, ...)` over `[exited 0]`.
- **Reopen.** Run `drive.ts r tui start --conversation <id>`,
  `drive.ts r tui wait 'You said: remember me'`,
  `drive.ts r tui screen reopened`. The same transcript, `READY`.
- **Continue.** Run `drive.ts r sigma exec --conversation <id> again`. Exit 0,
  stdout `You said: again`, and the reopened TUI shows the new exchange
  without a restart: `drive.ts r tui wait 'You said: again'`.
- **Resume.** Run `drive.ts r watch <id> --save before` and take the `id` of
  the view's last entry, the `sigma.run_end` of `again`. Run
  `drive.ts r sigma exec --conversation <id> later`, then
  `drive.ts r watch <id> --from <entry id> --save since`. Its view's
  `entries` start at that entry, then hold `later`'s `sigma.user`,
  `pi.assistant` and `sigma.run_end`, and nothing earlier.
- **Chosen id.** Run `drive.ts r tui start --conversation picked-1 'first words'`,
  `drive.ts r tui wait 'You said: first words'`, `drive.ts r tui stop`: it
  prints `resume with: sigma --conversation picked-1`. Then
  `drive.ts r tui start --conversation picked-1`, `drive.ts r tui wait READY`,
  `drive.ts r tui screen chosen`: one `You said: first words`, nothing sent
  twice.
- **Chosen id, exec.** In a fresh run, run `drive.ts r sigma exec -c picked-1 'first words'`
  and `drive.ts r sigma exec -c picked-1 again`: `You said: first words`, then
  `You said: again`, each exit 0. `drive.ts r rpc conversation/list` shows one
  conversation, `"id": "picked-1"`, whose `ended.said` is `You said: again`.

## Contexts

- **Server restart.** A reopened conversation shows the same committed transcript.

## Tests

Wire, `packages/sigma/test/wire.test.ts`:

- reopen-continue: a conversation reopened from a new server and connection goes on with a new prompt

Screen, `packages/sigma/test/screen.test.ts`:

- reopen-hint, reopen-tui: quitting prints the command that reopens the conversation, and it opens with its transcript

Stack, `packages/sigma/test/stack.test.ts`:

- chosen-id: sigma exec --conversation starts a conversation with an id it does not name yet, and continues it
- reopen-continue: sigma exec --conversation continues a conversation by its number, and a chosen one keeps its id

## Gotchas

- The hint is printed after the TUI leaves the screen, so it is not on the
  last screen. `tui stop` prints and saves everything the TUI left in the
  terminal, hint included.
- A watch that leaves 4096 changes unread ends with `FellBehind`, and the
  client watches again from the newest entry it holds. `drive.ts` cannot
  pause a `watch` to fall behind, so this is guarded by the wire test
  `wire-dropped` in `packages/sigma/test/wire.test.ts`.
