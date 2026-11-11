# Reopen and resume

Quitting the TUI prints the command that reopens the conversation, and
reopening shows the same transcript. A client that loses its connection
resubscribes from the last commit it saw and misses nothing.

## Sub-features

- `reopen-hint` prints `resume with: nisse --conversation <id>` on `^C`.
- `reopen-tui` reopens the conversation with its transcript.
- `reopen-continue` continues a reopened conversation with a new prompt.
- `resume-since` resubscribes with `sinceSeq` and gets only later commits.
- `chosen-id` [pending tui-views] opens the TUI on an id that names no conversation yet, starting
  one with that id, and sends a prompt given on the command line; `nisse exec --conversation <id>` does the
  same. On the kernel `exec` does; the TUI waits for tui-views.

## How to get to it

### People

- Press `^C` in the TUI, then run `nisse --conversation <id>`, or `nisse -c <id>`.

### Agents

- Run `nisse exec --conversation <id> '<prompt>'`, or `-c <id>`.
- Call `conversation/subscribe` with `sinceSeq`.
- Run `nisse --conversation <new id> '<prompt>'`, as attn does.

## Driving it with drive.ts

Preconditions:

- A fresh run with no script.

- **Quit.** Run `drive.ts r tui start`, `drive.ts r tui wait READY`,
  `drive.ts r tui type 'remember me'`, `drive.ts r tui key Enter`,
  `drive.ts r tui wait 'You said: remember me'`, `drive.ts r tui wait READY`,
  `drive.ts r tui stop`. The
  printed screen holds `resume with: nisse --conversation <id>` and ends with
  `Pane is dead (status 0, ...)` over `[exited 0]`.
- **Reopen.** Run `drive.ts r tui start --conversation <id>`,
  `drive.ts r tui wait 'You said: remember me'`,
  `drive.ts r tui screen reopened`. The same transcript, `READY`.
- **Continue.** Run `drive.ts r nisse exec --conversation <id> again`. Exit 0,
  stdout `You said: again`, and the reopened TUI shows the new exchange
  without a restart: `drive.ts r tui wait 'You said: again'`.
- **Resume.** Run `drive.ts r watch <id> --save before` and take the
  snapshot's `seq` (after the two exchanges here, 8). Run `drive.ts r nisse exec --conversation <id> later`,
  then `drive.ts r watch <id> --since <seq> --save since`. It delivers no
  snapshot, only the four commits for `later` (`enqueued`, the `user` entry,
  the `message` and the `run_end`), each with a `seq` above the one you took.
- **Chosen id.** Run `drive.ts r tui start --conversation picked-1 'first words'`,
  `drive.ts r tui wait 'You said: first words'`, `drive.ts r tui stop`: it
  prints `resume with: nisse --conversation picked-1`. Then
  `drive.ts r tui start --conversation picked-1`, `drive.ts r tui wait READY`,
  `drive.ts r tui screen chosen`: one `You said: first words`, nothing sent
  twice.
- **Chosen id, exec on the kernel.** In a fresh run made with
  `drive.ts r up --kernel`, run `drive.ts r nisse exec -c picked-1 'first words'`
  and `drive.ts r nisse exec -c picked-1 again`: `You said: first words`, then
  `You said: again`, each exit 0. `drive.ts r rpc conversation/list` shows one
  conversation, `"id": "picked-1"`, whose `ended.said` is `You said: again`.

## Contexts

- **Server restart.** A reopened conversation shows the same committed transcript.
- **On the kernel.** In a run made with `drive.ts r up --kernel`, the TUI speaks the kernel wire and every TUI step above drives the same way; a script names the kernel's tools in lower case, such as `bash` and `read`, so a call shows as `▸ bash(<command>)`.

## Tests

Kernel screen, `packages/nisse/test/kernel/screen.test.ts`, the TUI under `NISSE_KERNEL=1`:

- reopen-hint, reopen-tui: quitting prints the command that reopens the conversation, and it opens with its transcript

Kernel wire, `packages/nisse/test/kernel/wire.test.ts`, on a server under `NISSE_KERNEL=1`:

- reopen-continue: a conversation reopened from a new server and connection goes on with a new prompt

Kernel stack, `packages/nisse/test/kernel/stack.test.ts`, on a server under `NISSE_KERNEL=1`:

- start-with-id: a conversation opened on a client's id survives a restart, and a second start with it is answered
- chosen-id: nisse exec --conversation on the kernel starts a conversation with an id it does not name yet, and continues it
- reopen-continue: nisse exec --conversation on the kernel continues a conversation by the number it was given

Wire, `packages/nisse/test/wire.test.ts`:

- resume-since: a client resuming from a seq receives exactly the commits it missed

Screen, `packages/nisse/test/screen.test.ts`:

- reopen-hint: quitting prints the command that reopens the conversation
- start-with-id: a launcher opens nisse on an id it chose with a first prompt, and that id reopens the conversation

## Gotchas

- The hint is printed after the TUI leaves the screen, so it is not on the
  last screen. `tui stop` prints and saves everything the TUI left in the
  terminal, hint included.
- A client that falls 4096 commits behind is dropped with `FellBehind` and
  resubscribes with `sinceSeq`. `drive.ts` cannot pause a `watch` to fall
  behind, so this is guarded by the wire test "a client that stops reading is
  dropped while the others keep up" in `packages/nisse/test/wire.test.ts`;
  run it with `bun test packages/nisse/test/wire.test.ts`.
- A snapshot's `seq` is that of the conversation's last commit. Commit `seq`
  numbers are counted across the home, so one conversation's commits can skip
  numbers.
