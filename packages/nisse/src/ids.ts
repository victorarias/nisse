const alphabet = "0123456789abcdefghjkmnpqrstvwxyz"

export const newId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(10))
  let id = ""
  for (const byte of bytes) id += alphabet[byte & 31]
  return id
}
