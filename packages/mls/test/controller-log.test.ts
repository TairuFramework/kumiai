import {
  authorityPath,
  canonicalBytes,
  createInception,
  deriveKeyMaterial,
  didFromInception,
  digestOf,
  ROTATE_NEEDS_SNAPSHOT,
  type SignedEvent,
} from '@kokuin/controller'
import { ed25519 } from '@noble/curves/ed25519.js'
import { toB64U } from '@sozai/codec'
import { describe, expect, test } from 'vitest'

import {
  asControllerLog,
  foldChain,
  hasLegacyRevoke,
  isDetachedFoldReason,
  LEGACY_CHAIN_REVOKE,
} from '../src/controller-log.js'
import { createEmbeddedControllerResolver } from '../src/embedded-resolver.js'
import { revokeChain, rotateChain } from './fixtures/controller-chain.js'

const seed = new Uint8Array(32).fill(17)
const inception = createInception(seed, 0)
const did = didFromInception(inception.event)
const params = { seed, profile: 0, did }

describe('controller chain adapter', () => {
  test('wraps a copy of the chain without epoch events', () => {
    const chain = [inception]
    const log = asControllerLog(chain)
    expect(log).toEqual({ chain, events: [] })
    expect(log.chain).not.toBe(chain)
  })

  test('folds inception and snapshot-bearing rotation chains', () => {
    const chain = [inception]
    const first = foldChain(did, chain)
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error(first.reason)
    expect(first.states).toHaveLength(1)
    const folded = foldChain(did, [...chain, rotateChain({ ...params, chain })])
    expect(folded.ok).toBe(true)
    if (!folded.ok) throw new Error(folded.reason)
    expect(folded.states).toHaveLength(2)
  })

  test('refuses a rotation without a state snapshot', () => {
    const rotation = rotateChain({ ...params, chain: [inception] })
    const event: SignedEvent['event'] & { m?: unknown; d?: unknown } = { ...rotation.event }
    delete event.m
    delete event.d
    const sigs = [
      toB64U(
        ed25519.sign(
          canonicalBytes(event),
          deriveKeyMaterial(seed, authorityPath(0, 0, 1), 'EdDSA'),
        ),
      ),
    ]
    expect(foldChain(did, [inception, { event, sigs }])).toMatchObject({
      ok: false,
      reason: ROTATE_NEEDS_SNAPSHOT,
    })
  })

  test.each([false, true])('refuses an unsigned legacy revoke with crit=%s', (crit) => {
    const legacy = {
      event: {
        t: 'rev',
        crit,
        g: 0,
        s: 1,
        p: digestOf(inception.event),
        i: did,
        v: 1,
        x: 'did:key:legacy-target',
      },
      sigs: [],
    } as unknown as SignedEvent
    expect(hasLegacyRevoke([inception, legacy])).toBe(true)
    expect(hasLegacyRevoke([null, {}, inception])).toBe(false)
    expect(foldChain(did, [inception, legacy])).toEqual({
      ok: false,
      reason: LEGACY_CHAIN_REVOKE,
      index: 1,
    })
  })

  test('preserves earlier denials across revoking rotations', () => {
    const chain: Array<SignedEvent> = [inception]
    chain.push(revokeChain({ ...params, chain, subject: 'did:key:A' }))
    chain.push(revokeChain({ ...params, chain, subject: 'did:key:B' }))
    const folded = foldChain(did, chain)
    expect(folded.ok).toBe(true)
    if (!folded.ok) throw new Error(folded.reason)
    const head = folded.states.at(-1)
    if (head == null) throw new Error('Missing controller head')
    expect([...head.deny]).toEqual(['did:key:A', 'did:key:B'])
  })

  test.each([
    ['sequence gap', true],
    ['event does not chain to the previous digest', true],
    ['reset must restart the sequence', true],
    ['invalid rotate', false],
    ['unknown critical event type: rev', false],
    ['first event must be an inception', false],
  ])('classifies %s', (reason, detached) => {
    expect(isDetachedFoldReason(reason)).toBe(detached)
  })
})

test.each([false, true])(
  'the embedded resolver rejects legacy revokes with crit=%s',
  async (crit) => {
    const legacy = {
      event: {
        t: 'rev',
        crit,
        g: 0,
        s: 1,
        p: digestOf(inception.event),
        i: did,
        v: 1,
        x: 'did:key:legacy-target',
      },
      sigs: [],
    } as unknown as SignedEvent
    const resolver = createEmbeddedControllerResolver({
      controllerID: did,
      prefix: [inception, legacy],
    })
    await expect(resolver.resolve(did, {})).rejects.toThrow(/Unknown DID/)
    await expect(resolver.resolveHistoric?.(did, {})).rejects.toThrow(/Unknown DID/)
  },
)
