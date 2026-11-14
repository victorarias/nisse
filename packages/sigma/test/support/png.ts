// PNG files to attach: a grey image of any size, encoded here so a test can ask for one past the model's limits.
import { deflateSync } from "node:zlib"

const chunk = (type: string, data: Uint8Array) => {
  const body = new Uint8Array([...new TextEncoder().encode(type), ...data])
  const out = new DataView(new ArrayBuffer(12 + data.length))
  out.setUint32(0, data.length)
  new Uint8Array(out.buffer).set(body, 4)
  out.setUint32(8 + data.length, Bun.hash.crc32(body))
  return new Uint8Array(out.buffer)
}

/** An 8-bit greyscale PNG of `width` by `height` pixels. */
export const png = (width: number, height: number): Uint8Array => {
  const header = new DataView(new ArrayBuffer(13))
  header.setUint32(0, width)
  header.setUint32(4, height)
  header.setUint8(8, 8) // bit depth
  header.setUint8(9, 0) // greyscale
  const rows = new Uint8Array((width + 1) * height)
  for (let y = 0; y < height; y++) rows.fill((y * 7) % 256, y * (width + 1) + 1, (y + 1) * (width + 1))
  return new Uint8Array([
    ...[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    ...chunk("IHDR", new Uint8Array(header.buffer)),
    ...chunk("IDAT", deflateSync(rows)),
    ...chunk("IEND", new Uint8Array()),
  ])
}
