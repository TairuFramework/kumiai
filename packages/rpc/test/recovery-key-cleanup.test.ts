import { expect, test, vi } from 'vitest'

import { decodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import { settleRecovery } from '../src/recovery-reconcile.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryGroupMLS } from './fixtures/memory-group-mls.js'
import type { MakeMLSPeerOptions } from './fixtures/peer.js'
import { latchPeerSafety, makeMLSPeer } from './fixtures/peer.js'

function requester(
  hub: FakeHub,
  secret: Uint8Array,
  captured: boolean,
  options: MakeMLSPeerOptions,
) {
  const epoch = options.epoch ?? 1
  const crypto = createFakeCrypto({ epoch, localDID: 'bob' })
  const mls = createMemoryGroupMLS({
    storageID: 'bob',
    localDID: 'bob',
    recoverySecret: secret,
    epoch,
    members: options.members,
    onAdvance: (next) => crypto.setEpoch(next),
  })
  if (!captured) mls.capturedRecovery = undefined
  return makeMLSPeer(hub, 'bob', secret, { ...options, mls, crypto })
}

for (const captured of [false, true]) {
  test.each(['publish rejection', 'live hold', 'dispose', 'ledger rejection'] as const)(
    `early request failure zeroises owned key (captured: ${captured}, %s)`,
    async (fault) => {
      const hub = new FakeHub()
      const secret = new Uint8Array(32).fill(104)
      const options = {
        members: ['alice', 'bob'],
        recovery: { timeoutMs: 30, deadlineMs: 100, getDelayMs: () => 0 },
      }
      const alice = makeMLSPeer(hub, 'alice', secret, options)
      const bob = requester(hub, secret, captured, options)
      const keys: Array<Uint8Array> = []
      try {
        await alice.peer.replay()
        await bob.peer.replay()
        const create = bob.mls.createRecoveryRequest.bind(bob.mls)
        bob.mls.createRecoveryRequest = async (...args) => {
          const held = await create(...args)
          keys.push(held.requestKey)
          if (fault === 'live hold') latchPeerSafety(bob, 'fork-halted')
          if (fault === 'dispose') void bob.peer.dispose()
          if (fault === 'ledger rejection')
            bob.mls.getLedger = async () => {
              throw new Error('ledger unavailable')
            }
          return held
        }
        if (fault === 'publish rejection') {
          const publish = hub.publish.bind(hub)
          vi.spyOn(hub, 'publish').mockImplementation((value) => {
            if (decodeHandshakeFrame(value.payload).kind === HANDSHAKE_KIND.recoveryRequest)
              throw new Error('request publish rejected')
            return publish(value)
          })
        }
        await bob.peer.recover().catch(() => {})
        expect(keys.length).toBeGreaterThan(0)
        for (const requestKey of keys) expect(requestKey.every((byte) => byte === 0)).toBe(true)
        expect((await bob.control.load()).rejoin).toBeNull()
      } finally {
        await Promise.all([alice.peer.dispose(), bob.peer.dispose()])
        await Promise.all([alice.peer.drained(), bob.peer.drained()])
        vi.restoreAllMocks()
      }
    },
  )
}

test('durably owned request key survives until settlement proof', async () => {
  const hub = new FakeHub()
  const secret = new Uint8Array(32).fill(105)
  const options = {
    members: ['alice', 'bob'],
    recovery: { timeoutMs: 30, deadlineMs: 100, getDelayMs: () => 0 },
  }
  const alice = makeMLSPeer(hub, 'alice', secret, options)
  const bob = makeMLSPeer(hub, 'bob', secret, options)
  let ownedKey: Uint8Array | undefined
  let originalKey: Uint8Array | undefined
  try {
    await alice.peer.replay()
    await bob.peer.replay()
    const create = bob.mls.createRecoveryRequest.bind(bob.mls)
    bob.mls.createRecoveryRequest = async (...args) => {
      const held = await create(...args)
      ownedKey = held.requestKey
      originalKey = held.requestKey.slice()
      return held
    }
    const apply = bob.control.apply.bind(bob.control)
    bob.control.apply = async (changes, id) => {
      await apply(changes, id)
      if (changes.putRejoin?.stage === 'built') void bob.peer.dispose()
    }
    await bob.peer.recover().catch(() => {})
    await bob.peer.dispose()
    await bob.peer.drained()
    const record = (await bob.control.load()).rejoin
    if (record === null || !('format' in record)) throw new Error('Missing saved X')
    const savedOwnedKey = record.requestKey
    expect(savedOwnedKey).toEqual(originalKey)
    expect(ownedKey).toEqual(originalKey)
    const persisted = Promise.withResolvers<void>()
    const prove = Promise.withResolvers<void>()
    bob.control.apply = async (changes, id) => {
      await apply(changes, id)
      persisted.resolve()
      await prove.promise
    }
    const settling = settleRecovery({
      control: bob.control,
      record,
      provenance: { kind: 'not-accepted', epoch: record.target.groupInfoEpoch + 1 },
      mutationID: 'settle-X',
    })
    await persisted.promise
    expect(savedOwnedKey).toEqual(originalKey)
    prove.resolve()
    await settling
    expect(savedOwnedKey.every((byte) => byte === 0)).toBe(true)
    expect(record.candidate.every((byte) => byte === 0)).toBe(true)
  } finally {
    await Promise.all([alice.peer.dispose(), bob.peer.dispose()])
    await Promise.all([alice.peer.drained(), bob.peer.drained()])
  }
})

test.each([false, true])(
  'proven settlement zeroises the live owned buffer (captured: %s)',
  async (captured) => {
    const hub = new FakeHub()
    const secret = new Uint8Array(32).fill(107)
    const options = {
      members: ['alice', 'bob'],
      recovery: { timeoutMs: 50, deadlineMs: 500, getDelayMs: () => 0 },
    }
    const alice = makeMLSPeer(hub, 'alice', secret, options)
    const bob = requester(hub, secret, captured, options)
    const keys: Array<Uint8Array> = []
    const originalKeys: Array<Uint8Array> = []
    const candidates: Array<Uint8Array> = []
    try {
      await alice.peer.replay()
      await bob.peer.replay()
      const apply = bob.control.apply.bind(bob.control)
      bob.control.apply = async (changes, id) => {
        if (changes.putRejoin?.stage === 'built') candidates.push(changes.putRejoin.candidate)
        if (changes.putRejoin?.stage === 'published') expect(keys).toEqual(originalKeys)
        await apply(changes, id)
      }
      const create = bob.mls.createRecoveryRequest.bind(bob.mls)
      bob.mls.createRecoveryRequest = async (...args) => {
        const held = await create(...args)
        keys.push(held.requestKey)
        originalKeys.push(held.requestKey.slice())
        return held
      }
      await expect(bob.peer.recover()).resolves.toMatchObject({ advanced: true })
      expect((await bob.control.load()).rejoin).toBeNull()
      expect(candidates.length).toBeGreaterThan(0)
      for (const candidate of candidates) expect(candidate.every((byte) => byte === 0)).toBe(true)
      expect(keys.length).toBeGreaterThan(0)
      for (const requestKey of keys) expect(requestKey.every((byte) => byte === 0)).toBe(true)
    } finally {
      await Promise.all([alice.peer.dispose(), bob.peer.dispose()])
      await Promise.all([alice.peer.drained(), bob.peer.drained()])
    }
  },
)

test.each([false, true])(
  'settlement zeroises restored live request keys (captured: %s)',
  async (captured) => {
    const hub = new FakeHub()
    const secret = new Uint8Array(32).fill(109)
    const options = {
      members: ['alice', 'bob'],
      recovery: { timeoutMs: 50, deadlineMs: 1000, getDelayMs: () => 0 },
    }
    const alice = makeMLSPeer(hub, 'alice', secret, options)
    const bob = requester(hub, secret, captured, options)
    let restarted: ReturnType<typeof makeMLSPeer> | undefined
    try {
      await alice.peer.replay()
      await bob.peer.replay()
      const apply = bob.control.apply.bind(bob.control)
      bob.control.apply = async (changes, id) => {
        await apply(changes, id)
        if (changes.putRejoin?.stage === 'built') void bob.peer.dispose()
      }
      await bob.peer.recover().catch(() => {})
      await bob.peer.dispose()
      await bob.peer.drained()
      bob.control.apply = apply
      const crypto = createFakeCrypto({ epoch: 1, localDID: 'bob' })
      const mls = createMemoryGroupMLS({
        storageID: 'bob',
        localDID: 'bob',
        hostDB: bob.database,
        recoverySecret: secret,
        epoch: 1,
        members: options.members,
        onAdvance: (epoch) => crypto.setEpoch(epoch),
      })
      if (!captured) mls.capturedRecovery = undefined
      const keys: Array<Uint8Array> = []
      function observeRestoration<TPending>(port: {
        restoreRecovery(candidate: Uint8Array, requestKey: Uint8Array): Promise<TPending>
      }): void {
        const restore = port.restoreRecovery.bind(port)
        port.restoreRecovery = async (candidate, requestKey) => {
          expect(requestKey.some((byte) => byte !== 0)).toBe(true)
          keys.push(requestKey)
          return await restore(candidate, requestKey)
        }
      }
      if (mls.capturedRecovery === undefined) observeRestoration(mls)
      else observeRestoration(mls.capturedRecovery)
      restarted = makeMLSPeer(hub, 'bob', secret, { ...options, restartOf: bob, mls, crypto })
      await restarted.peer.replay()
      await restarted.peer.recover()
      await expect.poll(async () => (await restarted?.control.load())?.rejoin).toBeNull()
      expect(keys.length).toBeGreaterThan(0)
      for (const requestKey of keys) expect(requestKey.every((byte) => byte === 0)).toBe(true)
      expect(restarted.mls.epoch()).toBe(alice.mls.epoch())
    } finally {
      await Promise.all([alice.peer.dispose(), bob.peer.dispose(), restarted?.peer.dispose()])
      await Promise.all([alice.peer.drained(), bob.peer.drained(), restarted?.peer.drained()])
    }
  },
)
