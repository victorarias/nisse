# Images

People and tools attach images; large ones are prepared off the server's line, and a model without image input still works.

## Sub-features

- `image-input` [kernel] Images in user input (R245-305): A person attaches a screenshot
- `image-tool-result` [kernel] Images in tool results (R279, §7.3): Tools show pictures to the model
- `image-worker` [kernel] Image preparation in a worker, node variant (R245-305, `images/node`): Large photos get resized without blocking the server
- `image-placeholder` [kernel] Placeholder for a model without image input (R245-305): Switching to such a model still works
- `image-attach` The client path for Image attachments in the TUI and wire (R245-305): People send images from a client

## How to get to it

### People

- In the TUI on the kernel, drop an image file on the terminal, which pastes
  its path, or type the path, anywhere in the prompt. PNG, JPEG, GIF, WebP
  and BMP files attach, by absolute path, a path relative to the
  conversation's folder, `~/`, a quoted or backslash-escaped path, or a
  `file://` URL. The prompt shows `attaching <names>` under the text before
  Enter, and the message shows `with <names>` under it after. The text is
  sent as written, path included.
- `nisse "<prompt naming an image file>"` and `nisse exec "<prompt naming an
image file>"` on the kernel attach the same way, relative paths read from
  the current folder; an image the server refuses exits 1 with its reason.

### Agents

- Call `conversation/submit` with `images`: `[{name, data, mimeType}]`, `data`
  the file's bytes in base64. The server prepares each image to the model's
  limits (2000x2000 pixels and 4.5 MiB of base64 unless the model says
  otherwise), resizing or converting it, places them after the text, and
  names them in the user entry's `images`. An image it cannot decode or make
  fit refuses the whole input with `UnreadableImage` naming it.

## Driving it with drive.ts

Preconditions: a run made with `drive.ts r up --kernel --fake-openai text_answer`,
and a PNG at `/tmp/nisse-verify/r/Screen Shot.png` (any screenshot; a space in
the name checks the escaping).

- **Attach.** Run `drive.ts r tui start --provider openai`, `drive.ts r tui wait READY`,
  `drive.ts r tui type 'what is this? '`,
  `drive.ts r tui paste '/tmp/nisse-verify/r/Screen\ Shot.png'`,
  `drive.ts r tui wait 'attaching Screen Shot.png'` and
  `drive.ts r tui screen attaching`: the prompt holds the text and the path,
  with `attaching Screen Shot.png` under it.
- **Sent.** Press `Enter`, `drive.ts r tui wait READY`, `drive.ts r tui screen sent`:
  `ADA` over the text, `with Screen Shot.png` under it, then `NISSE` over
  `Hello there`. `evidence/fake-openai.ndjson` shows the request's user
  message as `input_text` then `input_image` with a `data:image/png;base64,`
  URL; its row is `differs` only in that input.
- **Committed.** `drive.ts r rpc conversation/list` for the `<id>`, then
  `drive.ts r watch <id> --save attached`: the `nisse.user` entry's data has
  `images: ["Screen Shot.png"]` and its message an `image` block.
- **Refused.** `drive.ts r rpc conversation/submit '{"conversation": "<id>", "requestId": "bad-1", "author": "ada", "text": "look", "images": [{"name": "broken.png", "data": "bm9wZQ==", "mimeType": "image/png"}]}'`
  answers `UnreadableImage` naming `broken.png`, and nothing is added.
- **Exec.** `drive.ts r nisse exec "describe /tmp/nisse-verify/r/Screen\ Shot.png"`
  exits 0, and the newest conversation's `nisse.user` entry names
  `Screen Shot.png`.

## Sources

Feature ledger area O: spec §7.3; README Tools.

## Contexts

- **Provider.** ChatGPT gets each image as an `input_image`; Claude Code as an
  `image` block beside the text (`image-input`); a model without image input
  sees a placeholder (`image-placeholder`).
- **On the kernel only.** The shipping wire's `conversation/submit` takes no
  images, so the TUI without `--kernel` shows no `attaching` line.

## Tests

`bun run coverage` lists every id here with its test, its mapped upstream rows or its owning child.

## Gotchas

- The TUI reads the file when Enter is pressed, from the machine the TUI runs
  on, so a path names a file there, not on the server's machine.
- A path to a file that is not an image, or a `.png` that is something else,
  stays plain text: nothing shows under the prompt.
