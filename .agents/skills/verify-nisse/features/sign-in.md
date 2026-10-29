# Sign-in

Every client sees how each provider is signed in, and any of them can start,
follow, answer or cancel a sign-in. ChatGPT signs in through a browser that
calls back to port 1455, or a device code entered on any device; Claude Code
signs in with its own `claude auth login`, run in a terminal. The TUI's splash
lists the providers and `^L` signs in to a signed-out one; `nisse login` and
`nisse logout` do it from a shell. A provider has at most one sign-in at a
time, and every connection sees it end as `succeeded`, `failed` or
`cancelled`.

## Sub-features

- `signin-status` lists each provider as `ready` with its account,
  `signed_out`, or `unavailable` with why, in `providers/list` and the splash.
- `signin-browser` shows the address to open, in the TUI's
  `SIGN IN · <provider>` panel, from `nisse login`, or as a `browser`
  interaction, and listens on `127.0.0.1:1455` for the browser's answer.
- `signin-paste` takes the address a browser on another machine ended on,
  typed into the TUI's prompt, pasted into `nisse login`, or sent with
  `auth/respond`.
- `signin-refused` answers a callback for another sign-in with 400, and fails
  a sign-in the browser refused with `ChatGPT refused the sign-in: <reason>`.
- `signin-device-code` shows a URL and a code to enter on any device, with
  `--device-code`, over SSH, or `"method": "device_code"`.
- `signin-terminal` runs Claude Code's `claude auth login` in the terminal of
  the TUI or `nisse login`, then checks how Claude Code is signed in.
- `signin-cancel` ends a sign-in with `Esc` in the TUI, `^C` in `nisse login`,
  or `auth/cancel`, and frees the callback port.
- `signin-shared` gives a second `auth/start` the sign-in already running, and
  shows every sign-in to every `auth/watch`.
- `signout` signs out with `nisse logout <provider>` or `auth/logout`, cancels
  a sign-in still running for that provider, and tells every `auth/watch` with
  `"phase": "signed_out"`, so open TUIs show the provider signed out.
- `signin-cannot` refuses an unknown provider, one with nothing to sign in to,
  and a method the provider does not offer.
- `signin-real` finishes a ChatGPT or Claude sign-in and names the account.

## How to get to it (user POV)

- Open `nisse`: the splash lists the providers; press `^L` to sign in to the
  conversation's provider if it is signed out, else the first signed-out one.
  Paste an address into the prompt and press `⏎`; `Esc` cancels.
- Run `nisse login <provider>`, `nisse login openai --device-code`, or
  `nisse logout <provider>`.
- Call `providers/list`, `auth/start`, `auth/respond`, `auth/cancel`,
  `auth/logout`, and follow `auth/watch`.

## Driving it with drive.ts

Preconditions:

- A fresh run made with `drive.ts r up`, with no script; its Claude is the
  fake playing `models`. The steps that reach the real ChatGPT's sign-in
  pages need network access to `auth.openai.com`; **Device code, faked**
  needs none.
- For the Claude terminal steps, a fresh run made with
  `drive.ts r up --fake-claude terminal_sign_in`: its first probe finds
  Claude Code signed out, and its second finds `person@example.com`.

- **Status.** Run `drive.ts r tui start`, `drive.ts r tui wait 'signed out'`,
  `drive.ts r tui screen splash`: `● script ready`,
  `● claude person@example.com · Claude Max`, `○ openai signed out`, and
  `^L  sign in`. Run `drive.ts r rpc providers/list '{}'`: the same
  providers, `openai` with `"signIn": ["browser", "device_code"]` and
  `"health": {"status": "signed_out", "message": "not signed in to ChatGPT", ...}`,
  `claude` with `"signIn": ["terminal"]` and `"version": "2.1.310"`.
- **Browser, TUI.** With the splash showing, run `drive.ts r tui key C-l`,
  `drive.ts r tui wait 'paste the address'`, `drive.ts r tui screen sign-in`:
  `SIGN IN · openai`, `Open this address to sign in:`, the whole
  `https://auth.openai.com/oauth/authorize?...` address, the hint to paste
  the address the browser ends on, and `esc  cancel`. Run
  `drive.ts r watch-auth` and take `<state>` from the address's `state=`. Run
  `drive.ts r watch-auth --until failed --save refused &` and, once it prints
  the `waiting` state, `drive.ts r tui type 'http://localhost:1455/auth/callback?state=<state>&error=access_denied&error_description=pasted+refusal'`
  and `drive.ts r tui key Enter`. The watch ends with
  `"phase": "failed", "message": "ChatGPT refused the sign-in: pasted refusal"`.
  `drive.ts r tui wait 'try again'`: the panel stays, showing
  `✗ ChatGPT refused the sign-in: pasted refusal` over `^L  try again` and
  `esc  close`; no `ADA` message is sent, and the splash still shows
  `○ openai signed out`. This fails today: the panel shows `^L  try again`
  and `esc  close` but keeps the stale address and its hint, with no
  `✗` line.
