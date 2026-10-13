import { randomIdentity } from '@kokuin/token'
import { decodeClientState, encodeClientState, type GroupHandle } from '@kumiai/mls'
import {
  type AdoptionExpected,
  type AdoptionWrite,
  asLogPosition,
  type ControlChanges,
  type ControlSlot,
} from '@kumiai/rpc'
import { describe, expect, test, vi } from 'vitest'

import { encodeControlJournal } from '../src/control-journal.js'
import { entryCapability } from '../src/entry-capability.js'
import { createGroupHandleRegistry } from '../src/index.js'
import { groupOwnerKey } from '../src/memory-incarnation-stores.js'
import { decodeStoredValue, encodeStoredValue } from '../src/persistence-codec.js'
import type { ReadableGroupState } from '../src/registry/types.js'
import {
  createMemoryGroupPersistence,
  createMemoryTransaction,
  createOwnerQueues,
  memoryFaults,
} from '../src/testing.js'
import { createDeterministicAtRestCodec } from './fixtures/at-rest.js'
import {
  createRegistryFixture,
  type RegistryFixtureBase,
  registryFixtureRestore,
} from './fixtures/registry.js'
import { installSeed, makeStorageSeed } from './fixtures/storage-seed.js'

function hostBytes(handle: GroupHandle) {
  return encodeStoredValue({
    state: encodeClientState(handle.state),
    credential: handle.credential,
    ledger: handle.ledgerTokens,
  })
}
async function restoreHost(fixture: RegistryFixtureBase, bytes: Uint8Array): Promise<GroupHandle> {
  const host = decodeStoredValue(bytes) as Pick<
    ReadableGroupState,
    'state' | 'credential' | 'ledger'
  >
  const state = host.state === null ? undefined : decodeClientState(host.state)
  if (state === undefined || host.state === null) throw new Error('Missing host state')
  return registryFixtureRestore(fixture)({
    ...host,
    state: host.state,
    groupID: host.credential.groupID,
    incarnation: 1,
    version: 1,
    deleted: false,
    terminal: false,
    epoch: Number(state.groupContext.epoch),
    epochAuthenticator: state.keySchedule.epochAuthenticator,
    senderHWM: 0,
  })
}
function registry(
  fixture: RegistryFixtureBase,
  restoreCandidate?: (bytes: Uint8Array) => Promise<GroupHandle>,
) {
  return createGroupHandleRegistry({
    persistence: fixture.device,
    providerID: fixture.device.providerID,
    recovery: fixture.environment,
    restore: registryFixtureRestore(fixture),
    restoreCandidate: restoreCandidate ?? ((bytes) => restoreHost(fixture, bytes)),
  })
}
async function accepted(
  fixture: RegistryFixtureBase,
  access: Awaited<ReturnType<ReturnType<typeof registry>['access']>>,
  slotFor: (slot: ControlSlot) => ControlSlot | null = (slot) => slot,
) {
  const { handle, source } = await access.readControl(async ({ handle, source }) => ({
    handle,
    source,
  }))
  const candidate = await fixture.advance(handle)
  const alternate = await fixture.advance(await access.read((current) => current))
  const journal = encodeControlJournal({
    version: 1,
    source,
    checkpoint: null,
    sourceState: encodeClientState(handle.state),
    sourceCredential: handle.credential,
    sourceLedger: handle.ledgerTokens,
    candidate: hostBytes(candidate),
  })
  const slot: ControlSlot = {
    opID: 'rotation',
    incarnation: 1,
    epoch: Number(handle.epoch),
    authenticatorBefore: handle.state.keySchedule.epochAuthenticator.slice(),
    searchFrom: null,
    expectedHead: null,
    publishID: 'publish',
    payload: new Uint8Array([1, 2, 3]),
    payloadDigest: 'accepted-payload',
    digest: 'rotation-digest',
    bodies: [],
    welcome: null,
    journal,
  }
  const occupied = slotFor(slot)
  await fixture.installRows({
    key: access.key,
    control: {
      putOperations: [
        {
          id: slot.opID,
          kind: 'rotation',
          revokes: false,
          body: new Uint8Array(),
          seq: 1,
          enqueuedAt: 0,
          deadline: 30000,
          stage: 'intent',
        },
      ],
      commitOnce: occupied,
    },
  })
  const proof = {
    source: await access.readControl(async ({ source }) => source),
    from: null,
    position: asLogPosition('00001'),
    payloadDigest: slot.payloadDigest,
  }
  if (occupied !== null)
    await fixture.installRows({
      key: access.key,
      control: {
        commitOnceAcceptance: {
          ...proof,
          from: occupied.searchFrom,
          payloadDigest: occupied.payloadDigest,
        },
      },
    })
  const expected = await access.readControl(async ({ source }) => source)
  const write: AdoptionWrite = {
    mutationID: 'ordinary-adoption',
    expected: { ...expected, acceptance: proof, journal },
    anchorLanded: slot.digest,
    changes: {
      commitOnce: null,
      deleteOperations: [slot.opID],
      putApplied: [
        {
          epoch: slot.epoch,
          digest: slot.digest,
          payloadDigest: slot.payloadDigest,
          sequenceID: proof.position,
          opID: slot.opID,
          removed: false,
        },
      ],
      cursor: { position: proof.position, epoch: Number(candidate.epoch) },
    },
  }
  return { candidate, alternate, write, expected }
}
async function evidence(
  fixture: RegistryFixtureBase,
  access: { key: AdoptionExpected['key']; stateVersion(): number },
) {
  return {
    rows: await fixture.inspectRows(),
    stateVersion: access.stateVersion(),
    lifetime: await fixture.device.groups.load(access.key.groupID),
    trust: await fixture.device.groups.loadTrust(access.key.groupID),
  }
}

