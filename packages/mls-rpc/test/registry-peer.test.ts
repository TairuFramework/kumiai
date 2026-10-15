import { randomIdentity } from '@kokuin/token'
import {
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  encodeClientState,
  processWelcome,
} from '@kumiai/mls'
import type { ConfirmedRecoveryHandoff, GroupPeer, GroupProtocolDefinition } from '@kumiai/rpc'
import { describe, expect, test, vi } from 'vitest'

import * as api from '../src/index.js'
import { registryRecoveryCoordinator } from '../src/registry/recovery-coordinator.js'
import { registrySafety } from '../src/registry/safety.js'
import { recoveryTrustFor } from '../src/registry/trust.js'
import { deferred } from '../src/runtime.js'
import { createRegistryFixture } from './fixtures/registry.js'
import { createRegistryRecovery } from './fixtures/registry-recovery.js'

const groupID = 'registry-peer'
const source = { groupID, incarnation: 1 }
const destination = { groupID, incarnation: 2 }
const target = { targetID: 'registry-recovery-hub', topicID: `commits/${groupID}` }

type Peer = GroupPeer<Record<string, GroupProtocolDefinition>>
function peerDouble(onDrain: () => Promise<void> = async () => {}): Peer {
  let disposed = false
  const unavailable = () => {
    throw new Error('No application work expected')
  }
  return {
    protocol: unavailable,
    retryAppDelivery: unavailable,
    dropAppFrame: unavailable,
    enqueue: unavailable,
    outcomes: unavailable,
    ack: unavailable,
    abandon: unavailable,
    commit: unavailable,
    replay: async () => ({}),
    recover: unavailable,
    resync: unavailable,
    anchorEpoch: () => 0,
    reauthorize: unavailable,
    dispose: async () => {
      disposed = true
    },
    drained: async () => {
      expect(disposed).toBe(true)
      await onDrain()
    },
  }
}

async function setup(confirmed = true) {
  const f = await createRegistryFixture({ mode: 'real-mls', setup: 'empty', groupID })
  const responderIdentity = randomIdentity()
  const genesis = (await createGroup(f.identity, groupID, f.environment.options)).group
  const bundle = await createKeyPackageBundle(responderIdentity)
  const { invite } = await createInvite({
    group: genesis,
    identity: f.identity,
    recipientDID: responderIdentity.id,
    permission: 'member',
  })
  const added = await commitInvite(genesis, bundle.publicPackage, invite)
  const responder = (
    await processWelcome({
      identity: responderIdentity,
      invite,
      welcome: added.welcomeMessage,
      keyPackageBundle: bundle,
      options: f.environment.options,
    })
  ).group
  const own = added.newGroup
  await f.installRows({
    key: source,
    state: {
      ...source,
      version: 1,
      deleted: false,
      terminal: false,
      epoch: Number(own.epoch),
      epochAuthenticator: own.state.keySchedule.epochAuthenticator,
      state: encodeClientState(own.state),
      credential: own.credential,
      ledger: own.ledgerTokens,
      senderHWM: 0,
    },
    trust: recoveryTrustFor(own, source, null),
  })
  const recovery = await createRegistryRecovery({
    format: 'captured',
    mode: 'real-mls',
    identity: f.identity,
    options: f.environment.options,
    source: own,
    sourceKey: source,
    sourceTrust: (await f.device.groups.loadTrust(groupID)) ?? undefined,
    responder: { identity: responderIdentity, group: responder },
  })
  if (confirmed) await f.installRows({ key: source, control: { putRejoin: recovery.record } })
  const created: Array<{ key: api.GroupKey; options: api.RegistryPeerOptions }> = []
  let handoff: ((value: ConfirmedRecoveryHandoff) => void) | undefined
  const continuation = api.createRecoveryContinuationPort({
    registry: f.registry,
    persistence: f.device.groups,
  })
  const start = (extra: Partial<Parameters<typeof api.createRegistryPeer>[0]> = {}) =>
    api.createRegistryPeer({
      registry: extra.registry ?? f.registry,
      key: source,
      recovery: f.environment,
      target,
      continuation,
      createMLS: async (key, sink) =>
        api.createRegistryGroupMLS({
          registry: f.registry,
          key,
          recovery: f.environment,
          target,
          identity: f.identity,
          entrySlot: api.createLedgerEntrySlot(),
          onConfirmedRecovery: sink,
        }),
      createPeer: async (key, options) => {
        created.push({ key, options })
        handoff = options.onConfirmedRecovery
        return peerDouble()
      },
      ...extra,
    })
  return {
    f,
    recovery,
    created,
    start,
    continuation,
    handoff: () => {
      if (handoff === undefined) throw new Error('Missing sink')
      return handoff
    },
  }
}

