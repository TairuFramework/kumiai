import { randomIdentity } from '@kokuin/token'
import { type ClientState, clientStateEncoder, defaultProposalTypes, encode } from 'ts-mls'
import { describe, expect, test } from 'vitest'

import { decodeClientState, encodeClientState, sanitizeRatchetTree } from '../src/codec.js'
import { createGroup } from '../src/group.js'

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function frameV2(
  body: Uint8Array,
  refs: Array<Uint8Array>,
  trailing = new Uint8Array(),
): Uint8Array {
  const bytes = new Uint8Array(
    9 + body.length + refs.reduce((length, ref) => length + 4 + ref.length, 0) + trailing.length,
  )
  const view = new DataView(bytes.buffer)
  bytes[0] = 2
  view.setUint32(1, body.length, false)
  bytes.set(body, 5)
  view.setUint32(5 + body.length, refs.length, false)
  let offset = 9 + body.length
  for (const ref of refs) {
    view.setUint32(offset, ref.length, false)
    bytes.set(ref, offset + 4)
    offset += 4 + ref.length
  }
  bytes.set(trailing, offset)
  return bytes
}

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
    expect(encoded[0]).toBe(2)
    expect(decoded?.groupContext.groupId).toEqual(group.state.groupContext.groupId)
  })

  test('the decoded state does not alias the encoded bytes', async () => {
    const { group } = await createGroup(randomIdentity(), 'codec-no-alias')
    const encoded = encodeClientState(group.state)
    const copy = encoded.slice()
    const decoded = decodeClientState(encoded)
    if (decoded == null) throw new Error('decode failed')

    // Decrypt zeroes consumed secrets in place; that must not reach bytes a host still holds.
    decoded.keySchedule.exporterSecret.fill(0)
    decoded.keySchedule.senderDataSecret.fill(0)

    expect(encoded).toEqual(copy)
  })

  test('refuses a blob whose version byte is not 2, even though the rest decodes fine', async () => {
    const alice = randomIdentity()
    const { group } = await createGroup(alice, 'codec-unknown-version')

    const encoded = encodeClientState(group.state)
    expect(encoded[0]).toBe(2)

    const tampered = encoded.slice()
    tampered[0] = 3

    // The intact payload must be refused by the version guard.
    expect(() => decodeClientState(tampered)).toThrow(
      'decodeClientState: unsupported client-state version 3',
    )
  })

  test('preserves zero one and absent senders through v2 and a sliced byte view', async () => {
    const { group } = await createGroup(randomIdentity(), 'codec-zero-senders')
    const state = group.state
    const proposal: ClientState['unappliedProposals'][string]['proposal'] = {
      proposalType: defaultProposalTypes.remove,
      remove: { removed: 0 },
    }
    state.unappliedProposals = {
      'AA==': { proposal, senderLeafIndex: 0 },
      'AQ==': { proposal, senderLeafIndex: 1 },
      'Ag==': { proposal, senderLeafIndex: undefined },
    }
    const original = structuredClone(state)
    const bytes = encodeClientState(state)
    const decoded = decodeClientState(bytes)
    if (decoded == null) throw new Error('decode failed')
    expect(decoded.unappliedProposals['AA==']?.senderLeafIndex).toBe(0)
    expect(Object.values(decoded.unappliedProposals).map((p) => p.senderLeafIndex)).toEqual([
      0,
      1,
      undefined,
    ])
    expect(bytes[0]).toBe(2)
    const sliced = new Uint8Array([99, ...bytes, 99]).subarray(1, bytes.length + 1)
    const slicedDecoded = decodeClientState(sliced)
    expect(slicedDecoded).toEqual(decoded)
    if (slicedDecoded == null) throw new Error('decode failed')
    slicedDecoded.keySchedule.senderDataSecret.fill(0)
    expect(decodeClientState(sliced)?.keySchedule.senderDataSecret).toEqual(
      state.keySchedule.senderDataSecret,
    )
    decoded.keySchedule.exporterSecret.fill(0)
    expect(decodeClientState(bytes)?.keySchedule.exporterSecret).toEqual(
      state.keySchedule.exporterSecret,
    )
    expect(state).toEqual(original)
  })

  test('refuses malformed zero sidecars and every v1 blob', async () => {
    const { group } = await createGroup(randomIdentity(), 'codec-malformed-sidecars')
    const state = group.state
    const proposal: ClientState['unappliedProposals'][string]['proposal'] = {
      proposalType: defaultProposalTypes.remove,
      remove: { removed: 0 },
    }
    state.unappliedProposals = {
      'AA==': { proposal, senderLeafIndex: 0 },
      'AQ==': { proposal, senderLeafIndex: 1 },
      'Ag==': { proposal, senderLeafIndex: undefined },
    }
    const body = encode(clientStateEncoder, state)
    for (const refs of [
      [utf8('AA=='), utf8('AA==')],
      [utf8('Aw==')],
      [utf8('AQ==')],
      [new Uint8Array([0xc3, 0x28])],
      [utf8('Ag=='), utf8('AA==')],
    ]) {
      expect(decodeClientState(frameV2(body, refs))).toBeUndefined()
    }
    expect(decodeClientState(frameV2(body, [], new Uint8Array([0])))).toBeUndefined()
    expect(decodeClientState(frameV2(new Uint8Array([...body, 0]), []))).toBeUndefined()
    expect(decodeClientState(frameV2(body.subarray(0, body.length - 1), []))).toBeUndefined()
    expect(decodeClientState(frameV2(new Uint8Array(), []))).toBeUndefined()
    const valid = frameV2(body, [utf8('AA==')])
    for (let length = 0; length < valid.length; length++) {
      expect(decodeClientState(valid.subarray(0, length)), `truncated at ${length}`).toBeUndefined()
    }
    for (const offset of [1, 5 + body.length, 9 + body.length]) {
      const oversized = valid.slice()
      new DataView(oversized.buffer).setUint32(offset, 0xffffffff, false)
      expect(decodeClientState(oversized), `oversized length at ${offset}`).toBeUndefined()
    }
    expect(decodeClientState(new Uint8Array())).toBeUndefined()
    expect(decodeClientState(new Uint8Array([2]))).toBeUndefined()
    expect(() => decodeClientState(new Uint8Array([1, ...body]))).toThrow(
      'unsupported client-state version 1',
    )
    expect(() => decodeClientState(new Uint8Array([3, ...body]))).toThrow(
      'unsupported client-state version 3',
    )
  })

  test('writes sorted zero references in the canonical framing', async () => {
    const { group } = await createGroup(randomIdentity(), 'codec-sorted-sidecar')
    const state = group.state
    const proposal: ClientState['unappliedProposals'][string]['proposal'] = {
      proposalType: defaultProposalTypes.remove,
      remove: { removed: 0 },
    }
    state.unappliedProposals = {
      'Ag==': { proposal, senderLeafIndex: 0 },
      'AA==': { proposal, senderLeafIndex: 0 },
      'AQ==': { proposal, senderLeafIndex: 1 },
    }
    const framed = frameV2(encode(clientStateEncoder, state), [utf8('AA=='), utf8('Ag==')])
    expect(encodeClientState(state)).toEqual(framed)
    expect(decodeClientState(framed)).toEqual(state)
  })

  test('preserves zero epoch path and generations and empty tree hashes', async () => {
    const { group } = await createGroup(randomIdentity(), 'codec-falsy-values')
    const state = group.state
    expect(state.groupContext.epoch).toBe(0n)
    expect(state.privatePath.leafIndex).toBe(0)
    state.groupContext.treeHash = new Uint8Array()
    state.treeHashCache = [new Uint8Array(), undefined]
    state.secretTree.leafNodes[0] = {
      application: {
        secret: state.keySchedule.exporterSecret.slice(),
        generation: 0,
        unusedGenerations: {},
      },
      handshake: {
        secret: state.keySchedule.senderDataSecret.slice(),
        generation: 0,
        unusedGenerations: {},
      },
    }
    const decoded = decodeClientState(encodeClientState(state))
    if (decoded == null) throw new Error('decode failed')
    expect(decoded.groupContext.epoch).toBe(0n)
    expect(decoded.privatePath.leafIndex).toBe(0)
    expect(decoded.secretTree.leafNodes[0]?.application.generation).toBe(0)
    expect(decoded.secretTree.leafNodes[0]?.handshake.generation).toBe(0)
    expect(decoded.groupContext.treeHash).toEqual(new Uint8Array())
    expect(decoded.treeHashCache).toEqual([new Uint8Array(), undefined])
  })

  test('an empty buffer is a truncated read, not a version from the future', () => {
    // The two diagnoses stay apart. Without the length guard `encoded[0]` is `undefined` here and
    // the version branch reports "unsupported client-state version undefined" — an empty or
    // never-written store described as a format this build is too old to read, which is the one
    // wrong thing that byte exists to stop it saying.
    expect(decodeClientState(new Uint8Array())).toBeUndefined()
  })
})