for (const mode of ['real-mls', 'double'] as const) {
  describe(`direct registry mutation and adoption (${mode})`, () => {
    const groupID = `direct-${mode}`
    const create = () => createRegistryFixture({ mode, groupID, setup: 'seeded' })

    test.each(['late', 'concrete'] as const)(
      '%s mutation ID binds marker, control and resolve proof',
      async (kind) => {
        const fixture = await create()
        try {
          const capability = entryCapability(fixture.device.groups)
          if (capability === null) throw new Error('Missing entry capability')
          const mutationID = `${kind}-bound`
          await capability.run(
            { groupID, mutationID: kind === 'late' ? null : mutationID },
            async (reads) => ({
              expected: await reads.lifetime(),
              mutationID: kind === 'late' ? mutationID : 'ignored-prepared-id',
              value: undefined,
            }),
            async (stores) => {
              await stores.incarnation(1).control.apply({}, mutationID)
            },
          )
          expect(
            (await fixture.inspectRows())['group-owner']?.get(groupOwnerKey(groupID)),
          ).toMatchObject({ mutationID })
          expect((await fixture.device.groups.load(groupID))?.mutationID).toBe(mutationID)
          expect(
            await fixture.device.groups.ports({ groupID, incarnation: 1 }).control.lastMutation(),
          ).toBe(mutationID)
          expect(await fixture.device.groups.resolve(groupID, mutationID)).toBe('committed')
        } finally {
          await fixture.close()
        }
      },
    )

    test('late mutation ID absent refuses before work and preserves rows', async () => {
      const fixture = await create()
      try {
        const capability = entryCapability(fixture.device.groups)
        if (capability === null) throw new Error('Missing entry capability')
        const before = await fixture.inspectRows()
        const work = vi.fn(async () => undefined)
        await expect(
          capability.run(
            { groupID, mutationID: null },
            async (reads) => ({ expected: await reads.lifetime(), value: undefined }),
            work,
          ),
        ).rejects.toThrow('mutation ID')
        expect(work).not.toHaveBeenCalled()
        expect(await fixture.inspectRows()).toEqual(before)
      } finally {
        await fixture.close()
      }
    })

    test.each(['commit', 'rollback'] as const)(
      'late mutation ID retains pending %s proof under the bound ID',
      async (outcome) => {
        const db = createMemoryTransaction({ rows: {} })
        const owners = createOwnerQueues()
        const groups = createMemoryGroupPersistence({
          db,
          owners,
          providerID: 'bound-proof-provider',
          atRest: createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(65) }),
        })
        await installSeed(
          groups,
          await makeStorageSeed({ id: groupID, incarnation: 1, epoch: 0, mode }),
          'seed',
        )
        const capability = entryCapability(groups)
        if (capability === null) throw new Error('Missing entry capability')
        const mutationID = `pending-${outcome}`
        const fault = memoryFaults(db).rejectCommitPending()
        let resolved = false
        const result = capability
          .run(
            { groupID, mutationID: null },
            async (reads) => ({ expected: await reads.lifetime(), mutationID, value: undefined }),
            async (stores) => {
              expect(owners.current()?.mutationID).toBe(mutationID)
              await stores.incarnation(1).control.apply({}, mutationID)
              return 'committed-result'
            },
          )
          .then(
            (value) => value,
            () => 'rolled-back',
          )
        try {
          await fault.barrierWaiting
          expect(owners.joinProof({ groupID }, mutationID)).not.toBeNull()
          const proof = groups.resolve(groupID, mutationID).then((value) => {
            resolved = true
            return value
          })
          await Promise.resolve()
          expect(resolved).toBe(false)
          await fault.finish(outcome)
          expect(await proof).toBe(outcome === 'commit' ? 'committed' : 'rolled-back')
          expect(await result).toBe(outcome === 'commit' ? 'committed-result' : 'rolled-back')
          expect(db.snapshot()['group-owner']?.get(groupOwnerKey(groupID))).toMatchObject({
            mutationID: outcome === 'commit' ? mutationID : 'seed',
          })
        } finally {
          await fault.finish(outcome)
          await result
        }
      },
    )

    test('concurrent mutate derives CAS in prepare', async () => {
      const fixture = await create()
      try {
        const access = await registry(fixture).access(groupID)
        const results = await Promise.all(
          [1, 2].map(() =>
            access.mutate(async (handle, persist) => {
              const next = await fixture.advance(handle)
              await persist(next)
              return Number(next.epoch)
            }),
          ),
        )
        expect(results).toEqual([1, 2])
        expect(access.stateVersion()).toBe(3)
        expect(await access.read((handle) => Number(handle.epoch))).toBe(2)
      } finally {
        await fixture.close()
      }
    })

    test('multiple persist calls save once and co-write epoch trust', async () => {
      const fixture = await create()
      try {
        const access = await registry(fixture).access(groupID)
        await access.mutate(async (handle, persist) => {
          await persist(handle)
          const next = await fixture.advance(handle)
          await persist(next)
          await persist(next)
        })
        expect(access.stateVersion()).toBe(2)
        const trust = await fixture.device.groups.loadTrust(groupID)
        expect(trust?.installed.epoch).toBe(1)
        expect(trust?.spentEpochAuthenticators).toHaveLength(2)
        expect(await access.read((handle) => Number(handle.epoch))).toBe(1)
        expect((await fixture.device.groups.load(groupID))?.revision).toBe(2)
      } finally {
        await fixture.close()
      }
    })

    test.each(['adopt', 'replace'] as const)(
      'ordinary %s installs once and proved replay is noop',
      async (method) => {
        const fixture = await create()
        try {
          const access = await registry(fixture).access(groupID)
          const { candidate, expected, write } = await accepted(fixture, access)
          await fixture.installRows({
            key: access.key,
            anchor: {
              anchor: { epoch: 0, secret: new Uint8Array(32).fill(8) },
              pending: {
                epochBefore: 0,
                epochAfter: 1,
                rosterBefore: [fixture.identity.id],
                forced: false,
                advance: 'rotation-digest',
              },
            },
          })
          // Refresh only the caller's CAS after the anchor write.
          const current = await access.readControl(async ({ source }) => source)
          write.expected = { ...write.expected, ...current }
          if (method === 'adopt')
            expect(await access.adopt(candidate, current, write)).toBe('installed')
          else await access.replace(candidate, () => write)
          expect(access.epoch()).toBe(1)
          expect(await fixture.device.groups.ports(access.key).anchor.load()).toMatchObject({
            pending: { landed: true },
          })
          const before = await evidence(fixture, access)
          if (method === 'adopt')
            expect(await access.adopt(candidate, expected, write)).toBe('noop')
          else await access.replace(candidate, () => write)
          expect(await evidence(fixture, access)).toEqual(before)
        } finally {
          await fixture.close()
        }
      },
    )

    test.each(['adopt', 'replace'] as const)(
      'A proof cannot install B through %s',
      async (method) => {
        const fixture = await create()
        try {
          const access = await registry(fixture).access(groupID)
          const { candidate, alternate, expected, write } = await accepted(fixture, access)
          expect(candidate.epoch).toBe(alternate.epoch)
          expect(candidate.state.keySchedule.epochAuthenticator).not.toEqual(
            alternate.state.keySchedule.epochAuthenticator,
          )
          const before = await evidence(fixture, access)
          const work = vi.fn()
          fixture.onPhase('work', work)
          const carry = vi.spyOn(Object.getPrototypeOf(alternate), 'carryReceiveProgress')
          try {
            if (method === 'adopt')
              expect(await access.adopt(alternate, expected, write)).toBe('moved')
            else
              await expect(access.replace(alternate, () => write)).rejects.toMatchObject({
                name: 'ControlAdoptionMovedError',
              })
            expect(carry).not.toHaveBeenCalled()
            expect(work).not.toHaveBeenCalled()
            expect(await evidence(fixture, access)).toEqual(before)
          } finally {
            carry.mockRestore()
          }
        } finally {
          await fixture.close()
        }
      },
    )

    test.each(['credential', 'state', 'progress'] as const)(
      'candidate %s mismatch refuses both methods unchanged',
      async (kind) => {
        const fixture = await create()
        try {
          const access = await registry(fixture).access(groupID)
          const { candidate, expected, write } = await accepted(fixture, access)
          if (kind === 'credential')
            Object.defineProperty(candidate, 'credential', {
              value: { ...candidate.credential, id: randomIdentity().id },
            })
          else if (kind === 'state') candidate.state.keySchedule.exporterSecret.fill(42)
          else await candidate.encrypt(new Uint8Array([9]))
          const before = await evidence(fixture, access)
          const work = vi.fn()
          fixture.onPhase('work', work)
          expect(await access.adopt(candidate, expected, write)).toBe('moved')
          await expect(access.replace(candidate, () => write)).rejects.toMatchObject({
            name: 'ControlAdoptionMovedError',
          })
          expect(work).not.toHaveBeenCalled()
          expect(await evidence(fixture, access)).toEqual(before)
        } finally {
          await fixture.close()
        }
      },
    )

    test.each(['reject', 'foreign', 'malformed', 'configuration'] as const)(
      'undecodable journal candidate (%s) refuses unchanged',
      async (kind) => {
        const fixture = await create()
        try {
          const access = await registry(fixture, async (bytes) => {
            if (kind === 'reject') throw new Error('Cannot decode host candidate')
            if (kind === 'configuration') {
              const destination = await restoreHost(fixture, bytes)
              const config = destination.context.clientConfig
              if (config === undefined) throw new Error('Missing registry client config')
              config.keyRetentionConfig = {
                ...config.keyRetentionConfig,
                retainKeysForGenerations: 1,
              }
              return destination
            }
            const handle = await fixture.makeHandle(1)
            Object.defineProperty(handle, 'groupID', {
              value: kind === 'foreign' ? 'another-group' : undefined,
            })
            return handle
          }).access(groupID)
          const { candidate, expected, write } = await accepted(fixture, access)
          const before = await evidence(fixture, access)
          const work = vi.fn()
          fixture.onPhase('work', work)
          expect(await access.adopt(candidate, expected, write)).toBe('moved')
          await expect(access.replace(candidate, () => write)).rejects.toMatchObject({
            name: 'ControlAdoptionMovedError',
          })
          expect(work).not.toHaveBeenCalled()
          expect(await evidence(fixture, access)).toEqual(before)
        } finally {
          await fixture.close()
        }
      },
    )

    test('same identity without write proof is moved', async () => {
      const fixture = await create()
      try {
        const access = await registry(fixture).access(groupID)
        const { handle, source } = await access.readControl(async ({ handle, source }) => ({
          handle,
          source,
        }))
        const journal = encodeControlJournal({
          version: 1,
          source,
          checkpoint: null,
          sourceState: encodeClientState(handle.state),
          sourceCredential: handle.credential,
          sourceLedger: handle.ledgerTokens,
          candidate: hostBytes(handle),
        })
        const write: AdoptionWrite = {
          mutationID: 'unproved',
          expected: {
            ...source,
            journal,
            acceptance: {
              source,
              from: null,
              position: asLogPosition('00001'),
              payloadDigest: 'unproved',
            },
          },
          changes: {},
        }
        const before = await evidence(fixture, access)
        expect(await access.adopt(handle, source, write)).toBe('moved')
        expect(await evidence(fixture, access)).toEqual(before)
      } finally {
        await fixture.close()
      }
    })

    test('ordinary replace refuses recovery envelope and absent provenance', async () => {
      const fixture = await create()
      try {
        const access = await registry(fixture).access(groupID)
        const { candidate, write } = await accepted(fixture, access)
        const before = await evidence(fixture, access)
        await expect(access.replace(candidate)).rejects.toMatchObject({
          name: 'RegistryRecoveryReplacementError',
        })
        if (write.expected === undefined) throw new Error('Missing accepted provenance')
        write.expected.journal = encodeStoredValue({
          version: 1,
          candidate: hostBytes(candidate),
          requestID: 'recovery',
        })
        await expect(access.replace(candidate, () => write)).rejects.toMatchObject({
          name: 'RegistryRecoveryReplacementError',
        })
        expect(await evidence(fixture, access)).toEqual(before)
      } finally {
        await fixture.close()
      }
    })

    test.each(['rollback', 'pending-rollback', 'pending-commit'] as const)(
      'mutate %s discards speculative progress until proof',
      async (kind) => {
        const fixture = await create()
        try {
          const access = await registry(fixture).access(groupID)
          const before = await access.read((handle) => encodeClientState(handle.state))
          const fault = kind === 'rollback' ? undefined : fixture.armNextWorkFault('pending')
          if (kind === 'rollback') fixture.armNextWorkFault('before-commit')
          const result = access
            .mutate(async (handle, persist) => {
              await handle.encrypt(new Uint8Array([4]))
              await persist(handle)
              return 'callback-result'
            })
            .then(
              (value) => value,
              () => 'rolled-back',
            )
          if (fault !== undefined) {
            await fault.rejected
            expect(access.stateVersion()).toBe(1)
            await fault.finish(kind === 'pending-commit' ? 'commit' : 'rollback')
          }
          expect(await result).toBe(kind === 'pending-commit' ? 'callback-result' : 'rolled-back')
          const after = await access.read((handle) => encodeClientState(handle.state))
          if (kind === 'pending-commit') expect(after).not.toEqual(before)
          else expect(after).toEqual(before)
        } finally {
          await fixture.close()
        }
      },
    )

    test('mutate stages ordinary control writes without replacement provenance', async () => {
      const fixture = await create()
      try {
        const access = await registry(fixture).access(groupID)
        const factory = vi.fn(() => ({
          mutationID: 'mutation-control',
          changes: { cursor: { position: asLogPosition('00002'), epoch: 0 } },
        }))
        expect(
          await access.mutate(async (handle, persist) => {
            await handle.encrypt(new Uint8Array([6]))
            await persist(handle)
            await persist(handle)
            return 'committed-result'
          }, factory),
        ).toBe('committed-result')
        expect(access.stateVersion()).toBe(2)
        expect(await fixture.device.groups.resolve(groupID, 'mutation-control')).toBe('committed')
        expect((await fixture.device.groups.load(groupID))?.mutationID).toBe('mutation-control')
        expect(
          (await fixture.device.groups.ports(access.key).control.load()).cursor?.position,
        ).toBe('00002')
        expect(await fixture.device.groups.ports(access.key).control.lastMutation()).toBe(
          'mutation-control',
        )
      } finally {
        await fixture.close()
      }
    })

    test.each([
      'strand',
      'stranded cursor',
      'control hold',
      'missing slot',
      'payload',
      'searchFrom',
      'journal',
      'acceptance',
    ] as const)('journal-bearing mutate refuses %s before work', async (kind) => {
      const fixture = await create()
      try {
        const access = await registry(fixture).access(groupID)
        const { candidate, write } = await accepted(fixture, access, (slot) => {
          if (kind === 'missing slot') return null
          return {
            ...slot,
            ...(kind === 'payload' ? { payloadDigest: 'another-payload' } : {}),
            ...(kind === 'searchFrom' ? { searchFrom: asLogPosition('00000') } : {}),
            ...(kind === 'journal' ? { journal: new Uint8Array([9]) } : {}),
          }
        })
        const control = await fixture.device.groups.ports(access.key).control.load()
        if (control.commitOnceAcceptance === null && kind !== 'missing slot')
          throw new Error('Missing accepted slot')
        let changes: ControlChanges
        if (kind === 'strand') changes = { strand: { reason: 'retention-gap' } }
        else if (kind === 'stranded cursor')
          changes = {
            cursor: { position: asLogPosition('00000'), epoch: 0, stranded: true },
          }
        else if (kind === 'control hold')
          changes = {
            controlHold: { reason: 'unsupported-version', position: null },
          }
        else if (kind === 'acceptance') {
          const proof = write.expected?.acceptance
          if (proof === undefined) throw new Error('Missing write acceptance')
          changes = {
            commitOnceAcceptance: {
              ...proof,
              position: asLogPosition('00002'),
            },
          }
        } else changes = {}
        await fixture.installRows({ key: access.key, control: changes })
        write.expected = {
          ...write.expected,
          ...(await access.readControl(async ({ source }) => source)),
        }
        const before = await evidence(fixture, access)
        const work = vi.fn()
        fixture.onPhase('work', work)
        await expect(
          access.mutate(
            async (_handle, persist) => {
              await persist(candidate)
            },
            () => write,
          ),
        ).rejects.toMatchObject({ name: 'ControlAdoptionMovedError' })
        expect(work).not.toHaveBeenCalled()
        expect(await evidence(fixture, access)).toEqual(before)
      } finally {
        await fixture.close()
      }
    })

    test.each(['marker', 'applied', 'control mutation', 'unproved'] as const)(
      'journal-bearing mutate replay with %s proof does not save again',
      async (kind) => {
        const fixture = await create()
        try {
          const access = await registry(fixture).access(groupID)
          const { candidate, expected, write } = await accepted(fixture, access)
          if (kind === 'marker' || kind === 'control mutation') write.changes.putApplied = []
          expect(await access.adopt(candidate, expected, write)).toBe('installed')
          if (kind === 'applied') {
            await fixture.installRows({
              key: access.key,
              control: { cursor: { position: asLogPosition('00002'), epoch: 1 } },
            })
          } else if (kind === 'control mutation') {
            await fixture.installRows({ key: access.key, anchor: null })
          } else if (kind === 'unproved') {
            await fixture.installRows({ key: access.key, control: { deleteAppliedFrom: 0 } })
          }
          const before = await evidence(fixture, access)
          const work = vi.fn()
          fixture.onPhase('work', work)
          const result = access.mutate(
            async (_handle, persist) => {
              await persist(candidate)
              return 'replay-result'
            },
            () => write,
          )
          if (kind === 'unproved')
            await expect(result).rejects.toMatchObject({ name: 'ControlAdoptionMovedError' })
          else expect(await result).toBe('replay-result')
          expect(work).not.toHaveBeenCalled()
          expect(await evidence(fixture, access)).toEqual(before)
        } finally {
          await fixture.close()
        }
      },
    )

    test('journal-bearing mutate installs accepted ordinary state and control together', async () => {
      const fixture = await create()
      try {
        const access = await registry(fixture).access(groupID)
        const { candidate, write } = await accepted(fixture, access)
        const version = access.stateVersion()
        expect(
          await access.mutate(
            async (_handle, persist) => {
              await persist(candidate)
              return 'installed-result'
            },
            () => write,
          ),
        ).toBe('installed-result')
        expect(access.epoch()).toBe(1)
        expect(access.stateVersion()).toBe(version + 1)
        const control = fixture.device.groups.ports(access.key).control
        expect(await control.load()).toMatchObject({
          commitOnce: null,
          cursor: { position: '00001', epoch: 1 },
        })
        expect(await control.lastMutation()).toBe(write.mutationID)
        expect(await fixture.device.groups.loadTrust(groupID)).toMatchObject({
          installed: { epoch: 1 },
        })
      } finally {
        await fixture.close()
      }
    })

    test('caught rejected persist preserves the accepted state, control and mutation ID', async () => {
      const fixture = await create()
      try {
        const access = await registry(fixture).access(groupID)
        const foreign = await fixture.makeHandle(0, 'foreign-group')
        const beforeTrust = await fixture.device.groups.loadTrust(groupID)
        let state: Uint8Array | undefined
        let attempts = 0
        expect(
          await access.mutate(
            async (handle, persist) => {
              await handle.encrypt(new Uint8Array([6]))
              state = encodeClientState(handle.state)
              await persist(handle)
              await expect(persist(foreign)).rejects.toThrow()
              return 'accepted-result'
            },
            () => {
              attempts++
              return {
                mutationID: attempts === 1 ? 'accepted-persist' : 'rejected-persist',
                changes: {
                  cursor: { position: asLogPosition(attempts === 1 ? '00002' : '00003'), epoch: 0 },
                },
              }
            },
          ),
        ).toBe('accepted-result')
        expect(await access.read((handle) => encodeClientState(handle.state))).toEqual(state)
        expect(access.stateVersion()).toBe(2)
        expect(await fixture.device.groups.loadTrust(groupID)).toEqual(beforeTrust)
        const control = fixture.device.groups.ports(access.key).control
        expect((await control.load()).cursor?.position).toBe('00002')
        expect(await control.lastMutation()).toBe('accepted-persist')
        expect(await fixture.device.groups.load(groupID)).toMatchObject({
          revision: 2,
          mutationID: 'accepted-persist',
        })
        expect(
          (await fixture.inspectRows())['group-owner']?.get(groupOwnerKey(groupID)),
        ).toMatchObject({
          mutationID: 'accepted-persist',
        })
        expect(await fixture.device.groups.resolve(groupID, 'accepted-persist')).toBe('committed')
        await expect(
          fixture.device.groups.resolve(groupID, 'rejected-persist'),
        ).rejects.toMatchObject({
          name: 'GroupStateUncertainError',
        })
      } finally {
        await fixture.close()
      }
    })

    test('persist stages bytes rather than retaining a mutable callback handle', async () => {
      const fixture = await create()
      try {
        const access = await registry(fixture).access(groupID)
        let staged: Uint8Array | undefined
        await access.mutate(async (handle, persist) => {
          await handle.encrypt(new Uint8Array([7]))
          staged = encodeClientState(handle.state)
          await persist(handle)
          await handle.encrypt(new Uint8Array([8]))
        })
        expect(await access.read((handle) => encodeClientState(handle.state))).toEqual(staged)
      } finally {
        await fixture.close()
      }
    })

    test('ordinary candidate carries committed progress', async () => {
      const fixture = await create()
      try {
        const access = await registry(fixture).access(groupID)
        const { candidate, write } = await accepted(fixture, access)
        await access.mutate(async (handle, persist) => {
          await handle.encrypt(new Uint8Array([5]))
          await persist(handle)
        })
        const tree = await access.read((handle) => structuredClone(handle.state.secretTree))
        const expected = await access.readControl(async ({ source }) => source)
        write.expected = { ...write.expected, ...expected }
        expect(await access.adopt(candidate, expected, write)).toBe('installed')
        expect(
          await access.read((handle) => handle.state.historicalReceiverData.get(0n)?.secretTree),
        ).toEqual(tree)
      } finally {
        await fixture.close()
      }
    })
  })
}
