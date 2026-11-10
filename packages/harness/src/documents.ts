// The provider-facing identity document the creation hook writes (spec 7.1). `pi.live`, `pi.inbox` and `pi.usage`
// live with the code that fills them: `live.ts`, `inbox.ts` and `usage.ts`.
import { defineDoc } from "@nisse/kernel"
import { uuidv7 } from "@nisse/models"

/** The provider-facing identity; every fork starts with a fresh one. */
export const ProviderDoc = defineDoc<{ sessionId: string }>({
  kind: "pi.provider",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ sessionId: uuidv7() }),
  checkpointWhen: () => true,
})
