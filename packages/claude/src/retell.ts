// What Claude Code is told of the conversation: the opening a fresh session gets, and what a resumed one missed after
// its position. Claude Code holds its own session, so whatever sigma committed that the session does not hold is told
// to it as text in the run's first message.
import type { EntryRecord } from "@sigma/kernel"
import type { ImageContent, Message } from "@sigma/models"

/** Opens a fresh session that a conversation with history joins, before that history. */
export const JOINING =
  "This Claude Code session joins a conversation it does not hold. This is the conversation so far; continue it."

/** About what a retelling of a long conversation keeps, besides its first prompt and the prompts being answered. */
export const RETOLD_CHARACTERS = 64_000

/** The result of a call a stop cut off, as sigma records it and Claude Code is told. */
export const INTERRUPTED = "interrupted; it may or may not have taken effect"

type Part = { readonly type: string; readonly text?: string }

/** One part of a message Claude Code is sent: a text, or an image a prompt carried. */
export type Said = string | ImageContent

/** A prompt as Claude Code is sent it: its text, then its images. */
export const promptOf = (content: unknown): Said[] => {
  const text = textOf(content)
  const images = Array.isArray(content) ? (content as ImageContent[]).filter((part) => part.type === "image") : []
  return [...(text === "" ? [] : [text]), ...images]
}

/** The text of a message's content: a string, or its text parts joined. */
export const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? (content as Part[]).map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("")
      : ""

const messagesOf = (entry: EntryRecord): readonly Message[] => (entry.model ?? []) as unknown as readonly Message[]

/**
 * What a resumed session missed: the entries after its position, as text. Prompts are told as they are; what Claude
 * wrote and sigma kept although the session lost it, and the results sigma recorded for calls the session holds no
 * result of, are told as cut off.
 */
export function unseen(entries: readonly EntryRecord[]): Said[] {
  return entries.flatMap((entry) =>
    messagesOf(entry).flatMap((message): Said[] => {
      switch (message.role) {
        case "user":
          return promptOf(message.content)
        case "assistant": {
          const text = textOf(message.content)
          return text === "" ? [] : [`You were cut off after writing: ${text}`]
        }
        case "toolResult":
          return [`Your ${message.toolName} call ${message.toolCallId} was cut off: ${textOf(message.content)}`]
        default:
          return []
      }
    }),
  )
}

type Told = { readonly text: string; readonly images?: readonly ImageContent[]; readonly asked: boolean }

/** Each message as the retelling says it; a call is told with its result, so results add nothing of their own. */
function told(messages: readonly Message[]): Told[] {
  const results = new Map<string, string>()
  for (const message of messages) {
    if (message.role === "toolResult") results.set(message.toolCallId, textOf(message.content))
  }
  return messages.flatMap((message): Told[] => {
    if (message.role === "user") {
      const [first, ...rest] = promptOf(message.content)
      if (first === undefined) return []
      const text = typeof first === "string" ? first : ""
      const images = [...(typeof first === "string" ? [] : [first]), ...rest] as ImageContent[]
      return [{ text, ...(images.length === 0 ? {} : { images }), asked: true }]
    }
    if (message.role !== "assistant") return []
    return message.content.flatMap((part): Told[] => {
      if (part.type === "text" && part.text !== "") return [{ text: `You answered: ${part.text}`, asked: false }]
      if (part.type !== "toolCall") return []
      const result = results.get(part.id) ?? "no result"
      return [
        { text: `You called ${part.name} with ${JSON.stringify(part.arguments)} and got: ${result}`, asked: false },
      ]
    })
  })
}

/**
 * The conversation so far, for a fresh session: its first prompt, then as many of the latest messages as fit in about
 * `RETOLD_CHARACTERS`, with how many were left out between them, then the prompts being answered.
 */
export function history(messages: readonly Message[]): Said[] {
  const items = told(messages)
  const current = items.findLastIndex((item) => !item.asked) + 1
  const asked = items.slice(current)
  const first = items.findIndex((item) => item.asked)
  if (first < 0 || first >= current) return items.flatMap(saidOf)
  const opening = items[first]!
  let room = RETOLD_CHARACTERS - opening.text.length - asked.reduce((total, item) => total + item.text.length, 0)
  let start = current
  while (start > first + 1) {
    const text = items[start - 1]!.text
    if (text.length > room) break
    room -= text.length
    start--
  }
  const kept = items.slice(start, current)
  const skipped = start - (first + 1)
  return [
    ...saidOf(opening),
    ...(skipped > 0 ? [`(${skipped} entries left out here)`] : []),
    ...kept.flatMap(saidOf),
    ...asked.flatMap(saidOf),
  ]
}

const saidOf = (item: Told): Said[] => [...(item.text === "" ? [] : [item.text]), ...(item.images ?? [])]