- **Cancel, TUI.** Press `Escape` to close the failed panel, then `C-l`,
  `drive.ts r tui wait 'esc  cancel'`, `drive.ts r tui key Escape`,
  `drive.ts r tui wait --gone 'SIGN IN'`.
  `curl http://localhost:1455/auth/callback` is refused.
- **Over a transcript.** Send `hello`, wait for `You said: hello`, press
  `C-l` and wait for `another machine`: the panel shows the same lines as
  over the splash. `Escape` cancels it.
- **Browser, CLI.** Run `drive.ts r tui start login openai` and
  `drive.ts r tui wait 'paste the address'`: `Open this address to sign in:`
  and the address. Take `<state>` from `drive.ts r watch-auth`, then type the
  refused address above with this `<state>` and press `Enter`.
  `drive.ts r doctor` shows `tui      exited with 1`; `drive.ts r tui stop`
  shows
  `signing in to openai failed: ChatGPT refused the sign-in: pasted refusal`.
- **Browser, wire.** Run `drive.ts r serve`,
  `drive.ts r rpc auth/start '{"provider": "openai"}'`:
  `"phase": "starting"` and a `flow`. Run it again: the same `flow`, now
  `"phase": "waiting"` with the `browser` interaction. Run
  `curl -s -w ' %{http_code}' 'http://localhost:1455/auth/callback?code=x&state=forged'`:
  `This answer is for another sign-in.` and `400`. Run
  `drive.ts r watch-auth --until failed --save wire-refused &` and, once it
  prints the `waiting` state, `curl -s 'http://localhost:1455/auth/callback?state=<state>&error=access_denied&error_description=the+person+said+no'`:
  the page says `the person said no`, and the watch ends with
  `ChatGPT refused the sign-in: the person said no`.
- **Paste, wire.** Start another sign-in with
  `drive.ts r rpc auth/start '{"provider": "openai", "method": "browser"}'`,
  start `drive.ts r watch-auth --until failed --save paste-wire &`, take
  `<state>` from its `waiting` state, then
  `drive.ts r rpc auth/respond '{"provider": "openai", "flow": "<flow>", "response": {"_tag": "callback", "url": "<the refused address with this state>"}}'`:
  `{"accepted": true}`, and the watch ends with
  `ChatGPT refused the sign-in: pasted refusal`. The same call again answers
  `{"accepted": false}`.
- **Cancel, wire.** Start a sign-in, start
  `drive.ts r watch-auth --until cancelled --save cancelled &`, and run
  `drive.ts r rpc auth/cancel '{"provider": "openai", "flow": "<flow>"}'`:
  `{"accepted": true}`, the watch ends with `"phase": "cancelled"`, and port
  1455 refuses connections.
- **Device code.** Run
  `drive.ts r rpc auth/start '{"provider": "openai", "method": "device_code"}'`
  and `drive.ts r watch-auth --until waiting --timeout 20000`: a `device_code`
  interaction with `"url": "https://auth.openai.com/codex/device"` and a
  `code` such as `MD3S-URUKW`. Cancel it. Run
  `drive.ts r tui start login openai --device-code` and
  `drive.ts r tui wait --timeout 20000 'enter the code'`:
  `Open https://auth.openai.com/codex/device on any device and enter the code <code>`.
  With `drive.ts r watch-auth --until cancelled &` running, `drive.ts r tui stop`
  exits 130 and the watch ends `cancelled`.
- **Device code over SSH.** In a fresh run made the same way, run
  `SSH_CONNECTION='10.0.0.1 50000 10.0.0.2 22' drive.ts r tui start`, wait for
  `signed out`, press `C-l`, and `drive.ts r tui wait --timeout 20000 'enter the code'`:
  the `SIGN IN · openai` panel shows the device URL and the code. `Escape`
  cancels it. `drive.ts r tui stop`, then `drive.ts r tui start login openai`
  in the same run shows a device code without `--device-code`.
