import {
  authorityPath,
  type ControllerLog,
  canonicalBytes,
  createAdd,
  createInception,
  createRemove,
  createRenew,
  createReset,
  createRevoke,
  deriveKeyMaterial,
  didFromInception,
  digestOf,
  encodeKey,
  type InceptionEvent,
  isEpochEventShape,
  MAX_EPOCH_EVENTS,
  pruneLog,
  ROTATE_NEEDS_SNAPSHOT,
  type SignedEvent,
  verifyEpochSignature,
} from '@kokuin/controller'
import { createIdentity } from '@kokuin/token'
import { ed25519 } from '@noble/curves/ed25519.js'
import { bytesToNumberLE, concatBytes } from '@noble/curves/utils.js'
import { sha512 } from '@noble/hashes/sha2.js'
import { toB64U } from '@sozai/codec'
import { beforeAll, describe, expect, test } from 'vitest'

import {
  asControllerLog,
  CHAIN_REVOKE_REFUSED,
  closureOf,
  foldChain,
  foldControllerLog,
  hasChainRevoke,
  isDetachedFoldReason,
  revokeIndices,
} from '../src/controller-log.js'
import { createRegistryControllerResolver } from '../src/embedded-resolver.js'
import { revokeChain, rotateChain } from './fixtures/controller-chain.js'
import { saturatedLog } from './fixtures/controller-epoch.js'

const seed = new Uint8Array(32).fill(17)
const inception = createInception(seed, 0)
const did = didFromInception(inception.event)
const params = { seed, profile: 0, did }

async function memberLog() {
  const privateKey = new Uint8Array(32).fill(53)
  const identity = await createIdentity({
    keys: [{ purpose: 'sig', alg: 'EdDSA', privateKey }],
    didMethod: 'peer:4',
  })
  if (identity.longForm == null) throw new Error('Missing member long form')
  const folded = foldChain(did, [inception])
  if (!folded.ok) throw new Error(folded.reason)
  const head = folded.head
  const member = {
    did: identity.longForm,
    key: encodeKey(identity.publicKey, 'EdDSA'),
    lease: 1000,
  }
  const add = createAdd({ ...params, head, parents: [head.epoch], member })
  const addDigest = digestOf(add.event)
  const renew = createRenew({
    did,
    head,
    parents: [addDigest],
    signer: { root: { seed, profile: 0 } },
    add: addDigest,
    lease: 2000,
  })
  const log: ControllerLog = { chain: [inception], events: [renew, add] }
  return { log, add, renew, head, member, identity, privateKey }
}

test('foldControllerLog applies member add and renew from events', async () => {
  const { log, add, renew, member } = await memberLog()
  const folded = foldControllerLog(did, log)
  expect(folded.ok).toBe(true)
  if (!folded.ok) throw new Error(folded.reason)
  const addDigest = digestOf(add.event)
  expect([...folded.head.members.values()]).toEqual([
    { ...member, add: addDigest, lease: 2000, removed: false, effective: true },
  ])
  expect(folded.applied).toEqual([addDigest, digestOf(renew.event)])
})

test('foldControllerLog refuses a chain rev', () => {
  for (const crit of [false, true]) {
    const revoke = {
      event: {
        t: 'rev',
        crit,
        g: 0,
        s: 1,
        p: digestOf(inception.event),
        i: did,
        v: 1,
        x: 'did:key:revoke-target',
      },
      sigs: [],
    } as unknown as SignedEvent
    expect(foldControllerLog(did, { chain: [inception, revoke], events: [] })).toEqual({
      ok: false,
      reason: CHAIN_REVOKE_REFUSED,
      index: 1,
    })
  }
})

test('revokeIndices identifies denial gains across forms and generations', async () => {
  const { identity, member } = await memberLog()
  const short = identity.id
  const long = member.did
  const shortChain: Array<SignedEvent> = [inception]
  shortChain.push(revokeChain({ ...params, chain: shortChain, subject: short }))
  const longChain: Array<SignedEvent> = [inception]
  longChain.push(revokeChain({ ...params, chain: longChain, subject: long }))
  const repeated = [...shortChain]
  repeated.push(revokeChain({ ...params, chain: repeated, subject: long }))
  const cleared = [...repeated, createReset(seed, 0, 1)]
  const reRevoked = [...cleared, createReset(seed, 0, 2)]
  reRevoked.push(revokeChain({ ...params, chain: reRevoked, subject: long }))
  const cases = [
    { name: 'no denial', chain: [inception], subject: short, expected: [] },
    { name: 'short denial, long subject', chain: shortChain, subject: long, expected: [1] },
    { name: 'long denial, short subject', chain: longChain, subject: short, expected: [1] },
    { name: 'repeated denial', chain: repeated, subject: long, expected: [1] },
    { name: 'denial cleared by reset', chain: cleared, subject: short, expected: [1] },
    { name: 're-revoke at gen 2', chain: reRevoked, subject: long, expected: [1, 5] },
  ]
  for (const { name, chain, subject, expected } of cases) {
    const folded = foldChain(did, chain)
    if (!folded.ok) throw new Error(folded.reason)
    expect(revokeIndices(did, chain, subject), name).toEqual(expected)
  }
})

