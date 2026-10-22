import { Buffer } from 'node:buffer'
import { randomIdentity } from '@kokuin/token'
import {
  clientStateDecoder,
  clientStateEncoder,
  createProposal,
  defaultProposalTypes,
  encode,
} from 'ts-mls'
import { describe, expect, test, vi } from 'vitest'

import {
  type ClientState,
  decodeClientState,
  encodeClientState,
  sanitizeRatchetTree,
} from '../src/codec.js'
import { createGroup } from '../src/group.js'
import { ClientStateReservationError } from '../src/index.js'

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

/** Build framing independently so malformed inputs do not depend on the encoder. */
function frame(state: ClientState, refs: Array<string | Uint8Array> = []): Uint8Array {
  const body = encode(clientStateEncoder, state)
  const strings = refs.map((ref) => (typeof ref === 'string' ? new TextEncoder().encode(ref) : ref))
  const out = new Uint8Array(10 + body.length + strings.reduce((n, ref) => n + 4 + ref.length, 0))
  const view = new DataView(out.buffer)
  out[0] = 2
  view.setUint32(2, body.length)
  out.set(body, 6)
  view.setUint32(6 + body.length, refs.length)
  let offset = 10 + body.length
  for (const ref of strings) {
    view.setUint32(offset, ref.length)
    out.set(ref, offset + 4)
    offset += 4 + ref.length
  }
  return out
}

function proposals(state: ClientState): ClientState {
  const proposal = { proposalType: 3 as const, remove: { removed: 0 } }
  return {
    ...state,
    unappliedProposals: {
      'eg==': { proposal, senderLeafIndex: 0 },
      'YQ==': { proposal, senderLeafIndex: 0 },
      YWJzZW50: { proposal, senderLeafIndex: undefined },
      'b3RoZXI=': { proposal, senderLeafIndex: 1 },
    },
  }
}

