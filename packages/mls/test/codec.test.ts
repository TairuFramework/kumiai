import { randomIdentity } from '@kokuin/token'
import { describe, expect, test } from 'vitest'

import { decodeClientState, encodeClientState, sanitizeRatchetTree } from '../src/codec.js'
import { createGroup } from '../src/group.js'

describe('sanitizeRatchetTree', () => {
  test('converts null entries to undefined', () => {
    const tree = [{ nodeType: 1, leaf: {} }, null, { nodeType: 2, parent: {} }] as Array<unknown>
    const result = sanitizeRatchetTree(tree)
    expect(result).toEqual([{ nodeType: 1, leaf: {} }, undefined, { nodeType: 2, parent: {} }])
    expect(result[1]).toBeUndefined()
  })

  test('preserves undefined entries', () => {
    const tree = [{ nodeType: 1, leaf: {} }, undefined] as Array<unknown>
    const result = sanitizeRatchetTree(tree)
    expect(result).toEqual([{ nodeType: 1, leaf: {} }, undefined])
    expect(result[1]).toBeUndefined()
  })

  test('handles empty tree', () => {
    const result = sanitizeRatchetTree([])
    expect(result).toEqual([])
  })

  test('handles tree with no blank nodes', () => {
    const nodes = [
      { nodeType: 1, leaf: {} },
      { nodeType: 2, parent: {} },
    ] as Array<unknown>
    const result = sanitizeRatchetTree(nodes)
    expect(result).toEqual(nodes)
  })
})

describe('encodeClientState / decodeClientState', () => {
  test('round trip preserves the state', async () => {
    const alice = randomIdentity()
    const { group } = await createGroup(alice, 'codec-round-trip')

    const encoded = encodeClientState(group.state)
    const decoded = decodeClientState(encoded)

    expect(decoded).toBeDefined()
    expect(encoded[0]).toBe(1)
    expect(decoded?.groupContext.groupId).toEqual(group.state.groupContext.groupId)
  })

  test('refuses a blob whose version byte is not 1, even though the rest decodes fine', async () => {
    const alice = randomIdentity()
    const { group } = await createGroup(alice, 'codec-unknown-version')

    const encoded = encodeClientState(group.state)
    expect(encoded[0]).toBe(1) // sanity: this really is a v1 blob before we tamper with it

    const tampered = encoded.slice()
    tampered[0] = 2

    // Not merely falsy: this must be the version guard rejecting the blob before it ever
    // reaches the decoder, not an incidental decode failure. The payload after byte 0 is
    // untouched and would decode fine at v1 — so a decoder that ignored the version byte
    // would succeed here. It must not.
    const result = decodeClientState(tampered)
    expect(result).toBeUndefined()
  })
})
