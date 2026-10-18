import { encodeEventFrame } from '@kumiai/broadcast'
import {
  ApplicationSendRefusedError,
  bindSendCeiling,
  type ControllerBinding,
  decodeClientState,
  type GroupHandle,
  type HoldingToken,
  ownApplicationGeneration,
  relinquishSend,
} from '@kumiai/mls'
import { serializeHandle } from '@kumiai/mls/testing'
import { encodeAppAAD, frameID } from '@kumiai/rpc'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { entryCapability } from '../src/entry-capability.js'
import { createLedgerEntrySlot } from '../src/mls.js'
import { GroupUnavailableError } from '../src/persistence-errors.js'
import * as reservations from '../src/registry/reserve.js'
import { recoveryTrustFor } from '../src/registry/trust.js'
import { createRegistryGroupMLS } from '../src/registry-group-mls.js'
import { deferred } from '../src/runtime.js'
import { restoreCommittedSender } from '../src/testing.js'
import {
  createRegistryFixture,
  type RegistryFixture,
  registryFixtureRestore,
} from './fixtures/registry.js'
import { createRegistryCryptoGroup } from './fixtures/registry-crypto.js'

const fixtures: Array<RegistryFixture> = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()))
})
async function setup(mode: 'real-mls' | 'double', seeded = false) {
  const fixture = await createRegistryFixture({
    mode,
    setup: seeded ? 'seeded' : 'empty',
    groupID: 'reservation',
  })
  fixtures.push(fixture)
  return fixture
}
async function stored(fixture: RegistryFixture, incarnation = 1) {
  const record = await fixture.device.groups.loadState({ groupID: 'reservation', incarnation })
  if (record === null || record.deleted || record.state === null) throw new Error('Missing state')
  const state = decodeClientState(record.state)
  if (state === undefined) throw new Error('Invalid state')
  return { record: { ...record, state: record.state }, generation: ownApplicationGeneration(state) }
}

function unmodifiedRestore(
  fixture: RegistryFixture,
  mode: 'real-mls' | 'double',
): ReturnType<typeof registryFixtureRestore> {
  return async (record) => {
    const { restoreGroup } = await import('@kumiai/mls')
    const { restoreMemoryControlHandle } = await import('./fixtures/sealed-memory-mls.js')
    const state = decodeClientState(record.state)
    if (state === undefined) throw new Error('Invalid test state')
    return (mode === 'real-mls' ? restoreGroup : restoreMemoryControlHandle)({
      state,
      credential: record.credential,
      ledgerEntries: record.ledger,
      options: fixture.environment.options,
    })
  }
}