describe('encodeClientState / decodeClientState', () => {
  test('v2 round trip preserves state without a reservation', async () => {
    const alice = randomIdentity()
    const { group } = await createGroup(alice, 'codec-round-trip')

    const encoded = encodeClientState(group.state)
    const decoded = decodeClientState(encoded)

    expect(decoded).toBeDefined()
    expect(encoded[0]).toBe(2)
    expect(encoded[1]).toBe(0)
    expect(encoded).toEqual(frame(group.state))
    expect(decoded?.handshakeReservation).toBeUndefined()
    expect(decoded?.groupContext.groupId).toEqual(group.state.groupContext.groupId)
  })

  test.each([false, true])(
    'v2 round trip preserves reservation evidence (consumed: %s)',
    async (consumed) => {
      const { group } = await createGroup(randomIdentity(), 'codec-reservation-round-trip')
      const reservation = { epoch: 0x100000001n, generation: 257, consumed }
      const encoded = encodeClientState({ ...group.state, handshakeReservation: reservation })

      expect(encoded[0]).toBe(2)
      expect(encoded[1]).toBe(1)
      const view = new DataView(encoded.buffer)
      expect(view.getBigUint64(2)).toBe(reservation.epoch)
      expect(view.getUint32(10)).toBe(reservation.generation)
      expect(encoded[14]).toBe(Number(consumed))
      const decoded = decodeClientState(encoded)
      expect(decoded?.handshakeReservation).toEqual(reservation)
      expect(decoded?.groupContext.groupId).toEqual(group.state.groupContext.groupId)
    },
  )

  test.each([1, 3])('refuses a v%s blob before decoding its body', async (version) => {
    const { group } = await createGroup(randomIdentity(), 'codec-unsupported')
    const body = encode(clientStateEncoder, group.state)
    const encoded = new Uint8Array((version === 1 ? 1 : 14) + body.length)
    encoded[0] = version
    encoded.set(body, version === 1 ? 1 : 14)

    expect(() => decodeClientState(encoded)).toThrow(
      `decodeClientState: unsupported client-state version ${version}`,
    )
  })

  test.each([1n << 64n, -1n, 0, '0', undefined])(
    'rejects an invalid reservation epoch %s with a typed error',
    async (epoch) => {
      const { group } = await createGroup(randomIdentity(), 'codec-invalid-epoch')

      expect(() => {
        encodeClientState({
          ...group.state,
          handshakeReservation: { epoch: epoch as bigint, generation: 0, consumed: false },
        })
      }).toThrowError(ClientStateReservationError)
    },
  )

  test.each([2 ** 32, 1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, '1', undefined])(
    'rejects an invalid reservation generation %s with a typed error',
    async (generation) => {
      const { group } = await createGroup(randomIdentity(), 'codec-invalid-generation')

      expect(() => {
        encodeClientState({
          ...group.state,
          handshakeReservation: { epoch: 0n, generation: generation as number, consumed: false },
        })
      }).toThrowError(ClientStateReservationError)
    },
  )

  test.each([
    { epoch: 0n, generation: 0, consumed: false },
    { epoch: (1n << 64n) - 1n, generation: 2 ** 32 - 1, consumed: true },
  ])('preserves reservation boundaries $epoch / $generation', async (reservation) => {
    const { group } = await createGroup(randomIdentity(), 'codec-reservation-boundaries')
    const encoded = encodeClientState({ ...group.state, handshakeReservation: reservation })

    expect(decodeClientState(encoded)?.handshakeReservation).toEqual(reservation)
  })

  test('preserves exact leaf-zero senders with sorted UTF-8 refs', async () => {
    const { group } = await createGroup(randomIdentity(), 'codec-proposals')
    const state = proposals(group.state)
    const encoded = encodeClientState(state)
    expect(encoded).toEqual(frame(state, ['YQ==', 'eg==']))
    expect(decodeClientState(encoded)?.unappliedProposals).toEqual(state.unappliedProposals)
  })

  test('a proposal created by leaf zero retains its sender after restore', async () => {
    const { group } = await createGroup(randomIdentity(), 'codec-leaf-zero')
    expect(group.state.privatePath.leafIndex).toBe(0)
    const { newState } = await createProposal({
      context: group.context,
      state: group.state,
      proposal: { proposalType: defaultProposalTypes.remove, remove: { removed: 0 } },
    })
    const pending = Object.values(newState.unappliedProposals)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.senderLeafIndex).toBe(0)
    expect(decodeClientState(encodeClientState(newState))?.unappliedProposals).toEqual(
      newState.unappliedProposals,
    )
  })

  test.each([false, true])(
    'decoded secrets do not alias stored bytes (Buffer: %s)',
    async (buffer) => {
      const { group } = await createGroup(randomIdentity(), 'codec-no-alias')
      const bytes = encodeClientState(group.state)
      const encoded = buffer ? Buffer.concat([Buffer.alloc(7), bytes]).subarray(7) : bytes
      const copy = new Uint8Array(encoded)
      const decoded = decodeClientState(encoded)
      if (decoded == null) throw new Error('decode failed')

      // Decrypt zeroes consumed secrets in place; that must not reach bytes a host still holds.
      decoded.keySchedule.exporterSecret.fill(0)
      decoded.keySchedule.senderDataSecret.fill(0)

      expect(new Uint8Array(encoded)).toEqual(copy)
    },
  )

  test.each([2, 255])('bad flags %s return undefined', async (flags) => {
    const { group } = await createGroup(randomIdentity(), 'codec-flags')
    const encoded = frame(group.state)
    encoded[1] = flags
    expect(decodeClientState(encoded)).toBeUndefined()
  })

  test.each([2, 255])('bad consumed byte %s returns undefined', async (consumed) => {
    const { group } = await createGroup(randomIdentity(), 'codec-consumed')
    const encoded = encodeClientState({
      ...group.state,
      handshakeReservation: { epoch: 0n, generation: 1, consumed: false },
    })
    encoded[14] = consumed
    expect(decodeClientState(encoded)).toBeUndefined()
  })

  test.each([
    { label: 'unsorted', refs: ['eg==', 'YQ=='] },
    { label: 'duplicate', refs: ['YQ==', 'YQ=='] },
    { label: 'unknown', refs: ['unknown'] },
    { label: 'inherited', refs: ['toString'] },
    { label: 'already has a sender', refs: ['b3RoZXI='] },
    { label: 'invalid UTF-8', refs: [new Uint8Array([0xff])] },
    { label: 'BOM-prefixed unknown', refs: ['\uFEFFYQ=='] },
  ])('$label ref returns undefined', async ({ refs }) => {
    const { group } = await createGroup(randomIdentity(), 'codec-bad-ref')
    expect(decodeClientState(frame(proposals(group.state), refs))).toBeUndefined()
  })

  test.each([false, true])(
    'every truncated prefix returns undefined (reservation: %s)',
    async (reserved) => {
      const { group } = await createGroup(randomIdentity(), 'codec-truncated')
      const encoded = encodeClientState({
        ...proposals(group.state),
        handshakeReservation: reserved ? { epoch: 1n, generation: 2, consumed: true } : undefined,
      })
      for (let length = 1; length < encoded.length; length++) {
        expect(decodeClientState(encoded.subarray(0, length)), `prefix ${length}`).toBeUndefined()
      }
    },
  )

  test('rejects trailing bytes outside and inside the body', async () => {
    const { group } = await createGroup(randomIdentity(), 'codec-trailing')
    const encoded = frame(group.state)
    expect(decodeClientState(new Uint8Array([...encoded, 0]))).toBeUndefined()
    const view = new DataView(encoded.buffer)
    const bodyLength = view.getUint32(2)
    const inside = new Uint8Array([...encoded.subarray(0, 6 + bodyLength), 0, 0, 0, 0, 0])
    new DataView(inside.buffer).setUint32(2, bodyLength + 1)
    expect(decodeClientState(inside)).toBeUndefined()
  })

  test('rejects a non-canonical optional tag in the body', async () => {
    const { group } = await createGroup(randomIdentity(), 'codec-optional-tag')
    const encoded = frame({ ...group.state, treeHashCache: [undefined] })
    const bodyLength = new DataView(encoded.buffer).getUint32(2)
    expect(decodeClientState(encoded)?.treeHashCache).toEqual([undefined])
    expect(encoded[6 + bodyLength - 1]).toBe(0)

    encoded[6 + bodyLength - 1] = 2

    expect(decodeClientState(encoded)).toBeUndefined()
  })

  test('rejects an inner vector truncated before an absent sender tag', async () => {
    const { group } = await createGroup(randomIdentity(), 'codec-inner-truncation')
    const state = {
      ...group.state,
      unappliedProposals: {
        'eg==': {
          proposal: { proposalType: 3 as const, remove: { removed: 0 } },
          senderLeafIndex: undefined,
        },
      },
    }
    const encoded = frame(state)
    // Nine-byte vector: one-byte ref "z", remove proposal, then absent sender tag.
    const vector = [9, 1, 0x7a, 0, 3, 0, 0, 0, 0, 0]
    const start = encoded.findIndex((_, index) => {
      return vector.every((byte, inner) => encoded[index + inner] === byte)
    })
    expect(start).toBeGreaterThan(6)
    const truncated = new Uint8Array([
      ...encoded.subarray(0, start + 9),
      ...encoded.subarray(start + 10),
    ])
    truncated[start] = 8
    const bodyLength = new DataView(encoded.buffer).getUint32(2) - 1
    new DataView(truncated.buffer).setUint32(2, bodyLength)
    const decoded = clientStateDecoder(truncated.subarray(6, 6 + bodyLength), 0)
    // Upstream accepts the missing tag and reports whole-body consumption.
    expect(decoded?.[1]).toBe(bodyLength)
    expect(decoded?.[0].unappliedProposals['eg==']?.proposal).toEqual(
      state.unappliedProposals['eg=='].proposal,
    )

    expect(decodeClientState(truncated)).toBeUndefined()
  })

  test('oversized body length, ref count and ref length return undefined', async () => {
    const { group } = await createGroup(randomIdentity(), 'codec-lengths')
    for (const target of ['body', 'count', 'ref']) {
      const encoded = frame(proposals(group.state), ['YQ=='])
      const view = new DataView(encoded.buffer)
      const bodyLength = view.getUint32(2)
      view.setUint32(target === 'body' ? 2 : bodyLength + (target === 'count' ? 6 : 10), 0xffffffff)
      expect(decodeClientState(encoded)).toBeUndefined()
    }
  })

  test('rejects a body declared above 64 MB before copying it', () => {
    const declaredLength = 64_000_001
    const encoded = new Uint8Array(10)
    encoded[0] = 2
    new DataView(encoded.buffer).setUint32(2, declaredLength)
    // Simulate enough available bytes to isolate the size guard without allocating 64 MB.
    Object.defineProperty(encoded, 'length', { value: declaredLength + 10 })
    const readBody = vi.spyOn(encoded, 'subarray')

    expect(decodeClientState(encoded)).toBeUndefined()
    expect(readBody).not.toHaveBeenCalled()
  })

  test('refuses a blob whose version byte is unsupported, even though the rest decodes fine', async () => {
    const alice = randomIdentity()
    const { group } = await createGroup(alice, 'codec-unknown-version')

    const encoded = encodeClientState(group.state)
    expect(encoded[0]).toBe(2)

    const tampered = encoded.slice()
    tampered[0] = 4

    expect(() => decodeClientState(tampered)).toThrow(
      'decodeClientState: unsupported client-state version 4',
    )
  })

  test('an empty buffer is a truncated read, not a version from the future', () => {
    // The two diagnoses stay apart. Without the length guard `encoded[0]` is `undefined` here and
    // the version branch reports "unsupported client-state version undefined" — an empty or
    // never-written store described as a format this build is too old to read, which is the one
    // wrong thing that byte exists to stop it saying.
    expect(decodeClientState(new Uint8Array())).toBeUndefined()
  })
})
