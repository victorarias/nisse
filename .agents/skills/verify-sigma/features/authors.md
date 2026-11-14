# Authors

Every call that changes a conversation names who made it, so the transcript
says who did what, whichever client did it. An author is two strings the
client chooses, `{"id", "name"}`: Sigma stores both on the change's entry,
shows the name, and never interprets either. The TUI and `sigma exec` act as
the author they were started with, which a program that starts them for
someone, such as attn, sets; otherwise as the system's user.

## Sub-features

- `author-every-change` records the author of `conversation/start`,
  `conversation/submit`, `conversation/interrupt`, `submission/withdraw`,
  `conversation/compact`, `conversation/continue`, `conversation/fork`,
  `conversation/select_model`, `conversation/reset`,
  `conversation/configure` and `approval/resolve` on a committed entry:
  `sigma.started`, `sigma.user`, `sigma.interrupted`, `sigma.withdrawn`,
  `pi.compaction` (or the `/compact` input's `sigma.user` on Claude),
  `sigma.continued`, the fork's own `sigma.forked`, `sigma.model`,
  `pi.reset`, `sigma.configured` and `sigma.approval`, each with
  `"author": {"id", "name"}`.
- `author-launch` makes the TUI and `exec` act as `SIGMA_AUTHOR_ID` and
  `SIGMA_AUTHOR_NAME`, each falling back to the system's user name, and the
  TUI draws each act under that name: `ERIKA` over a prompt,
  `◆ erika started the conversation`, `◆ erika interrupted`,
  `◆ erika continued`, `◆ erika forked the conversation here`,
  `◆ erika withdrew a queued prompt`, `◆ erika compacted the context`.

## How to get to it

### People

- Start `sigma` with `SIGMA_AUTHOR_ID` and `SIGMA_AUTHOR_NAME` set, then act
  in the TUI: type a prompt, `Esc`, `/continue`, `/withdraw`, `/compact`,
  `/fork`, `/model`, `/reset`, `/instructions`, `/max-turns`, `^Y` or `^N`.

### Agents

- Pass `author` to any of the calls above on the home's socket.
- Run `sigma exec` with `SIGMA_AUTHOR_ID` and `SIGMA_AUTHOR_NAME` set.

## Driving it with drive.ts

Preconditions:

- A fresh run whose script is
  `[{"text": "checking", "tool": {"name": "bash", "input": {"command": "echo held"}}}, {"text": "checking again", "tool": {"name": "bash", "input": {"command": "echo held"}}}, {"text": "done"}]`.

- **TUI as someone.** Run
  `SIGMA_AUTHOR_ID=person:p-7k3f9m SIGMA_AUTHOR_NAME=Erika drive.ts r tui start -c shared`,
  `drive.ts r tui wait READY`, `drive.ts r tui type go`,
  `drive.ts r tui key Enter`, `drive.ts r tui wait 'allow this call?'`,
  `drive.ts r tui key Escape`, `drive.ts r tui wait READY`,
  `drive.ts r tui type /continue`, `drive.ts r tui key Enter`,
  `drive.ts r tui wait 'allow this call?'`, `drive.ts r tui key C-y`,
  `drive.ts r tui wait done`, `drive.ts r tui screen erika`:
  `◆ erika started the conversation`, `ERIKA` over `go`, `◆ erika interrupted`
  over the run's `◆ interrupted`,
  `◆ erika continued`, `✓ allowed by erika`, and no `ADA`.
- **Exec as someone.** `SIGMA_AUTHOR_ID=person:p-bo SIGMA_AUTHOR_NAME=Bo drive.ts r sigma exec -c e1 hello`,
  then `drive.ts r watch e1`: `sigma.started` and `sigma.user` hold Bo's author.
- **Committed.** `drive.ts r watch shared --save authors`: every entry the
  screen named holds `"author": {"id": "person:p-7k3f9m", "name": "Erika"}`.
- **Two people on the wire.** With the TUI open, run
  `drive.ts r rpc conversation/fork '{"conversation": "shared", "at": <last entry id>, "author": {"id": "person:p-bo", "name": "Bo"}}'`
  and `drive.ts r watch <fork id>`, the number the fork answers: the fork's last entry is `sigma.forked`
  with Bo's author, after the entries it inherits with Erika's.

## Tests

Wire, `packages/sigma/test/wire.test.ts`:

- author-every-change: two people steer one conversation, and its committed entries name who made each change

Screen, `packages/sigma/test/screen.test.ts`:

- author-launch: a TUI started for someone sends as them, by the name shown and the id the transcript keeps

## Gotchas

- `drive.ts` runs the TUI as `USER=ada`, so without `SIGMA_AUTHOR_*` its
  author is `{"id": "ada", "name": "ada"}`.
- An interrupt of an idle conversation is still recorded: it names who asked,
  and no `sigma.run_end` follows it.
- A withdrawal an interrupt or a failed run made names no author; the
  `sigma.interrupted` entry or the run's end says what happened.
- A compaction that found nothing to summarize commits nothing, so it names
  no one.
