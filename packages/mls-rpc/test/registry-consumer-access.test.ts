import { randomIdentity } from '@kokuin/token'
import {
  commitKeyRotation,
  decodeClientState,
  encodeClientState,
  type GroupHandle,
  GroupRestoreError as InvalidCandidateError,
  restoreGroup,
} from '@kumiai/mls'
import {
  type ControlBuildPort,
  type ControlSlot,
  digestAppliedCommit,
  type Operation,
} from '@kumiai/rpc'
import { expect, test, vi } from 'vitest'

import type { ControlReadScope } from '../src/access.js'
import { createControlAdoptionPort } from '../src/control-adoption.js'
import { createControlBuildPort, createPersistenceBuildSaver } from '../src/control-build.js'
import { decodeControlJournal } from '../src/control-journal.js'
import {
  bindEntryCapability,
  coordinatorBinding,
  entryCapability,
} from '../src/entry-capability.js'
import { encodeStoredValue } from '../src/persistence-codec.js'
import { createRegistryHandleAccess } from '../src/registry-handle-access.js'
import {
  drainRegistryMaintenance,
  dropRegistryOwner,
  gateRegistryMaintenance,
} from '../src/testing.js'
import { createGatedRegistryFixture as createRegistryFixture } from './fixtures/registry.js'
import { testRegistryBackgroundWarmup } from './fixtures/registry-maintenance.js'
import {
  buildSealedMemoryOperation,
  restoreMemoryControlHandle,
  restoreMemoryControlSource,
} from './fixtures/sealed-memory-mls.js'

