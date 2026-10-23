import { decodeClientState, encodeClientState, restoreGroup, withCommitPermit } from '@kumiai/mls'
import {
  createGroupPeer,
  type InternalOperations,
  type LogHub,
  OperationRejectedError,
  type OperationRequest,
  type Outcome,
} from '@kumiai/rpc'
import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  autoRotationRequest,
  buildKeyRotation,
  createAutoRotationScheduler,
  decodeAutoRotationCandidate,
  ROTATION_IDENTITY_SUPERSEDED,
} from '../src/auto-rotation.js'
import * as api from '../src/index.js'
import { decodeStoredValue } from '../src/persistence-codec.js'
import { listRetiredOutcomes, retireIncarnation } from '../src/registry/retired.js'
import { registryRetirement } from '../src/registry/retirement.js'
import { registryLeaseSnapshot } from '../src/testing.js'
import { createRegistryLeaseFixture } from './fixtures/registry-lease.js'
import {
  buildSealedMemoryOperation,
  restoreMemoryControlHandle,
  restoreMemoryControlSource,
  sealedMemoryValidation,
} from './fixtures/sealed-memory-mls.js'
import {
  makeStorageSeed,
  nextChange,
  writeInstallationCheckpoint,
} from './fixtures/storage-seed.js'

const { FakeHub } = (await import(
  new URL('../../rpc/test/fixtures/fake-hub.ts', import.meta.url).href
)) as { FakeHub: new () => LogHub }

afterEach(() => {
  vi.useRealTimers()
})

test('rotation operation IDs are deterministic 128-bit identity digests', () => {
  const identity = {
    groupID: 'rotation-identity',
    incarnation: 1,
    epoch: 1,
    authenticator: new Uint8Array(32).fill(71),
  }
  const request = autoRotationRequest(identity)
  expect(request.id).toMatch(/^kumiai\/internal\/rotation\/[0-9a-f]{32}$/)
  expect(autoRotationRequest({ ...identity })).toEqual(request)
  expect(autoRotationRequest({ ...identity, epoch: 2 }).id).not.toBe(request.id)
})

