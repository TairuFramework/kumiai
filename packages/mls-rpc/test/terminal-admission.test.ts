import { encodeEventFrame } from '@kumiai/broadcast'
import * as Mls from '@kumiai/mls'
import {
  asLogPosition,
  controlBatch,
  digestAppliedCommit,
  encodeAppAAD,
  frameID,
  PeerRemovedError,
  type SendAdmission,
} from '@kumiai/rpc'
import { expect, test, vi } from 'vitest'

import { createControlAdoptionPort } from '../src/control-adoption.js'
import { entryCapability } from '../src/entry-capability.js'
import { createHandlerCompletion } from '../src/handler-completion.js'
import { createGroupMLS, createLedgerEntrySlot } from '../src/mls.js'
import * as coldModule from '../src/registry/cold.js'
import { loadValidatedGroup, restoreValidated } from '../src/registry/cold.js'
import * as liveSendModule from '../src/registry/live-send.js'
import { restoreCaptured } from '../src/registry/reserve.js'
import { createRegistryGroupMLS } from '../src/registry-group-mls.js'
import { controlAdoptionFixture } from './fixtures/control-adoption.js'
import {
  createRealGroup,
  testGroupMLSDependencies,
  testHandleAccess,
} from './fixtures/real-group.js'
import { createRegistryFixture, registryFixtureRestore } from './fixtures/registry.js'
import { createRegistryCryptoGroup } from './fixtures/registry-crypto.js'
import { createTransactionalStore } from './fixtures/transactional-access.js'

test.each(['real-mls', 'double'] as const)(
  'cold access refuses terminal private restoration while saved plaintext can complete (%s)',
  async (mode) => {
    const group = await createRegistryCryptoGroup(mode, crypto.randomUUID(), 2, {
      backgroundMaintenance: 'gated',
    })
    let cold: Awaited<ReturnType<typeof createRegistryFixture>> | undefined
    try {
      const topicID = 'terminal-saved-plaintext'
      const aad = encodeAppAAD({ topicID, intent: 'log' })
      const ciphertext = await group.sender.handle.encrypt(encodeEventFrame('posted', {}), { aad })
      const frame = {
        ...group.key,
        id: frameID(topicID, ciphertext),
        topicID,
        protocol: 'chat',
        segment: group.access().epoch(),
        position: '01',
      }
      await group.receiver().unwrap(ciphertext, { expectedAAD: aad, frame })
      const f = group.fixture()
      const mls = await createRegistryGroupMLS({
        registry: f.registry,
        key: group.key,
        recovery: f.environment,
        identity: f.identity,
        entrySlot: createLedgerEntrySlot(),
        target: { targetID: 'hub', topicID: 'removal' },
      })
      const binding = controlBatch(mls)
      if (binding === undefined) throw new Error('Missing control batch')
      const commit = await group.prepareCommit(0)
      await binding.run({
        source: 'removal',
        prepare: async (scope) => {
          const epoch = await scope.readEpoch()
          return scope.prepareCommit(commit, {
            adoption: (staged) => ({
              mutationID: crypto.randomUUID(),
              changes: {
                commitOnce: null,
                cursor: { position: asLogPosition('01'), epoch: staged.epochAfter },
                putApplied: [
                  {
                    epoch,
                    digest: digestAppliedCommit(commit),
                    payloadDigest: 'removal',
                    sequenceID: asLogPosition('01'),
                    opID: null,
                    removed: staged.removed,
                  },
                ],
              },
            }),
          })
        },
      })
      expect(await group.fixture().device.groups.loadState(group.key)).toMatchObject({
        terminal: true,
      })
      cold = await group.fixture().reopen()
      const before = cold.restores()
      const result = await cold.registry.access(group.key.groupID).catch((error: unknown) => error)
      expect(cold.restores()).toBe(before)
      expect(result).toBeInstanceOf(PeerRemovedError)
      const completion = createHandlerCompletion({
        persistence: cold.device.groups,
        key: group.key,
      })
      await completion.complete([frame.id])
      const entry = entryCapability(cold.device.groups)
      if (entry === null) throw new Error('Missing entry capability')
      expect(
        await entry.read(group.key.groupID, (reads) => reads.pendingFrames(group.key.incarnation)),
      ).toEqual([])
      expect(cold.restores()).toBe(before)
    } finally {
      await cold?.close()
      await group.close()
    }
  },
)

test.each(
  (['real-mls', 'double'] as const).flatMap((mode) =>
    (['registry', 'access'] as const).map((boundary) => ({ mode, boundary })),
  ),
)(
  'supplied $boundary restorer checks the source terminal admission ($mode)',
  async ({ mode, boundary }) => {
    const captureCold = vi.spyOn(coldModule, 'loadValidatedGroup')
    const captureLive = vi.spyOn(liveSendModule, 'createLiveSend')
    let fixture: Awaited<ReturnType<typeof createRegistryFixture>> | undefined
    let restoreAdmission = () => {}
    try {
      const groupID = crypto.randomUUID()
      fixture = await createRegistryFixture({
        mode,
        groupID,
        setup: 'seeded',
        backgroundMaintenance: 'gated',
      })
      const key = { groupID, incarnation: 1 }
      await fixture.registry.access(groupID)
      const params = captureLive.mock.calls.find(
        ([input]) => input.owner.key.groupID === groupID,
      )?.[0]
      const restore =
        boundary === 'access'
          ? params?.environment.restore
          : captureCold.mock.calls.find(([, id]) => id === groupID)?.[3].restore
      const record = await fixture.device.groups.loadState(key)
      if (
        params === undefined ||
        restore === undefined ||
        record === null ||
        record.deleted ||
        record.state === null
      )
        throw new Error('Missing supplied source restorer')
      const prior = params.owner.admission
      restoreAdmission = () => {
        params.owner.admission = prior
      }
      params.owner.admission = { epoch: prior.epoch, admissible: false, reason: 'terminal' }
      const source = { ...record, state: record.state }
      const before = fixture.restores()
      const result = await Promise.resolve()
        .then(() => restore(source))
        .catch((error: unknown) => error)
      expect(fixture.restores()).toBe(before)
      expect(result).toBeInstanceOf(PeerRemovedError)
    } finally {
      restoreAdmission()
      captureCold.mockRestore()
      captureLive.mockRestore()
      await fixture?.close()
    }
  },
)

