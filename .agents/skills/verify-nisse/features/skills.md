# Instructions and skills

An OpenAI conversation is told the `AGENTS.md` files and the skills of its
directory. A skill is a folder with a `SKILL.md`, found under `.agents/skills`
and `.claude/skills` from the conversation's directory up to the repository's
root, then under `NISSE_HOME/skills`; the nearest skill of a name wins.
`skills/list` answers which skills a conversation can name. A message that
starts with `/name`, or holds `$name`, carries that skill's `SKILL.md` in its
committed `user` entry, and every TUI shows `with <name>, ...` under the
message. Claude Code reads its own `CLAUDE.md` files and skills, so Claude and
scripted conversations list none and carry none.

## Sub-features

- `skills-list` answers a conversation's skills, sorted by name, each with its
  `name`, `description` and `path`; `[]` for `claude` and `script`;
  `NoSuchConversation` for an unknown id.
- `skills-found` looks in `.agents/skills` and `.claude/skills` of each folder
  from the conversation's directory up to the folder holding `.git`, then in
  `NISSE_HOME/skills`. A directory outside any repository looks only in itself
  and the home.
- `skills-nearest` keeps the nearest skill of a name: a deeper folder before a
  shallower one, `.agents` before `.claude` in one folder, the project before
  the home.
- `skills-frontmatter` takes `name` and `description` from the `SKILL.md`
  frontmatter, folding a `>` or `|` description into one line and unquoting a
  quoted one; without a `name` the folder names the skill, and without a
  `description` it is `""`.
- `skills-attach` carries every skill a message names, once each, in the
  order named, as `"skills": [{"name", "path", "text"}]` on the `user` entry:
  `/name` only at the message's start, `$name` anywhere. Trailing `.` or `:`
  is not part of the name, and a name nisse does not know carries nothing.
- `skills-snapshot` keeps the `SKILL.md` text as it was when the message was
  placed; editing the file later changes later messages only.
- `skills-tui` shows `with <name>, <name>` under the message in every TUI and
  after a reopen.
- `agents-md` tells ChatGPT `NISSE_HOME/AGENTS.md`, then the `AGENTS.md` (or
  `AGENTS.override.md` instead) of each folder from the repository's root down
  to the conversation's directory, up to 32 KiB in all, then the skill list.
  Only a ChatGPT run shows it.

## How to get to it (user POV)

- Put skills in `<repo>/.agents/skills/<name>/SKILL.md`,
  `<repo>/.claude/skills/<name>/SKILL.md`, the same under any folder between
  the repository's root and the conversation's directory, or
  `NISSE_HOME/skills/<name>/SKILL.md`.
- Put instructions in `NISSE_HOME/AGENTS.md` and in `AGENTS.md` or
  `AGENTS.override.md` in the repository's folders.
- In an OpenAI conversation, type a message that starts with `/name` or holds
  `$name`, in the TUI, `nisse exec` or `conversation/submit`.
- Call `skills/list` with `{"conversation": "<id>"}`.
- The TUI has no skill completion or listing; `skills/list` is the list.

## Driving it with drive.ts

Preconditions:

- A fresh run. Listing skills and carrying them needs no sign-in: the `user`
  entry is committed before the run fails `not signed in to ChatGPT`.
- `agents-md` and a carried skill reaching the model need a ChatGPT sign-in,
  as [OpenAI](./openai.md) says. Without one they are not verified.
- A project at `/tmp/nisse-verify/r/project`, made before the drive:

  ```sh
  P=/tmp/nisse-verify/r/project H=/tmp/nisse-verify/r/home
  mkdir -p $P/.git $P/app/.agents/skills/deploy $P/.agents/skills/deploy $P/.agents/skills/bare $P/.claude/skills/review $H/skills/notes $H/skills/review
  printf -- '---\nname: deploy\ndescription: Ship the app from the root\n---\nRoot deploy steps.\n' > $P/.agents/skills/deploy/SKILL.md
  printf -- '---\nname: deploy\ndescription: Ship the app folder\n---\nApp deploy steps.\n' > $P/app/.agents/skills/deploy/SKILL.md
  printf -- '---\nname: review\ndescription: >\n  Review a change\n  line by line\n---\nProject review steps.\n' > $P/.claude/skills/review/SKILL.md
  printf -- '---\nname: review\ndescription: Home review\n---\nHome review.\n' > $H/skills/review/SKILL.md
  printf -- '---\ndescription: "Take notes"\n---\nNotes steps.\n' > $H/skills/notes/SKILL.md
  printf 'no frontmatter\n' > $P/.agents/skills/bare/SKILL.md
  ```