- **Device code, faked.** In a fresh run made with
  `drive.ts r up --fake-openai text_answer --openai-signed-out --openai-refreshes 1`,
  run `SSH_CONNECTION='10.0.0.1 50000 10.0.0.2 22' drive.ts r tui start`, wait for `○ openai signed out`, save
  `drive.ts r tui screen before`, and start
  `drive.ts r watch-auth --until succeeded --save device-code &`. Press
  `C-l` and `drive.ts r tui wait '● openai'`, then
  `drive.ts r tui screen signed-in`: the splash shows
  `● openai ada@example.com · ChatGPT Plus` and the panel is gone. The watch
  shows `starting`, `waiting` with a `device_code` interaction whose `code`
  is `ABCD-1234` and whose `url` is the fake's `/codex/device`, `verifying`,
  then `succeeded` with `"message": "ada@example.com · ChatGPT Plus"`.
  `ls -l /tmp/nisse-verify/r/home/auth/openai.json` is `-rw-------`, and
  `drive.ts r nisse exec --provider openai hello` prints `Hello there`, its
  request `as recorded`. In another fresh run made the same way,
  without `SSH_CONNECTION`, `drive.ts r tui start login openai --device-code` shows
  `Open http://127.0.0.1:<port>/codex/device on any device and enter the code ABCD-1234`,
  then `signed in to openai as ada@example.com · ChatGPT Plus`, exit 0.
- **Terminal, wire.** In a `terminal_sign_in` run, run `drive.ts r serve`
  and `drive.ts r rpc providers/list '{}'`: `claude` is `signed_out` with
  `not signed in to Claude Code`. Run
  `drive.ts r rpc auth/start '{"provider": "claude"}'` and
  `drive.ts r watch-auth --until waiting`: a `terminal` interaction whose
  `command` is the fake's path with `auth` and `login`. Answer it with
  `drive.ts r rpc auth/respond '{"provider": "claude", "flow": "<flow>", "response": {"_tag": "terminal_exited", "success": false}}'`:
  the sign-in fails with `` `claude auth login` did not finish ``. Start a
  second sign-in, follow it with
  `drive.ts r watch-auth --until succeeded --save terminal-wire &`, and
  answer it `"success": true`: it goes `verifying`, then `succeeded` with
  `"message": "person@example.com · Claude Max"`.
- **Terminal, CLI.** In a fresh `terminal_sign_in` run, run
  `drive.ts r tui start login claude` and
  `drive.ts r tui wait --timeout 20000 'signed in to claude'`;
  `drive.ts r tui stop` shows `fake claude auth login done` and
  `signed in to claude as person@example.com · Claude Max`, exit 0, and
  `evidence/fake-claude/log.ndjson` holds `{"auth":["login"]}`.
- **Sign out.** Write
  `{"access_token": "x.e30.y", "refresh_token": "stale", "expires_at_ms": 99999999999999, "account_id": "acct"}`
  to `/tmp/nisse-verify/r/home/auth/openai.json`, then run
  `drive.ts r nisse logout openai`: exit 0, stderr
  `signed out of openai: signed out`, and the file is gone.
  `drive.ts r rpc auth/logout '{"provider": "openai"}'` answers the provider
  with `"status": "signed_out"`.
  Write the file again, `drive.ts r tui start` and wait for `● openai`, then
  `drive.ts r nisse logout openai`: the TUI's splash turns to
  `○ openai signed out`, and `drive.ts r watch-auth` shows
  `"phase": "signed_out"` for `openai`.
- **Cannot.** `drive.ts r nisse login nope`: exit 1, stderr
  `no provider named nope; there are script, claude, openai`.
  `drive.ts r nisse login script`: exit 1, `script has nothing to sign in to`.
  `drive.ts r nisse logout nope`: `no provider named nope`.
  `drive.ts r nisse logout script`: `there is nothing to sign out of`.
  `drive.ts r rpc auth/start '{"provider": "openai", "method": "terminal"}'`:
  an error, `openai can't sign in by terminal`.

## Gotchas

- The TUI follows only the sign-in it started; another client's sign-in does
  not open its panel.
- A cancelled sign-in closes the TUI's panel. A failed one keeps it, showing
  `✗ <reason>` with `^L  try again` and `esc  close`.