for (const mode of ['real-mls', 'double'] as const) {
  test(`registry control scope reads its entry and expires (${mode})`, async () => {
    const f = await createRegistryFixture({
      mode,
      groupID: `consumer-scope-${mode}`,
      setup: 'seeded',
    })
    try {
      const registryAccess = await f.registry.access(`consumer-scope-${mode}`)
      const access = createRegistryHandleAccess({ access: registryAccess })
      const control = f.device.groups.ports(registryAccess.key).control
      const load = vi.spyOn(control, 'load').mockRejectedValue(new Error('root load'))
      let scope!: ControlReadScope
      await access.readControl(async (owned) => {
        scope = owned
        expect((await owned.loadControl(control)).commitOnce).toBeNull()
        const foreign = { ...control, key: { ...control.key, incarnation: 2 } }
        await expect(owned.loadControl(foreign)).rejects.toMatchObject({
          name: 'DisplacedGroupHandleError',
        })
        expect((await owned.loadControl()).operations).toEqual([])
      })
      expect(load).not.toHaveBeenCalled()
      await expect(scope.loadControl(control)).rejects.toThrow('Control read scope has ended')
      await expect(scope.refresh()).rejects.toThrow('Control read scope has ended')
      expect('open' in access).toBe(false)
    } finally {
      await f.close()
    }
  })

  test(`registry build releases reads before callbacks and retries identical bytes (${mode})`, async () => {
    const groupID = `consumer-build-${mode}`
    const f = await createRegistryFixture({ mode, groupID, setup: 'seeded' })
    try {
      const registryAccess = await f.registry.access(groupID)
      const access = createRegistryHandleAccess({ access: registryAccess })
      const control = f.device.groups.ports(registryAccess.key).control
      const intent: Operation & { stage: 'intent' } = {
        id: 'rotation',
        kind: 'rotation',
        revokes: false,
        body:
          mode === 'double' ? encodeStoredValue({ target: randomIdentity().id }) : new Uint8Array(),
        seq: 1,
        enqueuedAt: 1,
        deadline: 30_001,
        stage: 'intent',
      }
      await control.apply({ putOperations: [intent] }, 'enqueue')
      const saver = createPersistenceBuildSaver({
        persistence: f.device.groups,
        key: registryAccess.key,
      })
      const prepared: Array<ControlSlot> = []
      const build = vi.fn(async (_op: Operation, handle: GroupHandle) => {
        // Root access here requires the captured Read to have released ownership.
        await access.read((current) => current.epoch)
        await control.load()
        if (mode === 'double') return buildSealedMemoryOperation(_op, handle)
        const rotated = await commitKeyRotation(handle)
        const candidate = rotated.newGroup
        return {
          commit: rotated.commitMessage,
          digest: digestAppliedCommit(rotated.commitMessage),
          bodies: [],
          welcome: null,
          incarnation: 1,
          epoch: Number(handle.epoch),
          authenticatorBefore: handle.state.keySchedule.epochAuthenticator.slice(),
          journal: f.stateBytes(candidate),
        }
      })
      const port = createControlBuildPort({
        access,
        control,
        build,
        restoreSource: async ({ state, credential, ledgerEntries }) => {
          const decoded = decodeClientState(state)
          if (decoded === undefined) throw new TypeError('Invalid control source state')
          return (mode === 'double' ? restoreMemoryControlSource : restoreGroup)({
            state: decoded,
            credential,
            ledgerEntries,
            options: f.environment.options,
          })
        },
        restoreCandidate: async (bytes) => {
          const state = decodeClientState(bytes)
          if (state === undefined) throw new InvalidCandidateError('Invalid candidate')
          return access.read((current) =>
            (mode === 'double' ? restoreMemoryControlHandle : restoreGroup)({
              state,
              credential: current.credential,
              ledgerEntries: mode === 'double' ? undefined : current.ledgerTokens,
              options: f.environment.options,
            }),
          )
        },
        now: () => 10,
        newID: () => crypto.randomUUID(),
        saveBuilt: async (op, slot, source, id) => {
          prepared.push(structuredClone(slot))
          if (prepared.length === 1) await control.apply({}, 'head-only-move')
          return saver(op, slot, source, id)
        },
      })
      const frame = vi.fn<Parameters<ControlBuildPort['prepareBuild']>[1]>(async (_built, seal) => {
        await control.load()
        return {
          payload: (await seal(new Uint8Array([3]))).sealed,
          publishID: 'publish',
          expectedHead: null,
        }
      })
      expect((await port.prepareBuild(intent, frame)).kind).toBe('saved')
      expect(prepared).toHaveLength(2)
      expect(prepared[1]).toEqual(prepared[0])
      expect(build).toHaveBeenCalledTimes(1)
      expect(frame).toHaveBeenCalledTimes(1)
      expect((await control.load()).commitOnce).toEqual(prepared[0])
    } finally {
      await f.close()
    }
  })

  test(`maintenance after pending adoption proof retains control and applied evidence (${mode})`, async () => {
    const groupID = `superseded-adoption-${mode}`
    const f = await createRegistryFixture({ mode, groupID, setup: 'seeded' })
    try {
      const gate = gateRegistryMaintenance(f.registry)
      const registryAccess = await f.registry.access(groupID)
      const access = createRegistryHandleAccess({ access: registryAccess })
      const { candidate, write } = await f.acceptedOrdinary(registryAccess)
      const mutationID = `adoption-${mode}`
      const fault = f.armNextWorkFault('pending')
      const replacing = access.replace(candidate, () => ({ ...write, mutationID }))
      await fault.rejected
      await fault.finish('commit')
      await replacing
      expect(await f.device.groups.resolve(groupID, mutationID)).toBe('committed')
      const control = f.device.groups.ports(registryAccess.key).control
      const before = await control.load()
      expect(before.applied.length).toBeGreaterThan(0)
      const version = registryAccess.stateVersion()
      // Reopening removes the installed hand-off, so load must reserve again.
      dropRegistryOwner(registryAccess)
      const reloaded = await f.registry.access(groupID)
      gate.release()
      await drainRegistryMaintenance(reloaded)
      expect(reloaded.stateVersion()).toBe(version + 1)
      await expect(f.device.groups.resolve(groupID, mutationID)).rejects.toMatchObject({
        name: 'GroupStateUncertainError',
      })
      expect(await control.load()).toEqual(before)
      expect(await control.lastMutation()).toBe(mutationID)
      expect((await f.device.groups.loadTrust(groupID))?.installed.epoch).toBe(1)
      expect(reloaded.epoch()).toBe(1)
    } finally {
      await f.close()
    }
  })

  test.each(['rollback', 'pending-rollback', 'pending-commit'] as const)(
    `factory-selected adoption ID binds all writes after proof (${mode}, %s)`,
    async (kind) => {
      const groupID = `consumer-proof-${mode}-${kind}`
      const f = await createRegistryFixture({ mode, groupID, setup: 'seeded' })
      try {
        const registryAccess = await f.registry.access(groupID)
        const access = createRegistryHandleAccess({ access: registryAccess })
        const { candidate, write } = await f.acceptedOrdinary(registryAccess)
        const before = await f.inspectRows()
        const control = f.device.groups.ports(registryAccess.key).control
        const mutationID = `selected-${mode}-${kind}`
        const fault = kind === 'rollback' ? undefined : f.armNextWorkFault('pending')
        if (kind === 'rollback') f.armNextWorkFault('before-commit')
        const replacing = access
          .replace(candidate, () => ({ ...write, mutationID }))
          .then(
            () => 'installed',
            () => 'rolled-back',
          )
        if (fault !== undefined) {
          await fault.rejected
          expect(await f.inspectRows()).toEqual(before)
          expect(access.epoch()).toBe(0)
          await fault.finish(kind === 'pending-commit' ? 'commit' : 'rollback')
        }
        expect(await replacing).toBe(kind === 'pending-commit' ? 'installed' : 'rolled-back')
        if (kind === 'pending-commit')
          expect(await f.device.groups.resolve(groupID, mutationID)).toBe('committed')
        else
          await expect(f.device.groups.resolve(groupID, mutationID)).rejects.toMatchObject({
            name: 'GroupStateUncertainError',
          })
        if (kind === 'pending-commit') {
          expect((await f.device.groups.load(groupID))?.mutationID).toBe(mutationID)
          expect(await control.lastMutation()).toBe(mutationID)
          expect((await control.load()).commitOnce).toBeNull()
          expect((await f.device.groups.loadTrust(groupID))?.installed.epoch).toBe(1)
          expect((await f.device.groups.loadState(registryAccess.key))?.version).toBeGreaterThan(1)
          expect(access.epoch()).toBe(1)
        } else expect(await f.inspectRows()).toEqual(before)
      } finally {
        await f.close()
      }
    },
  )

  test.each(['replace', 'mutate'] as const)(
    `missing factory mutation ID refuses unchanged (${mode}, %s)`,
    async (method) => {
      const groupID = `consumer-missing-id-${mode}`
      const f = await createRegistryFixture({ mode, groupID, setup: 'seeded' })
      try {
        const registryAccess = await f.registry.access(groupID)
        const access = createRegistryHandleAccess({ access: registryAccess })
        const { candidate, write } = await f.acceptedOrdinary(registryAccess)
        const before = await f.inspectRows()
        const factory = () => ({ ...write, mutationID: '' })
        await expect(
          method === 'replace'
            ? access.replace(candidate, factory)
            : access.mutate(async (_handle, persist) => await persist(candidate), factory),
        ).rejects.toThrow('mutation ID')
        expect(await f.inspectRows()).toEqual(before)
        expect(access.epoch()).toBe(0)
      } finally {
        await f.close()
      }
    },
  )

  test(`registry load rejects a value returned after scope release (${mode})`, async () => {
    const groupID = `consumer-late-load-${mode}`
    const f = await createRegistryFixture({ mode, groupID, setup: 'seeded' })
    try {
      const capability = entryCapability(f.device.groups)
      const binding = coordinatorBinding(f.device.groups)
      if (capability === null || binding === null) throw new Error('Missing entry capability')
      const started = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let suspended = false
      bindEntryCapability({
        persistence: f.device.groups,
        coordinatorBinding: binding,
        capability: {
          ...capability,
          read: (id, fn) =>
            capability.read(id, (reads) =>
              fn({
                ...reads,
                control: async (incarnation) => {
                  const value = await reads.control(incarnation)
                  if (suspended) {
                    started.resolve()
                    await release.promise
                  }
                  return value
                },
              }),
            ),
        },
      })
      const access = createRegistryHandleAccess({ access: await f.registry.access(groupID) })
      let loading!: ReturnType<ControlReadScope['loadControl']>
      await access.readControl(async (scope) => {
        suspended = true
        loading = scope.loadControl()
        await started.promise
      })
      release.resolve()
      await expect(loading).rejects.toThrow('Control read scope has ended')
    } finally {
      await f.close()
    }
  })

  test(`registry consumer adopts accepted journals without root calls in an entry (${mode})`, async () => {
    const groupID = `consumer-adopt-${mode}`
    const f = await createRegistryFixture({ mode, groupID, setup: 'seeded' })
    try {
      const registryAccess = await f.registry.access(groupID)
      const access = createRegistryHandleAccess({ access: registryAccess })
      const { candidate, expected: previous, write } = await f.acceptedOrdinary(registryAccess)
      const bytes = write.expected?.journal
      const proof = write.expected?.acceptance
      if (bytes === undefined || proof === undefined) throw new Error('Missing accepted journal')
      if (mode === 'real-mls') await registryAccess.mutate((handle) => f.advanceSender(handle))
      else await f.device.groups.ports(registryAccess.key).control.apply({}, 'source-move')
      const receiveTree = await access.read((handle) => structuredClone(handle.state.secretTree))
      const control = f.device.groups.ports(registryAccess.key).control
      const restoreCandidate = async () => candidate
      const port = createControlAdoptionPort({ access, control, restoreCandidate })
      expect(await port.adopt(bytes, { ...previous, acceptance: proof }, write)).toBe('installed')
      expect(access.epoch()).toBe(1)
      if (mode === 'real-mls')
        expect(
          await access.read((handle) => handle.state.historicalReceiverData.get(0n)?.secretTree),
        ).toEqual(receiveTree)
      const installed = await f.inspectRows()
      const current = await access.readControl(async ({ source }) => source)
      expect(await port.adopt(bytes, { ...current, acceptance: proof }, write)).toBe('noop')
      expect(await f.inspectRows()).toEqual(installed)
      const journal = decodeControlJournal(bytes)
      expect(journal.source.identity?.epoch).toBe(0)
      const record = await f.device.groups.loadState(registryAccess.key)
      if (record === null || record.deleted) throw new Error('Missing state')
      expect(record.state).toEqual(await access.read((handle) => encodeClientState(handle.state)))
      expect(await f.device.groups.resolve(groupID, write.mutationID)).toBe('committed')
    } finally {
      await f.close()
    }
  })
}

testRegistryBackgroundWarmup('consumer-access')
