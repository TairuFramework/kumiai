import { randomIdentity } from '@kokuin/token'
import * as mlsAPI from '@kumiai/mls'
import {
  commitInvite,
  commitKeyRotation,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  encodeClientState,
  processWelcome,
} from '@kumiai/mls'
import type {
  ConfirmedRecoveryHandoff,
  GroupPeer,
  GroupProtocolDefinition,
  LogHub,
  RecoveryEvent,
} from '@kumiai/rpc'
import {
  commitTopic,
  createGroupPeer,
  decodeCommitFrame,
  decodeHandshakeFrame,
  encodeCommitFrame,
  encodeHandshakeFrame,
  HANDSHAKE_KIND,
} from '@kumiai/rpc'
import { describe, expect, test, vi } from 'vitest'

import type { EntryReads } from '../src/entry-capability.js'
import * as api from '../src/index.js'
import {
  createVerdictJudge,
  RecoveryCandidateError,
  restoreRecoveryCandidate,
} from '../src/recovery.js'
import {
  decodeCapturedRecoveryCandidate,
  encodeCapturedRecoveryCandidate,
} from '../src/recovery-codec.js'
import * as publicRecovery from '../src/recovery-public-state.js'
import { validateCapturedRecoveryRecord } from '../src/recovery-record.js'
import { registryRecoveryCoordinator } from '../src/registry/recovery-coordinator.js'
import { registryRetirement } from '../src/registry/retirement.js'
import { registrySafety } from '../src/registry/safety.js'
import { recoveryTrustFor } from '../src/registry/trust.js'
import { deferred } from '../src/runtime.js'
import {
  createNotMemberFixture,
  createRegistryFixture,
  registryFixtureRecoverySource,
} from './fixtures/registry.js'
import { createRegistryRecovery } from './fixtures/registry-recovery.js'

