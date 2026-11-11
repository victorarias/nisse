# Images

People and tools attach images; large ones are prepared off the server's line, and a model without image input still works.

## Sub-features

- `image-input` [kernel] Images in user input (R245-305): A person attaches a screenshot
- `image-tool-result` [kernel] Images in tool results (R279, §7.3): Tools show pictures to the model
- `image-worker` [kernel] Image preparation in a worker, node variant (R245-305, `images/node`): Large photos get resized without blocking the server
- `image-placeholder` [kernel] Placeholder for a model without image input (R245-305): Switching to such a model still works
- `image-attach` [pending tui-images] The client path for Image attachments in the TUI and wire (R245-305): People send images from a client

## How to get to it

### People

None yet.

### Agents

- Not reachable yet: `image-attach` lands with `tui-images`, which adds its entry point and recipe.

## Sources

Feature ledger area O: spec §7.3; README Tools.

## Tests

`bun run coverage` lists every id here with its test, its mapped upstream rows or its owning child.

## Gotchas

None recorded yet.