test('revokeIndices returns no indices when the chain is invalid', () => {
  const chain: Array<SignedEvent> = [inception]
  const subject = 'did:key:revoked-device'
  chain.push(revokeChain({ ...params, chain, subject }))
  chain.push({ ...rotateChain({ ...params, chain }), sigs: [] })
  expect(revokeIndices(did, chain, subject)).toEqual([])
})

test('closureOf returns the renew with its add', async () => {
  const { log, add, renew } = await memberLog()
  const closure = closureOf(did, log, [digestOf(renew.event)])
  expect(closure).toEqual({ chain: [inception], events: [add, renew] })
  if (closure == null) throw new Error('Missing closure')
  const folded = foldControllerLog(did, closure)
  if (!folded.ok) throw new Error(folded.reason)
  expect(folded.applied).toEqual([digestOf(add.event), digestOf(renew.event)])
})

test('closureOf refuses a target pending on a missing parent', async () => {
  const { renew } = await memberLog()
  const log = { chain: [inception], events: [renew] }
  const folded = foldControllerLog(did, log)
  if (!folded.ok) throw new Error(folded.reason)
  expect(folded.applied).toEqual([])
  expect(folded.pending).toBe(1)
  expect(closureOf(did, log, [digestOf(renew.event)])).toBeUndefined()
})

test('closureOf refuses a target not applied', async () => {
  const { log, add, head, privateKey } = await memberLog()
  const addDigest = digestOf(add.event)
  const renew = createRenew({
    did,
    head,
    parents: [addDigest],
    signer: { member: { privateKey, add: addDigest } },
    add: addDigest,
    lease: 3000,
  })
  log.events.push(renew)
  const folded = foldControllerLog(did, log)
  if (!folded.ok) throw new Error(folded.reason)
  expect(folded.applied).not.toContain(digestOf(renew.event))
  expect(folded.rejected).toBe(1)
  expect(closureOf(did, log, [digestOf(renew.event)])).toBeUndefined()
})

test('closureOf keeps authenticated copies and excludes unrelated events', async () => {
  const { log, add, renew, head } = await memberLog()
  const forgedAdd = { ...add, sigs: renew.sigs }
  const forgedRenew = { ...renew, sigs: add.sigs }
  for (const forged of [forgedAdd, forgedRenew]) {
    expect(isEpochEventShape(forged)).toBe(true)
    expect(verifyEpochSignature(forged, { rootKeys: head.keys })).toBe(false)
  }
  const unrelated = createRevoke({
    did,
    head,
    parents: [head.epoch],
    signer: { root: { seed, profile: 0 } },
    target: 'did:key:unrelated',
  })
  log.events = [
    ...Array.from({ length: 128 }, () => forgedAdd),
    ...Array.from({ length: 128 }, () => forgedRenew),
    unrelated,
    renew,
    add,
  ]
  const closure = closureOf(did, log, [digestOf(renew.event), digestOf(add.event)])
  expect(closure).toEqual({
    chain: [inception],
    events: [add, renew],
  })
  expect(closure?.events).toEqual(
    pruneLog(did, log).events.filter(
      (signed) => digestOf(signed.event) !== digestOf(unrelated.event),
    ),
  )
})

test.each([false, true])(
  'closureOf keeps kokuin canonical signatures with reversed input=%s',
  async (reverse) => {
    const { log, add, renew, head } = await memberLog()
    const privateKey = deriveKeyMaterial(seed, authorityPath(0, 0, 0), 'EdDSA')
    const { scalar, pointBytes } = ed25519.utils.getExtendedPublicKey(privateKey)
    // A different signing nonce gives a second valid signature for the same body.
    const nonce = 1n
    const point = ed25519.Point.BASE.multiply(nonce).toBytes()
    const challenge = bytesToNumberLE(
      sha512(concatBytes(point, pointBytes, canonicalBytes(add.event))),
    )
    const response = ed25519.Point.Fn.toBytes(ed25519.Point.Fn.create(nonce + challenge * scalar))
    const alternative = { ...add, sigs: [toB64U(concatBytes(point, response))] }
    expect(alternative.sigs).not.toEqual(add.sigs)
    for (const signed of [add, alternative]) {
      expect(isEpochEventShape(signed)).toBe(true)
      expect(verifyEpochSignature(signed, { rootKeys: head.keys })).toBe(true)
    }
    log.events = reverse ? [alternative, renew, add] : [add, renew, alternative]
    const canonical = pruneLog(did, log).events
    expect(canonical).toHaveLength(2)
    expect(closureOf(did, log, [digestOf(renew.event)])?.events).toEqual(canonical)
  },
)

