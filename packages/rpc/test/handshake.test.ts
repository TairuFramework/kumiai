import { describe, expect, test } from 'vitest'

import {
  decodeHandshakeFrame,
  encodeHandshakeFrame,
  HANDSHAKE_KIND,
  HANDSHAKE_MAGIC,
  HANDSHAKE_VERSION,
} from '../src/handshake.js'

describe('handshake frame codec', () => {
  test('round-trips each kind with its payload', () => {
    for (const kind of Object.values(HANDSHAKE_KIND)) {
      const payload = new Uint8Array([1, 2, 3, kind])
      const decoded = decodeHandshakeFrame(encodeHandshakeFrame(kind, payload))
      expect(decoded.kind).toBe(kind)
      expect(Array.from(decoded.payload)).toEqual([1, 2, 3, kind])
    }
  })

  test('frames lead with magic, version, then the kind tag', () => {
    const frame = encodeHandshakeFrame(HANDSHAKE_KIND.commit, new Uint8Array([9]))
    expect(frame[0]).toBe(HANDSHAKE_MAGIC[0])
    expect(frame[1]).toBe(HANDSHAKE_MAGIC[1])
    expect(frame[2]).toBe(HANDSHAKE_VERSION)
    expect(frame[3]).toBe(HANDSHAKE_KIND.commit)
    expect(frame.length).toBe(5)
  })

  test('the kinds are distinct', () => {
    const kinds = Object.values(HANDSHAKE_KIND)
    expect(new Set(kinds).size).toBe(kinds.length)
  })

  test('an empty payload round-trips', () => {
    const decoded = decodeHandshakeFrame(
      encodeHandshakeFrame(HANDSHAKE_KIND.recoveryRequest, new Uint8Array()),
    )
    expect(decoded.kind).toBe(HANDSHAKE_KIND.recoveryRequest)
    expect(decoded.payload.length).toBe(0)
  })

  test('rejects a frame shorter than the header', () => {
    expect(() => decodeHandshakeFrame(new Uint8Array([0x45, 0x4b, 1]))).toThrow()
  })

  test('rejects a bad magic', () => {
    expect(() => decodeHandshakeFrame(new Uint8Array([0x00, 0x00, 1, 0, 9]))).toThrow(/magic/)
  })

  test('reports the version rather than throwing on one it does not know', () => {
    // Deliberately NOT a throw, and the one place this codec defers instead of refusing. The
    // right answer to an unreadable frame differs by lane — on the commit topic it is evidence
    // the group moved on and the peer heals, everywhere else it is dropped — and only the caller
    // knows which lane it is on. A decoder that threw here would decide for all of them, which
    // is how a version bump strands every old peer at a dead epoch.
    const decoded = decodeHandshakeFrame(
      new Uint8Array([HANDSHAKE_MAGIC[0], HANDSHAKE_MAGIC[1], 99, 0, 9]),
    )
    expect(decoded.version).toBe(99)
    expect(decoded.version).not.toBe(HANDSHAKE_VERSION)
  })

  test('a frame this build does read reports the current version', () => {
    const decoded = decodeHandshakeFrame(
      encodeHandshakeFrame(HANDSHAKE_KIND.commit, new Uint8Array([1])),
    )
    expect(decoded.version).toBe(HANDSHAKE_VERSION)
  })

  test('rejects an unknown kind tag', () => {
    expect(() =>
      decodeHandshakeFrame(
        new Uint8Array([HANDSHAKE_MAGIC[0], HANDSHAKE_MAGIC[1], HANDSHAKE_VERSION, 0xff, 1]),
      ),
    ).toThrow(/kind/)
  })
})
