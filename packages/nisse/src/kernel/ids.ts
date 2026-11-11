// Conversation ids on the wire (D15). A conversation is named by the kernel's number, or by the id a client chose
// when it started it; `nisse.conversation_ids` maps each chosen id to its number, so a chosen id survives restarts and
// a second start with it answers with the same conversation.
import { type ConversationId, defineDoc, idFromNumber } from "@nisse/kernel"

export const ConversationIdsDoc = defineDoc<{ ids: Record<string, number> }>({
  kind: "nisse.conversation_ids",
  version: 1,
  scope: "session",
  initial: () => ({ ids: {} }),
  checkpointWhen: () => true,
})

/** A kernel number written in decimal: the id a conversation has when its client chose none. */
export const kernelNumber = (id: string): ConversationId | undefined =>
  /^[1-9][0-9]*$/.test(id) ? idFromNumber<ConversationId>(Number(id)) : undefined

/**
 * Why a client may not choose `id`, or `undefined` when it may. A number would read as a kernel number, and an empty
 * id names nothing.
 */
export const refusedChoice = (id: string): string | undefined =>
  id === ""
    ? "a chosen conversation id may not be empty"
    : /^[0-9]+$/.test(id)
      ? `a chosen conversation id may not be all digits, which name conversations by number: ${id}`
      : undefined