test.each(['load', 'validated', 'captured', 'boundary'] as const)(
  'registry restoration preserves terminal refusal through %s cleanup',
  async (boundary) => {
    const groupID = crypto.randomUUID()
    const key = { groupID, incarnation: 1 }
    const f = await createRegistryFixture({
      mode: 'double',
      groupID,
      setup: 'seeded',
      backgroundMaintenance: 'gated',
    })
    try {
      const capability = entryCapability(f.device.groups)
      if (capability === null) throw new Error('Missing entry capability')
      const environment = {
        ownerDID: f.identity.id,
        recovery: f.environment,
        restore: registryFixtureRestore(f),
      }
      const { value } = await capability.read(key.groupID, (reads) =>
        loadValidatedGroup(reads, key.groupID, null, environment),
      )
      const removed = new PeerRemovedError()
      const refused = {
        ...environment,
        restore: async () => {
          throw removed
        },
      }
      if (boundary === 'boundary') {
        const access = await f.registry.access(key.groupID)
        const before = access.runtime.snapshot()
        f.overrideRestore(refused.restore)
        await expect(access.read(() => {})).rejects.toBe(removed)
        expect(access.runtime.snapshot()).toEqual(before)
        expect(() => access.admission()).not.toThrow()
      } else {
        const work =
          boundary === 'load'
            ? capability.read(key.groupID, (reads) =>
                loadValidatedGroup(reads, key.groupID, null, refused),
              )
            : boundary === 'validated'
              ? restoreValidated(value, refused)
              : restoreCaptured(refused, value.record)
        await expect(work).rejects.toBe(removed)
      }
    } finally {
      await f.close()
    }
  },
)

test('adoption rechecks terminal admission after its safety read before restore', async () => {
  const f = await controlAdoptionFixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let terminal = false
  const restore = vi.fn(f.restoreCandidate)
  const port = createControlAdoptionPort({
    access: {
      ...f.host.access,
      admission: () =>
        terminal ? { epoch: 0, admissible: false, reason: 'terminal' } : f.host.access.admission(),
      readControl: async (fn) => {
        const result = await f.host.access.readControl(fn)
        entered.resolve()
        await release.promise
        return result
      },
    },
    control: f.store.control,
    restoreCandidate: restore,
  })
  const before = f.store.snapshot()
  const work = port
    .adopt(f.slot.journal, await f.expected(), f.write)
    .catch((error: unknown) => error)
  try {
    await entered.promise
    terminal = true
    release.resolve()
    const result = await work
    expect(restore).not.toHaveBeenCalled()
    expect(result).toMatchObject({ name: 'PeerRemovedError' })
    expect(f.store.snapshot()).toEqual(before)
  } finally {
    release.resolve()
    await work
  }
})

test.each(['restore', 'seal'] as const)(
  'captured GroupInfo rechecks terminal admission immediately before %s',
  async (boundary) => {
    const group = await createRealGroup(1, 'terminal-capture')
    const member = group.members[0]
    if (member === undefined) throw new Error('Missing capture member')
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let admission: SendAdmission = { epoch: Number(member.handle.epoch), admissible: true }
    const base = testHandleAccess({ handle: () => member.handle, adopt: () => {} })
    const pause = async () => {
      entered.resolve()
      await release.promise
    }
    const port = createGroupMLS({
      ...testGroupMLSDependencies(
        {
          ...base,
          admission: () => admission,
          readControl: async (fn) => {
            const result = await base.readControl(fn)
            if (boundary === 'restore') await pause()
            return result
          },
        },
        createTransactionalStore(member.handle).control,
      ),
      identity: member.identity,
      entrySlot: member.slot,
    })
    const request = await port.createRecoveryRequest('terminal-capture')
    const restoreGroup = Mls.restoreGroup
    const restore = vi.spyOn(Mls, 'restoreGroup').mockImplementation(async (...args) => {
      const result = await restoreGroup(...args)
      if (boundary === 'seal') await pause()
      return result
    })
    const seal = vi.spyOn(Mls, 'sealCapturedGroupInfo')
    const work = port.sealGroupInfo(request.request, null).catch((error: unknown) => error)
    try {
      await entered.promise
      admission = { epoch: admission.epoch, admissible: false, reason: 'terminal' }
      restore.mockClear()
      release.resolve()
      const result = await work
      expect(restore).not.toHaveBeenCalled()
      expect(seal).not.toHaveBeenCalled()
      expect(result).toMatchObject({ name: 'PeerRemovedError' })
    } finally {
      release.resolve()
      await work
      restore.mockRestore()
      seal.mockRestore()
    }
  },
)