- One browser sign-in listens on port 1455 at a time; a second, from another
  home, fails at once, and `watch-auth` in that home shows
  `could not listen on 127.0.0.1:1455 for the browser's answer (is another sign-in running?); ...`.
  `nisse login openai` there prints that failure and exits 1, and `^L` in
  that home's TUI shows it in the `SIGN IN · openai` panel.
- The splash, `providers/list`, `nisse login claude` and `nisse logout claude`
  run Claude Code: the fake, logging the logout as `{"auth":["logout"]}`,
  unless the run is `--real-claude`, where `nisse logout claude` runs your
  own `claude auth logout`.
- The TUI and `nisse login` use a device code when `SSH_CONNECTION` reaches
  them. Each tmux window gets the environment of the `drive.ts` command that
  opens it, so set `SSH_CONNECTION` on `tui start`, not on `up`.
- The fake ChatGPT grants a token only from `--openai-refreshes`, so a faked
  sign-in needs at least 1; with none it fails after `waiting` with
  `token exchange failed (400: invalid_grant)`.
- The server exits 30 s after its last client leaves even while a sign-in
  waits; keep a `watch-auth` or the TUI open.

## With a real account

Proves a sign-in finishes against the real services. Every step needs a
person at a browser or another device; the agent drives the commands and the
person signs in. Follow the skill's [Real accounts](../SKILL.md#real-accounts),
except that the provider starts signed out. Give every `tui wait` for the
person `--timeout 300000`, and keep `evidence/`.

- **ChatGPT, device code (needs a person).** Start with this one: it works
  wherever the person's browser runs. In a run made with plain
  `drive.ts r up`, run `drive.ts r serve` and
  `drive.ts r rpc providers/list '{}'`: `openai` is `signed_out`. Run
  `drive.ts r tui start login openai --device-code` and
  `drive.ts r tui wait --timeout 20000 'enter the code'`; the person opens
  `https://auth.openai.com/codex/device` on any device and enters the code
  the screen shows. `drive.ts r tui wait --timeout 300000 'signed in to openai'`
  and `drive.ts r tui stop`: `signed in to openai as <email> · ChatGPT <plan>`,
  exit 0. `ls -l /tmp/nisse-verify/r/home/auth/openai.json` is `-rw-------`,
  and a new `tui start` splash shows `● openai <email> · ChatGPT <plan>`.
  To keep this sign-in for other runs, copy that file now, as
  [Real accounts](../SKILL.md#real-accounts) says.
- **ChatGPT, browser (needs a person).** In the same run,
  `drive.ts r nisse logout openai`, then
  `drive.ts r tui start login openai` and
  `drive.ts r tui wait 'paste the address'`. The person opens the address
  and signs in. When their browser runs on this machine it calls back by
  itself. Otherwise the browser ends on an address starting
  `http://localhost:1455/auth/callback?`: the person sends it to you, and
  you run `drive.ts r tui type '<that address>'` and
  `drive.ts r tui key Enter`. Then
  `drive.ts r tui wait --timeout 300000 'signed in to openai'` and
  `drive.ts r tui stop` end the same way as the device-code step.

- **Claude, terminal (needs a person).** In a run made with
  `drive.ts r2 up --real-claude`, write
  `[providers.claude-alt]` with `driver = "claude"` and
  `config_dir = "/tmp/nisse-verify/r2/claude-alt"` to the home's
  `config.toml`, so the sign-in lands there and not in your own Claude Code.
  Run `drive.ts r2 serve` and `drive.ts r2 rpc providers/list '{}'`: `claude`
  is `ready` with your account, and `claude-alt` is `signed_out`. Where
  Claude Code is signed in by its environment, as in a hosted session,
  `claude-alt` is `ready` too; report that and skip this step. Run
  `drive.ts r2 tui start login claude-alt` and
  `drive.ts r2 tui wait --timeout 20000 http`: Claude Code's own sign-in asks
  for a browser and a pasted code. The person signs in and pastes the code:
  `signed in to claude-alt as <account>`, exit 0. To prove the cancel
  instead, press `drive.ts r2 tui key C-c C-c` (Claude Code's sign-in needs
  `^C` twice; `tui stop` presses it once): `drive.ts r2 tui stop` shows
  ``signing in to claude-alt failed: `claude auth login` did not finish``,
  exit 1.

Save each `tui stop` output and a `providers/list` after it in `evidence/`.
