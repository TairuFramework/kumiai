import { fromUTF, toUTF } from '@sozai/codec'

/**
 * Format version of the directed-payload tag, AND the byte that tells a tagged frame from a
 * legacy one: legacy directed frames are `JSON.stringify` output (`hub-tunnel/frame.ts`), so they
 * begin with `{` or JSON leading whitespace — never `0x00`. The first byte alone disambiguates.
 */
export const DIRECTED_TAG_VERSION = 0x00

const VERSION_BYTES = 1
const LENGTH_BYTES = 2
const HEADER_BYTES = VERSION_BYTES + LENGTH_BYTES
const MAX_PROTOCOL_BYTES = 0xffff

/** Whether these bytes are NOT a tagged directed payload (empty, or a non-version leading byte). */
export function isLegacyDirectedPayload(bytes: Uint8Array): boolean {
  return bytes.length === 0 || bytes[0] !== DIRECTED_TAG_VERSION
}

/**
 * Prepend the authenticated protocol tag to a directed frame, to be sealed by `crypto.wrap`. The
 * fixed-width length makes the `protocol ‖ frame` split injective regardless of the name's bytes.
 */
export function encodeDirectedPayload(protocol: string, frame: Uint8Array): Uint8Array {
  const name = fromUTF(protocol)
  if (name.length > MAX_PROTOCOL_BYTES) {
    throw new Error(
      `encodeDirectedPayload: protocol name is ${name.length} bytes, exceeds the ${MAX_PROTOCOL_BYTES}-byte tag limit`,
    )
  }
  const out = new Uint8Array(HEADER_BYTES + name.length + frame.length)
  out[0] = DIRECTED_TAG_VERSION
  new DataView(out.buffer).setUint16(VERSION_BYTES, name.length, false)
  out.set(name, HEADER_BYTES)
  out.set(frame, HEADER_BYTES + name.length)
  return out
}

/**
 * Split a sealed directed payload into its protocol tag and inner frame. Throws on a legacy or
 * malformed buffer (a caller that must drop rather than throw checks {@link isLegacyDirectedPayload}
 * first). Never a partial read: an overrunning length or ill-formed UTF-8 name is rejected.
 */
export function decodeDirectedPayload(bytes: Uint8Array): { protocol: string; frame: Uint8Array } {
  if (bytes.length < HEADER_BYTES) {
    throw new Error('decodeDirectedPayload: buffer shorter than the tag header')
  }
  if (bytes[0] !== DIRECTED_TAG_VERSION) {
    throw new Error(`decodeDirectedPayload: unexpected version byte ${bytes[0]}`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const nameLength = view.getUint16(VERSION_BYTES, false)
  const frameStart = HEADER_BYTES + nameLength
  if (bytes.length < frameStart) {
    throw new Error('decodeDirectedPayload: protocol length overruns the buffer')
  }
  // `toUTF` is a fatal TextDecoder in this repo (fromUTF/toUTF wrap WHATWG codecs); ill-formed
  // UTF-8 throws here rather than yielding replacement chars.
  const protocol = toUTF(bytes.subarray(HEADER_BYTES, frameStart))
  return { protocol, frame: bytes.subarray(frameStart) }
}
