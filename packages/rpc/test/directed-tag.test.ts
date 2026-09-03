import { fromUTF } from '@sozai/codec'
import { describe, expect, test } from 'vitest'

import {
  DIRECTED_TAG_VERSION,
  decodeDirectedPayload,
  encodeDirectedPayload,
  isLegacyDirectedPayload,
} from '../src/directed-tag.js'

describe('directed-tag codec', () => {
  test('round-trips protocol and frame', () => {
    const frame = new Uint8Array([1, 2, 3, 4])
    const encoded = encodeDirectedPayload('chat', frame)
    expect(encoded[0]).toBe(DIRECTED_TAG_VERSION)
    const decoded = decodeDirectedPayload(encoded)
    expect(decoded.protocol).toBe('chat')
    expect(decoded.frame).toEqual(frame)
  })

  test('recovers a protocol name containing arbitrary characters exactly', () => {
    const name = 'app/v1:room-42'
    const decoded = decodeDirectedPayload(encodeDirectedPayload(name, new Uint8Array([9])))
    expect(decoded.protocol).toBe(name)
  })

  test('recovers an empty frame and a multibyte protocol name', () => {
    const name = 'café/協定'
    const decoded = decodeDirectedPayload(encodeDirectedPayload(name, new Uint8Array(0)))
    expect(decoded.protocol).toBe(name)
    expect(decoded.frame.length).toBe(0)
  })

  test('rejects a legacy JSON frame by its version marker', () => {
    const legacy = fromUTF(JSON.stringify({ v: 1, sessionID: 's', seq: 0, kind: 'message' }))
    expect(legacy[0]).not.toBe(DIRECTED_TAG_VERSION)
    expect(isLegacyDirectedPayload(legacy)).toBe(true)
    expect(() => decodeDirectedPayload(legacy)).toThrow()
  })

  test('encoder rejects a protocol name exceeding the uint16 length', () => {
    const tooLong = 'x'.repeat(65536)
    expect(fromUTF(tooLong).length).toBeGreaterThan(0xffff)
    expect(() => encodeDirectedPayload(tooLong, new Uint8Array(1))).toThrow(
      /length|65535|tag limit/i,
    )
  })

  test('decoder rejects a truncated header', () => {
    expect(() => decodeDirectedPayload(new Uint8Array([DIRECTED_TAG_VERSION, 0]))).toThrow()
  })

  test('decoder rejects a length that overruns the buffer', () => {
    // VERSION, len=10, but only 2 name bytes follow
    const bad = new Uint8Array([DIRECTED_TAG_VERSION, 0, 10, 65, 66])
    expect(() => decodeDirectedPayload(bad)).toThrow()
  })

  test('decoder rejects a non-well-formed-UTF-8 protocol slice', () => {
    // VERSION, len=1, 0xff is not valid UTF-8
    const bad = new Uint8Array([DIRECTED_TAG_VERSION, 0, 1, 0xff, 42])
    expect(() => decodeDirectedPayload(bad)).toThrow()
  })
})
