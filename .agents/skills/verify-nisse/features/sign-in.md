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
- `signout` signs out with `nisse logout <provider>` or `auth/logout`.
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

- A fresh run with no script, and network access to `auth.openai.com`.
- For `signin-terminal` and the splash's Claude line: the run's server started
  without the session's Claude variables, as [Claude](./claude.md) says.
- For `signin-real`: a person with a ChatGPT account at the browser or device,
  or a signed-out Claude Code they can sign in. Without one, drive every
  journey up to the point where the person acts, and report the rest as not
  verified.

- **Status.** Run `drive.ts r tui start`, `drive.ts r tui wait 'signed out'`,
  `drive.ts r tui screen splash`: `● script ready`, `● claude <account>`,
  `○ openai signed out`, and `^L  sign in`. Run
  `drive.ts r rpc providers/list '{}'`: the same providers, `openai` with
  `"signIn": ["browser", "device_code"]` and
  `"health": {"status": "signed_out", "message": "not signed in to ChatGPT", ...}`,
  `claude` with `"signIn": ["terminal"]` and its `version`.
- **Browser, TUI.** With the splash showing, run `drive.ts r tui key C-l`,
  `drive.ts r tui wait 'paste the address'`, `drive.ts r tui screen sign-in`:
  `SIGN IN · openai`, `Open this address to sign in:`, the whole
  `https://auth.openai.com/oauth/authorize?...` address, the hint to paste
  the address the browser ends on, and `esc  cancel`. Run
  `drive.ts r watch-auth` and take `<state>` from the address's `state=`. Run
  `drive.ts r watch-auth --until failed --save refused &` and, once it prints
  the `waiting` state, `drive.ts r tui type 'http://localhost:1455/auth/callback?state=<state>&error=access_denied&error_description=pasted+refusal'`
  and `drive.ts r tui key Enter`. The watch ends with
  `"phase": "failed", "message": "ChatGPT refused the sign-in: pasted refusal"`,
  the panel goes away, no `ADA` message is sent, and the splash still shows
  `○ openai signed out`.
- **Cancel, TUI.** Press `C-l` again, `drive.ts r tui wait 'esc  cancel'`,
  `drive.ts r tui key Escape`, `drive.ts r tui wait --gone 'SIGN IN'`.
  `curl http://localhost:1455/auth/callback` is refused.
- **Over a transcript.** Send `hello`, wait for `You said: hello`, press
  `C-l` and wait for `another machine`: the panel shows the same lines as
  over the splash.
- **Browser, CLI.** Run `drive.ts r tui start login openai` and
  `drive.ts r tui wait 'paste the address'`: `Open this address to sign in:`
  and the address. Take `<state>` from `drive.ts r watch-auth`, then
  `drive.ts r tui type '<the refused address above>'` and
  `drive.ts r tui key Enter`. `drive.ts r doctor` shows
  `tui      exited with 1`; `drive.ts r tui stop` shows
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
  `"method": "browser"`, then
  `drive.ts r rpc auth/respond '{"provider": "openai", "flow": "<flow>", "response": {"_tag": "callback", "url": "<the refused address>"}}'`:
  `{"accepted": true}`, and a `watch-auth` started before it ends with
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
- **Device code over SSH.** In a fresh run, run
  `SSH_CONNECTION='10.0.0.1 50000 10.0.0.2 22' drive.ts r tui start`, wait for
  `signed out`, press `C-l`, and `drive.ts r tui wait --timeout 20000 'enter the code'`:
  the `SIGN IN · openai` panel shows the device URL and the code. `Escape`
  cancels it. `drive.ts r tui start login openai` in the same run shows a
  device code without `--device-code`.
- **Terminal, wire.** Run `drive.ts r rpc auth/start '{"provider": "claude"}'`
  and `drive.ts r watch-auth --until waiting`: a `terminal` interaction whose
  `command` is Claude Code's binary with `auth` and `login`. Answer it with
  `drive.ts r rpc auth/respond '{"provider": "claude", "flow": "<flow>", "response": {"_tag": "terminal_exited", "success": false}}'`:
  the sign-in fails with `` `claude auth login` did not finish ``. Answered
  `"success": true` in a second sign-in, it goes `verifying`, then
  `succeeded` with the account when Claude Code is signed in.
- **Terminal, CLI.** Run `drive.ts r tui start login claude` and
  `drive.ts r tui wait --timeout 20000 http`: Claude Code's own sign-in asks
  for a browser and a pasted code. Press `drive.ts r tui key C-c C-c`;
  `drive.ts r tui stop` shows
  ``signing in to claude failed: `claude auth login` did not finish``, exit 1.
- **Sign out.** Write
  `{"access_token": "x.e30.y", "refresh_token": "stale", "expires_at_ms": 99999999999999, "account_id": "acct"}`
  to `/tmp/nisse-verify/r/home/auth/openai.json`, then run
  `drive.ts r nisse logout openai`: exit 0, stderr
  `signed out of openai: signed out`, and the file is gone.
  `drive.ts r rpc auth/logout '{"provider": "openai"}'` answers the provider
  with `"status": "signed_out"`.
- **Cannot.** `drive.ts r nisse login nope`: exit 1, stderr
  `no provider named nope; there are script, claude, openai`.
  `drive.ts r nisse login script`: exit 1, `script has nothing to sign in to`.
  `drive.ts r nisse logout nope`: `no provider named nope`.
  `drive.ts r nisse logout script`: `there is nothing to sign out of`.
  `drive.ts r rpc auth/start '{"provider": "openai", "method": "terminal"}'`:
  an error, `openai can't sign in by terminal`.
- **Real sign-in.** A person opens the address from **Browser, CLI** and
  signs in: `signed in to openai as <email> · ChatGPT <plan>`, exit 0,
  `auth/openai.json` readable only by its owner, and the splash shows
  `● openai <email> · ChatGPT <plan>`. A device code entered on any device
  finishes the same way.

## Gotchas

- `tui stop` presses `^C` once; Claude Code's sign-in needs it twice.
- The TUI follows only the sign-in it started; another client's sign-in does
  not open its panel.
- A failed or cancelled sign-in closes the TUI's panel; the reason shows in
  `watch-auth`, not on the screen.
- One browser sign-in listens on port 1455 at a time; a second, from another
  home, fails at once, and `watch-auth` in that home shows
  `could not listen on 127.0.0.1:1455 for the browser's answer (is another sign-in running?); ...`.
- `nisse logout claude` runs `claude auth logout`: drive it only with
  `CLAUDE_CONFIG_DIR` set to a folder in the run.
- The server exits 30 s after its last client leaves even while a sign-in
  waits; keep a `watch-auth` or the TUI open.
