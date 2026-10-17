import { commitKeyRotation, decodeClientState, encodeClientState, restoreGroup } from '@kumiai/mls'
import { testGroupStorageConformance } from '@kumiai/rpc-conformance'
import { describe, expect, test } from 'vitest'

import { assertStateTransition } from '../src/persistence-guards.js'
import { registryOptions, validateRegistryHandle } from '../src/registry/validation.js'
import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'
import { createRealGroup } from './fixtures/real-group.js'
import { createRegistryFixture } from './fixtures/registry.js'
import { createStorageFixture, writeSideRow } from './fixtures/storage-persistence.js'
import {
  cacheAtCurrentGeneration,
  makeStorageSeed,
  retainedTupleChanged,
} from './fixtures/storage-seed.js'

for (const mode of ['real-mls', 'double'] as const) {
  testGroupStorageConformance(
    {
      label: `guards ${mode}`,
      ownershipContext: createAsyncLocalOwnershipContext,
      lowerEpochCandidate: (id) => makeStorageSeed({ id, incarnation: 1, epoch: 2, mode }),
      writeSideRow,
      createFixture: (id, options) => createStorageFixture({ id, mode, ...options }),
    },
    { cacheAtCurrentGeneration, retainedTupleChanged },
  )

  describe(`installed state guards -- ${mode}`, () => {
    for (const installation of ['first installation', 'new incarnation'] as const) {
      for (const location of ['current', 'retained'] as const) {
        test.each(['handshake', 'application'] as const)(
          `${installation} refuses a skipped %s key at the generation in the ${location} tree`,
          async (kind) => {
            const seed = await makeStorageSeed({
              id: 'installed-skipped-index',
              incarnation: 1,
              epoch: 1,
              mode,
            })
            const state =
              seed.state.state === null ? undefined : decodeClientState(seed.state.state)
            if (state === undefined) throw new Error('Missing seed state')
            let handle = await restoreGroup({
              state,
              credential: seed.state.credential,
              ledgerEntries: seed.state.ledger,
            })
            await handle.encrypt(new Uint8Array([1]))
            handle = (await commitKeyRotation(handle)).newGroup
            await handle.encrypt(new Uint8Array([2]))
            const previous = installation === 'first installation' ? null : seed.state
            const candidate = () => {
              return {
                ...seed.state,
                incarnation: installation === 'first installation' ? 1 : 2,
                epoch: Number(handle.epoch),
                epochAuthenticator: handle.state.keySchedule.epochAuthenticator.slice(),
                state: encodeClientState(handle.state),
              }
            }
            expect(() => assertStateTransition(previous, candidate(), seed.trust)).not.toThrow()
            const tree =
              location === 'current'
                ? handle.state.secretTree
                : handle.state.historicalReceiverData.get(1n)?.secretTree
            const ratchet = tree?.leafNodes[0]?.[kind]
            if (ratchet === undefined) throw new Error('Missing ratchet')
            ratchet.unusedGenerations[ratchet.generation] = ratchet.secret.slice()
            expect(() => assertStateTransition(previous, candidate(), seed.trust)).toThrow(
              'Invalid skipped-key index',
            )
          },
        )
      }
    }
  })
}

test('senderHWM reads the own node index', async () => {
  const real = await createRealGroup(1, 'own-sender-hwm')
  const member = real.members[0]
  if (member === undefined) throw new Error('Missing member')
  expect(member.handle.state.privatePath.leafIndex).toBe(1)
  const fixture = await createRegistryFixture({
    mode: 'real-mls',
    setup: 'empty',
    groupID: member.handle.groupID,
    identity: member.identity,
    options: { resolveLedgerEntries: real.resolveLedgerEntries },
  })
  try {
    const handle = await restoreGroup({
      state: structuredClone(member.handle.state),
      credential: member.handle.credential,
      ledgerEntries: member.handle.ledgerTokens,
      options: fixture.environment.options,
    })
    const key = await fixture.registry.seed(handle, {
      packageUse: { sourceID: 'own-sender', ref: 'member-package', kind: 'ordinary' },
    })
    const access = await fixture.registry.access(key.groupID)
    await access.mutate(async (current, persist) => {
      await current.encrypt(new Uint8Array([1]))
      await persist(current)
    })
    expect(await fixture.device.groups.loadState(key)).toMatchObject({ senderHWM: 1 })
  } finally {
    await fixture.close()
  }
})

