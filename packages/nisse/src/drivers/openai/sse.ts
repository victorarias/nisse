export async function* events(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<unknown> {
  const reader = body.getReader()
  const cancel = () => void reader.cancel().catch(() => undefined)
  signal.addEventListener("abort", cancel, { once: true })
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n")
      let boundary: number
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n")
        if (data !== "" && data !== "[DONE]") yield JSON.parse(data)
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel)
    reader.releaseLock()
  }
}