for (const mode of ['real-mls', 'double'] as const) {
  describe(`installation reservations (${mode})`, () => {
    test('seed advances only the stored state and transfers ownership', async () => {
      const fixture = await setup(mode)
      const input = await fixture.makeHandle(0)
      const before = fixture.restoreCount('reservation')
      await fixture.registry.seed(input, { packageUse: null })
      const saved = await stored(fixture)
      expect(saved.generation).toBe(16)
      expect(saved.record.senderHWM).toBe(16)
      expect(fixture.restoreCount('reservation') - before).toBe(1)
      expect(ownApplicationGeneration(input.state)).toBe(0)
      await expect(input.encrypt(new Uint8Array([1]))).rejects.toBeInstanceOf(
        ApplicationSendRefusedError,
      )
      expect(() => bindSendCeiling(input, () => 100)).toThrow(TypeError)
    })

    test('later-incarnation seed keeps reservation identity, pre and envelope aligned', async () => {
      const fixture = await setup(mode)
      const welcome = await fixture.welcomeHistory('ordinary')
      await fixture.registry.seed(welcome.exact, { packageUse: welcome.packageUse })
      const reserve = vi.spyOn(reservations, 'reserveFromBytes')
      const envelopeFor = vi.spyOn(reservations, 'reservationEnvelope')
      const key = await fixture.registry.seed(welcome.newer, {
        replace: true,
        packageUse: welcome.packageUse,
      })
      expect(key.incarnation).toBe(2)
      const result = await reserve.mock.results[0]?.value
      expect(result.reservation.identity.incarnation).toBe(key.incarnation)
      expect(result.reservation.pre.incarnation).toBe(key.incarnation)
      const saved = (await stored(fixture, key.incarnation)).record
      const envelope = envelopeFor.mock.results[0]?.value
      expect(envelope.saved).toEqual(saved)
      expect(envelope.saved.incarnation).toBe(key.incarnation)
      expect(result.reservation.pre.epoch).toBe(envelope.saved.epoch)
    })

    test('Welcome seed and recovery switch reserve in their installing write', async () => {
      const fixture = await setup(mode)
      const welcome = await fixture.welcomeHistory('ordinary')
      await fixture.registry.seed(welcome.exact, { packageUse: welcome.packageUse })
      expect((await stored(fixture)).generation).toBe(16)
      const recovery = await fixture.confirmedRecovery(
        { groupID: 'reservation', incarnation: 1 },
        { confirm: true },
      )
      await fixture.registry.switchIncarnation(recovery.candidate, {
        source: recovery.source,
        rejoinID: recovery.record.id,
        proof: recovery.proof,
        write: {
          mutationID:
            'format' in recovery.record
              ? (recovery.record.switchMutationID ?? crypto.randomUUID())
              : crypto.randomUUID(),
          source: { rejoinID: recovery.record.id },
          destination: {
            control: {
              cursor: {
                position: recovery.proof.position,
                epoch: Number(recovery.candidate.epoch),
              },
            },
          },
        },
      })
      expect((await stored(fixture, 2)).generation).toBe(16)
      expect((await stored(fixture, 2)).record.senderHWM).toBe(16)
      await expect(recovery.candidate.encrypt(new Uint8Array([1]))).rejects.toBeInstanceOf(
        ApplicationSendRefusedError,
      )
    })

    test('ordinary adoption reserves the new epoch from zero despite the old ceiling', async () => {
      const fixture = await setup(mode, true)
      const old = await stored(fixture)
      await fixture.installRows({
        key: { groupID: 'reservation', incarnation: 1 },
        state: { ...old.record, version: old.record.version + 1, senderHWM: 480 },
      })
      const access = await fixture.registry.access('reservation')
      const accepted = await fixture.acceptedOrdinary(access)
      await access.replace(accepted.candidate, () => accepted.write)
      const saved = await stored(fixture)
      expect(saved.generation).toBe(16)
      expect(saved.record.senderHWM).toBe(16)
    })

    test('same identity saves keep the capture and lift legacy sender progress', async () => {
      const fixture = await setup(mode, true)
      const access = await fixture.registry.access('reservation')
      const before = fixture.restoreCount('reservation')
      await access.mutate(async (input, persist) => {
        await input.encrypt(new Uint8Array([1]))
        await persist(input)
      })
      const saved = await stored(fixture)
      expect(saved.generation).toBe(1)
      expect(saved.record.senderHWM).toBe(1)
      // One mutation handle plus one private restore of the captured state.
      expect(fixture.restoreCount('reservation') - before).toBe(2)
    })

    test('seed drains an unrelated serializer before capturing, and refuses later sends', async () => {
      const fixture = await setup(mode)
      const input = await fixture.makeHandle(0)
      await input.encrypt(new Uint8Array([0]))
      const started = deferred<void>()
      const release = deferred<void>()
      const holding = serializeHandle(input, async () => {
        started.resolve()
        await release.promise
        const ratchet = input.state.secretTree.leafNodes[0]?.application
        if (ratchet === undefined) throw new Error('Missing ratchet')
        ratchet.generation = 7
      })
      await started.promise
      let settled = false
      const install = fixture.registry.seed(input, { packageUse: null }).finally(() => {
        settled = true
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(settled).toBe(false)
      release.resolve()
      await holding
      await install
      expect((await stored(fixture)).generation).toBe(23)
      await expect(input.encrypt(new Uint8Array([1]))).rejects.toBeInstanceOf(
        ApplicationSendRefusedError,
      )
    })

    test.each([0, 489, 499, 500])(
      'seed caps a generation %s reservation at 500',
      async (generation) => {
        const fixture = await setup(mode)
        const input = await fixture.makeHandle(0)
        await input.encrypt(new Uint8Array([1]))
        const ratchet = input.state.secretTree.leafNodes[0]?.application
        if (ratchet === undefined) throw new Error('Missing sender')
        ratchet.generation = generation
        const reserve = vi.spyOn(reservations, 'reserveFromBytes')
        await fixture.registry.seed(input, { packageUse: null })
        const saved = await stored(fixture)
        expect(saved.generation).toBe(Math.min(generation + 16, 500))
        expect(saved.record.senderHWM).toBe(saved.generation)
        const result = await reserve.mock.results[0]?.value
        expect(saved.record.state).toEqual(result.state)
        if (generation === 500) expect(result.reservation).toBeNull()
        else
          expect(result.reservation).toMatchObject({ start: generation, limit: saved.generation })
        const raw = await restoreCommittedSender(fixture.registry, 'reservation')
        expect((await raw.encryptApplication(new Uint8Array([1]))).generation).toBe(
          saved.generation,
        )
      },
    )

    test.each(['removed', 'proposal'] as const)(
      'ineligible %s seed commits without reserving',
      async (kind) => {
        const fixture = await setup(mode)
        const input = await fixture.makeHandle(0)
        if (kind === 'removed') input.state.groupActiveState = { kind: 'removedFromGroup' }
        if (kind === 'proposal') {
          const { createGroup } = await import('@kumiai/mls')
          const source = (
            await createGroup(fixture.identity, 'reservation', fixture.environment.options)
          ).group
          await source.proposeSelfRemoval()
          input.state.unappliedProposals = structuredClone(source.state.unappliedProposals)
        }
        const reserve = vi.spyOn(reservations, 'reserveFromBytes')
        await fixture.registry.seed(input, { packageUse: null })
        const result = await reserve.mock.results[0]?.value
        expect(result.reservation).toBeNull()
        expect((await stored(fixture)).generation).toBe(0)
        expect((await stored(fixture)).record.terminal).toBe(false)
        const capability = entryCapability(fixture.device.groups)
        if (capability === null) throw new Error('Missing entry capability')
        const facts = await capability.read('reservation', (reads) => reads.checkpoints())
        expect(facts.some((fact) => fact.kind === 'publication')).toBe(true)
      },
    )

    test('eligibility binds the own leaf lapse bit independently of state', async () => {
      const fixture = await setup(mode)
      const input = await fixture.makeHandle(0)
      const active = reservations.eligibilityOf(input.state, false)
      expect(reservations.eligibilityOf(input.state, true)).not.toEqual(active)
      const reserve = vi.spyOn(reservations, 'reserveFromBytes')
      await fixture.registry.seed(input, { packageUse: null })
      const result = await reserve.mock.results[0]?.value
      expect(result.reservation.eligibility).toEqual(active)
    })

    test('a controller floor lapses an install even when the remaining tree does not', async () => {
      const { timedBinding, rawCommit } = (await import(
        new URL('../../mls/test/fixtures/lifecycle-pipeline.ts', import.meta.url).href
      )) as {
        timedBinding(params: {
          identity: RegistryFixture['identity']
          iat: number
          exp: number
        }): Promise<ControllerBinding>
        rawCommit(params: {
          group: GroupHandle
          tokens: Array<string>
        }): Promise<{ newState: GroupHandle['state'] }>
      }
      const { createGroup, restoreGroup, signLedgerEntry, DEVICE_ENTRY_TYPE } = await import(
        '@kumiai/mls'
      )
      const { registryHandle } = await import('./fixtures/registry-welcome.js')
      vi.spyOn(Date, 'now').mockReturnValue(150_000)
      const fixture = await setup(mode)
      const binding = await timedBinding({ identity: fixture.identity, iat: 100, exp: 200 })
      const { group } = await createGroup(fixture.identity, 'reservation', { controller: binding })
      const token = await signLedgerEntry(fixture.identity, {
        type: DEVICE_ENTRY_TYPE,
        groupID: group.groupID,
        subject: binding.id,
        value: { op: 'clock', time: 201 },
      })
      const committed = await rawCommit({ group, tokens: [token] })
      const canonical = await restoreGroup({
        state: committed.newState,
        credential: group.credential,
        ledgerEntries: [token],
      })
      const input = await registryHandle({
        mode,
        handle: canonical,
        options: fixture.environment.options,
      })
      expect(input.registry.controllers.get(binding.id)?.timeFloor).toBe(201)
      const withoutFloor = await restoreGroup({
        state: committed.newState,
        credential: group.credential,
        ledgerEntries: [token],
      })
      const controller = withoutFloor.registry.controllers.get(binding.id)
      if (controller === undefined) throw new Error('Missing controller floor')
      controller.timeFloor = 0
      expect(withoutFloor.state.ratchetTree).toEqual(input.state.ratchetTree)
      expect(withoutFloor.ownLeafLapsed()).toBe(false)
      expect(input.ownLeafLapsed()).toBe(true)
      const reserve = vi.spyOn(reservations, 'reserveFromBytes')
      await fixture.registry.seed(input, {
        packageUse: { sourceID: 'floor', ref: 'lapsed', kind: 'ordinary' },
      })
      const result = await reserve.mock.results[0]?.value
      expect(result.reservation).toBeNull()
      expect((await stored(fixture)).record.state).toEqual(fixture.stateBytes(input))
      expect((await stored(fixture)).generation).toBe(0)
    })

    test('same identity writes refuse a generation regression without saving', async () => {
      const fixture = await setup(mode)
      const input = await fixture.makeHandle(0)
      await fixture.registry.seed(input, { packageUse: null })
      const before = await stored(fixture)
      const access = await fixture.registry.access('reservation')
      await expect(access.mutate(async (_current, persist) => persist(input))).rejects.toThrow()
      expect((await stored(fixture)).record).toEqual(before.record)
    })

    test('persist waits for a held serializer before deriving the capture', async () => {
      const fixture = await setup(mode, true)
      const access = await fixture.registry.access('reservation')
      await access.mutate(async (input, persist) => {
        await input.encrypt(new Uint8Array([1]))
        const entered = deferred<void>()
        const released = deferred<void>()
        const holder = serializeHandle(input, async () => {
          entered.resolve()
          await released.promise
          const node = input.state.secretTree.leafNodes[0]
          if (node === undefined) throw new Error('Missing sender')
          node.application.generation = 3
        })
        await entered.promise
        let settled = false
        const saving = persist(input).then(() => {
          settled = true
        })
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(settled).toBe(false)
        released.resolve()
        await holder
        await saving
      })
      expect((await stored(fixture)).generation).toBe(3)
    })

    test.each(['commit', 'rollback', 'unknown'] as const)(
      'caller sends refuse during reservation with %s proof',
      async (outcome) => {
        const fixture = await setup(mode)
        const input = await fixture.makeHandle(0)
        const pending = outcome === 'unknown' ? fixture.armNextWorkFault('pending') : undefined
        if (outcome === 'rollback') fixture.armNextWorkFault('before-commit')
        const barrier = fixture.holdRestore('reservation')
        const installing = fixture.registry.seed(input, { packageUse: null })
        const installed = installing.then(
          () => true,
          () => false,
        )
        await barrier.started
        await expect(input.encrypt(new Uint8Array([1]))).rejects.toBeInstanceOf(
          ApplicationSendRefusedError,
        )
        barrier.release()
        if (pending !== undefined) {
          await pending.rejected
          await pending.finish('rollback')
        }
        expect(await installed).toBe(outcome === 'commit')
        await expect(input.encrypt(new Uint8Array([1]))).rejects.toBeInstanceOf(
          ApplicationSendRefusedError,
        )
      },
    )

    test('incoming commit forwards its holding token through the MLS adapter and reserves', async () => {
      const group = await createRegistryCryptoGroup(mode, 'incoming-reservation', 1)
      const fixture = group.fixture()
      fixtures.push(fixture)
      const local = group.group.members[0]
      if (local === undefined) throw new Error('Missing local member')
      const mls = await createRegistryGroupMLS({
        registry: fixture.registry,
        key: group.key,
        identity: local.identity,
        entrySlot: local.slot,
        recovery: fixture.environment,
        target: { targetID: 'reservation', topicID: 'commits' },
      })
      const { commitKeyRotation } = await import('@kumiai/mls')
      const { memoryModel } = await import('./fixtures/sealed-memory-mls.js')
      const commit =
        mode === 'real-mls'
          ? (await commitKeyRotation(group.group.committer.handle)).commitMessage
          : memoryModel(group.group.committer.handle).buildCommit([])
      const reserve = vi.spyOn(reservations, 'reserveFromBytes')
      const applying =
        mode === 'real-mls'
          ? mls.processCommit(commit, { resolveLedgerEntries: async () => [] })
          : group.access().mutate((handle, persist) => handle.processMessage(commit, { persist }))
      const bounded = new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Persist token deadlock')), 2000)
        void applying.finally(() => clearTimeout(timer)).catch(() => {})
      })
      const applied = await Promise.race([applying, bounded])
      if (mode === 'real-mls') expect(applied).toMatchObject({ advanced: true })
      const record = await fixture.device.groups.loadState(group.key)
      if (record === null || record.deleted || record.state === null)
        throw new Error('Missing installation')
      const state = decodeClientState(record.state)
      if (state === undefined) throw new Error('Invalid installation')
      expect(ownApplicationGeneration(state)).toBe(16)
      expect(record.senderHWM).toBe(16)
      const result = await reserve.mock.results[0]?.value
      expect(result.reservation).toMatchObject({ start: 0, limit: 16 })
      expect(record.state).toEqual(result.state)
    })

    test('incoming persist derives only from the capture while its caller holds the serializer', async () => {
      const group = await createRegistryCryptoGroup(mode, 'incoming-isolation', 1)
      const fixture = group.fixture()
      fixtures.push(fixture)
      const { commitKeyRotation } = await import('@kumiai/mls')
      const { memoryModel } = await import('./fixtures/sealed-memory-mls.js')
      const commit =
        mode === 'real-mls'
          ? (await commitKeyRotation(group.group.committer.handle)).commitMessage
          : memoryModel(group.group.committer.handle).buildCommit([])
      const reads: Array<string> = []
      await group.access().mutate(async (input, persist) =>
        input
          .processMessage(commit, {
            persist: async (candidate, ctx) => {
              let armed = false
              for (const key of [
                'state',
                'epoch',
                'credential',
                'ledgerTokens',
                'listMembers',
                'exportSecret',
              ] as const) {
                const value = Reflect.get(candidate, key, candidate)
                Object.defineProperty(candidate, key, {
                  configurable: true,
                  get() {
                    if (armed) reads.push(key)
                    return typeof value === 'function' ? value.bind(candidate) : value
                  },
                })
              }
              armed = true
              try {
                await persist(candidate, ctx)
              } finally {
                armed = false
              }
            },
          })
          .then(() => {}),
      )
      expect(reads).toEqual(['state', 'ledgerTokens', 'credential'])
      expect(await fixture.device.groups.loadState(group.key)).toMatchObject({ senderHWM: 16 })
    })

    test.each(['seed', 'switch', 'replace', 'adopt', 'persist', 'persist-journal'] as const)(
      'relinquish-isolation for %s',
      async (path) => {
        const fixture = await setup(mode, path !== 'seed')
        let input: GroupHandle
        let accept: () => Promise<unknown>
        if (path === 'seed') {
          input = await fixture.makeHandle(0)
          accept = () => fixture.registry.seed(input, { packageUse: null })
        } else if (path === 'switch') {
          const recovery = await fixture.confirmedRecovery(
            { groupID: 'reservation', incarnation: 1 },
            { confirm: true },
          )
          input = recovery.candidate
          const options = {
            source: recovery.source,
            rejoinID: recovery.record.id,
            proof: recovery.proof,
            write: {
              mutationID:
                'format' in recovery.record
                  ? (recovery.record.switchMutationID ?? crypto.randomUUID())
                  : crypto.randomUUID(),
              source: { rejoinID: recovery.record.id },
              destination: {
                control: {
                  cursor: { position: recovery.proof.position, epoch: Number(input.epoch) },
                },
              },
            },
          }
          accept = () => fixture.registry.switchIncarnation(input, options)
        } else {
          const access = await fixture.registry.access('reservation')
          if (path === 'replace' || path === 'adopt' || path === 'persist-journal') {
            const accepted = await fixture.acceptedOrdinary(access)
            input = accepted.candidate
            accept =
              path === 'replace'
                ? () => access.replace(input, () => accepted.write)
                : path === 'adopt'
                  ? async () => {
                      if (accepted.write.expected === undefined)
                        throw new Error('Missing adoption source')
                      return access.adopt(input, accepted.write.expected, accepted.write)
                    }
                  : () =>
                      access.mutate(
                        async (_current, persist) => persist(input),
                        () => accepted.write,
                      )
          } else {
            input = await access.read((handle) => handle)
            accept = () => access.mutate(async (_handle, persist) => persist(input))
          }
        }
        const reads: Array<string> = []
        let armed = false
        // Preserve canonical identity: an outer Proxy would be rejected before transfer.
        for (const key of [
          'state',
          'epoch',
          'groupID',
          'credential',
          'ledgerTokens',
          'listMembers',
          'exportSecret',
          'confirmAdopted',
        ] as const) {
          const value = Reflect.get(input, key, input)
          Object.defineProperty(input, key, {
            configurable: true,
            get() {
              // confirmAdopted only flushes queued events; it touches no captured state.
              if (armed && key !== 'confirmAdopted') reads.push(key)
              return typeof value === 'function' ? value.bind(input) : value
            },
          })
        }
        armed = true
        await accept()
        armed = false
        expect(reads).toEqual(['state', 'ledgerTokens', 'credential'])
      },
    )

    test.each(['seed', 'replace', 'persist-journal', 'persist-same', 'switch'] as const)(
      'already admitted encrypt drains before %s acceptance',
      async (path) => {
        const fixture = await setup(mode, path !== 'seed')
        let input: GroupHandle
        let accept: () => Promise<unknown>
        if (path === 'seed') {
          input = await fixture.makeHandle(0)
          accept = () => fixture.registry.seed(input, { packageUse: null })
        } else if (path === 'switch') {
          const recovery = await fixture.confirmedRecovery(
            { groupID: 'reservation', incarnation: 1 },
            { confirm: true },
          )
          input = recovery.candidate
          const options = {
            source: recovery.source,
            rejoinID: recovery.record.id,
            proof: recovery.proof,
            write: {
              mutationID:
                'format' in recovery.record
                  ? (recovery.record.switchMutationID ?? crypto.randomUUID())
                  : crypto.randomUUID(),
              source: { rejoinID: recovery.record.id },
              destination: {
                control: {
                  cursor: { position: recovery.proof.position, epoch: Number(input.epoch) },
                },
              },
            },
          }
          accept = () => fixture.registry.switchIncarnation(input, options)
        } else {
          const access = await fixture.registry.access('reservation')
          if (path === 'persist-same') {
            input = await access.read((handle) => handle)
            accept = () => access.mutate(async (_current, persist) => persist(input))
          } else {
            const accepted = await fixture.acceptedOrdinary(access)
            input = accepted.candidate
            accept =
              path === 'replace'
                ? () => access.replace(input, () => accepted.write)
                : () =>
                    access.mutate(
                      async (_current, persist) => persist(input),
                      () => accepted.write,
                    )
          }
        }
        const before = await fixture.inspectRows()
        const entered = deferred<void>()
        const released = deferred<void>()
        let unblock: () => void
        if (mode === 'double' && path !== 'switch') {
          const { blockMemoryEncrypt } = await import('./fixtures/sealed-memory-mls.js')
          const barrier = blockMemoryEncrypt(input)
          unblock = barrier.release
          void barrier.started.then(() => entered.resolve())
        } else {
          const signature = input.context.cipherSuite.signature
          const sign = signature.sign
          vi.spyOn(signature, 'sign').mockImplementation(async (...args) => {
            entered.resolve()
            await released.promise
            return sign(...args)
          })
          unblock = () => released.resolve()
        }
        const sending = input.encryptApplication(new Uint8Array([1]))
        await entered.promise
        let finished = false
        const accepting = accept()
          .then(
            () => ({ installed: true }),
            (error: unknown) => ({ installed: false, error }),
          )
          .finally(() => {
            finished = true
          })
        try {
          await new Promise((resolve) => setTimeout(resolve, 20))
          expect(finished).toBe(false)
        } finally {
          unblock()
        }
        const frame = await sending
        const result = await accepting
        expect(frame.generation).toBe(0)
        if (path === 'seed') {
          expect(result.installed).toBe(true)
          expect((await stored(fixture)).generation).toBe(17)
        } else if (path === 'persist-same') {
          expect(result.installed).toBe(true)
          expect((await stored(fixture)).generation).toBe(1)
        } else {
          expect(result.installed).toBe(false)
          expect(await fixture.inspectRows()).toEqual(before)
          if ('error' in result)
            expect(result.error).toMatchObject({
              name: path === 'switch' ? 'RegistryResyncRefusedError' : 'ControlAdoptionMovedError',
            })
        }
        await expect(input.encrypt(new Uint8Array([2]))).rejects.toBeInstanceOf(
          ApplicationSendRefusedError,
        )
      },
    )

    test('switch validates its write before reading the supplied source', async () => {
      const fixture = await setup(mode, true)
      const input = await fixture.makeHandle(1)
      const before = await fixture.inspectRows()
      const source = vi.fn(() => {
        throw new Error('source read before validation')
      })
      const options = {
        get source() {
          return source()
        },
        write: {},
      } as unknown as Parameters<typeof fixture.registry.switchIncarnation>[1]
      await expect(fixture.registry.switchIncarnation(input, options)).rejects.toThrow(
        'Restricted registry switch write required',
      )
      expect(source).not.toHaveBeenCalled()
      expect(await fixture.inspectRows()).toEqual(before)
      await expect(input.encrypt(new Uint8Array([1]))).rejects.toBeInstanceOf(
        ApplicationSendRefusedError,
      )
    })

    test.each(['replace', 'adopt', 'ordinary', 'persist', 'seed', 'switch'] as const)(
      'private restore failure refuses %s without saving',
      async (path) => {
        const fixture = await setup(mode, true)
        const access = await fixture.registry.access('reservation')
        let input: GroupHandle
        let accept: () => Promise<unknown>
        if (path === 'seed') {
          const welcome = await fixture.welcomeHistory('ordinary')
          input = welcome.newer
          accept = () =>
            fixture.registry.seed(input, { replace: true, packageUse: welcome.packageUse })
        } else if (path !== 'switch') {
          const accepted = await fixture.acceptedOrdinary(access)
          input = accepted.candidate
          accept =
            path === 'adopt'
              ? async () => {
                  if (accepted.write.expected === undefined)
                    throw new Error('Missing adoption source')
                  return access.adopt(input, accepted.write.expected, accepted.write)
                }
              : path === 'persist'
                ? () => access.mutate(async (_handle, persist) => persist(input))
                : () =>
                    access.replace(input, path === 'ordinary' ? undefined : () => accepted.write)
        } else {
          const recovery = await fixture.confirmedRecovery(access.key, { confirm: true })
          input = recovery.candidate
          const options = {
            source: recovery.source,
            rejoinID: recovery.record.id,
            proof: recovery.proof,
            write: {
              mutationID:
                'format' in recovery.record
                  ? (recovery.record.switchMutationID ?? crypto.randomUUID())
                  : crypto.randomUUID(),
              source: { rejoinID: recovery.record.id },
              destination: {
                control: {
                  cursor: { position: recovery.proof.position, epoch: Number(input.epoch) },
                },
              },
            },
          }
          accept = () => fixture.registry.switchIncarnation(input, options)
        }
        const before = await fixture.inspectRows()
        const restore = unmodifiedRestore(fixture, mode)
        let restores = 0
        fixture.overrideRestore(async (record) => {
          if (path === 'persist' && restores++ === 0) return restore(record)
          throw new Error('private restore fault')
        })
        await expect(accept()).rejects.toMatchObject({
          name: 'GroupUnavailableError',
          reason: 'invalid',
        })
        expect(await fixture.inspectRows()).toEqual(before)
        expect(access.runtime.snapshot()).toBeNull()
        await expect(access.read(() => {})).rejects.toMatchObject({
          name: 'DisplacedGroupHandleError',
        })
        await expect(input.encrypt(new Uint8Array([1]))).rejects.toBeInstanceOf(
          ApplicationSendRefusedError,
        )
        const reopened = await fixture.reopen()
        fixtures.push(reopened)
        const current = await reopened.registry.access('reservation')
        expect(current.runtime.snapshot()?.available).toBe(true)
        expect(await reopened.inspectRows()).toEqual(before)
      },
    )

    test.each(['ordinary', 'persist'] as const)(
      'noncanonical private restore invalidates %s access without saving',
      async (path) => {
        const fixture = await setup(mode, true)
        const access = await fixture.registry.access('reservation')
        const accepted = await fixture.acceptedOrdinary(access)
        const before = await fixture.inspectRows()
        const restore = unmodifiedRestore(fixture, mode)
        let restores = 0
        fixture.overrideRestore(async (record) => {
          if (path === 'persist' && restores++ === 0) return restore(record)
          return new Proxy(await restore(record), {})
        })
        await expect(
          path === 'persist'
            ? access.mutate(async (_handle, persist) => persist(accepted.candidate))
            : access.replace(accepted.candidate),
        ).rejects.toMatchObject({ name: 'GroupUnavailableError', reason: 'invalid' })
        expect(await fixture.inspectRows()).toEqual(before)
        expect(access.runtime.snapshot()).toBeNull()
        await expect(access.read(() => {})).rejects.toMatchObject({
          name: 'DisplacedGroupHandleError',
        })
        await expect(accepted.candidate.encrypt(new Uint8Array([1]))).rejects.toBeInstanceOf(
          ApplicationSendRefusedError,
        )
        const reopened = await fixture.reopen()
        fixtures.push(reopened)
        expect((await reopened.registry.access('reservation')).runtime.snapshot()?.available).toBe(
          true,
        )
        expect(await reopened.inspectRows()).toEqual(before)
      },
    )

    test.each(['reject', 'noncanonical'] as const)(
      'displaced access private restore %s preserves its replacement owner',
      async (fault) => {
        const fixture = await setup(mode, true)
        const accessA = await fixture.registry.access('reservation')
        const accepted = await fixture.acceptedOrdinary(accessA)
        const restore = unmodifiedRestore(fixture, mode)
        fixture.overrideRestore(async () => {
          throw new Error('displace first owner')
        })
        await expect(accessA.read(() => {})).rejects.toMatchObject({ reason: 'invalid' })
        fixture.overrideRestore(restore)
        const accessB = await fixture.registry.access('reservation')
        expect(accessB).not.toBe(accessA)
        const before = await fixture.inspectRows()
        fixture.overrideRestore(async (record) => {
          if (fault === 'reject') throw new Error('stale private restore fault')
          return new Proxy(await restore(record), {})
        })
        if (accepted.write.expected === undefined) throw new Error('Missing adoption source')
        await expect(
          accessA.adopt(accepted.candidate, accepted.write.expected, accepted.write),
        ).rejects.toMatchObject({ name: 'GroupUnavailableError', reason: 'invalid' })
        fixture.overrideRestore(restore)
        expect(accessB.runtime.snapshot()?.available).toBe(true)
        expect(await fixture.registry.access('reservation')).toBe(accessB)
        expect(await accessB.read((handle) => handle.credential.id)).toBe(fixture.identity.id)
        expect(await fixture.inspectRows()).toEqual(before)
      },
    )

    test('an unconsumed persist token for another handle waits without consuming authorization', async () => {
      const fixture = await setup(mode, true)
      const input = await fixture.restoreCommittedSender()
      const other = await fixture.restoreCommittedSender()
      const before = await relinquishSend(await fixture.restoreCommittedSender())
      const entered = deferred<void>()
      const release = deferred<void>()
      const holder = serializeHandle(other, async () => {
        entered.resolve()
        await release.promise
      })
      await entered.promise
      let borrowed!: Promise<unknown>
      let settled = false
      try {
        await input.bootstrapLedger(input.ledgerTokens, {
          persist: async (candidate, ctx) => {
            borrowed = relinquishSend(other, ctx).then(
              (value) => {
                settled = true
                return value
              },
              (error: unknown) => {
                settled = true
                return error
              },
            )
            await new Promise((resolve) => setTimeout(resolve, 20))
            expect(settled).toBe(false)
            const intended = relinquishSend(candidate, ctx)
            const bounded = new Promise<never>((_resolve, reject) => {
              const timer = setTimeout(() => reject(new Error('Persist token deadlock')), 2000)
              void intended.finally(() => clearTimeout(timer)).catch(() => {})
            })
            expect((await Promise.race([intended, bounded])).state).toEqual(before.state)
            expect(settled).toBe(false)
          },
        })
      } finally {
        release.resolve()
        await holder
      }
      expect(await borrowed).toMatchObject({ state: before.state })
    })

    test('incoming persist restore failure keeps the committed source and the caller denied', async () => {
      const group = await createRegistryCryptoGroup(mode, 'incoming-fault', 1)
      const fixture = group.fixture()
      fixtures.push(fixture)
      const source = await fixture.device.groups.loadState(group.key)
      if (source === null || source.deleted || source.state === null)
        throw new Error('Missing source')
      const { commitKeyRotation, restoreGroup } = await import('@kumiai/mls')
      const { memoryModel, restoreMemoryControlHandle } = await import(
        './fixtures/sealed-memory-mls.js'
      )
      const commit =
        mode === 'real-mls'
          ? (await commitKeyRotation(group.group.committer.handle)).commitMessage
          : memoryModel(group.group.committer.handle).buildCommit([])
      const access = group.access()
      const before = await fixture.inspectRows()
      fixture.overrideRestore(async (record) => {
        if (record.epoch !== source.epoch) throw new Error('private restore fault')
        const state = decodeClientState(record.state)
        if (state === undefined) throw new Error('Missing source state')
        return (mode === 'real-mls' ? restoreGroup : restoreMemoryControlHandle)({
          state,
          credential: record.credential,
          ledgerEntries: record.ledger,
          options: fixture.environment.options,
        })
      })
      let transferred: GroupHandle | undefined
      await expect(
        access.mutate(async (input, persist) => {
          transferred = input
          await input.processMessage(commit, { persist })
        }),
      ).rejects.toMatchObject({ name: 'GroupUnavailableError', reason: 'invalid' })
      expect(await fixture.inspectRows()).toEqual(before)
      if (transferred === undefined) throw new Error('Missing transferred handle')
      await expect(transferred.encrypt(new Uint8Array([1]))).rejects.toBeInstanceOf(
        ApplicationSendRefusedError,
      )
      expect(access.runtime.snapshot()).toBeNull()
      await expect(access.read(() => {})).rejects.toMatchObject({
        name: 'DisplacedGroupHandleError',
      })
      const reopened = await fixture.reopen()
      fixtures.push(reopened)
      expect(
        (await reopened.registry.access(group.key.groupID)).runtime.snapshot()?.available,
      ).toBe(true)
      expect(await reopened.device.groups.loadState(group.key)).toEqual(source)
    })

    test('an expired unconsumed persist token waits for the current holder', async () => {
      const fixture = await setup(mode, true)
      const input = await fixture.restoreCommittedSender()
      let context: { holding?: HoldingToken } | undefined
      await input.bootstrapLedger(input.ledgerTokens, {
        persist: async (_candidate, ctx) => {
          context = ctx
        },
      })
      const entered = deferred<void>()
      const release = deferred<void>()
      const holder = serializeHandle(input, async () => {
        entered.resolve()
        await release.promise
      })
      await entered.promise
      let captured = false
      const transfer = relinquishSend(input, context).then((value) => {
        captured = true
        return value
      })
      try {
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(captured).toBe(false)
      } finally {
        release.resolve()
        await holder
      }
      await transfer
      expect(captured).toBe(true)
    })

    test.each(['commit', 'rollback'] as const)(
      'borrowed persist token waits for the bootstrap holder to %s',
      async (outcome) => {
        const fixture = await setup(mode, true)
        const input = await fixture.restoreCommittedSender()
        const before = await relinquishSend(await fixture.restoreCommittedSender())
        const entered = deferred<void>()
        const release = deferred<void>()
        let borrowed!: Promise<Awaited<ReturnType<typeof relinquishSend>>>
        let captured = false
        const holder = input.bootstrapLedger(input.ledgerTokens, {
          persist: async (candidate, ctx) => {
            await relinquishSend(candidate, ctx)
            borrowed = relinquishSend(candidate, ctx).then((value) => {
              captured = true
              return value
            })
            entered.resolve()
            await release.promise
            if (outcome === 'rollback') throw new Error('bootstrap rollback')
          },
        })
        const completion = holder.then(
          () => null,
          (error: unknown) => error,
        )
        await entered.promise
        try {
          await new Promise((resolve) => setTimeout(resolve, 20))
          expect(captured).toBe(false)
        } finally {
          release.resolve()
        }
        expect(await completion).toEqual(
          outcome === 'commit' ? null : new Error('bootstrap rollback'),
        )
        expect((await borrowed).state).toEqual(before.state)
        expect(captured).toBe(true)
      },
    )

    test.each(['commit', 'rollback'] as const)(
      'borrowed persist token waits for the incoming-commit holder to %s',
      async (outcome) => {
        const group = await createRegistryCryptoGroup(mode, 'borrowed-incoming', 1)
        const fixture = group.fixture()
        fixtures.push(fixture)
        const { commitKeyRotation } = await import('@kumiai/mls')
        const { memoryModel } = await import('./fixtures/sealed-memory-mls.js')
        const commit =
          mode === 'real-mls'
            ? (await commitKeyRotation(group.group.committer.handle)).commitMessage
            : memoryModel(group.group.committer.handle).buildCommit([])
        const access = group.access()
        const epoch = access.epoch()
        const before = await fixture.inspectRows()
        const entered = deferred<void>()
        const release = deferred<void>()
        let borrowed!: Promise<Awaited<ReturnType<typeof relinquishSend>>>
        let captured = false
        const holder = access.mutate(async (input, persist) => {
          await input.processMessage(commit, {
            persist: async (candidate, ctx) => {
              await persist(candidate, ctx)
              borrowed = relinquishSend(candidate, ctx).then((value) => {
                captured = true
                return value
              })
              entered.resolve()
              await release.promise
              if (outcome === 'rollback') throw new Error('receive rollback')
            },
          })
        })
        const completion = holder.then(
          () => null,
          (error: unknown) => error,
        )
        await entered.promise
        try {
          await new Promise((resolve) => setTimeout(resolve, 20))
          expect(captured).toBe(false)
        } finally {
          release.resolve()
        }
        expect(await completion).toEqual(
          outcome === 'commit' ? null : new Error('receive rollback'),
        )
        const state = decodeClientState((await borrowed).state)
        if (state === undefined) throw new Error('Missing borrowed capture')
        expect(Number(state.groupContext.epoch)).toBe(outcome === 'commit' ? epoch + 1 : epoch)
        if (outcome === 'rollback') expect(await fixture.inspectRows()).toEqual(before)
      },
    )

    test('bootstrapLedger forwards the holding token through the MLS adapter', async () => {
      const fixture = await setup(mode, true)
      const access = await fixture.registry.access('reservation')
      const tokens = await access.read((handle) => handle.ledgerTokens)
      const mls = await createRegistryGroupMLS({
        registry: fixture.registry,
        key: access.key,
        identity: fixture.identity,
        entrySlot: createLedgerEntrySlot(),
        recovery: fixture.environment,
        target: { targetID: 'bootstrap', topicID: 'commits' },
      })
      const before = access.stateVersion()
      const bootstrapping = mls.bootstrapLedger(tokens)
      const bounded = new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Bootstrap token deadlock')), 2000)
        void bootstrapping.finally(() => clearTimeout(timer)).catch(() => {})
      })
      await Promise.race([bootstrapping, bounded])
      expect(access.stateVersion()).toBe(before + 1)
    })

    test('a caller commit after capture cannot change the saved installation', async () => {
      const group = await createRegistryCryptoGroup(mode, 'capture-race', 1)
      fixtures.push(group.fixture())
      const input = await group.fixture().restoreCommittedSender(group.key.groupID)
      const sourceEpoch = Number(input.epoch)
      const authenticator = input.state.keySchedule.epochAuthenticator.slice()
      const own = ownApplicationGeneration(input.state)
      const local = group.group.members[0]
      if (local === undefined) throw new Error('Missing local member')
      const fixture = await createRegistryFixture({
        mode,
        setup: 'empty',
        groupID: group.key.groupID,
        identity: local.identity,
        options: group.fixture().environment.options,
      })
      fixtures.push(fixture)
      const restore = fixture.holdRestore(group.key.groupID)
      const installing = fixture.registry.seed(input, {
        packageUse: { sourceID: 'capture', ref: 'race', kind: 'ordinary' },
      })
      await restore.started
      const { commitKeyRotation } = await import('@kumiai/mls')
      const { memoryModel } = await import('./fixtures/sealed-memory-mls.js')
      const commit =
        mode === 'real-mls'
          ? (await commitKeyRotation(group.group.committer.handle)).commitMessage
          : memoryModel(group.group.committer.handle).buildCommit([])
      await input.processMessage(commit)
      expect(Number(input.epoch)).toBe(sourceEpoch + 1)
      restore.release()
      const key = await installing
      const saved = await fixture.device.groups.loadState(key)
      const trust = await fixture.device.groups.loadTrust(key.groupID)
      expect(saved).toMatchObject({
        epoch: sourceEpoch,
        epochAuthenticator: authenticator,
        senderHWM: own + 16,
      })
      expect(trust?.installed).toMatchObject({ epoch: sourceEpoch, authenticator })
      const checkpoint = await fixture.registry.access(key.groupID)
      expect(checkpoint.runtime.snapshot()?.epoch).toBe(sourceEpoch)
      await expect(input.encrypt(new Uint8Array([1]))).rejects.toBeInstanceOf(
        ApplicationSendRefusedError,
      )
    })

    test('same identity saves retain a legacy high-water mark without changing captured bytes', async () => {
      const fixture = await setup(mode, true)
      const before = await stored(fixture)
      await fixture.installRows({
        key: { groupID: 'reservation', incarnation: 1 },
        state: { ...before.record, version: before.record.version + 1, senderHWM: 480 },
      })
      const access = await fixture.registry.access('reservation')
      await access.mutate(async () => {})
      const after = await stored(fixture)
      expect(after.record.senderHWM).toBe(480)
      expect(after.record.state).toEqual(before.record.state)
      expect(after.generation).toBe(0)
    })

    test('a same identity reservation lifts legacy lag before advancing its stored range', async () => {
      const fixture = await setup(mode)
      const input = await fixture.makeHandle(0)
      const key = { groupID: 'reservation', incarnation: 1 }
      const captured = await relinquishSend(input)
      const record = { ...reservations.capturedRecord(captured, key, 1), senderHWM: 480 }
      const result = await reservations.reserveFromBytes(
        {
          ownerDID: fixture.identity.id,
          recovery: fixture.environment,
          restore: registryFixtureRestore(fixture),
        },
        record,
        record.senderHWM,
      )
      expect(result.reservation).toMatchObject({ start: 480, limit: 496 })
      await fixture.installRows({
        key,
        state: { ...record, state: result.state, senderHWM: result.senderHWM },
        trust: recoveryTrustFor(result.handle, key, null),
      })
      expect((await stored(fixture)).generation).toBe(496)
      expect((await stored(fixture)).record.senderHWM).toBe(496)
      expect(ownApplicationGeneration(input.state)).toBe(0)
    })

    test('reservation envelopes freeze a private copy of the saved record and version', async () => {
      const fixture = await setup(mode, true)
      const { record } = await stored(fixture)
      const envelope = reservations.reservationEnvelope(record)
      expect(Object.isFrozen(envelope)).toBe(true)
      expect(Object.isFrozen(envelope.saved)).toBe(true)
      expect(envelope.version).toBe(record.version)
      expect(envelope.saved).toEqual(record)
      expect(envelope.saved.state).not.toBe(record.state)
      const first = envelope.saved.state[0]
      record.state.fill(0)
      expect(envelope.saved.state[0]).toBe(first)
    })

    test('seed captures a successful concurrent peer decrypt before reserving', async () => {
      const group = await createRegistryCryptoGroup(mode, 'decrypt-capture', 1)
      fixtures.push(group.fixture())
      const input = await group.fixture().restoreCommittedSender(group.key.groupID)
      const local = group.group.members[0]
      if (local === undefined) throw new Error('Missing local member')
      const fixture = await createRegistryFixture({
        mode,
        setup: 'empty',
        groupID: input.groupID,
        identity: local.identity,
        options: group.fixture().environment.options,
      })
      fixtures.push(fixture)
      const frame = await group.sender.handle.encrypt(new Uint8Array([7]))
      const entered = deferred<void>()
      const released = deferred<void>()
      const decrypting = input.decryptStaged(frame, {}, async () => {
        entered.resolve()
        await released.promise
      })
      await entered.promise
      let settled = false
      const reserve = vi.spyOn(reservations, 'reserveFromBytes')
      const installing = fixture.registry
        .seed(input, { packageUse: { sourceID: 'decrypt', ref: 'capture', kind: 'ordinary' } })
        .finally(() => {
          settled = true
        })
      try {
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(settled).toBe(false)
      } finally {
        released.resolve()
      }
      await decrypting
      const key = await installing
      const saved = await fixture.device.groups.loadState(key)
      if (saved === null || saved.deleted || saved.state === null)
        throw new Error('Missing installation')
      const state = decodeClientState(saved.state)
      if (state === undefined) throw new Error('Missing client state')
      const result = await reserve.mock.results[0]?.value
      expect(saved.state).toEqual(result.state)
      expect(ownApplicationGeneration(state)).toBe(result.reservation.limit)
      expect(reservations.receiveProjection(state)).toEqual(
        reservations.receiveProjection(input.state),
      )
    })

    test('replace waits for an unrelated bootstrap rollback before capturing', async () => {
      const fixture = await setup(mode, true)
      const access = await fixture.registry.access('reservation')
      const accepted = await fixture.acceptedOrdinary(access)
      const input = accepted.candidate
      const original = fixture.stateBytes(input)
      const ledger = [...input.ledgerTokens]
      const entered = deferred<void>()
      const released = deferred<void>()
      const bootstrap = input.bootstrapLedger(ledger, {
        persist: async () => {
          entered.resolve()
          await released.promise
          throw new Error('bootstrap rollback')
        },
      })
      const rolledBack = expect(bootstrap).rejects.toThrow('bootstrap rollback')
      await entered.promise
      const reserve = vi.spyOn(reservations, 'reserveFromBytes')
      let settled = false
      const accepting = access
        .replace(input, () => accepted.write)
        .finally(() => {
          settled = true
        })
      try {
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(settled).toBe(false)
      } finally {
        released.resolve()
      }
      await rolledBack
      await accepting
      expect(fixture.stateBytes(input)).toEqual(original)
      expect(input.ledgerTokens).toEqual(ledger)
      const result = await reserve.mock.results[0]?.value
      expect(result.reservation).toMatchObject({ start: 0, limit: 16 })
      expect((await stored(fixture)).record.state).toEqual(result.state)
      expect((await stored(fixture)).generation).toBe(16)
    })

    test.each(['seed', 'replace'] as const)(
      'concurrent staged decrypt drains before %s capture',
      async (path) => {
        const fixture = await setup(mode, path === 'replace')
        const access = path === 'replace' ? await fixture.registry.access('reservation') : null
        const accepted = access === null ? null : await fixture.acceptedOrdinary(access)
        const input = accepted?.candidate ?? (await fixture.makeHandle(0))
        const { restoreGroup } = await import('@kumiai/mls')
        const { restoreMemoryControlHandle } = await import('./fixtures/sealed-memory-mls.js')
        const sender = await (mode === 'real-mls' ? restoreGroup : restoreMemoryControlHandle)({
          state: structuredClone(input.state),
          credential: input.credential,
          ledgerEntries: input.ledgerTokens,
          options: fixture.environment.options,
        })
        const ciphertext = await sender.encrypt(new Uint8Array([7]))
        const entered = deferred<void>()
        const released = deferred<void>()
        // Refusing staged persistence rolls the receive back before acceptance captures it.
        const decrypting = input.decryptStaged(ciphertext, {}, async () => {
          entered.resolve()
          await released.promise
          throw new Error('receive rollback')
        })
        const rolledBack = expect(decrypting).rejects.toThrow('receive rollback')
        await entered.promise
        let settled = false
        const reserve = vi.spyOn(reservations, 'reserveFromBytes')
        const accepting = (
          access !== null && accepted !== null
            ? access.replace(input, () => accepted.write)
            : fixture.registry.seed(input, { packageUse: null })
        ).finally(() => {
          settled = true
        })
        try {
          await new Promise((resolve) => setTimeout(resolve, 20))
          expect(settled).toBe(false)
        } finally {
          released.resolve()
        }
        await rolledBack
        await accepting
        const result = await reserve.mock.results[0]?.value
        expect(result.reservation).toMatchObject({ start: 0, limit: 16 })
        expect((await stored(fixture)).record.state).toEqual(result.state)
        expect((await stored(fixture)).generation).toBe(16)
      },
    )

    test('app-open relinquish-isolation starts at acceptance entry', async () => {
      const group = await createRegistryCryptoGroup(mode, 'open-isolation', 1)
      const fixture = group.fixture()
      fixtures.push(fixture)
      const restore = unmodifiedRestore(fixture, mode)
      const reads: Array<string> = []
      fixture.overrideRestore(async (record) => {
        const handle = await restore(record)
        const decrypt = handle.decryptStaged.bind(handle)
        handle.decryptStaged = async (...args) => {
          const result = await decrypt(...args)
          for (const key of [
            'state',
            'epoch',
            'groupID',
            'credential',
            'ledgerTokens',
            'listMembers',
            'exportSecret',
          ] as const) {
            const value = Reflect.get(handle, key, handle)
            Object.defineProperty(handle, key, {
              configurable: true,
              get() {
                reads.push(key)
                return typeof value === 'function' ? value.bind(handle) : value
              },
            })
          }
          // Getter setup can itself consult another getter in the memory adapter.
          reads.length = 0
          return result
        }
        return handle
      })
      const aad = encodeAppAAD({ topicID: 'open-topic', intent: 'log' })
      const ciphertext = await group.sender.handle.encrypt(
        encodeEventFrame('posted', { text: 'capture' }),
        { aad },
      )
      expect(
        await group.access().openBatch([
          {
            ciphertext,
            expectedAAD: aad,
            frame: {
              ...group.key,
              topicID: 'open-topic',
              protocol: 'chat',
              id: frameID('open-topic', ciphertext),
              segment: group.access().epoch(),
              position: '00001',
            },
          },
        ]),
      ).toMatchObject([{ kind: 'opened' }])
      expect(reads).toEqual(['state', 'ledgerTokens', 'credential'])
    })

    test('app-open private restore failure invalidates the advertised owner without saving', async () => {
      const group = await createRegistryCryptoGroup(mode, 'open-fault', 1)
      const fixture = group.fixture()
      fixtures.push(fixture)
      const access = group.access()
      const aad = encodeAppAAD({ topicID: 'open-topic', intent: 'log' })
      const ciphertext = await group.sender.handle.encrypt(
        encodeEventFrame('posted', { text: 'capture' }),
        { aad },
      )
      const restore = unmodifiedRestore(fixture, mode)
      let restores = 0
      let input: GroupHandle | undefined
      fixture.overrideRestore(async (record) => {
        if (restores++ !== 0) throw new Error('private restore fault')
        input = await restore(record)
        return input
      })
      const before = await fixture.inspectRows()
      await expect(
        access.openBatch([
          {
            ciphertext,
            expectedAAD: aad,
            frame: {
              ...group.key,
              topicID: 'open-topic',
              protocol: 'chat',
              id: frameID('open-topic', ciphertext),
              segment: access.epoch(),
              position: '00001',
            },
          },
        ]),
      ).rejects.toMatchObject({ name: 'GroupUnavailableError', reason: 'invalid' })
      expect(await fixture.inspectRows()).toEqual(before)
      expect(access.runtime.snapshot()).toBeNull()
      await expect(access.read(() => {})).rejects.toMatchObject({
        name: 'DisplacedGroupHandleError',
      })
      if (input === undefined) throw new Error('Missing open input')
      await expect(input.encrypt(new Uint8Array([1]))).rejects.toBeInstanceOf(
        ApplicationSendRefusedError,
      )
      const reopened = await fixture.reopen()
      fixtures.push(reopened)
      expect(
        (await reopened.registry.access(group.key.groupID)).runtime.snapshot()?.available,
      ).toBe(true)
      expect(await reopened.inspectRows()).toEqual(before)
    })

    test('app-open relinquishes after decrypt and drains an already admitted encrypt', async () => {
      const group = await createRegistryCryptoGroup(mode, 'open-capture', 1)
      const fixture = group.fixture()
      fixtures.push(fixture)
      const opened = deferred<GroupHandle>()
      const returning = deferred<void>()
      const { restoreGroup } = await import('@kumiai/mls')
      const { blockMemoryEncrypt, restoreMemoryControlHandle } = await import(
        './fixtures/sealed-memory-mls.js'
      )
      fixture.overrideRestore(async (record) => {
        const state = decodeClientState(record.state)
        if (state === undefined) throw new Error('Missing open state')
        const handle = await (mode === 'real-mls' ? restoreGroup : restoreMemoryControlHandle)({
          state,
          credential: record.credential,
          ledgerEntries: record.ledger,
          options: fixture.environment.options,
        })
        const decrypt = handle.decryptStaged.bind(handle)
        handle.decryptStaged = async (...args) => {
          const value = await decrypt(...args)
          opened.resolve(handle)
          await returning.promise
          return value
        }
        return handle
      })
      const aad = encodeAppAAD({ topicID: 'open-topic', intent: 'log' })
      const ciphertext = await group.sender.handle.encrypt(
        encodeEventFrame('posted', { text: 'capture' }),
        { aad },
      )
      let settled = false
      const opening = group
        .access()
        .openBatch([
          {
            ciphertext,
            expectedAAD: aad,
            frame: {
              ...group.key,
              topicID: 'open-topic',
              protocol: 'chat',
              id: frameID('open-topic', ciphertext),
              segment: group.access().epoch(),
              position: '00001',
            },
          },
        ])
        .finally(() => {
          settled = true
        })
      const input = await opened.promise
      let unblock: () => void
      let started: Promise<void>
      if (mode === 'double') {
        const barrier = blockMemoryEncrypt(input)
        unblock = barrier.release
        started = barrier.started
      } else {
        const entered = deferred<void>()
        const released = deferred<void>()
        const signature = input.context.cipherSuite.signature
        const sign = signature.sign
        vi.spyOn(signature, 'sign').mockImplementation(async (...args) => {
          entered.resolve()
          await released.promise
          return sign(...args)
        })
        started = entered.promise
        unblock = () => released.resolve()
      }
      const sending = input.encryptApplication(new Uint8Array([1]))
      await started
      returning.resolve()
      try {
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(settled).toBe(false)
      } finally {
        unblock()
      }
      expect((await sending).generation).toBe(16)
      expect(await opening).toMatchObject([{ kind: 'opened' }])
      const record = await fixture.device.groups.loadState(group.key)
      expect(record).toMatchObject({ senderHWM: 17 })
      if (record === null || record.deleted || record.state === null)
        throw new Error('Missing open state')
      const state = decodeClientState(record.state)
      if (state === undefined) throw new Error('Invalid open state')
      expect(ownApplicationGeneration(state)).toBe(17)
      await expect(input.encrypt(new Uint8Array([2]))).rejects.toBeInstanceOf(
        ApplicationSendRefusedError,
      )
      expect(() => bindSendCeiling(input, () => 32)).toThrow(TypeError)
    })

    test('private restore failure refuses seed without saving and leaves the input denied', async () => {
      const fixture = await setup(mode)
      const input = await fixture.makeHandle(0)
      fixture.overrideRestore(async () => {
        throw new Error('private restore fault')
      })
      await expect(fixture.registry.seed(input, { packageUse: null })).rejects.toBeInstanceOf(
        GroupUnavailableError,
      )
      expect(
        await fixture.device.groups.loadState({ groupID: 'reservation', incarnation: 1 }),
      ).toBeNull()
      await expect(input.encrypt(new Uint8Array([1]))).rejects.toBeInstanceOf(
        ApplicationSendRefusedError,
      )
    })
  })
}