describe('retained epoch guards', () => {
  test.each(['current', 'retained', 'new-epoch'] as const)(
    'skipped-key indices precede their generation in the %s tree',
    async (location) => {
      const seed = await makeStorageSeed({
        id: 'skipped-index-guards',
        incarnation: 1,
        epoch: 1,
        mode: 'real-mls',
      })
      const state = seed.state.state === null ? undefined : decodeClientState(seed.state.state)
      if (state === undefined) throw new Error('Missing seed state')
      let handle = await restoreGroup({
        state,
        credential: seed.state.credential,
        ledgerEntries: seed.state.ledger,
      })
      await handle.encrypt(new Uint8Array([1]))
      handle = (await commitKeyRotation(handle)).newGroup
      await handle.encrypt(new Uint8Array([1]))
      const previous = {
        ...seed.state,
        epoch: Number(handle.epoch),
        epochAuthenticator: handle.state.keySchedule.epochAuthenticator.slice(),
        state: encodeClientState(handle.state),
      }
      const next = location === 'new-epoch' ? (await commitKeyRotation(handle)).newGroup : handle
      if (location === 'new-epoch') await next.encrypt(new Uint8Array([2]))
      const tree =
        location === 'retained'
          ? next.state.historicalReceiverData.get(1n)?.secretTree
          : next.state.secretTree
      const node = tree?.leafNodes[0]
      if (node === undefined) throw new Error('Missing ratchet')
      for (const kind of ['handshake', 'application'] as const) {
        const ratchet = node[kind]
        const candidate = () => {
          return {
            ...previous,
            version: previous.version + 1,
            epoch: Number(next.epoch),
            epochAuthenticator: next.state.keySchedule.epochAuthenticator.slice(),
            state: encodeClientState(next.state),
          }
        }
        expect(() => assertStateTransition(previous, candidate(), seed.trust)).not.toThrow()
        ratchet.unusedGenerations[ratchet.generation] = ratchet.secret.slice()
        expect(() => assertStateTransition(previous, candidate(), seed.trust)).toThrow(
          'Invalid skipped-key index',
        )
        delete ratchet.unusedGenerations[ratchet.generation]
      }
    },
  )

  test.each(['senderDataSecret', 'ratchetTree', 'groupContext', 'resumptionPsk'] as const)(
    'refuses changed %s in retained and departing epochs',
    async (field) => {
      const seed = await makeStorageSeed({
        id: 'tuple-guards',
        incarnation: 1,
        epoch: 2,
        mode: 'real-mls',
      })
      for (const departing of [false, true]) {
        const state = seed.state.state === null ? undefined : decodeClientState(seed.state.state)
        if (state === undefined) throw new Error('Missing seed state')
        const handle = await restoreGroup({
          state,
          credential: seed.state.credential,
          ledgerEntries: seed.state.ledger,
        })
        const next = departing ? (await commitKeyRotation(handle)).newGroup : handle
        const epoch = departing ? 2n : 1n
        const retained = next.state.historicalReceiverData.get(epoch)
        if (retained === undefined) throw new Error('Missing retained tuple')
        const candidate = () => {
          return {
            ...seed.state,
            version: seed.state.version + 1,
            epoch: Number(next.epoch),
            epochAuthenticator: next.state.keySchedule.epochAuthenticator.slice(),
            state: encodeClientState(next.state),
          }
        }
        expect(() => assertStateTransition(seed.state, candidate(), seed.trust)).not.toThrow()
        if (field === 'senderDataSecret' || field === 'resumptionPsk')
          retained[field][0] = (retained[field][0] ?? 0) ^ 1
        if (field === 'groupContext')
          retained.groupContext.confirmedTranscriptHash[0] =
            (retained.groupContext.confirmedTranscriptHash[0] ?? 0) ^ 1
        if (field === 'ratchetTree') {
          const leaf = retained.ratchetTree[0]
          if (leaf?.nodeType !== 1) throw new Error('Missing retained leaf')
          leaf.leaf.signaturePublicKey[0] = (leaf.leaf.signaturePublicKey[0] ?? 0) ^ 1
        }
        expect(() => assertStateTransition(seed.state, candidate(), seed.trust)).toThrow(
          'Retained epoch tuple changed',
        )
      }
    },
  )

  test.each(['current', 'retained'] as const)(
    'restore refuses oversized generation caches in the %s tree',
    async (location) => {
      const real = await createRealGroup(0, `generation-cache-${location}`)
      let handle = await restoreGroup({
        state: real.committer.handle.state,
        credential: real.committer.handle.credential,
        ledgerEntries: real.committer.handle.ledgerTokens,
        options: registryOptions({}),
      })
      await handle.encrypt(new Uint8Array([1]))
      if (location === 'retained') handle = (await commitKeyRotation(handle)).newGroup
      const tree =
        location === 'current'
          ? handle.state.secretTree
          : handle.state.historicalReceiverData.get(0n)?.secretTree
      const ratchet = tree?.leafNodes[0]?.application
      if (ratchet === undefined) throw new Error('Missing ratchet')
      ratchet.generation = 1001
      for (let index = 0; index < 1000; index++)
        ratchet.unusedGenerations[index] = ratchet.secret.slice()
      const params = {
        handle,
        key: { groupID: handle.groupID, incarnation: 1 },
        trust: null,
        ownerDID: real.committer.identity.id,
        environment: { identity: real.committer.identity, options: registryOptions({}) },
      }
      expect(() => validateRegistryHandle(params)).not.toThrow()
      ratchet.unusedGenerations[1000] = ratchet.secret.slice()
      expect(() => validateRegistryHandle(params)).toThrow('Registry skipped-key limit exceeded')
    },
  )
})