describe.each(['real-mls', 'double'] as const)('%s auto-rotation', (mode) => {
  test('a settled host ID cannot overwrite its retained outcome and can be reused after ack', async () => {
    const f = await createRegistryLeaseFixture(mode)
    const fixture = f.fixture()
    const ports = fixture.device.groups.ports(f.key)
    const mls = await api.createRegistryGroupMLS({
      registry: fixture.registry,
      key: f.key,
      recovery: fixture.environment,
      target: { targetID: 'id-reuse-hub', topicID: 'id-reuse-commits' },
      identity: fixture.identity,
      entrySlot: api.createLedgerEntrySlot(),
    })
    const peer = createGroupPeer({
      mls,
      hub: new FakeHub(),
      crypto: api.createGroupCrypto({ access: f.access() }),
      control: ports.control,
      anchorStore: ports.anchor,
      appCursorStore: ports.cursor,
      appOutbox: ports.outbox,
      appOutboxLimit: 16,
      localDID: fixture.identity.id,
      protocols: {},
      handlers: {},
      prepareBuild: async (operation) => ({
        kind: 'rejected',
        operation,
        reason: 'No host candidate',
      }),
      validation: { restoreValidation: async () => null },
      readEvidence: () => fixture.device.groups.readEvidence(f.key),
      adopt: async () => {
        throw new Error('No candidate to adopt')
      },
      deliverWelcome: async () => {},
    })
    try {
      const request: OperationRequest = {
        id: 'retained-host-id',
        kind: 'ledger',
        body: new Uint8Array(),
        revokes: false,
      }
      await peer.enqueue(request)
      await vi.waitFor(async () => expect(await peer.outcomes()).toHaveLength(1))
      const outcome = (await peer.outcomes())[0]
      if (outcome === undefined) throw new Error('Missing final outcome')
      expect(outcome).toMatchObject({ opID: request.id, kind: 'rejected' })
      const before = await ports.control.load()
      await expect(peer.enqueue(request)).rejects.toBeInstanceOf(OperationRejectedError)
      expect(await ports.control.load()).toEqual(before)
      await peer.ack(outcome.id)
      await peer.enqueue(request)
      await vi.waitFor(async () => expect(await peer.outcomes()).toHaveLength(1))
      expect((await peer.outcomes())[0]?.id).not.toBe(outcome.id)
    } finally {
      await peer.dispose()
      await peer.drained()
      await fixture.registry.dispose()
    }
  })
  test('a superseded rejection resets retry backoff', async () => {
    const f = await createRegistryLeaseFixture(mode, 'seed', 500)
    vi.useFakeTimers()
    const scheduler = createAutoRotationScheduler({ access: f.access() })
    try {
      const requests: Array<OperationRequest> = []
      scheduler.bind({
        enqueue: async (request) => {
          requests.push(request)
        },
      })
      await vi.advanceTimersByTimeAsync(0)
      const request = requests[0]
      if (request === undefined) throw new Error('Missing rotation request')
      await scheduler.onOutcome({
        id: 'rejected',
        opID: request.id,
        kind: 'rejected',
        reason: 'pending proposals',
        at: Date.now(),
      })
      await vi.advanceTimersByTimeAsync(250)
      expect(requests).toHaveLength(2)
      await scheduler.onOutcome({
        id: 'superseded',
        opID: request.id,
        kind: 'rejected',
        reason: ROTATION_IDENTITY_SUPERSEDED,
        at: Date.now(),
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(requests).toHaveLength(3)
      await scheduler.onOutcome({
        id: 'rejected-again',
        opID: request.id,
        kind: 'rejected',
        reason: 'pending proposals',
        at: Date.now(),
      })
      await vi.advanceTimersByTimeAsync(249)
      expect(requests).toHaveLength(3)
      await vi.advanceTimersByTimeAsync(1)
      expect(requests).toHaveLength(4)
    } finally {
      scheduler.stop()
      vi.useRealTimers()
      await f.fixture().registry.dispose()
    }
  })
  test('the lease fixture rotation handoff starts a fresh reserved range', async () => {
    const f = await createRegistryLeaseFixture(mode, 'seed', 500)
    try {
      await f.rotate()
      expect(f.access().epoch()).toBe(1)
      expect(f.lease()).toMatchObject({ own: 0, limit: 16 })
    } finally {
      await f.fixture().registry.dispose()
    }
  })
  test('an unbuilt stale internal intent is rejected before construction', async () => {
    const f = await createRegistryLeaseFixture(mode, 'seed', 500)
    try {
      const identity = f.access().runtime.snapshot()
      if (identity === null) throw new Error('Missing identity')
      const control = f.fixture().device.groups.ports(f.key).control
      const request = autoRotationRequest({ ...identity, incarnation: identity.incarnation + 1 })
      const op = {
        ...request,
        stage: 'intent' as const,
        seq: 1,
        enqueuedAt: Date.now(),
        deadline: Date.now() + 30000,
      }
      await control.apply({ putOperations: [op] }, crypto.randomUUID())
      const unreachable = vi.fn(async (): Promise<never> => {
        throw new Error('Stale intent reached construction')
      })
      const port = api.createControlBuildPort({
        access: api.createRegistryHandleAccess({ access: f.access() }),
        control,
        build: unreachable,
        rotate: unreachable,
        restoreCandidate: unreachable,
        saveBuilt: unreachable,
        now: Date.now,
        newID: () => crypto.randomUUID(),
      })
      expect(await port.prepareBuild(op, unreachable)).toMatchObject({
        kind: 'rejected',
        reason: ROTATION_IDENTITY_SUPERSEDED,
      })
      expect(unreachable).not.toHaveBeenCalled()
      expect((await control.load()).commitOnce).toBeNull()
    } finally {
      await f.fixture().registry.dispose()
    }
  })
  test('a rotation candidate adapter fault rejects once and backs off', async () => {
    const f = await createRegistryLeaseFixture(mode, 'seed', 500)
    const scheduler = createAutoRotationScheduler({ access: f.access() })
    try {
      const identity = f.access().runtime.snapshot()
      if (identity === null) throw new Error('Missing identity')
      const control = f.fixture().device.groups.ports(f.key).control
      const request = autoRotationRequest(identity)
      const op = {
        ...request,
        stage: 'intent' as const,
        seq: 1,
        enqueuedAt: Date.now(),
        deadline: Date.now() + 30_000,
      }
      await control.apply({ putOperations: [op] }, crypto.randomUUID())
      const unreachable = async (): Promise<never> => {
        throw new Error('Unexpected build save')
      }
      const restoreCandidate = vi.fn(async (): Promise<never> => {
        throw new TypeError('Host adapter cannot decode the library envelope')
      })
      const port = api.createControlBuildPort({
        access: api.createRegistryHandleAccess({ access: f.access() }),
        control,
        build: unreachable,
        rotate: mode === 'double' ? buildSealedMemoryOperation : undefined,
        restoreSource: async ({ state, credential, ledgerEntries }) => {
          const decoded = decodeClientState(state)
          if (decoded === undefined) throw new Error('Missing source')
          return (mode === 'double' ? restoreMemoryControlSource : restoreGroup)({
            state: decoded,
            credential,
            ledgerEntries,
            options: f.fixture().environment.options,
          })
        },
        restoreCandidate,
        saveBuilt: unreachable,
        now: Date.now,
        newID: () => crypto.randomUUID(),
      })
      const result = await port.prepareBuild(op, unreachable)
      expect(result).toMatchObject({ kind: 'rejected', operation: op })
      expect(restoreCandidate).toHaveBeenCalledOnce()
      expect((await control.load()).commitOnce).toBeNull()
      await control.apply({ deleteOperations: [op.id] }, crypto.randomUUID())
      vi.useFakeTimers()
      const requests: Array<OperationRequest> = []
      scheduler.bind({
        enqueue: async (row) => {
          requests.push(row)
        },
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(requests).toHaveLength(1)
      if (result.kind !== 'rejected') throw new Error('Missing refusal')
      await scheduler.onOutcome({
        id: 'adapter-refusal',
        opID: op.id,
        at: Date.now(),
        kind: 'rejected',
        reason: result.reason,
      })
      await vi.advanceTimersByTimeAsync(249)
      expect(requests).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(requests).toHaveLength(2)
    } finally {
      scheduler.stop()
      vi.useRealTimers()
      await f.fixture().registry.dispose()
    }
  })
  test.each(['landed', 'withheld', 'proposals', 'live-bound', 'retired'] as const)(
    'reopen at 500 uses the private producer: %s',
    async (scenario) => {
      const withheld = scenario === 'withheld' || scenario === 'retired'
      const f = await createRegistryLeaseFixture(
        mode,
        'seed',
        scenario === 'live-bound' ? 484 : 500,
      )
      if (scenario === 'proposals') await f.writeElsewhere('proposal')
      if (scenario !== 'live-bound') await f.reopen()
      const fixture = f.fixture()
      const hub = new FakeHub()
      if (withheld) vi.spyOn(hub, 'publish').mockResolvedValue({ sequenceID: 'withheld-position' })
      const onOutcome = vi.fn()
      const publishErrors = vi.fn()
      const preparations: Array<string> = []
      let producer: InternalOperations | undefined
      let privateEnqueue: ((request: OperationRequest) => Promise<void>) | undefined
      const privateRequests: Array<OperationRequest> = []
      const hostBuild = vi.fn(async (): Promise<never> => {
        throw new Error('Host builder called for rotation')
      })
      let publicEnqueue: ReturnType<typeof vi.spyOn> | undefined
      const restore = async (bytes: Uint8Array) => {
        const candidate = decodeAutoRotationCandidate(bytes)
        const state = decodeClientState(candidate.state)
        if (state === undefined) throw new Error('Missing candidate')
        return (mode === 'double' ? restoreMemoryControlHandle : restoreGroup)({
          state,
          credential: candidate.credential,
          ledgerEntries: candidate.ledger,
          options: fixture.environment.options,
        })
      }
      const owner = await api.createRegistryPeer({
        registry: fixture.registry,
        key: f.key,
        recovery: fixture.environment,
        target: { targetID: 'rotation-hub', topicID: 'rotation-commits' },
        continuation: api.createRecoveryContinuationPort({
          registry: fixture.registry,
          persistence: fixture.device.groups,
        }),
        createMLS: (key) =>
          api.createRegistryGroupMLS({
            registry: fixture.registry,
            key,
            recovery: fixture.environment,
            target: { targetID: 'rotation-hub', topicID: 'rotation-commits' },
            identity: fixture.identity,
            entrySlot: api.createLedgerEntrySlot(),
          }),
        createPeer: async (key, options) => {
          producer = options.internalOperations
          if (producer !== undefined) {
            const bind = producer.bind
            producer.bind = (capability) => {
              privateEnqueue = capability.enqueue
              bind({
                enqueue: async (request) => {
                  privateRequests.push(request)
                  await capability.enqueue(request)
                },
              })
            }
          }
          const rawAccess = await fixture.registry.access(key.groupID)
          const access = api.createRegistryHandleAccess({ access: rawAccess })
          const ports = fixture.device.groups.ports(key)
          const buildPort = api.createControlBuildPort({
            access,
            control: ports.control,
            build: hostBuild,
            rotate: mode === 'double' ? buildSealedMemoryOperation : undefined,
            restoreCandidate: restore,
            restoreSource: async ({ state, credential, ledgerEntries }) => {
              const decoded = decodeClientState(state)
              if (decoded === undefined) throw new Error('Missing source')
              return (mode === 'double' ? restoreMemoryControlSource : restoreGroup)({
                state: decoded,
                credential,
                ledgerEntries,
                options: fixture.environment.options,
              })
            },
            saveBuilt: api.createPersistenceBuildSaver({ persistence: fixture.device.groups, key }),
            now: Date.now,
            newID: () => crypto.randomUUID(),
          })
          const peer = createGroupPeer({
            ...options,
            hub,
            crypto: api.createGroupCrypto({ access: rawAccess }),
            control: ports.control,
            anchorStore: ports.anchor,
            appCursorStore: ports.cursor,
            appOutbox: ports.outbox,
            appOutboxLimit: 16,
            localDID: fixture.identity.id,
            protocols: {},
            handlers: {},
            onOutcome,
            onControlPublishError: publishErrors,
            prepareBuild: async (...args) => {
              const result = await buildPort.prepareBuild(...args)
              preparations.push(result.kind)
              return result
            },
            validation:
              mode === 'double'
                ? sealedMemoryValidation()
                : api.createControlValidationPort({
                    identity: fixture.identity,
                    options: fixture.environment.options,
                    restoreCandidate: restore,
                  }),
            readEvidence: () => fixture.device.groups.readEvidence(key),
            adopt: api.createControlAdoptionPort({
              access,
              control: ports.control,
              restoreCandidate: restore,
            }).adopt,
            deliverWelcome: async () => {},
          })
          publicEnqueue = vi.spyOn(peer, 'enqueue')
          return peer
        },
      })
      try {
        await owner.ready
        if (scenario === 'live-bound') {
          expect(privateRequests).toEqual([])
          expect(f.admission().admissible).toBe(true)
          for (let index = 0; index < 16; index++) await f.sealEphemeral()
        }
        const control = fixture.device.groups.ports(f.key).control
        if (withheld) {
          await vi.waitFor(
            async () =>
              expect((await control.load()).commitOnce?.acceptedAs).toBe('withheld-position'),
            { timeout: 3000 },
          )
          const built = (await control.load()).commitOnce
          expect(built?.revokes).toBe(false)
          expect(f.admission()).toMatchObject({ reason: 'rotation-required' })
          expect((await control.load()).controlHold).toBeNull()
          const request = privateRequests[0]
          if (request === undefined || privateEnqueue === undefined)
            throw new Error('Missing private request')
          const before = await control.load()
          await expect(privateEnqueue(request)).rejects.toBeInstanceOf(OperationRejectedError)
          expect(await control.load()).toEqual(before)
          if (scenario === 'retired') {
            const destination = { ...f.key, incarnation: 2 }
            const seed = await makeStorageSeed({
              id: f.key.groupID,
              incarnation: 2,
              epoch: 1,
              mode,
              identity: fixture.identity,
              options: fixture.environment.options,
            })
            const retirement = registryRetirement(fixture.registry).beginRetirement(f.key)
            await retirement.drain()
            expect(owner.peer()).toBeNull()
            const groups = fixture.device.groups
            const mutationID = crypto.randomUUID()
            await groups.transition(
              await nextChange(groups, f.key.groupID, mutationID),
              async (stores) => {
                const lifetime = await stores.lifetime.load()
                const trust = await stores.trust.load()
                if (lifetime === null || trust === null) throw new Error('Missing source metadata')
                await retireIncarnation(stores, {
                  source: f.key,
                  nextIncarnation: 2,
                  mutationID,
                  at: Date.now(),
                })
                await stores.lifetime.save({
                  ...lifetime,
                  latestIncarnation: 2,
                  activeIncarnation: 2,
                  revision: lifetime.revision + 1,
                  mutationID,
                })
                await stores.incarnation(2).state.save(seed.state)
                await stores.trust.save({
                  ...seed.trust,
                  genesisAnchor: trust.genesisAnchor,
                  spentEpochAuthenticators: trust.spentEpochAuthenticators,
                })
                await writeInstallationCheckpoint(stores, {
                  key: destination,
                  confirmedTranscriptHash: seed.confirmedTranscriptHash,
                  mutationID,
                  stateVersion: seed.state.version,
                })
              },
            )
            retirement.settle('committed')
            expect(await listRetiredOutcomes({ persistence: groups, key: f.key })).toEqual([])
            expect((await control.load()).outcomes).toEqual([])
            expect(onOutcome).not.toHaveBeenCalled()
            await fixture.registry.delete(destination)
            expect((await groups.load(f.key.groupID))?.activeIncarnation).toBeNull()
            return
          }
          vi.useFakeTimers()
          await producer?.onOutcome({
            id: 'clock-report',
            opID: built?.opID ?? null,
            kind: 'unknown',
            at: Date.now(),
          })
          await vi.advanceTimersByTimeAsync(60_000)
          expect(privateRequests).toHaveLength(1)
          expect((await control.load()).commitOnce?.publishID).toBe(built?.publishID)
          await owner.peer()?.abandon()
          await vi.advanceTimersByTimeAsync(0)
          await vi.waitFor(async () => expect((await control.load()).outcomes).toEqual([]))
          expect((await control.load()).spentSource).toEqual({
            epoch: f.access().epoch(),
            opID: built?.opID,
          })
          await vi.advanceTimersByTimeAsync(60_000)
          expect(privateRequests).toHaveLength(1)
          expect((await control.load()).operations).toEqual([])
          expect((await control.load()).commitOnce).toBeNull()
        } else {
          if (scenario === 'proposals') {
            await vi.waitFor(() => expect(preparations).toEqual(['rejected']))
            vi.useFakeTimers()
            await producer?.onOutcome({
              id: 'rejected-report',
              opID: privateRequests[0]?.id ?? null,
              kind: 'rejected',
              reason: 'pending proposals',
              at: Date.now(),
            })
            await vi.advanceTimersByTimeAsync(15_000)
            expect(preparations.length).toBeLessThanOrEqual(7)
            expect(preparations.every((kind) => kind === 'rejected')).toBe(true)
            await f.access().mutate(async (handle) => {
              handle.state.unappliedProposals = {}
            })
            await vi.advanceTimersByTimeAsync(1000)
            await owner.peer()?.replay()
            expect(f.access().epoch()).toBe(1)
            vi.useRealTimers()
          }
          await vi.waitFor(
            async () => {
              await owner.peer()?.replay()
              expect(f.access().epoch()).toBe(1)
            },
            { timeout: 3000 },
          )
          await vi.waitFor(async () => expect((await control.load()).outcomes).toEqual([]))
          expect(registryLeaseSnapshot(f.access())).toMatchObject({ own: 0, limit: 16 })
          expect((await control.load()).commitOnce).toBeNull()
        }
        expect(onOutcome).not.toHaveBeenCalled()
        expect(publicEnqueue).not.toHaveBeenCalled()
        expect(hostBuild).not.toHaveBeenCalled()
        expect(await owner.peer()?.outcomes()).toEqual([])
      } finally {
        vi.useRealTimers()
        owner.dispose()
        await owner.drained()
        await fixture.registry.dispose()
      }
    },
  )
  test('a non-admin builds an empty non-revoking rotation at the bound', async () => {
    const f = await createRegistryLeaseFixture(mode, 'welcome')
    try {
      const access = f.access()
      const identity = access.runtime.snapshot()
      if (identity === null) throw new Error('Missing identity')
      const request = autoRotationRequest(identity)
      expect(request.revokes).toBe(false)
      const handle = f.group?.group.members[0]?.handle
      if (handle === undefined) throw new Error('Missing member')
      expect(handle.roster.roles.get(handle.credential.id)).toBe('member')
      const op = { ...request, stage: 'intent' as const, seq: 1, enqueuedAt: 0, deadline: 30000 }
      const build = mode === 'double' ? buildSealedMemoryOperation : buildKeyRotation
      const before = encodeClientState(handle.state)
      const { value, receipt } = await withCommitPermit(
        async () => {
          const permitted = await (mode === 'double' ? restoreMemoryControlSource : restoreGroup)({
            state: structuredClone(handle.state),
            credential: handle.credential,
            ledgerEntries: handle.ledgerTokens,
            options: f.fixture().environment.options,
          })
          Reflect.set(permitted, 'sendAdmission', () => ({
            epoch: Number(permitted.epoch),
            admissible: false,
            reason: 'rotation-required',
          }))
          return permitted
        },
        (permitted) => build(op, permitted),
      )
      expect(value).toMatchObject({ bodies: [], welcome: null, epoch: identity.epoch })
      expect(receipt).not.toBeNull()
      expect(value.journal).not.toEqual(before)
      const candidate = decodeStoredValue(value.journal) as {
        ledger: Array<string>
        credential: typeof handle.credential
        state: Uint8Array
      }
      expect(candidate.ledger).toEqual(handle.ledgerTokens)
      expect(candidate.credential).toEqual(handle.credential)
      expect(decodeClientState(candidate.state)?.groupContext.epoch).toBe(handle.epoch + 1n)
    } finally {
      await f.fixture().registry.dispose()
    }
  })

  test.each(['identity', 'proposals', 'inactive', 'admission'] as const)(
    'refuses %s before authoring',
    async (guard) => {
      const f = await createRegistryLeaseFixture(mode)
      try {
        const access = f.access()
        const identity = access.runtime.snapshot()
        if (identity === null) throw new Error('Missing identity')
        const handle = await f.fixture().makeHandle(0)
        const request = autoRotationRequest({
          ...identity,
          groupID: handle.groupID,
          epoch: Number(handle.epoch),
          authenticator: handle.state.keySchedule.epochAuthenticator,
        })
        if (guard === 'identity') request.id += '/stale'
        if (guard === 'proposals') handle.state.unappliedProposals = await f.proposal()
        if (guard === 'inactive') handle.state.groupActiveState = { kind: 'removedFromGroup' }
        if (guard === 'admission')
          vi.spyOn(handle, 'sendAdmission').mockReturnValue({
            epoch: Number(handle.epoch),
            admissible: false,
            reason: 'lapsed',
          })
        const before = encodeClientState(handle.state)
        const build = mode === 'double' ? buildSealedMemoryOperation : buildKeyRotation
        await expect(
          build({ ...request, stage: 'intent', seq: 1, enqueuedAt: 0, deadline: 30000 }, handle),
        ).rejects.toMatchObject({ name: 'OperationRejectedError' })
        expect(encodeClientState(handle.state)).toEqual(before)
      } finally {
        await f.fixture().registry.dispose()
      }
    },
  )

  test('startup at 500 enqueues privately once, and outcomes re-evaluate admission', async () => {
    const f = await createRegistryLeaseFixture(mode, 'seed', 500)
    const scheduler = createAutoRotationScheduler({ access: f.access() })
    try {
      const enqueue = vi.fn(async (_request: OperationRequest) => {})
      scheduler.bind({ enqueue })
      await vi.waitFor(() => expect(enqueue).toHaveBeenCalledOnce())
      const request = enqueue.mock.calls[0]?.[0]
      expect(request?.id).toMatch(/^kumiai\/internal\//)
      expect(request?.revokes).toBe(false)
      const outcome: Outcome = { id: 'closed', opID: request?.id ?? null, kind: 'lost', at: 1 }
      await scheduler.onOutcome(outcome)
      await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(2))
      vi.spyOn(f.access(), 'admission').mockReturnValue({
        epoch: f.access().epoch(),
        admissible: true,
      })
      await scheduler.onOutcome(outcome)
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
      expect(enqueue).toHaveBeenCalledTimes(2)
    } finally {
      scheduler.stop()
      await f.fixture().registry.dispose()
    }
  })
})

test('rejections and enqueue failures back off, while eligibility changes reset the delay', async () => {
  const f = await createRegistryLeaseFixture('double', 'seed', 500)
  vi.useFakeTimers()
  const scheduler = createAutoRotationScheduler({ access: f.access() })
  try {
    let request: OperationRequest | undefined
    const enqueue = vi.fn(async (value: OperationRequest) => {
      request = value
      if (enqueue.mock.calls.length === 1) throw new Error('enqueue unavailable')
    })
    scheduler.bind({ enqueue })
    await vi.advanceTimersByTimeAsync(0)
    expect(enqueue).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(249)
    expect(enqueue).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(enqueue).toHaveBeenCalledTimes(2)
    for (let index = 0; index < 8; index++) {
      await scheduler.onOutcome({
        id: `rejected-${index}`,
        opID: request?.id ?? null,
        kind: 'rejected',
        reason: 'pending proposals',
        at: 1,
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(enqueue).toHaveBeenCalledTimes(index + 2)
      await vi.advanceTimersByTimeAsync(15000)
    }
    scheduler.stop()
    const count = enqueue.mock.calls.length
    await vi.advanceTimersByTimeAsync(60000)
    expect(enqueue).toHaveBeenCalledTimes(count)
  } finally {
    scheduler.stop()
    vi.useRealTimers()
    await f.fixture().registry.dispose()
  }
})
