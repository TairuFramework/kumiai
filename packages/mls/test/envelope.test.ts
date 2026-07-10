import { describe, expect, test } from 'vitest'

import {
  CONTROL_ENVELOPE_VERSION,
  type ControlEnvelope,
  type DecodeResult,
  decodeControlEnvelope,
  encodeControlEnvelope,
} from '../src/envelope.js'

/** Read the envelope out of a decode result, failing the test on a rejection. */
function expectAccepted(result: DecodeResult): ControlEnvelope {
  expect(result.ok).toBe(true)
  if (!result.ok) {
    throw new Error(`expected an accepted envelope, got rejection: ${result.reason}`)
  }
  return result.envelope
}

describe('control envelope', () => {
  test('a caller encodes, wires the bytes, and decodes back a usable envelope', () => {
    const envelope: ControlEnvelope = {
      v: 1,
      entries: ['a', 'b'],
      app: { recoverySecret: 'x' },
    }
    // The bytes ride in a commit's authenticatedData.
    const authenticatedData = encodeControlEnvelope(envelope)
    expect(authenticatedData).toBeInstanceOf(Uint8Array)

    // The commit policy asks "valid, and if so what entries" without a try/catch.
    const result = decodeControlEnvelope(authenticatedData)
    const decoded = expectAccepted(result)
    expect(decoded).toEqual(envelope)
  })

  test('round trips with no entries', () => {
    const cases: Array<ControlEnvelope> = [{ v: CONTROL_ENVELOPE_VERSION }, { v: 1, app: 'x' }]
    for (const envelope of cases) {
      const decoded = expectAccepted(decodeControlEnvelope(encodeControlEnvelope(envelope)))
      expect(decoded).toEqual(envelope)
    }
  })

  test('an encode of a bare version omits absent keys', () => {
    const json = new TextDecoder().decode(encodeControlEnvelope({ v: 1 }))
    expect(json).not.toContain('entries')
    expect(json).not.toContain('app')
    expect(json).not.toContain('null')
  })

  test('round trips entries without app, and app without entries', () => {
    const entriesOnly: ControlEnvelope = { v: 1, entries: ['x', 'y', 'z'] }
    expect(expectAccepted(decodeControlEnvelope(encodeControlEnvelope(entriesOnly)))).toEqual(
      entriesOnly,
    )

    const appOnly: ControlEnvelope = { v: 1, app: { any: ['nested', 42, true] } }
    expect(expectAccepted(decodeControlEnvelope(encodeControlEnvelope(appOnly)))).toEqual(appOnly)
  })

  test('empty authenticatedData decodes to a bare version, not a rejection', () => {
    const result = decodeControlEnvelope(new Uint8Array(0))
    expect(result).toEqual({ ok: true, envelope: { v: 1 } })
  })

  test('an unknown version rejects rather than throwing', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ v: 2, entries: ['a'] }))
    const result = decodeControlEnvelope(bytes)
    expect(result.ok).toBe(false)
  })

  test('garbage and wrong-shape JSON reject, never throw', () => {
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
    const rejected: Array<Uint8Array> = [
      new TextEncoder().encode('not json at all {'),
      new TextEncoder().encode(''.padEnd(4, '￿')),
      encode({}),
      encode({ v: 1, entries: 'x' }),
      encode({ v: 1, entries: [1, 2] }),
      encode({ v: 1, entries: ['ok', 3] }),
      encode(['a', 'b']),
      encode('a bare string'),
      encode(42),
      encode(null),
    ]
    for (const bytes of rejected) {
      const result = decodeControlEnvelope(bytes)
      expect(result.ok).toBe(false)
    }
  })

  test('app is opaque: an arbitrary nested value survives untouched', () => {
    const app = {
      nested: { deep: [1, { keep: 'me' }, null, false] },
      unicode: '❄️ 組合',
      number: -1.5,
    }
    const decoded = expectAccepted(decodeControlEnvelope(encodeControlEnvelope({ v: 1, app })))
    expect(decoded.app).toEqual(app)
  })

  test('decode never throws across a spread of malformed buffers', () => {
    const buffers: Array<Uint8Array> = [
      new Uint8Array(0),
      new Uint8Array([0]),
      new Uint8Array([0xff, 0xfe, 0xfd]),
      new Uint8Array([0x7b]),
      new Uint8Array([0x5b, 0x5b]),
      new TextEncoder().encode('{'),
      new TextEncoder().encode('{"v":'),
      new TextEncoder().encode('true'),
      new TextEncoder().encode('undefined'),
      new TextEncoder().encode('{"v":1,'),
      new Uint8Array(1024).fill(0x22),
    ]
    for (const bytes of buffers) {
      expect(() => decodeControlEnvelope(bytes)).not.toThrow()
      expect(typeof decodeControlEnvelope(bytes).ok).toBe('boolean')
    }
  })
})