- **List.** Run `drive.ts r serve`, then
  `drive.ts r rpc conversation/start '{"cwd": "/tmp/nisse-verify/r/project/app", "provider": "openai"}'`
  and `drive.ts r rpc skills/list '{"conversation": "<id>"}'`: `bare` with
  `"description": ""`, `deploy` `Ship the app folder` from
  `project/app/.agents/skills`, `notes` `Take notes` from `home/skills`, and
  `review` `Review a change line by line` from `project/.claude/skills`, in
  that order. With `"conversation": "nope"` it exits 1 with
  `NoSuchConversation`.
- **None for script or Claude.** Start the same with `"provider": "script"`,
  and again with `"provider": "claude"`: `skills/list` answers `[]` for both.
  Starting a Claude conversation runs nothing.
- **Carry over the wire.** Run
  `drive.ts r watch <openai id> --submit '/deploy now, then $review and $notes, $deploy again, $missing' --until run_end --save carried`:
  the `user` entry holds `"skills"` with `deploy` (`App deploy steps.`),
  `review` and `notes`, once each, then a `run_end` `failed` with
  `not signed in to ChatGPT`. Submit `please /review this, cost is $5`: the
  entry has no `skills`. Submit `  /deploy.`: it carries `deploy`.
- **Snapshot.** Change `App deploy steps.` in
  `project/app/.agents/skills/deploy/SKILL.md` to `Changed deploy steps.`,
  submit `/deploy` again, then `drive.ts r watch <id> --save reread`: the
  first entries still carry `App deploy steps.`, the new one
  `Changed deploy steps.`.
- **Script carries nothing.** `watch <script id> --submit '/deploy now' --until run_end`:
  the `user` entry has no `skills`, and the answer is `You said: /deploy now`.
- **TUI.** The TUI's conversation runs in the checkout, whose
  `.agents/skills` holds `verify-nisse`. Run
  `drive.ts r tui start --provider openai`, `drive.ts r tui wait READY`,
  `drive.ts r tui type '/verify-nisse check the queue, with $maintain-verification-skill'`,
  `drive.ts r tui key Enter`, `drive.ts r tui wait 'not signed in to ChatGPT'`,
  `drive.ts r tui screen skill`: `ADA` over the message, then
  `with verify-nisse, maintain-verification-skill`, then the failure. Take the
  id from `drive.ts r tui stop`; `tui start --conversation <id>` and
  `tui wait 'with verify-nisse'` show it again.
- **Instructions, signed in.** Write `Always end a reply with the word heron.`
  to `/tmp/nisse-verify/r/home/AGENTS.md` and `The code word is egret.` to
  `/tmp/nisse-verify/r/project/AGENTS.md`, then
  `drive.ts r rpc conversation/start '{"cwd": "/tmp/nisse-verify/r/project/app", "provider": "openai"}'`
  and `drive.ts r watch <id> --submit 'What is the code word? Answer in one sentence.' --until run_end --timeout 120000 --save agents-md`:
  the `message` names `egret` and ends with `heron`. Add
  `/tmp/nisse-verify/r/project/AGENTS.override.md` with
  `The code word is ibis.` and ask again: `ibis`. Every file is read at each
  run, so no restart is needed.
- **Skill reaches the model, signed in.** Submit
  `/deploy What does the deploy skill say? Quote it.`: the answer quotes
  `deploy steps.` Submit `Which skills can you use? List their names.`: the
  answer names `bare`, `deploy`, `notes` and `review`.

## Gotchas

- Skills come from the server's view of the conversation's `cwd`, which is
  the directory the TUI or `exec` ran in, or `cwd` on `conversation/start`.
  `drive.ts` runs the TUI and `nisse` in the checkout.
- The repository's root is the nearest folder above the `cwd` with a `.git`
  file or folder, so a worktree counts. Without one only the `cwd` itself is
  searched.
- A message of exactly `/model` opens the model list in the TUI; name a skill
  called `model` with `$model`.
- Skills are matched when the message is placed, not when it is queued, and
  on the conversation's provider at that moment: in a conversation switched
  from `script` to `openai`, messages before the switch carry nothing and
  messages after it carry their skills.
- `with ...` is the only thing the TUI draws of a skill; the skill's text is in
  the committed entry, seen with `watch`.
