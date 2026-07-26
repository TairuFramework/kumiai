import { randomIdentity } from '@kokuin/token'
import { toB64 } from '@sozai/codec'
import { describe, expect, test } from 'vitest'

import { createKeyPackageBundle } from '../src/group.js'
import { decodeKeyPackage, encodeKeyPackage } from '../src/key-package-codec.js'

function fromEncoded(encoded: string): Uint8Array {
  return Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))
}

async function samplePackage() {
  const bundle = await createKeyPackageBundle(randomIdentity())
  return bundle.publicPackage
}

describe('encodeKeyPackage / decodeKeyPackage', () => {
  test('a round trip reproduces the key package structurally', async () => {
    const original = await samplePackage()
    const decoded = decodeKeyPackage(encodeKeyPackage(original))
    expect(decoded).toEqual(original)
  })

  test('encoding is deterministic for the same package', async () => {
    const original = await samplePackage()
    expect(encodeKeyPackage(original)).toBe(encodeKeyPackage(original))
  })

  /**
   * ts-mls's own `decode()` helper is `dec(t, 0)?.[0]` — it discards the consumed length, so
   * trailing garbage rides along silently and one logical package gains unlimited byte forms.
   * The codec calls the decoder directly to get that length back and compare it.
   */
  test('trailing bytes after a valid encoding are rejected', async () => {
    const original = await samplePackage()
    const bytes = new Uint8Array([...fromEncoded(encodeKeyPackage(original)), 0x00])
    expect(decodeKeyPackage(toB64(bytes))).toBeNull()
  })

  /**
   * Canonicality is a STRING-level property here, not just a byte-level one: the hub stores and
   * compares the string. `fromB64` trims surrounding whitespace, so without the canonical-form
   * check the same package has a second, equally-acceptable string form.
   */
  test('a whitespace-padded encoding is rejected', async () => {
    const original = await samplePackage()
    expect(decodeKeyPackage(`${encodeKeyPackage(original)}\n`)).toBeNull()
  })

  /** `fromB64` THROWS on a bad alphabet rather than returning a sentinel — decode must absorb it. */
  test('non-base64 input returns null rather than throwing', () => {
    expect(decodeKeyPackage('not base64 !!!')).toBeNull()
  })

  test('the empty string is rejected', () => {
    expect(decodeKeyPackage('')).toBeNull()
  })

  test('truncated TLS bytes are rejected', async () => {
    const original = await samplePackage()
    const bytes = fromEncoded(encodeKeyPackage(original))
    expect(decodeKeyPackage(toB64(bytes.subarray(0, bytes.length - 1)))).toBeNull()
  })
})