describe('registry peer recovery coordination', () => {
  test('resumes a saved confirmed switch before source peer work', async () => {
    const s = await setup()
    let owner: api.RegistryPeer | undefined
    try {
      expect(api.createRegistryPeer).toBeTypeOf('function')
      owner = await s.start()
      await owner.ready
      expect(owner.installedKey()).toEqual(destination)
      expect(s.created.map(({ key }) => key)).toEqual([destination])
      expect(s.created[0]?.options).toMatchObject({
        recoveryOnly: false,
        continuation: { source, destination },
        completion: expect.any(Function),
      })
      expect((await s.f.device.groups.ports(source).control.load()).rejoin).toMatchObject({
        stage: 'adopted',
        switchMutationID: s.recovery.record.switchMutationID,
      })
    } finally {
      owner?.dispose()
      await owner?.drained()
      await s.f.close()
    }
  })

  test('assigns an absent switch ID once before resuming', async () => {
    const s = await setup(false)
    let owner: api.RegistryPeer | undefined
    try {
      await s.f.installRows({
        key: source,
        control: { putRejoin: { ...s.recovery.record, switchMutationID: null } },
      })
      owner = await s.start()
      await owner.ready
      const record = (await s.f.device.groups.ports(source).control.load()).rejoin
      expect(record).toMatchObject({ stage: 'adopted', switchMutationID: expect.any(String) })
      expect(owner.installedKey()).toEqual(destination)
    } finally {
      owner?.dispose()
      await owner?.drained()
      await s.f.close()
    }
  })

  test.each(['null', 'client-state'] as const)(
    'starts %s state recovery-only without restoring a handle',
    async (damage) => {
      const s = await setup(false)
      let owner: api.RegistryPeer | undefined
      try {
        if (damage === 'null') {
          const state = await s.f.device.groups.loadState(source)
          if (state === null || state.deleted) throw new Error('Missing state')
          await s.f.installRows({
            key: source,
            state: { ...state, version: state.version + 1, state: null },
          })
        } else await s.f.corruptState(source, damage)
        const restores = s.f.restoreCount(groupID)
        owner = await s.start()
        await owner.ready
        expect(s.created[0]?.options.recoveryOnly).toBe(true)
        expect(s.f.restoreCount(groupID)).toBe(restores)
      } finally {
        owner?.dispose()
        await owner?.drained()
        await s.f.close()
      }
    },
  )

  test('waits for callback completion and source drainage before raw acceptance', async () => {
    const s = await setup(false)
    const completion = deferred<void>()
    const drain = deferred<void>()
    let owner: api.RegistryPeer | undefined
    try {
      owner = await s.start({
        createPeer: async (key, options) => {
          s.created.push({ key, options })
          return peerDouble(() => (key.incarnation === 1 ? drain.promise : Promise.resolve()))
        },
      })
      await owner.ready
      await s.f.installRows({ key: source, control: { putRejoin: s.recovery.record } })
      s.created[0]?.options.onConfirmedRecovery({
        record: s.recovery.record,
        completion: completion.promise,
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect((await s.f.device.groups.load(groupID))?.activeIncarnation).toBe(1)
      completion.resolve()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect((await s.f.device.groups.load(groupID))?.activeIncarnation).toBe(1)
      drain.resolve()
      await vi.waitFor(() => expect(owner?.installedKey()).toEqual(destination))
      expect(s.created.map(({ key }) => key)).toEqual([source, destination])
    } finally {
      completion.resolve()
      drain.resolve()
      owner?.dispose()
      await owner?.drained()
      await s.f.close()
    }
  })

  test('a rejected handoff never authorises a write', async () => {
    const s = await setup(false)
    let owner: api.RegistryPeer | undefined
    try {
      owner = await s.start()
      await owner.ready
      const before = await s.f.inspectRows()
      const completion = Promise.reject(new Error('source callback failed'))
      s.handoff()({ record: s.recovery.record, completion })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(await s.f.inspectRows()).toEqual(before)
      expect(owner.installedKey()).toEqual(source)
    } finally {
      owner?.dispose()
      await owner?.drained().catch(() => {})
      await s.f.close()
    }
  })

  test('moved identity preserves accepted bytes and obligations without a settlement callback', async () => {
    const s = await setup()
    let owner: api.RegistryPeer | undefined
    try {
      const trust = await s.f.device.groups.loadTrust(groupID)
      if (trust === null) throw new Error('Missing trust')
      const state = await s.f.device.groups.loadState(source)
      if (state === null || state.deleted) throw new Error('Missing state')
      const advanced = await s.f.advance(
        await (await s.f.registry.access(groupID)).read((handle) => handle),
      )
      await s.f.installRows({
        key: source,
        state: {
          ...state,
          version: state.version + 1,
          epoch: Number(advanced.epoch),
          epochAuthenticator: advanced.state.keySchedule.epochAuthenticator,
          state: encodeClientState(advanced.state),
        },
        trust: recoveryTrustFor(advanced, source, trust),
        control: {
          putWelcomes: [
            { opID: 'owed', welcome: new Uint8Array([9]), recipients: ['member'], committed: true },
          ],
          putOutcomes: [{ id: 'old', opID: null, at: 1, kind: 'unknown' }],
        },
      })
      const before = await s.f.device.groups.ports(source).control.load()
      owner = await s.start()
      await expect(owner.ready).rejects.toThrow()
      expect(await s.f.device.groups.ports(source).control.load()).toEqual(before)
      expect(owner.peer()).toBeNull()
    } finally {
      owner?.dispose()
      await owner?.drained()
      await s.f.close()
    }
  })

  test.each([false, true])(
    'holds missing retained trust with confirmed=%s before constructing MLS or issuing requests',
    async (confirmed) => {
      const s = await setup(confirmed)
      let owner: api.RegistryPeer | undefined
      try {
        await s.f.corruptTrust(groupID)
        const make = vi.fn(() => {
          throw new Error('Must not construct MLS')
        })
        owner = await s.start({ createMLS: make })
        await expect(owner.ready).rejects.toThrow()
        expect(make).not.toHaveBeenCalled()
        expect(registrySafety(s.f.registry)?.held(source)).toBe('recovery-unavailable')
      } finally {
        owner?.dispose()
        await owner?.drained()
        await s.f.close()
      }
    },
  )
  test('an unconfirmed saved candidate starts recovery-only and retains its exact bytes', async () => {
    const s = await setup(false)
    let owner: api.RegistryPeer | undefined
    try {
      const record = { ...s.recovery.record, stage: 'published' as const, switchMutationID: null }
      await s.f.installRows({ key: source, control: { putRejoin: record } })
      owner = await s.start()
      await owner.ready
      expect(s.created[0]?.options.recoveryOnly).toBe(true)
      expect((await s.f.device.groups.ports(source).control.load()).rejoin).toEqual(record)
    } finally {
      owner?.dispose()
      await owner?.drained()
      await s.f.close()
    }
  })

  test.each(['manual', 'policy-hold'] as const)(
    'stops %s before assigning a switch ID',
    async (kind) => {
      const s = await setup(false)
      let owner: api.RegistryPeer | undefined
      try {
        const record = {
          ...s.recovery.record,
          switchMutationID: null,
          ...(kind === 'manual'
            ? { trigger: 'manual' as const, authorisationID: 'host-authorisation' }
            : {}),
        }
        await s.f.installRows({
          key: source,
          control: {
            putRejoin: record,
            ...(kind === 'policy-hold'
              ? { controlHold: { reason: 'unsupported-version' as const, position: null } }
              : {}),
          },
        })
        const before = await s.f.device.groups.ports(source).control.load()
        owner = await s.start()
        await expect(owner.ready).rejects.toThrow()
        expect(await s.f.device.groups.ports(source).control.load()).toEqual(before)
        expect(s.created).toEqual([])
      } finally {
        owner?.dispose()
        await owner?.drained()
        await s.f.close()
      }
    },
  )

  test('retirement counter movement retries the identical switch ID and candidate', async () => {
    const s = await setup()
    let owner: api.RegistryPeer | undefined
    try {
      let moved = false
      registrySafety(s.f.registry)?.onRetire(source, async () => {
        if (moved) return
        moved = true
        const state = await s.f.device.groups.loadState(source)
        if (state === null || state.deleted) throw new Error('Missing state')
        await s.f.installRows({ key: source, state: { ...state, version: state.version + 1 } })
      })
      const calls = vi.spyOn(s.f.registry, 'switchIncarnation')
      owner = await s.start()
      await owner.ready
      expect(calls).toHaveBeenCalledTimes(2)
      expect(calls.mock.calls.map(([, input]) => input.write.mutationID)).toEqual([
        s.recovery.record.switchMutationID,
        s.recovery.record.switchMutationID,
      ])
      expect(calls.mock.calls.map(([candidate]) => encodeClientState(candidate.state))).toEqual([
        encodeClientState(s.recovery.candidate.state),
        encodeClientState(s.recovery.candidate.state),
      ])
      expect(owner.installedKey()).toEqual(destination)
    } finally {
      owner?.dispose()
      await owner?.drained()
      await s.f.close()
    }
  })

  test.each(['committed', 'rolled-back'] as const)(
    'unhooked uncertainty resolves %s through a fresh read after a later marker',
    async (outcome) => {
      const s = await setup()
      let owner: api.RegistryPeer | undefined
      try {
        const switchCall = s.f.registry.switchIncarnation.bind(s.f.registry)
        let first = true
        vi.spyOn(s.f.registry, 'switchIncarnation').mockImplementation(async (candidate, input) => {
          if (!first) return switchCall(candidate, input)
          first = false
          if (outcome === 'committed') await switchCall(candidate, input)
          await s.f.device.groups
            .ports(outcome === 'committed' ? destination : source)
            .control.apply({ deleteOutcomes: [] }, 'later-marker')
          throw new api.GroupStateUncertainError('Unhooked switch result')
        })
        owner = await s.start()
        await owner.ready
        expect(owner.installedKey()).toEqual(destination)
        expect(s.created.map(({ key }) => key)).toEqual([destination])
        expect((await s.f.device.groups.ports(source).control.load()).rejoin).toMatchObject({
          stage: 'adopted',
          switchMutationID: s.recovery.record.switchMutationID,
        })
      } finally {
        owner?.dispose()
        await owner?.drained()
        await s.f.close()
      }
    },
  )

  test('switch-before-peer restart loads continuation after destination epoch advancement', async () => {
    const s = await setup()
    let owner: api.RegistryPeer | undefined
    try {
      owner = await s.start()
      await owner.ready
      owner.dispose()
      await owner.drained()
      owner = undefined
      const state = await s.f.device.groups.loadState(destination)
      if (state === null || state.deleted) throw new Error('Missing destination')
      const advanced = await s.f.advance(s.recovery.candidate)
      const trust = await s.f.device.groups.loadTrust(groupID)
      await s.f.installRows({
        key: destination,
        state: {
          ...state,
          version: state.version + 1,
          epoch: Number(advanced.epoch),
          epochAuthenticator: advanced.state.keySchedule.epochAuthenticator,
          state: encodeClientState(advanced.state),
        },
        trust: recoveryTrustFor(advanced, destination, trust),
      })
      s.created.length = 0
      owner = await s.start({ key: destination })
      await owner.ready
      expect(s.created[0]?.options.continuation).toMatchObject({ source, destination })
      expect(s.created[0]?.options.mls.sendAdmission().epoch).toBe(Number(advanced.epoch))
      await s.created[0]?.options.completion?.({ ledger: [], mutationID: 'complete-after-restart' })
      expect((await s.f.device.groups.ports(source).control.load()).rejoin).toBeNull()
    } finally {
      owner?.dispose()
      await owner?.drained()
      await s.f.close()
    }
  })

  test.each([
    'missing-record',
    'spent-without-installation',
    'missing-initial-proof',
    'committed-marker-only',
  ] as const)('inconsistent %s never proves rollback', async (kind) => {
    const s = await setup()
    try {
      if (kind === 'missing-record')
        await s.f.installRows({ key: source, control: { deleteRejoin: true } })
      if (kind === 'spent-without-installation') {
        const trust = await s.f.device.groups.loadTrust(groupID)
        if (trust === null) throw new Error('Missing trust')
        await s.f.installRows({
          key: source,
          trust: {
            ...trust,
            spentEpochAuthenticators: [
              ...trust.spentEpochAuthenticators,
              s.recovery.candidate.state.keySchedule.epochAuthenticator,
            ],
          },
        })
      }
      if (kind === 'missing-initial-proof') {
        await s.f.registry.switchIncarnation(s.recovery.candidate, {
          source: await s.f.registry.recoverySource(groupID),
          rejoinID: s.recovery.record.id,
          proof: s.recovery.proof,
          write: {
            mutationID: s.recovery.record.switchMutationID ?? 'missing-switch-id',
            source: { rejoinID: s.recovery.record.id },
            destination: {
              control: {
                cursor: {
                  position: s.recovery.proof.position,
                  epoch: s.recovery.record.epochAfter,
                },
              },
            },
          },
        })
        await s.f.mutateMetadata(destination, (value) => ({
          ...(value as object),
          initialIdentity: null,
        }))
      }
      if (kind === 'committed-marker-only')
        await s.f.device.groups
          .ports(source)
          .control.apply(
            { deleteOutcomes: [] },
            s.recovery.record.switchMutationID ?? 'missing-switch-id',
          )
      expect(
        await registryRecoveryCoordinator(s.f.registry).resolveRecoverySwitch(s.recovery.record),
      ).toEqual({ kind: 'pending' })
    } finally {
      await s.f.close()
    }
  })
  test.each(['commit', 'rollback'] as const)(
    'hooked uncertain %s never releases a destination before settlement',
    async (outcome) => {
      const s = await setup()
      let owner: api.RegistryPeer | undefined
      const id = s.recovery.record.switchMutationID ?? 'missing-switch-id'
      const fault = s.f.armWorkFault(id, 'pending')
      const proof = s.f.holdProof(id)
      try {
        owner = await s.start()
        await fault.rejected
        await proof.started
        expect(s.created).toEqual([])
        expect(owner.installedKey()).toEqual(source)
        await fault.finish(outcome)
        proof.release()
        await owner.ready
        expect(s.created.map(({ key }) => key)).toEqual([destination])
      } finally {
        await fault.finish(outcome)
        proof.release()
        owner?.dispose()
        await owner?.drained()
        await s.f.close()
      }
    },
  )

  test('rejected retirement hooks stop acceptance with confirmed bytes intact', async () => {
    const s = await setup()
    let owner: api.RegistryPeer | undefined
    try {
      registrySafety(s.f.registry)?.onRetire(source, async () => {
        throw new Error('Host drain rejected')
      })
      const before = await s.f.device.groups.ports(source).control.load()
      owner = await s.start()
      await expect(owner.ready).rejects.toMatchObject({ name: 'RegistryRetireHookError' })
      expect(await s.f.device.groups.ports(source).control.load()).toEqual(before)
      expect(s.created).toEqual([])
    } finally {
      owner?.dispose()
      await owner?.drained()
      await s.f.close().catch(() => {})
    }
  })

  test('pending proofs retry with bounded backoff and never write or create peers', async () => {
    const s = await setup()
    let owner: api.RegistryPeer | undefined
    const capability = registryRecoveryCoordinator(s.f.registry)
    const resolve = vi
      .spyOn(capability, 'resolveRecoverySwitch')
      .mockResolvedValue({ kind: 'pending' })
    const write = vi.spyOn(s.f.registry, 'switchIncarnation')
    try {
      vi.useFakeTimers()
      owner = await s.start()
      for (let round = 0; round < 12; round++) {
        await vi.waitFor(() => expect(resolve.mock.calls.length).toBe(round + 1))
        await vi.advanceTimersToNextTimerAsync()
      }
      expect(write).not.toHaveBeenCalled()
      expect(s.created).toEqual([])
      expect(
        resolve.mock.calls.every(
          ([record]) => record.switchMutationID === s.recovery.record.switchMutationID,
        ),
      ).toBe(true)
      expect(vi.getTimerCount()).toBeLessThanOrEqual(1)
    } finally {
      owner?.dispose()
      await owner?.drained()
      vi.useRealTimers()
      await s.f.close()
    }
  })

  test('local rollback followed by authenticated source movement preserves accepted work across restart', async () => {
    const s = await setup()
    let fixture = s.f
    let owner: api.RegistryPeer | undefined
    try {
      const record = {
        ...s.recovery.record,
        ledgerBefore: ['owed-ledger-token', ...s.recovery.record.ledgerBefore],
      }
      await fixture.installRows({
        key: source,
        control: {
          putRejoin: record,
          putWelcomes: [
            { opID: 'owed', welcome: new Uint8Array([7]), recipients: ['member'], committed: true },
          ],
          putOutcomes: [{ id: 'prior', opID: null, at: 1, kind: 'unknown' }],
        },
      })
      const before = await fixture.device.groups.ports(source).control.load()
      fixture.armWorkFault(record.switchMutationID ?? 'missing-switch-id', 'before-commit')
      const switchCall = fixture.registry.switchIncarnation.bind(fixture.registry)
      vi.spyOn(fixture.registry, 'switchIncarnation').mockImplementation(
        async (candidate, input) => {
          try {
            return await switchCall(candidate, input)
          } catch (error) {
            const state = await fixture.device.groups.loadState(source)
            if (state === null || state.deleted) throw new Error('Missing state', { cause: error })
            const trust = await fixture.device.groups.loadTrust(groupID)
            const handle = await (await fixture.registry.access(groupID)).read((value) => value)
            const advanced = await fixture.advance(handle)
            await fixture.installRows({
              key: source,
              state: {
                ...state,
                version: state.version + 1,
                epoch: Number(advanced.epoch),
                epochAuthenticator: advanced.state.keySchedule.epochAuthenticator,
                state: encodeClientState(advanced.state),
              },
              trust: recoveryTrustFor(advanced, source, trust),
            })
            throw error
          }
        },
      )
      owner = await s.start()
      await expect(owner.ready).rejects.toThrow('Accepted recovery origin moved')
      expect(await fixture.device.groups.ports(source).control.load()).toEqual(before)
      expect(await fixture.device.groups.loadState(destination)).toBeNull()
      owner.dispose()
      await owner.drained()
      owner = undefined
      fixture = await fixture.reopen()
      const createMLS = vi.fn(() => {
        throw new Error('Moved accepted work must stay stopped')
      })
      owner = await s.start({
        registry: fixture.registry,
        recovery: fixture.environment,
        continuation: api.createRecoveryContinuationPort({
          registry: fixture.registry,
          persistence: fixture.device.groups,
        }),
        createMLS,
      })
      await expect(owner.ready).rejects.toThrow('Accepted recovery origin moved')
      expect(createMLS).not.toHaveBeenCalled()
      expect(await fixture.device.groups.ports(source).control.load()).toEqual(before)
      expect(await fixture.device.groups.loadState(destination)).toBeNull()
    } finally {
      owner?.dispose()
      await owner?.drained()
      await fixture.close()
    }
  })

  test('a transient provider TypeError retains the saved attempt and retries through resolution', async () => {
    const s = await setup()
    let owner: api.RegistryPeer | undefined
    try {
      const resolve = vi
        .spyOn(s.f.device.groups, 'resolve')
        .mockRejectedValueOnce(new TypeError('Temporary provider failure'))
      owner = await s.start()
      await owner.ready
      expect(owner.installedKey()).toEqual(destination)
      expect(resolve.mock.calls.every(([, id]) => id === s.recovery.record.switchMutationID)).toBe(
        true,
      )
    } finally {
      owner?.dispose()
      await owner?.drained()
      await s.f.close()
    }
  })
})