test('closureOf includes every ancestor back to the epoch anchor', async () => {
  const { log, add, renew, head, privateKey } = await memberLog()
  const addDigest = digestOf(add.event)
  const revoke = createRevoke({
    did,
    head,
    parents: [digestOf(renew.event)],
    signer: { member: { privateKey, add: addDigest } },
    target: 'did:key:edge-device',
  })
  const later = createRenew({
    did,
    head,
    parents: [digestOf(revoke.event)],
    signer: { root: { seed, profile: 0 } },
    add: addDigest,
    lease: 3000,
  })
  const remove = createRemove({
    did,
    head,
    parents: [digestOf(later.event)],
    signer: { root: { seed, profile: 0 } },
    add: addDigest,
  })
  log.events = [remove, later, { ...revoke, sigs: add.sigs }, revoke, ...log.events]
  expect(closureOf(did, log, [digestOf(later.event)])).toEqual({
    chain: [inception],
    events: [add, renew, revoke, later],
  })
  log.events = log.events.filter((entry) => entry !== renew)
  expect(closureOf(did, log, [digestOf(later.event)])).toBeUndefined()
})

test('closureOf refuses a missing target', async () => {
  const { log } = await memberLog()
  expect(closureOf(did, log, [digestOf('missing target')])).toBeUndefined()
})

test('closureOf refuses a log that does not fold', async () => {
  const { log, renew } = await memberLog()
  log.chain = [{ ...inception, sigs: [] }]
  expect(foldControllerLog(did, log).ok).toBe(false)
  expect(closureOf(did, log, [digestOf(renew.event)])).toBeUndefined()
})

test('closureOf refuses the epoch anchor as a target', async () => {
  const { log, head } = await memberLog()
  expect(closureOf(did, log, [head.epoch])).toBeUndefined()
})

test('closureOf returns the chain alone for empty targets', async () => {
  const { log } = await memberLog()
  expect(closureOf(did, log, [])).toEqual({ chain: [inception], events: [] })
})

describe('saturated controller epoch', () => {
  let log: ControllerLog
  let controller: string
  let addDigest: string

  beforeAll(async () => {
    log = await saturatedLog()
    const inception = log.chain[0]
    const add = log.events.find((signed) => signed.event.t === 'add')
    if (inception?.event.t !== 'icp' || add == null) throw new Error('Missing saturated fixture')
    controller = didFromInception(inception.event as InceptionEvent)
    addDigest = digestOf(add.event)
    const folded = foldControllerLog(controller, log)
    if (!folded.ok) throw new Error(folded.reason)
    expect(folded.applied).toHaveLength(MAX_EPOCH_EVENTS + 1)
    expect(folded.applied).toContain(addDigest)
    expect(folded.head.saturated).toBe(true)
  })

  test('closureOf refuses a saturated epoch for an applied target', () => {
    expect(closureOf(controller, log, [addDigest])).toBeUndefined()
  })

  test('closureOf refuses a saturated epoch even for empty targets', () => {
    expect(closureOf(controller, log, [])).toBeUndefined()
  })
})

test('mutating a closure does not change the input log', async () => {
  const fixture = await memberLog()
  const log = structuredClone(fixture.log)
  const before = structuredClone(log)
  const closure = closureOf(did, log, [digestOf(fixture.renew.event)])
  if (closure == null) throw new Error('Missing closure')
  const chainEntry = closure.chain[0]
  const eventEntry = closure.events[0]
  if (
    chainEntry == null ||
    !('k' in chainEntry.event) ||
    !Array.isArray(chainEntry.event.k) ||
    eventEntry == null
  ) {
    throw new Error('Missing closure entries')
  }
  chainEntry.sigs.push('changed chain signature')
  chainEntry.event.crit = false
  chainEntry.event.k.push('changed root key')
  eventEntry.sigs.push('changed epoch signature')
  eventEntry.event.crit = false
  eventEntry.event.p.push('changed parent')
  closure.chain.length = 0
  closure.events.length = 0
  expect(log).toEqual(before)
})

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

  test.each([false, true])('refuses an unsigned chain revoke with crit=%s', (crit) => {
    const revoke = {
      event: {
        t: 'rev',
        crit,
        g: 0,
        s: 1,
        p: digestOf(inception.event),
        i: did,
        v: 1,
        x: 'did:key:revoke-target',
      },
      sigs: [],
    } as unknown as SignedEvent
    expect(hasChainRevoke([inception, revoke])).toBe(true)
    expect(hasChainRevoke([null, {}, inception])).toBe(false)
    expect(foldChain(did, [inception, revoke])).toEqual({
      ok: false,
      reason: CHAIN_REVOKE_REFUSED,
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
  'the embedded resolver rejects chain revokes with crit=%s',
  async (crit) => {
    const revoke = {
      event: {
        t: 'rev',
        crit,
        g: 0,
        s: 1,
        p: digestOf(inception.event),
        i: did,
        v: 1,
        x: 'did:key:revoke-target',
      },
      sigs: [],
    } as unknown as SignedEvent
    const resolver = createRegistryControllerResolver({
      controllerID: did,
      prefix: [inception, revoke],
    })
    await expect(resolver.resolve(did, {})).rejects.toThrow(/Unknown DID/)
    await expect(resolver.resolveHistoric?.(did, {})).rejects.toThrow(/Unknown DID/)
  },
)
