// Images a person attaches by naming them in the prompt. A terminal pastes a file dragged onto it as its path, quoted,
// with spaces escaped or as a file:// URL, so a path to an image file anywhere in the text, typed or pasted, attaches
// that file; the text is sent as written.
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { detectSupportedImageMimeType } from "@nisse/tools"
import type { Image } from "@nisse/protocol"

/** An image file the prompt names. */
export interface Attachment {
  readonly name: string
  readonly path: string
  readonly mimeType: string
}

const IMAGE_NAME = /\.(png|jpe?g|gif|webp|bmp)$/i
const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/
/** Enough of a file to tell its format: the detection reads at most BMP's header and PNG's first two chunks. */
const HEADER_BYTES = 64

/** The words of `text` much as a shell reads them: split on whitespace, with quotes and backslash escapes undone. */
export const words = (text: string): ReadonlyArray<string> => {
  const found: Array<string> = []
  let word: string | undefined
  let quote: string | undefined
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else word += char
    } else if ((char === "'" || char === '"') && word === undefined) {
      // Only a quote that starts a word opens one, so the apostrophe in "what's" is a letter.
      quote = char
      word = ""
    } else if (char === "\\" && i + 1 < text.length) {
      word = (word ?? "") + text[++i]
    } else if (/\s/.test(char)) {
      if (word !== undefined) found.push(word)
      word = undefined
    } else word = (word ?? "") + char
  }
  if (word !== undefined) found.push(word)
  return found
}

const pathOf = (word: string, cwd: string): string | undefined => {
  if (word.startsWith("file://")) {
    try {
      return fileURLToPath(word)
    } catch {
      return undefined
    }
  }
  if (word === "~" || word.startsWith("~/")) return resolve(homedir(), word.slice(2))
  return resolve(cwd, word)
}

const mimeTypeOf = (path: string): string | undefined => {
  try {
    if (!statSync(path).isFile()) return undefined
    const file = openSync(path, "r")
    try {
      const header = new Uint8Array(HEADER_BYTES)
      return detectSupportedImageMimeType(header.subarray(0, readSync(file, header)))
    } finally {
      closeSync(file)
    }
  } catch {
    return undefined
  }
}

/** The image files `text` names, each once, in order; relative paths are read from `cwd`. */
export const attachmentsIn = (text: string, cwd: string): ReadonlyArray<Attachment> => {
  const seen = new Set<string>()
  return words(text).flatMap((written) => {
    // A path typed at the end of a sentence carries its punctuation: "is /tmp/shot.png?"
    const word = written.replace(TRAILING_PUNCTUATION, "")
    const path = IMAGE_NAME.test(word) ? pathOf(word, cwd) : undefined
    if (path === undefined || seen.has(path)) return []
    const mimeType = mimeTypeOf(path)
    if (mimeType === undefined) return []
    seen.add(path)
    return [{ name: basename(path), path, mimeType }]
  })
}

/** The images `text` attaches, read now, as the wire sends them; a file gone since it was named is left out. */
export const imagesIn = (text: string, cwd: string): ReadonlyArray<Image> =>
  attachmentsIn(text, cwd).flatMap((attachment) => {
    try {
      const data = readFileSync(attachment.path).toString("base64")
      return [{ name: attachment.name, data, mimeType: attachment.mimeType }]
    } catch {
      return []
    }
  })