const groupID = 'registry-peer'
const source = { groupID, incarnation: 1 }
const destination = { groupID, incarnation: 2 }
const target = { targetID: 'registry-recovery-hub', topicID: `commits/${groupID}` }
const { FakeHub } = (await import(
  new URL('../../rpc/test/fixtures/fake-hub.ts', import.meta.url).href
)) as { FakeHub: new () => LogHub }

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
    recoverySource: await registryFixtureRecoverySource(f, source),
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
      createMLS: async (key) =>
        api.createRegistryGroupMLS({
          registry: f.registry,
          key,
          recovery: f.environment,
          target,
          identity: f.identity,
          entrySlot: api.createLedgerEntrySlot(),
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
    responder,
    responderIdentity,
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
  test('peer factories receive the registry-bound checkpoint service', async () => {
    const s = await setup(false)
    const owner = await s.start()
    try {
      await owner.ready
      const created = s.created[0]
      if (created === undefined) throw new Error('Missing peer factory call')
      const service = created.options.checkpoints
      const records = await service.readRecords()
      const fact = records.find((row) => row.kind === 'fact')
      if (fact?.kind !== 'fact') throw new Error('Missing installed fact')
      expect(await service.signInstalled(fact.id)).toBeInstanceOf(Uint8Array)
      expect(await service.checkpointCoverage(source.groupID)).toMatchObject({
        current: { key: source },
      })
      await expect(
        service.updateRecords({ put: [{ ...fact, id: 'fabricated' }] }),
      ).rejects.toThrow()
    } finally {
      owner.dispose()
      await owner.drained()
      await s.f.close()
    }
  })
  test.each(['return', 'throw', 'reject'] as const)(
    'a terminal handoff failure reaches the live host when its diagnostic callback will %s',
    async (callback) => {
      const s = await setup(false)
      let owner: api.RegistryPeer | undefined
      try {
        const events: Array<RecoveryEvent> = []
        owner = await s.start({
          onRecovery: (event) => {
            events.push(event)
            if (callback === 'throw') throw new Error('Host diagnostic failed')
            if (callback === 'reject') return Promise.reject(new Error('Host diagnostic rejected'))
          },
        })
        await owner.ready
        const error = new api.GroupStateConflictError('Confirmed recovery cannot continue')
        vi.spyOn(
          registryRecoveryCoordinator(s.f.registry),
          'resolveRecoverySwitch',
        ).mockRejectedValue(error)
        await s.f.installRows({ key: source, control: { putRejoin: s.recovery.record } })
        const before = await s.f.inspectRows()
        s.handoff()({ record: s.recovery.record, completion: Promise.resolve() })
        await vi.waitFor(() => expect(owner?.peer()).toBeNull())
        await vi.waitFor(() => expect(events).toHaveLength(1))
        expect(events[0]).toEqual({
          groupID: target.topicID,
          attemptID: s.recovery.record.id,
          trigger: 'automatic',
          phase: 'failed',
          reason: 'error',
          error,
        })
        expect(owner.status()).toEqual({ kind: 'failed', error })
        expect(await s.f.inspectRows()).toEqual(before)
        owner.dispose()
        await expect(owner.drained()).rejects.toBe(error)
      } finally {
        owner?.dispose()
        await owner?.drained().catch(() => {})
        vi.restoreAllMocks()
        await s.f.close()
      }
    },
  )

  test('an unresolved switch exposes pending state while ready waits without a timeout', async () => {
    const s = await setup()
    let owner: api.RegistryPeer | undefined
    try {
      vi.spyOn(
        registryRecoveryCoordinator(s.f.registry),
        'resolveRecoverySwitch',
      ).mockResolvedValue({ kind: 'pending' })
      const events: Array<RecoveryEvent> = []
      vi.useFakeTimers()
      owner = await s.start({
        onRecovery: (event) => {
          events.push(event)
        },
      })
      let ready = false
      void owner.ready.then(() => {
        ready = true
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(owner.status()).toEqual({ kind: 'pending' })
      expect(owner.peer()).toBeNull()
      await vi.advanceTimersByTimeAsync(120_000)
      expect(owner.status()).toEqual({ kind: 'pending' })
      expect(ready).toBe(false)
      expect(events).toEqual([])
      owner.dispose()
      await owner.drained()
      expect(owner.status()).toEqual({ kind: 'disposed' })
    } finally {
      owner?.dispose()
      await owner?.drained().catch(() => {})
      vi.useRealTimers()
      vi.restoreAllMocks()
      await s.f.close()
    }
  })

  test.each(['acceptance-unknown', 'unsupported-version'] as const)(
    'restart with %s preserves hold policy through normal delivery',
    async (reason) => {
      const s = await setup(false)
      await s.f.installRows({ key: source, control: { controlHold: { reason, position: null } } })
      const f = await s.f.reopen()
      let owner: api.RegistryPeer | undefined
      try {
        const hub = new FakeHub()
        owner = await api.createRegistryPeer({
          registry: f.registry,
          key: source,
          recovery: f.environment,
          target,
          continuation: api.createRecoveryContinuationPort({
            registry: f.registry,
            persistence: f.device.groups,
          }),
          createMLS: (key) =>
            api.createRegistryGroupMLS({
              registry: f.registry,
              key,
              recovery: f.environment,
              target,
              identity: f.identity,
              entrySlot: api.createLedgerEntrySlot(),
            }),
          createPeer: async (key, options) => {
            const ports = f.device.groups.ports(key)
            return createGroupPeer({
              ...options,
              hub,
              crypto: api.createGroupCrypto({ access: await f.registry.access(key.groupID) }),
              control: ports.control,
              anchorStore: ports.anchor,
              appCursorStore: ports.cursor,
              appOutbox: ports.outbox,
              appOutboxLimit: 16,
              localDID: f.identity.id,
              protocols: {},
              handlers: {},
              validation: api.createControlValidationPort({
                identity: f.identity,
                options: f.environment.options,
                restoreCandidate: async () => {
                  throw new Error('No own candidate expected')
                },
              }),
              readEvidence: () => f.device.groups.readEvidence(key),
              prepareBuild: async () => {
                throw new Error('No own build expected')
              },
              adopt: async () => {
                throw new Error('No own adoption expected')
              },
              deliverWelcome: async () => {},
            })
          },
        })
        if (reason === 'unsupported-version') {
          await expect(owner.ready).rejects.toThrow('held')
          expect(owner.peer()).toBeNull()
          expect((await f.device.groups.ports(source).control.load()).controlHold?.reason).toBe(
            reason,
          )
        } else {
          await owner.ready
          const peer = owner.peer()
          if (peer === null) throw new Error('Restart did not start a peer')
          await peer.replay()
          expect((await f.device.groups.ports(source).control.load()).controlHold?.reason).toBe(
            reason,
          )
          const rotation = await commitKeyRotation(s.responder)
          const topicID = commitTopic(await api.deriveRecoverySecret(s.responder))
          await hub.publish({
            topicID,
            senderDID: s.responderIdentity.id,
            payload: encodeHandshakeFrame(
              HANDSHAKE_KIND.commit,
              encodeCommitFrame(rotation.commitMessage, new Uint8Array()),
            ),
            retain: 'log',
          })
          await vi.waitFor(async () => {
            const control = await f.device.groups.ports(source).control.load()
            expect(control.cursor?.epoch).toBe(Number(rotation.newGroup.epoch))
            expect(control.controlHold).toBeNull()
          })
        }
      } finally {
        owner?.dispose()
        await owner?.drained().catch(() => {})
        await f.close()
        await s.f.close()
      }
    },
  )

  test.each([
    ['acceptance-unknown', false],
    ['acceptance-unknown', true],
    ['unsupported-version', false],
    ['unsupported-version', true],
  ] as const)(
    'confirmed recovery with %s and missing switch ID=%s obeys hold policy',
    async (reason, missingID) => {
      const s = await setup(false)
      let owner: api.RegistryPeer | undefined
      try {
        const record = {
          ...s.recovery.record,
          switchMutationID: missingID ? null : s.recovery.record.switchMutationID,
        }
        await s.f.installRows({
          key: source,
          control: { putRejoin: record, controlHold: { reason, position: null } },
        })
        const before = await s.f.inspectRows()
        owner = await s.start()
        if (reason === 'unsupported-version') {
          await expect(owner.ready).rejects.toThrow('held')
          expect(await s.f.inspectRows()).toEqual(before)
          expect(owner.peer()).toBeNull()
          if (missingID)
            await expect(
              registryRecoveryCoordinator(s.f.registry).assignSwitchID(record),
            ).rejects.toThrow('held')
        } else {
          await owner.ready
          expect(owner.installedKey()).toEqual(destination)
          const old = await s.f.device.groups.ports(source).control.load()
          expect(old.rejoin?.stage).toBe('adopted')
          expect(old.controlHold).toBeNull()
          if (old.rejoin === null || !('format' in old.rejoin))
            throw new Error('Missing captured adoption')
          expect(await s.f.device.groups.ports(source).control.lastMutation()).toBe(
            old.rejoin.switchMutationID,
          )
          expect((await s.f.device.groups.ports(destination).control.load()).controlHold).toBeNull()
        }
      } finally {
        owner?.dispose()
        await owner?.drained().catch(() => {})
        await s.f.close()
      }
    },
  )

  test.each(['acceptance-unknown', 'unsupported-version'] as const)(
    'accepted-unadoptable settlement with %s obeys hold policy in one transition',
    async (reason) => {
      const s = await setup(false)
      let owner: api.RegistryPeer | undefined
      try {
        owner = await s.start()
        await owner.ready
        const record = { ...s.recovery.record, ledgerBefore: ['owed-X'] }
        await s.f.installRows({
          key: source,
          control: {
            putRejoin: record,
            controlHold: { reason, position: null },
            putOutcomes: [{ id: 'prior', opID: null, at: 1, kind: 'unknown' }],
            putWelcomes: [
              {
                opID: 'owed',
                welcome: new Uint8Array([7]),
                recipients: ['member'],
                committed: true,
              },
            ],
          },
        })
        const before = await s.f.inspectRows()
        const settle = s.created[0]?.options.settleAcceptedRecovery
        if (settle === undefined) throw new Error('Missing settlement sink')
        let transitions = 0
        s.f.onPhase('work', () => {
          transitions++
        })
        if (reason === 'unsupported-version') {
          await expect(
            settle(record, record.epochAfter + 1, 'authenticated-leaf', record.epochAfter + 2),
          ).rejects.toThrow('settlement')
          expect(await s.f.inspectRows()).toEqual(before)
          expect(transitions).toBe(0)
          expect(record.requestKey.some((byte) => byte !== 0)).toBe(true)
        } else {
          await settle(record, record.epochAfter + 1, 'authenticated-leaf', record.epochAfter + 2)
          expect(transitions).toBe(1)
          const snapshot = await s.f.device.groups.ports(source).control.load()
          expect(snapshot.controlHold).toBeNull()
          expect(snapshot.rejoin).toBeNull()
          expect(snapshot.recoveryEpochFloor).toBe(record.epochAfter + 2)
          expect(snapshot.settledRejoins).toEqual([
            expect.objectContaining({
              id: record.id,
              kind: 'accepted-unadoptable',
              ledgerBefore: ['owed-X'],
            }),
          ])
          expect(snapshot.outcomes).toContainEqual({
            id: 'prior',
            opID: null,
            at: 1,
            kind: 'unknown',
          })
          expect(snapshot.welcomes.map((row) => row.opID)).toEqual(['owed'])
          expect(record.requestKey.every((byte) => byte === 0)).toBe(true)
          expect(record.candidate.every((byte) => byte === 0)).toBe(true)
        }
      } finally {
        owner?.dispose()
        await owner?.drained().catch(() => {})
        await s.f.close()
      }
    },
  )

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

  test('moved identity preserves accepted bytes and obligations while offering authenticated settlement', async () => {
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
      await owner.ready
      expect(await s.f.device.groups.ports(source).control.load()).toEqual(before)
      expect(owner.peer()).not.toBeNull()
      expect(s.created[0]?.options.reconcileConfirmedRecovery).toBe(before.rejoin?.id)
      expect(s.created[0]?.options.settleAcceptedRecovery).toBeTypeOf('function')
    } finally {
      owner?.dispose()
      await owner?.drained().catch(() => {})
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
        await owner?.drained().catch(() => {})
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
        await owner?.drained().catch(() => {})
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
      const advanced = await s.f.advance(await s.f.restoreCommittedSender(groupID))
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
      await owner?.drained().catch(() => {})
      await s.f.close().catch(() => {})
    }
  })

  test('switch proof remains visibly pending without elapsed bound', async () => {
    const s = await setup()
    let owner: api.RegistryPeer | undefined
    const capability = registryRecoveryCoordinator(s.f.registry)
    const resolve = vi
      .spyOn(capability, 'resolveRecoverySwitch')
      .mockResolvedValue({ kind: 'pending' })
    const write = vi.spyOn(s.f.registry, 'switchIncarnation')
    try {
      vi.useFakeTimers()
      const delays: Array<number> = []
      owner = await s.start()
      for (let round = 0; round < 100; round++) {
        await vi.advanceTimersByTimeAsync(0)
        expect(resolve.mock.calls.length).toBe(round + 1)
        expect(vi.getTimerCount()).toBe(1)
        const before = Date.now()
        await vi.advanceTimersToNextTimerAsync()
        delays.push(Date.now() - before)
      }
      expect(delays).toEqual([
        100,
        200,
        400,
        800,
        1600,
        3200,
        6400,
        12800,
        ...Array<number>(92).fill(15000),
      ])
      expect(owner.status()).toEqual({ kind: 'pending' })
      expect(await s.f.device.groups.ports(source).control.load()).toMatchObject({
        rejoin: s.recovery.record,
      })
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

  test('local switch rollback and source movement recapture accepted X through the shared settlement callback', async () => {
    const s = await setup()
    let owner: api.RegistryPeer | undefined
    try {
      const record = { ...s.recovery.record, ledgerBefore: ['owed-X'] }
      await s.f.installRows({
        key: source,
        control: {
          putRejoin: record,
          putWelcomes: [
            { opID: 'owed', welcome: new Uint8Array([7]), recipients: ['member'], committed: true },
          ],
          putOutcomes: [{ id: 'prior', opID: null, at: 1, kind: 'unknown' }],
        },
      })
      const stored = await s.f.device.groups.loadState(source)
      if (stored === null || stored.deleted) throw new Error('Missing source')
      const trust = await s.f.device.groups.loadTrust(groupID)
      const handle = await (await s.f.registry.access(groupID)).read((value) => value)
      const moved = await s.f.advance(handle)
      await s.f.installRows({
        key: source,
        state: {
          ...stored,
          version: stored.version + 1,
          epoch: Number(moved.epoch),
          epochAuthenticator: moved.state.keySchedule.epochAuthenticator,
          state: encodeClientState(moved.state),
        },
        trust: recoveryTrustFor(moved, source, trust),
      })
      owner = await s.start()
      await owner.ready
      expect(owner.installedKey()).toEqual(source)
      const options = s.created[0]?.options
      if (
        options?.reconcileAcceptedRecovery === undefined ||
        options.settleAcceptedRecovery === undefined
      )
        throw new Error('Missing accepted settlement callbacks')
      expect(options.recoveryOnly).toBe(true)
      expect((await s.f.device.groups.ports(source).control.load()).rejoin).toEqual(record)
      const requestID = 'moved-accepted-X'
      const { request, requestKey } = await options.mls.createRecoveryRequest(requestID)
      await s.responder.processMessage(
        decodeCommitFrame(decodeHandshakeFrame(record.payload).payload).commit,
      )
      const advanced = await s.f.advance(s.responder)
      const sealed = await mlsAPI.sealCapturedGroupInfo({
        group: advanced,
        identity: s.responderIdentity,
        request: new TextDecoder().decode(request),
        captureHead: null,
      })
      const result = await options.reconcileAcceptedRecovery(record, {
        sealed,
        requestID,
        requestKey,
        epochFloor: null,
      })
      expect(result).toMatchObject({
        kind: 'accepted',
        epoch: Number(advanced.epoch),
        leafDigest: expect.any(String),
      })
      if (result.kind !== 'accepted') throw new Error('X acceptance was not authenticated')
      await options.settleAcceptedRecovery(
        record,
        record.epochAfter,
        result.leafDigest,
        result.epoch,
      )
      const snapshot = await s.f.device.groups.ports(source).control.load()
      expect(snapshot.rejoin).toBeNull()
      expect(snapshot.recoveryEpochFloor).toBe(Number(advanced.epoch))
      expect(snapshot.settledRejoins).toEqual([
        expect.objectContaining({
          kind: 'accepted-unadoptable',
          id: record.id,
          acceptedEpoch: record.epochAfter,
          ledgerBefore: ['owed-X'],
        }),
      ])
      expect(snapshot.welcomes.map((row) => row.opID)).toEqual(['owed'])
      expect(snapshot.outcomes).toContainEqual({ id: 'prior', opID: null, at: 1, kind: 'unknown' })
      const yRequest = await options.mls.createRecoveryRequest('fresh-Y')
      const yReply = await mlsAPI.sealCapturedGroupInfo({
        group: advanced,
        identity: s.responderIdentity,
        request: new TextDecoder().decode(yRequest.request),
        captureHead: null,
      })
      const y = await options.mls.capturedRecovery?.applyRecovery(
        yReply,
        'fresh-Y',
        yRequest.requestKey,
      )
      if (y === null || y === undefined || 'renewalRequired' in y) throw new Error('Missing Y')
      await advanced.processMessage(y.commit)
      expect(Number(advanced.epoch)).toBe(result.epoch + 1)
      expect(advanced.listMembers().filter((member) => member.id === s.f.identity.id)).toHaveLength(
        1,
      )
    } finally {
      owner?.dispose()
      await owner?.drained().catch(() => {})
      await s.f.close()
    }
  })

  test.each([
    'destination-row',
    'initial-identity',
    'spent-candidate',
    'missing-trust',
    'adopted-uninstalled',
    'adopted-unspent',
  ] as const)(
    'inconsistent switch evidence %s cannot authorise replay or release',
    async (kind) => {
      const s = await setup()
      const safety = registrySafety(s.f.registry)
      if (safety === null) throw new Error('Missing capability')
      const read = safety.entry.read.bind(safety.entry)
      try {
        const adopted = kind.startsWith('adopted-')
        if (adopted) {
          const owner = await s.start()
          await owner.ready
          owner.dispose()
          await owner.drained()
        }
        const metadata = await read(groupID, (reads) => reads.metadata(adopted ? 2 : 1))
        if (metadata === null) throw new Error('Missing metadata')
        const authenticator = s.recovery.candidate.state.keySchedule.epochAuthenticator
        const override = (reads: EntryReads): EntryReads => ({
          ...reads,
          metadata: async (incarnation) => {
            if (incarnation !== 2) return reads.metadata(incarnation)
            if (kind === 'destination-row')
              return { ...metadata, ...destination, initialIdentity: null }
            if (kind === 'initial-identity')
              return {
                ...metadata,
                ...destination,
                initialIdentity: {
                  ...destination,
                  epoch: s.recovery.record.epochAfter,
                  authenticator,
                },
              }
            if (kind === 'adopted-uninstalled') return null
            return reads.metadata(incarnation)
          },
          trust: async () => {
            const trust = await reads.trust()
            if (trust === null) throw new Error('Missing trust')
            if (kind === 'missing-trust') return null
            if (kind === 'spent-candidate')
              return {
                ...trust,
                spentEpochAuthenticators: [...trust.spentEpochAuthenticators, authenticator],
              }
            if (kind === 'adopted-unspent')
              return {
                ...trust,
                spentEpochAuthenticators: trust.spentEpochAuthenticators.filter(
                  (value) => !value.every((byte, index) => byte === authenticator[index]),
                ),
              }
            return trust
          },
        })
        vi.spyOn(safety.entry, 'read').mockImplementation((id, fn) =>
          read(id, (reads) => fn(override(reads))),
        )
        const resolving = registryRecoveryCoordinator(s.f.registry).resolveRecoverySwitch(
          s.recovery.record,
        )
        if (kind === 'missing-trust')
          await expect(resolving).rejects.toMatchObject({ reason: 'recovery-unavailable' })
        else await expect(resolving).resolves.toEqual({ kind: 'pending' })
      } finally {
        vi.restoreAllMocks()
        await s.f.close()
      }
    },
  )

  test('concurrent switch ID assignment preserves the first committed ID', async () => {
    const s = await setup(false)
    try {
      const record = { ...s.recovery.record, switchMutationID: null }
      await s.f.installRows({ key: source, control: { putRejoin: record } })
      const coordinator = registryRecoveryCoordinator(s.f.registry)
      const results = await Promise.allSettled([
        coordinator.assignSwitchID(record),
        coordinator.assignSwitchID(record),
      ])
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
      const saved = await coordinator.readRecoveryRecord(source)
      expect(saved).toMatchObject({ ...record, switchMutationID: expect.any(String) })
      await expect(coordinator.assignSwitchID(record)).rejects.toBeInstanceOf(
        api.GroupStateConflictError,
      )
      if (saved === null || !('format' in saved)) throw new Error('Missing captured record')
      await expect(coordinator.assignSwitchID(saved)).rejects.toBeInstanceOf(
        api.GroupStateConflictError,
      )
      expect(await coordinator.readRecoveryRecord(source)).toEqual(saved)
    } finally {
      await s.f.close()
    }
  })

  test('rereads a record removed after proof resolution before accepting', async () => {
    const s = await setup()
    let owner: api.RegistryPeer | undefined
    try {
      const coordinator = registryRecoveryCoordinator(s.f.registry)
      const resolve = coordinator.resolveRecoverySwitch.bind(coordinator)
      vi.spyOn(coordinator, 'resolveRecoverySwitch').mockImplementation(async (record) => {
        const result = await resolve(record)
        await s.f.installRows({ key: source, control: { deleteRejoin: true } })
        return result
      })
      const write = vi.spyOn(s.f.registry, 'switchIncarnation')
      owner = await s.start()
      const error = await owner.ready.then(
        () => null,
        (error: unknown) => error,
      )
      expect(write).not.toHaveBeenCalled()
      expect(error).toBeInstanceOf(api.GroupStateConflictError)
      expect(error).toMatchObject({ message: 'Confirmed recovery moved after drainage' })
      expect(await coordinator.readRecoveryRecord(source)).toBeNull()
    } finally {
      owner?.dispose()
      await owner?.drained().catch(() => {})
      await s.f.close()
    }
  })

  test.each([
    ['MLS', 'retirement'],
    ['continuation', 'retirement'],
    ['peer', 'retirement'],
    ['MLS', 'dispose'],
    ['continuation', 'dispose'],
    ['peer', 'dispose'],
  ] as const)(
    'a %s factory completion after %s cannot install a stale peer',
    async (stage, invalidation) => {
      const s = await setup(false)
      const entered = deferred<void>()
      const release = deferred<void>()
      let owner: api.RegistryPeer | undefined
      let releasedMLS = false
      let releasedPeer = false
      let madePeer = false
      let loadedContinuation = false
      try {
        const load = s.continuation.loadRecoveryContinuation.bind(s.continuation)
        vi.spyOn(s.continuation, 'loadRecoveryContinuation').mockImplementation(async (key) => {
          loadedContinuation = true
          if (stage === 'continuation') {
            entered.resolve()
            await release.promise
          }
          return load(key)
        })
        owner = await s.start({
          createMLS: async (key) => {
            const mls = await api.createRegistryGroupMLS({
              registry: s.f.registry,
              key,
              recovery: s.f.environment,
              target,
              identity: s.f.identity,
              entrySlot: api.createLedgerEntrySlot(),
            })
            if (stage === 'MLS') {
              entered.resolve()
              await release.promise
            }
            return {
              ...mls,
              dispose: async () => {
                releasedMLS = true
              },
            }
          },
          createPeer: async () => {
            madePeer = true
            if (stage === 'peer') {
              entered.resolve()
              await release.promise
            }
            return peerDouble(async () => {
              releasedPeer = true
            })
          },
        })
        await entered.promise
        let retiring: Promise<void> | undefined
        let attempt:
          | ReturnType<ReturnType<typeof registryRetirement>['beginRetirement']>
          | undefined
        if (invalidation === 'dispose') owner.dispose()
        else {
          const hook = deferred<void>()
          registrySafety(s.f.registry)?.onRetire(source, async () => {
            hook.resolve()
          })
          attempt = registryRetirement(s.f.registry).beginRetirement(source)
          retiring = attempt.drain()
          await hook.promise
        }
        release.resolve()
        await retiring
        attempt?.settle('rolled-back')
        await owner.ready
        expect(owner.peer()).toBeNull()
        expect(releasedMLS).toBe(true)
        expect(loadedContinuation).toBe(stage !== 'MLS')
        expect(madePeer).toBe(stage === 'peer')
        expect(releasedPeer).toBe(stage === 'peer')
      } finally {
        release.resolve()
        owner?.dispose()
        await owner?.drained().catch(() => {})
        await s.f.close()
      }
    },
  )

  test.each(['wrong-key', 'duplicate', 'disposed'] as const)(
    'ignores a %s handoff without switching',
    async (kind) => {
      const s = await setup(false)
      const completion = deferred<void>()
      let owner: api.RegistryPeer | undefined
      try {
        owner = await s.start()
        await owner.ready
        await s.f.installRows({ key: source, control: { putRejoin: s.recovery.record } })
        const read = vi.spyOn(registryRecoveryCoordinator(s.f.registry), 'readRecoveryRecord')
        const write = vi.spyOn(s.f.registry, 'switchIncarnation')
        if (kind === 'disposed') owner.dispose()
        if (kind === 'duplicate')
          s.handoff()({ record: s.recovery.record, completion: completion.promise })
        s.handoff()({
          record:
            kind === 'wrong-key'
              ? { ...s.recovery.record, source: { ...s.recovery.record.source, key: destination } }
              : s.recovery.record,
          completion: Promise.resolve(),
        })
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(read).not.toHaveBeenCalled()
        expect(write).not.toHaveBeenCalled()
      } finally {
        owner?.dispose()
        completion.resolve()
        await owner?.drained().catch(() => {})
        await s.f.close()
      }
    },
  )

  test.each(['drain', 'construction'] as const)(
    'a hanging source %s releases retirement without writes and the coordinator retries',
    async (phase) => {
      const s = await setup(false)
      const entered = deferred<void>()
      const release = deferred<void>()
      let sourceOwner: api.RegistryPeer | undefined
      let switchOwner: api.RegistryPeer | undefined
      try {
        sourceOwner = await s.start({
          createPeer: async () => {
            if (phase === 'construction') {
              entered.resolve()
              await release.promise
            }
            return peerDouble(async () => {
              if (phase === 'drain') {
                entered.resolve()
                await release.promise
              }
            })
          },
        })
        if (phase === 'drain') await sourceOwner.ready
        else await entered.promise
        await s.f.installRows({ key: source, control: { putRejoin: s.recovery.record } })
        const before = await s.f.inspectRows()
        const calls = vi.spyOn(s.f.registry, 'switchIncarnation')
        vi.useFakeTimers()
        switchOwner = await s.start()
        await vi.waitFor(() => expect(calls).toHaveBeenCalledTimes(1))
        await entered.promise
        await vi.advanceTimersByTimeAsync(5_000)
        await expect(s.f.registry.access(groupID)).resolves.toMatchObject({ key: source })
        expect(await s.f.inspectRows()).toEqual(before)
        expect(calls).toHaveBeenCalledTimes(1)
        release.resolve()
        await vi.advanceTimersByTimeAsync(100)
        await switchOwner.ready
        expect(switchOwner.installedKey()).toEqual(destination)
        expect(calls).toHaveBeenCalledTimes(2)
        expect(calls.mock.calls.map(([, input]) => input.write.mutationID)).toEqual([
          s.recovery.record.switchMutationID,
          s.recovery.record.switchMutationID,
        ])
      } finally {
        release.resolve()
        sourceOwner?.dispose()
        switchOwner?.dispose()
        await sourceOwner?.drained().catch(() => {})
        await switchOwner?.drained().catch(() => {})
        vi.useRealTimers()
        await s.f.close()
      }
    },
  )

  test.each(['continuation', 'peer-factory'] as const)(
    'a failed %s start releases its owned MLS adapter',
    async (phase) => {
      const s = await setup(false)
      let owner: api.RegistryPeer | undefined
      let disposed = false
      try {
        const makeMLS = async (key: api.GroupKey) => {
          const mls = await api.createRegistryGroupMLS({
            registry: s.f.registry,
            key,
            recovery: s.f.environment,
            target,
            identity: s.f.identity,
            entrySlot: api.createLedgerEntrySlot(),
          })
          return {
            ...mls,
            dispose: async () => {
              disposed = true
            },
          }
        }
        if (phase === 'continuation')
          vi.spyOn(s.continuation, 'loadRecoveryContinuation').mockRejectedValue(
            new api.GroupStateConflictError('Cannot start'),
          )
        owner = await s.start({
          createMLS: makeMLS,
          ...(phase === 'peer-factory'
            ? {
                createPeer: async () => {
                  throw new api.GroupStateConflictError('Cannot start')
                },
              }
            : {}),
        })
        await expect(owner.ready).rejects.toThrow('Cannot start')
        expect(disposed).toBe(true)
        expect(owner.peer()).toBeNull()
      } finally {
        owner?.dispose()
        await owner?.drained().catch(() => {})
        await s.f.close()
      }
    },
  )

  test.each(['startup', 'handoff'] as const)(
    'a locally invalid bound tag stops %s with a diagnostic and preserves the attempt',
    async (path) => {
      const s = await setup(false)
      let owner: api.RegistryPeer | undefined
      try {
        const snapshot = decodeCapturedRecoveryCandidate(
          s.recovery.record.candidate,
          s.recovery.record.requestKey,
        )
        if (snapshot.boundCommit === undefined) throw new Error('Missing bound commit')
        const tag = snapshot.boundCommit.tag
        if (tag === undefined) throw new Error('Missing tag')
        const candidate = encodeCapturedRecoveryCandidate(
          {
            ...snapshot,
            boundCommit: {
              ...snapshot.boundCommit,
              tag: `${tag[0] === 'A' ? 'B' : 'A'}${tag.slice(1)}`,
            },
          },
          s.recovery.record.requestKey,
        )
        const record = { ...s.recovery.record, candidate }
        expect(() => validateCapturedRecoveryRecord(record)).not.toThrow()
        const write = vi.spyOn(s.f.registry, 'switchIncarnation')
        const resolve = vi.spyOn(registryRecoveryCoordinator(s.f.registry), 'resolveRecoverySwitch')
        if (path === 'handoff') {
          owner = await s.start()
          await owner.ready
        }
        await s.f.installRows({ key: source, control: { putRejoin: record } })
        const before = await s.f.inspectRows()
        if (path === 'startup') {
          owner = await s.start()
          await expect(owner.ready).rejects.toThrow('confirmation tag mismatch')
        } else {
          s.handoff()({ record, completion: Promise.resolve() })
          await vi.waitFor(() => expect(resolve).toHaveBeenCalled())
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        if (owner === undefined) throw new Error('Missing owner')
        owner.dispose()
        await expect(owner.drained()).rejects.toThrow('confirmation tag mismatch')
        expect(write).not.toHaveBeenCalled()
        expect(resolve).toHaveBeenCalledTimes(1)
        expect(await s.f.inspectRows()).toEqual(before)
      } finally {
        owner?.dispose()
        await owner?.drained().catch(() => {})
        await s.f.close()
      }
    },
  )

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

  test.each([
    'decode',
    'owner',
    'restore',
    'restore-capability',
    'authentication',
    'authentication-refusal',
    'attestation-tree',
    'authentication-lapse',
    'authentication-revoke',
    'ledger',
    'confirmation-refusal',
  ] as const)('a saved candidate %s failure stops with unchanged persistence', async (fault) => {
    const s = await setup()
    let owner: api.RegistryPeer | undefined
    try {
      const snapshot = decodeCapturedRecoveryCandidate(
        s.recovery.record.candidate,
        s.recovery.record.requestKey,
      )
      let record = s.recovery.record
      if (fault === 'decode') {
        const candidate = record.candidate.slice()
        candidate[candidate.length - 1] = (candidate[candidate.length - 1] ?? 0) ^ 1
        record = { ...record, candidate }
      }
      if (fault === 'restore') {
        record = {
          ...record,
          candidate: encodeCapturedRecoveryCandidate(
            {
              ...snapshot,
              state: {
                ...snapshot.state,
                groupContext: {
                  ...snapshot.state.groupContext,
                  extensions: snapshot.state.groupContext.extensions.filter(
                    (extension) => extension.extensionType !== mlsAPI.GROUP_ANCHOR_EXTENSION_TYPE,
                  ),
                },
              },
            },
            record.requestKey,
          ),
        }
      }
      if (fault === 'restore-capability') {
        const controller = 'did:kokuin:invalid-saved-capability'
        const leafIndex = snapshot.state.privatePath.leafIndex * 2
        const tree = [...snapshot.state.ratchetTree]
        const node = tree[leafIndex]
        if (node?.nodeType !== 1 || !('identity' in node.leaf.credential))
          throw new Error('Missing candidate leaf')
        tree[leafIndex] = {
          ...node,
          leaf: {
            ...node.leaf,
            credential: {
              ...node.leaf.credential,
              identity: new TextEncoder().encode(
                JSON.stringify({
                  id: s.f.identity.id,
                  controller: {
                    id: controller,
                    prefix: [],
                    capability: 'invalid-saved-capability',
                  },
                }),
              ),
            },
          },
        }
        record = {
          ...record,
          candidate: encodeCapturedRecoveryCandidate(
            {
              ...snapshot,
              state: {
                ...snapshot.state,
                ratchetTree: tree,
                groupContext: {
                  ...snapshot.state.groupContext,
                  extensions: snapshot.state.groupContext.extensions.map((extension) =>
                    extension.extensionType === mlsAPI.GROUP_ANCHOR_EXTENSION_TYPE
                      ? mlsAPI.buildGroupAnchorExtension({
                          creatorDID: s.f.identity.id,
                          version: 1,
                          controller,
                        })
                      : extension,
                  ),
                },
              },
            },
            record.requestKey,
          ),
        }
      }
      if (fault === 'authentication') {
        record = {
          ...record,
          candidate: encodeCapturedRecoveryCandidate(
            { ...snapshot, requestID: 'different-authenticated-request' },
            record.requestKey,
          ),
          requestID: 'different-authenticated-request',
        }
      }
      if (fault === 'authentication-refusal') {
        vi.spyOn(mlsAPI, 'authenticateRecoveryReply').mockRejectedValue(
          new mlsAPI.SealedGroupInfoError('unauthenticated', 'Saved attestation refused'),
        )
      }
      if (fault === 'authentication-lapse') {
        vi.spyOn(mlsAPI, 'authenticateRecoveryReply').mockRejectedValue(
          new mlsAPI.LeafLapsedError('lapsed'),
        )
      }
      if (fault === 'authentication-revoke') {
        vi.spyOn(mlsAPI, 'authenticateRecoveryReply').mockRejectedValue(
          new mlsAPI.RevokeProofError('generation-floor'),
        )
      }
      if (fault === 'ledger') {
        vi.spyOn(mlsAPI.GroupHandle.prototype, 'applyLedgerEntries').mockRejectedValue(
          new TypeError('Invalid saved ledger'),
        )
      }
      if (fault === 'confirmation-refusal') {
        vi.spyOn(mlsAPI, 'confirmationKey').mockRejectedValue(
          new mlsAPI.LeafBindingError('confirmation-invalid'),
        )
      }
      if (fault === 'attestation-tree') {
        vi.spyOn(publicRecovery, 'offeredTree').mockImplementation(() => {
          throw new TypeError('Invalid saved attestation tree')
        })
      }
      await s.f.installRows({ key: source, control: { putRejoin: record } })
      const before = await s.f.inspectRows()
      const resolve = vi.spyOn(registryRecoveryCoordinator(s.f.registry), 'resolveRecoverySwitch')
      const write = vi.spyOn(s.f.registry, 'switchIncarnation')
      if (fault === 'decode') {
        await expect(resolve(record)).rejects.toBeInstanceOf(RecoveryCandidateError)
        owner = await s.start()
        await expect(owner.ready).rejects.toThrow('Invalid saved recovery record')
      } else {
        owner = await s.start(
          fault === 'owner' ? { recovery: { ...s.f.environment, identity: randomIdentity() } } : {},
        )
        let failure: unknown
        void owner.ready.catch((error: unknown) => {
          failure = error
        })
        await vi.waitFor(() => expect(failure).toBeInstanceOf(RecoveryCandidateError), {
          timeout: 1_000,
        })
        owner.dispose()
        await expect(owner.drained()).rejects.toBeInstanceOf(RecoveryCandidateError)
      }
      expect(resolve).toHaveBeenCalledTimes(1)
      expect(write).not.toHaveBeenCalled()
      expect(await s.f.inspectRows()).toEqual(before)
    } finally {
      owner?.dispose()
      await owner?.drained().catch(() => {})
      vi.restoreAllMocks()
      await s.f.close()
    }
  })

  test('saved verdict binding refuses a different confirmation tuple terminally', async () => {
    const s = await setup()
    try {
      const snapshot = decodeCapturedRecoveryCandidate(
        s.recovery.record.candidate,
        s.recovery.record.requestKey,
      )
      const judge = createVerdictJudge({
        group: s.recovery.candidate,
        sourceTree: snapshot.sourceTree,
        known: snapshot.knownRegistry,
        requestID: snapshot.requestID,
        boundCommit: snapshot.boundCommit,
      })
      await expect(
        judge.confirmationKey('different-position', s.recovery.record.digest),
      ).rejects.toBeInstanceOf(RecoveryCandidateError)
    } finally {
      await s.f.close()
    }
  })

  test('saved candidate source validation is terminal', async () => {
    const s = await setup()
    try {
      await expect(
        restoreRecoveryCandidate({
          source: { ...s.recovery.source, trustDigest: 'invalid' },
          candidate: s.recovery.record.candidate,
          requestKey: s.recovery.record.requestKey,
          environment: { ...s.f.environment, accept: async () => {} },
        }),
      ).rejects.toBeInstanceOf(RecoveryCandidateError)
    } finally {
      await s.f.close()
    }
  })

  test.each(['restore', 'authentication', 'confirmation'] as const)(
    'a provider error from saved candidate %s keeps identity and retries',
    async (phase) => {
      const s = await setup()
      let owner: api.RegistryPeer | undefined
      try {
        const error = new TypeError('Restore provider unavailable')
        const restore =
          phase === 'restore'
            ? vi.spyOn(mlsAPI, 'restoreGroup').mockRejectedValueOnce(error)
            : phase === 'authentication'
              ? vi.spyOn(mlsAPI, 'authenticateRecoveryReply').mockRejectedValueOnce(error)
              : vi.spyOn(mlsAPI, 'confirmationKey').mockRejectedValueOnce(error)
        await expect(
          restoreRecoveryCandidate({
            source: s.recovery.source,
            candidate: s.recovery.record.candidate,
            requestKey: s.recovery.record.requestKey,
            environment: { ...s.f.environment, accept: async () => {} },
          }),
        ).rejects.toBe(error)
        restore.mockRejectedValueOnce(error)
        const resolve = vi.spyOn(registryRecoveryCoordinator(s.f.registry), 'resolveRecoverySwitch')
        owner = await s.start()
        await owner.ready
        expect(owner.installedKey()).toEqual(destination)
        expect(resolve.mock.calls.length).toBeGreaterThanOrEqual(2)
        expect((await s.f.device.groups.ports(source).control.load()).rejoin).toMatchObject({
          stage: 'adopted',
          switchMutationID: s.recovery.record.switchMutationID,
        })
      } finally {
        owner?.dispose()
        await owner?.drained()
        vi.restoreAllMocks()
        await s.f.close()
      }
    },
  )

  test('an aggregate retirement timeout retries the same saved switch', async () => {
    const s = await setup(false)
    const entered = deferred<void>()
    const release = deferred<void>()
    let sourceOwner: api.RegistryPeer | undefined
    let switchOwner: api.RegistryPeer | undefined
    let unregister = () => {}
    try {
      sourceOwner = await s.start({
        createPeer: async () =>
          peerDouble(async () => {
            entered.resolve()
            await release.promise
          }),
      })
      await sourceOwner.ready
      const capability = registrySafety(s.f.registry)
      if (capability === null) throw new Error('Missing capability')
      unregister = capability.onRetire(source, async () => {
        throw new Error('Another hook failed')
      })
      await s.f.installRows({ key: source, control: { putRejoin: s.recovery.record } })
      const before = await s.f.inspectRows()
      const calls = vi.spyOn(s.f.registry, 'switchIncarnation')
      vi.useFakeTimers()
      switchOwner = await s.start()
      void switchOwner.ready.catch(() => {})
      await vi.waitFor(() => expect(calls).toHaveBeenCalledTimes(1))
      await entered.promise
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await s.f.inspectRows()).toEqual(before)
      await expect(s.f.registry.access(groupID)).resolves.toMatchObject({ key: source })
      unregister()
      release.resolve()
      await vi.advanceTimersByTimeAsync(100)
      await switchOwner.ready
      expect(switchOwner.installedKey()).toEqual(destination)
      expect(calls.mock.calls.map(([, input]) => input.write.mutationID)).toEqual([
        s.recovery.record.switchMutationID,
        s.recovery.record.switchMutationID,
      ])
    } finally {
      unregister()
      release.resolve()
      sourceOwner?.dispose()
      switchOwner?.dispose()
      await sourceOwner?.drained().catch(() => {})
      await switchOwner?.drained().catch(() => {})
      vi.useRealTimers()
      await s.f.close()
    }
  })
})

test('recovery retains the current ledger when private MLS state is unavailable', async () => {
  const s = await setup(false)
  try {
    const trust = await s.f.device.groups.loadTrust(groupID)
    if (trust === null) throw new Error('Missing retained trust')
    expect(trust.ledger.length).toBeGreaterThan(0)
    const restores = s.f.restoreCount(groupID)
    await s.f.corruptState(source)
    const mls = await api.createRegistryGroupMLS({
      registry: s.f.registry,
      key: source,
      recovery: s.f.environment,
      target,
      identity: s.f.identity,
      entrySlot: api.createLedgerEntrySlot(),
    })
    expect(mls.getRecoveryLedger).toBeTypeOf('function')
    const ledger = await mls.getRecoveryLedger?.()
    expect(ledger).toEqual(trust.ledger)
    ledger?.push('caller mutation')
    expect(await mls.getRecoveryLedger?.()).toEqual(trust.ledger)
    expect(s.f.restoreCount(groupID)).toBe(restores)
  } finally {
    await s.f.close()
  }
})

test('not member retains target behind reason', async () => {
  const f = await createNotMemberFixture()
  let owner: api.RegistryPeer | undefined
  let recovery: ((event: RecoveryEvent) => void | Promise<void>) | undefined
  try {
    await f.diagnose(await f.proof())
    owner = await api.createRegistryPeer({
      registry: f.local().registry,
      key: f.key,
      recovery: f.local().environment,
      target: { targetID: 'diagnostic-hub', topicID: 'diagnostic-commits' },
      continuation: api.createRecoveryContinuationPort({
        registry: f.local().registry,
        persistence: f.local().device.groups,
      }),
      createMLS: async () => f.mls(),
      createPeer: async (_key, options) => {
        recovery = options.onRecovery
        return peerDouble()
      },
    })
    await owner.ready
    expect(owner.status()).toMatchObject({ kind: 'not-member', retrying: true })
    await recovery?.({
      groupID: f.key.groupID,
      attemptID: 'retry',
      trigger: 'automatic',
      phase: 'failed',
      reason: 'target-behind',
      pendingReason: 'target-behind',
    })
    expect(owner.status()).toMatchObject({
      kind: 'not-member',
      retrying: true,
      pendingReason: 'target-behind',
    })
  } finally {
    owner?.dispose()
    await owner?.drained()
    await f.close()
  }
})
