import {
  commitKeyRotation,
  decodeClientState,
  encodeClientState,
  type GroupHandle,
  restoreGroup,
} from '@kumiai/mls'
import { InvalidCandidateError } from '@kumiai/mls-rpc'
import {
  checkpointTopic,
  commitTopic,
  createGroupPeer,
  encodeCommitFrame,
  encodeHandshakeFrame,
  encodeLedgerEntries,
  type GroupKey,
  type GroupMLS,
  HANDSHAKE_KIND,
  type LogHub,
  type LogPosition,
  type MailboxHub,
  type RecoveryEvent,
  rendezvousTopic,
} from '@kumiai/rpc'
import { toB64U as toB64 } from '@sozai/codec'
import { expect, type MockInstance, test, vi } from 'vitest'

import { createRegistryCheckpointService } from '../../../packages/mls-rpc/src/checkpoint.js'
import * as api from '../../../packages/mls-rpc/src/index.js'
import { decodeStoredValue } from '../../../packages/mls-rpc/src/persistence-codec.js'
import { recoveryTrustFor } from '../../../packages/mls-rpc/src/registry/trust.js'
import { createForkRecoveryRealFixture } from '../../../packages/mls-rpc/test/fixtures/captured-recovery.js'
import { createAsyncLocalOwnershipContext } from '../../../packages/mls-rpc/test/fixtures/ownership-context.js'
import { createRealGroup } from '../../../packages/mls-rpc/test/fixtures/real-group.js'
import {
  createRegistryFixture,
  type RegistryFixture,
  registryFixtureMutateControl,
  registryFixtureSafetyParams,
} from '../../../packages/mls-rpc/test/fixtures/registry.js'
import { FakeHub } from '../../../packages/rpc/test/fixtures/fake-hub.js'

const key = { groupID: 'hub-migration-live', incarnation: 1 }
const binding = { targetID: 'registry-recovery-hub', commitTopicID: `commits/${key.groupID}` }

async function start(
  fixture: RegistryFixture,
  resolveTarget: (id: string) => Promise<api.RecoveryTarget>,
) {
  const created: Array<api.RegistryPeerOptions> = []
  const owner = await api.createRegistryPeer({
    registry: fixture.registry,
    key,
    recovery: fixture.environment,
    target: { targetID: 'old-host-handle', topicID: 'old-commits' },
    resolveTarget,
    continuation: api.createRecoveryContinuationPort({
      registry: fixture.registry,
      persistence: fixture.device.groups,
    }),
    createMLS: (current, _handoff, options) =>
      api.createRegistryGroupMLS({
        registry: fixture.registry,
        key: current,
        recovery: fixture.environment,
        identity: fixture.identity,
        entrySlot: api.createLedgerEntrySlot(),
        ...options,
      }),
    createPeer: async (current, options) => {
      created.push(options)
      const access = await fixture.registry.access(current.groupID)
      const crypto = api.createGroupCrypto({ access })
      const ports = fixture.device.groups.ports(current)
      return createGroupPeer({
        ...options,
        hub: options.hub ?? new FakeHub(),
        crypto,
        control: options.control ?? ports.control,
        anchorStore: ports.anchor,
        appCursorStore: ports.cursor,
        appOutbox: ports.outbox,
        appOutboxLimit: 16,
        localDID: fixture.identity.id,
        protocols: {},
        handlers: {},
        recovery: { timeoutMs: 100, deadlineMs: 500, getDelayMs: () => 100 },
        readEvidence: () => fixture.device.groups.readEvidence(current),
        validation: api.createControlValidationPort({
          identity: fixture.identity,
          options: fixture.environment.options,
          restoreCandidate: async () => {
            throw new Error('No ordinary candidate expected')
          },
        }),
        prepareBuild: async () => {
          throw new Error('No ordinary build expected')
        },
        adopt: async () => {
          throw new Error('No ordinary adoption expected')
        },
        deliverWelcome: async () => {},
      })
    },
  })
  return {
    owner,
    created,
    close: async () => {
      owner.dispose()
      await owner.drained()
    },
  }
}

for (const context of ['supplied', 'absent'] as const) {
  test(`unresolved durable target pauses without fallback / real-mls / ${context}`, async () => {
    let fixture = await createRegistryFixture({
      mode: 'real-mls',
      groupID: key.groupID,
      setup: 'seeded',
      ownershipContext: context === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
    })
    const original = new FakeHub()
    const unavailable = vi.fn(async (_id: string): Promise<api.RecoveryTarget> => {
      throw new Error('Host offline')
    })
    let active: Awaited<ReturnType<typeof start>> | undefined
    try {
      const candidate = await fixture.confirmedRecovery(key, { confirm: false })
      if (!('format' in candidate.record)) throw new Error('Captured candidate required')
      // A known-behind device rejoins instead of moving current.
      await fixture.installRows({ key, control: {} })
      await registryFixtureMutateControl(fixture, key, (snapshot) => ({
        ...snapshot,
        strand: { reason: 'retention-gap' },
      }))
      active = await start(fixture, unavailable)
      await active.owner.ready
      const safety = api.createGroupSafety(await registryFixtureSafetyParams(fixture))
      const running = safety.recover(key, {
        mode: 'resync',
        target: { ...binding, hub: original },
        allowOpenFork: true,
      })
      void running.catch(() => {})
      await vi.waitFor(() => expect(active?.created).toHaveLength(2))
      const status = (await safety.status(key)).manualRecovery
      if (status === null) throw new Error('Missing durable target')
      await active.close()
      await fixture
        .manualRecovery()
        .manualRecoveryControl(status.id)
        .apply(
          {
            putRejoin: { ...candidate.record, trigger: 'manual', authorisationID: status.id },
          },
          'save-confirmed-move',
        )
      const saved = await fixture.manualRecovery().readManualRecovery(status.id)
      if (saved?.choice.mode !== 'resync') throw new Error('Missing resync authority')
      fixture = await fixture.reopen()
      active = await start(fixture, unavailable)
      await active.owner.ready
      expect(active.created).toEqual([])
      expect(active.owner.status()).toMatchObject({
        kind: 'pending',
        reason: 'target-unresolved',
        authorisationID: status.id,
      })
      expect(await fixture.manualRecovery().readManualRecovery(status.id)).toEqual({
        ...saved,
        pauseReason: 'target-unresolved',
        mutationID: expect.any(String),
      })
      expect(active.owner.installedKey()).toEqual(key)
      await active.close()
      const restored = new FakeHub()
      const resolver = vi.fn(async (id: string) => ({
        id,
        hub: restored as LogHub & MailboxHub,
        commitTopicID: binding.commitTopicID,
      }))
      active = await start(fixture, resolver)
      await active.owner.ready
      expect(active.created).toHaveLength(1)
      expect(active.created[0]).toMatchObject({
        hub: restored,
        target: { targetID: binding.targetID, topicID: binding.commitTopicID },
      })
      expect((await fixture.manualRecovery().readManualRecovery(status.id))?.choice).toEqual(
        saved.choice,
      )
      expect(resolver.mock.calls.every(([id]) => id === binding.targetID)).toBe(true)
      expect(active.owner.installedKey()).toEqual({ ...key, incarnation: 2 })
      expect((await fixture.manualRecovery().readManualRecovery(status.id))?.attempt).toMatchObject(
        {
          id: saved.attempt?.id,
          requestKey: saved.attempt?.requestKey,
          payload: saved.attempt?.payload,
          authorisationID: saved.id,
          source: saved.attempt?.source,
        },
      )
      expect((await fixture.manualRecovery().readManualRecovery(status.id))?.stage).toBe(
        'completed',
      )
    } finally {
      await active?.close()
      await fixture.close()
    }
  })
}

type LiveOwner = {
  owner: api.RegistryPeer
  hubs: Array<LogHub & MailboxHub>
  events: Array<RecoveryEvent>
  close(): Promise<void>
}

async function liveOwner(
  fixture: RegistryFixture,
  params: {
    key: GroupKey
    hub: FakeHub
    target: { targetID: string; topicID: string }
    resolveTarget?: (id: string) => Promise<api.RecoveryTarget>
    recovery?: { timeoutMs: number; deadlineMs: number; getDelayMs: () => number }
  },
): Promise<LiveOwner> {
  const hubs: Array<LogHub & MailboxHub> = []
  const events: Array<RecoveryEvent> = []
  const owner = await api.createRegistryPeer({
    registry: fixture.registry,
    key: params.key,
    recovery: fixture.environment,
    target: params.target,
    onRecovery: (event) => {
      events.push(event)
    },
    ...(params.resolveTarget === undefined ? {} : { resolveTarget: params.resolveTarget }),
    continuation: api.createRecoveryContinuationPort({
      registry: fixture.registry,
      persistence: fixture.device.groups,
    }),
    createMLS: (current, _handoff, options) =>
      api.createRegistryGroupMLS({
        registry: fixture.registry,
        key: current,
        recovery: fixture.environment,
        identity: fixture.identity,
        entrySlot: api.createLedgerEntrySlot(),
        ...options,
      }),
    createPeer: async (current, options) => {
      const ports = fixture.device.groups.ports(current)
      const opened = async () => {
        const access = await fixture.registry.access(current.groupID)
        expect(access.key).toEqual(current)
        return access
      }
      const access: api.RegistryHandleAccess = {
        get key() {
          return current
        },
        get runtime(): never {
          throw new TypeError('unused')
        },
        stateVersion: () => {
          throw new TypeError('unused')
        },
        onRetire: () => {
          throw new TypeError('unused')
        },
        epoch: () => options.mls.sendAdmission().epoch,
        admission: () => options.mls.sendAdmission(),
        read: async (fn) => (await opened()).read(fn),
        readControl: async (fn) => (await opened()).readControl(fn),
        mutate: async (fn, write) => (await opened()).mutate(fn, write),
        replace: async (next, write, prepare) => (await opened()).replace(next, write, prepare),
        adopt: async (next, expected, write) => (await opened()).adopt(next, expected, write),
        openBatch: async (frames) => (await opened()).openBatch(frames),
        pending: {
          list: async () => (await opened()).pending.list(),
          complete: async (id) => (await opened()).pending.complete(id),
        },
      }
      const restoreCandidate = async (bytes: Uint8Array) => {
        let value: {
          state: Uint8Array
          credential: GroupHandle['credential']
          ledger: Array<string>
        }
        try {
          value = decodeStoredValue(bytes) as typeof value
          if (!(value?.state instanceof Uint8Array))
            throw new InvalidCandidateError('Invalid candidate state')
        } catch (cause) {
          throw new InvalidCandidateError('Invalid candidate envelope', { cause })
        }
        const state = decodeClientState(value.state)
        if (state === undefined) throw new InvalidCandidateError('Invalid control candidate')
        return restoreGroup({
          state,
          credential: value.credential,
          ledgerEntries: value.ledger,
          options: fixture.environment.options,
        })
      }
      // A host falls back to its original hub only when the owner supplies none.
      const hub = options.hub ?? params.hub
      hubs.push(hub)
      return createGroupPeer({
        recoveryTarget: params.target,
        ...options,
        hub,
        localDID: fixture.identity.id,
        protocols: {},
        handlers: {},
        crypto: api.createGroupCrypto({ access }),
        control: options.control ?? ports.control,
        prepareBuild: async () => {
          throw new Error('No operations are queued')
        },
        validation: api.createControlValidationPort({
          identity: fixture.identity,
          options: fixture.environment.options,
          restoreCandidate,
        }),
        adopt: api.createControlAdoptionPort({
          access,
          control: ports.control,
          restoreCandidate,
        }).adopt,
        readEvidence: () => fixture.device.groups.readEvidence(current),
        anchorStore: ports.anchor,
        appCursorStore: ports.cursor,
        appOutbox: ports.outbox,
        appOutboxLimit: 16,
        deliverWelcome: async () => {
          throw new Error('No Welcome is owed')
        },
        recovery: params.recovery ?? { timeoutMs: 1000, deadlineMs: 8000, getDelayMs: () => 0 },
      })
    },
  })
  return {
    owner,
    hubs,
    events,
    close: async () => {
      owner.dispose()
      await owner.drained().catch(() => {})
    },
  }
}

function moveTarget(hub: FakeHub, commitTopicID: string) {
  return { targetID: 'destination-hub', hub: hub as LogHub & MailboxHub, commitTopicID }
}

function safetyFor(fixture: RegistryFixture, mls: GroupMLS, hub: FakeHub, topicID: string) {
  return api.createGroupSafety({
    registry: fixture.registry,
    persistence: fixture.device.groups,
    mls,
    resolveTarget: async (id) => ({ id, hub, commitTopicID: topicID }),
  })
}

async function derivedTopics(mls: GroupMLS) {
  const secret = await mls.exportRecoverySecret()
  return {
    commit: commitTopic(secret),
    rendezvous: rendezvousTopic(secret),
    checkpoint: checkpointTopic(secret),
  }
}

for (const reason of ['legacy halt', 'known behind'] as const) {
  test(`${reason === 'legacy halt' ? 'manual move under legacy halt requires rejoin' : 'known behind device never starts destination log'} / real-mls`, async () => {
    const f = await createForkRecoveryRealFixture(true)
    const old = new FakeHub()
    const destination = new FakeHub()
    const owners: Array<LiveOwner> = []
    try {
      const local = f.local()
      // Only the named reason may refuse the current move.
      await f.rewriteNotice((notice) => {
        notice.closedAt = Date.now()
      })
      if (reason === 'legacy halt')
        await registryFixtureMutateControl(local, f.key, (snapshot) => ({
          ...snapshot,
          forkHalt: {
            eventID: 'legacy-halt',
            detectedAt: 1,
            evidence: { kind: 'unexplained-own-commit', epoch: 20, position: 'fork', digest: 'f' },
          },
        }))
      else
        await registryFixtureMutateControl(local, f.key, (snapshot) => ({
          ...snapshot,
          strand: { reason: 'retention-gap' },
        }))
      const sourceBefore = await f.snapshot()
      const topics = await derivedTopics(f.requester())
      const safety = safetyFor(local, f.requester(), destination, f.target.topicID)
      // Saved before any owner runs: the held source cannot start ordinary work.
      await safety
        .recover(f.key, { mode: 'resync', target: moveTarget(destination, f.target.topicID) })
        .catch(() => {})
      const requester = await liveOwner(local, { key: f.key, hub: old, target: f.target })
      owners.push(requester)
      await vi.waitFor(
        () =>
          expect(
            requester.events.some(
              (event) => event.phase === 'failed' && event.pendingReason === 'no-reply',
            ),
          ).toBe(true),
        { timeout: 15000 },
      )
      const knownBehindPublishBeforeRecovery = destination.published.filter(
        (frame) => frame.topicID !== topics.rendezvous && frame.topicID !== topics.checkpoint,
      ).length
      expect(knownBehindPublishBeforeRecovery).toBe(0)
      expect(old.published).toEqual([])
      expect(requester.hubs.every((hub) => hub === destination)).toBe(true)
      expect(requester.owner.installedKey()).toEqual(f.key)
      // Refused as a current move: the saved choice waits on destination responders.
      const choice = (await safety.status(f.key)).manualRecovery
      expect(choice).toMatchObject({ kind: 'pending' })
      expect(requester.owner.status()).toMatchObject({ authorisationID: choice?.id })
      const remote = await liveOwner(f.remote(), {
        key: { ...f.key, incarnation: 1 },
        hub: destination,
        target: f.target,
      })
      owners.push(remote)
      await remote.owner.ready
      await vi.waitFor(() => expect(requester.owner.installedKey().incarnation).toBe(2), {
        timeout: 15000,
      })
      const destinationKey = requester.owner.installedKey()
      expect(await local.manualRecovery().readManualRecovery(choice?.id ?? '')).toMatchObject({
        stage: 'completed',
        destination: destinationKey,
      })
      const sourceAfter = await f.snapshot()
      expect(sourceAfter.forkHalt).toEqual(sourceBefore.forkHalt)
      expect(sourceAfter.strand).toEqual(sourceBefore.strand)
      if (reason === 'legacy halt') {
        const sourceInternalLatchBefore = sourceBefore.forkHalt
        const sourceInternalLatchAfterSuccessfulRejoin = sourceAfter.forkHalt
        expect(sourceInternalLatchAfterSuccessfulRejoin).toEqual(sourceInternalLatchBefore)
      }
      const destinationHoldAfterSuccessfulRejoin = (await local.safety().status(destinationKey))
        .hold
      expect(destinationHoldAfterSuccessfulRejoin).toBeNull()
      expect(old.published).toEqual([])
    } finally {
      for (const owner of owners) await owner.close()
      await f.close()
    }
  }, 60000)
}

test('ahead device reaching migrated topic stays visibly pending / real-mls', async () => {
  const f = await createForkRecoveryRealFixture(true)
  const old = new FakeHub()
  const migrated = new FakeHub()
  const checkpointSink = new FakeHub()
  const owners: Array<LiveOwner> = []
  let timers: MockInstance<typeof setTimeout> | undefined
  try {
    await f.rewriteNotice((notice) => {
      notice.closedAt = Date.now()
    })
    await f.local().installRows({ key: f.key, control: { recoveryEpochFloor: 20 } })
    const topics = await derivedTopics(f.requester())
    const send = migrated.publish.bind(migrated)
    // Blind non-delivery of checkpoints leaves recovery with no R2/R7 authority.
    vi.spyOn(migrated, 'publish').mockImplementation((params) =>
      params.topicID === topics.checkpoint ? checkpointSink.publish(params) : send(params),
    )
    const remote = await liveOwner(f.remote(), {
      key: { ...f.key, incarnation: 1 },
      hub: migrated,
      target: f.target,
      recovery: { timeoutMs: 3000, deadlineMs: 15000, getDelayMs: () => 0 },
    })
    owners.push(remote)
    await remote.owner.ready
    await remote.owner.peer()?.replay()
    const local = await liveOwner(f.local(), {
      key: f.key,
      hub: old,
      target: f.target,
      resolveTarget: async () => {
        throw new Error('Live binding expected')
      },
      recovery: { timeoutMs: 3000, deadlineMs: 15000, getDelayMs: () => 0 },
    })
    owners.push(local)
    await local.owner.ready
    const safety = safetyFor(f.local(), f.requester(), migrated, f.target.topicID)
    const moved = await safety.recover(f.key, {
      mode: 'resync',
      target: moveTarget(migrated, f.target.topicID),
    })
    expect(moved).toEqual(f.key)
    expect(local.hubs.at(-1)).toBe(migrated)
    const oldPublished = old.published.length
    await local.owner.peer()?.replay()
    const before = await f.snapshot()
    const state = await f.local().device.groups.loadState(f.key)
    timers = vi.spyOn(globalThis, 'setTimeout')
    for (let round = 0; round < 8; round++) {
      expect(await local.owner.peer()?.recover()).toEqual({ advanced: false, reenact: [] })
      const aheadStatus = local.owner.status()
      expect(aheadStatus).toMatchObject({ kind: 'pending', reason: 'target-behind' })
      expect(local.owner.installedKey()).toEqual(f.key)
      expect(await f.snapshot()).toEqual(before)
      expect(await f.local().device.groups.loadState(f.key)).toEqual(state)
    }
    expect(before.recoveryEpochFloor).toBe(20)
    expect(timers.mock.calls.filter(([, delay]) => delay === 15000).length).toBeGreaterThan(1)
    expect(timers.mock.calls.some(([, delay]) => delay === 60000)).toBe(false)
    expect(
      migrated.published.filter(
        (frame) => frame.topicID === topics.commit || frame.topicID === f.target.topicID,
      ),
    ).toEqual([])
    expect(old.published).toHaveLength(oldPublished)
  } finally {
    timers?.mockRestore()
    for (const owner of owners) await owner.close()
    await f.close()
  }
}, 120000)

test('partial migration diverges without notice / real-mls', async () => {
  const f = await createForkRecoveryRealFixture(true)
  const original = new FakeHub()
  const prior = new FakeHub()
  const migrated = new FakeHub()
  const owners: Array<LiveOwner> = []
  try {
    await f.rewriteNotice((notice) => {
      notice.closedAt = Date.now()
    })
    const topics = await derivedTopics(f.requester())
    const remoteKey = { ...f.key, incarnation: 1 }
    const seeded = new Map([
      [f.local(), new Set(await evidenceFrames(f.local(), f.key))],
      [f.remote(), new Set(await evidenceFrames(f.remote(), remoteKey))],
    ])
    // The remote keeps the original hub; the local device moves from its prior hub.
    const remote = await liveOwner(f.remote(), {
      key: { ...f.key, incarnation: 1 },
      hub: original,
      target: f.target,
    })
    owners.push(remote)
    await remote.owner.ready
    const local = await liveOwner(f.local(), {
      key: f.key,
      hub: prior,
      target: f.target,
      resolveTarget: async () => {
        throw new Error('Live binding expected')
      },
    })
    owners.push(local)
    await local.owner.ready
    const localState = await f.local().device.groups.loadState(f.key)
    expect(remote.owner.installedKey()).toEqual(remoteKey)
    const remoteState = await f.remote().device.groups.loadState(remoteKey)
    const safety = safetyFor(f.local(), f.requester(), migrated, f.target.topicID)
    expect(
      await safety.recover(f.key, {
        mode: 'resync',
        target: moveTarget(migrated, f.target.topicID),
      }),
    ).toEqual(f.key)
    await vi.waitFor(
      () => {
        expect(
          migrated.published.some(
            (frame) =>
              frame.topicID === topics.checkpoint && frame.senderDID === f.local().identity.id,
          ),
        ).toBe(true)
        expect(
          original.published.some(
            (frame) =>
              frame.topicID === topics.checkpoint && frame.senderDID === f.remote().identity.id,
          ),
        ).toBe(true)
      },
      { timeout: 10000 },
    )
    await local.owner.peer()?.replay()
    await remote.owner.peer()?.replay()
    // Separate hubs cannot exchange checkpoint evidence: no halt, rollback or detection claim.
    expect(original.published.every((frame) => frame.senderDID !== f.local().identity.id)).toBe(
      true,
    )
    for (const hub of [prior, migrated])
      expect(hub.published.every((frame) => frame.senderDID !== f.remote().identity.id)).toBe(true)
    expect(local.hubs).toEqual([prior, migrated])
    const payloads = (...hubs: Array<FakeHub>) =>
      new Set(hubs.flatMap((hub) => hub.published.map((frame) => toB64(frame.payload))))
    for (const [fixture, key, owner, own, other] of [
      [f.local(), f.key, local, [migrated, prior], [original]],
      [f.remote(), remoteKey, remote, [original], [migrated, prior]],
    ] as const) {
      expect(owner.owner.status().kind).toBe('running')
      expect(owner.owner.installedKey()).toEqual(key)
      expect((await fixture.safety().status(key)).hold).toBeNull()
      const ownPayloads = payloads(...own)
      const crossed = [...payloads(...other)].filter((frame) => !ownPayloads.has(frame))
      expect(crossed.length).toBeGreaterThan(0)
      // Same-hub intake may keep comparing the fixture's seeded split; no frame crosses hubs.
      const learned = (await evidenceFrames(fixture, key)).filter(
        (frame) => seeded.get(fixture)?.has(frame) !== true,
      )
      expect(learned.filter((frame) => crossed.includes(frame))).toEqual([])
    }
    // Startup bookkeeping may bump the row version; MLS bytes and epoch never roll back.
    expect(mlsBytes(await f.local().device.groups.loadState(f.key))).toEqual(mlsBytes(localState))
    expect(mlsBytes(await f.remote().device.groups.loadState(remoteKey))).toEqual(
      mlsBytes(remoteState),
    )
  } finally {
    for (const owner of owners) await owner.close()
    await f.close()
  }
}, 60000)

function mlsBytes(record: Awaited<ReturnType<RegistryFixture['device']['groups']['loadState']>>) {
  if (record === null || record.deleted) throw new Error('Missing MLS state')
  return { state: record.state, epoch: record.epoch, epochAuthenticator: record.epochAuthenticator }
}

async function evidenceFrames(fixture: RegistryFixture, key: GroupKey) {
  return (await createRegistryCheckpointService(fixture.registry, key).readRecords()).flatMap(
    (row) => (row.kind === 'evidence' ? [toB64(row.first), toB64(row.second)] : []),
  )
}

async function currentMember(groupID: string) {
  const real = await createRealGroup(1, groupID)
  const member = real.members[0]
  if (member === undefined) throw new Error('Missing real member')
  const memberKey = { groupID, incarnation: 1 }
  const fixture = await createRegistryFixture({
    mode: 'real-mls',
    setup: 'empty',
    groupID,
    identity: member.identity,
    options: { resolveLedgerEntries: real.resolveLedgerEntries },
  })
  await fixture.installRows({
    key: memberKey,
    state: {
      ...memberKey,
      version: 1,
      deleted: false,
      terminal: false,
      epoch: Number(member.handle.epoch),
      epochAuthenticator: member.handle.state.keySchedule.epochAuthenticator.slice(),
      state: encodeClientState(member.handle.state),
      credential: member.handle.credential,
      ledger: member.handle.ledgerTokens,
      senderHWM: 0,
    },
    trust: recoveryTrustFor(member.handle, memberKey, null),
  })
  return { real, member, memberKey, fixture }
}

async function commitPayload(source: GroupHandle, commit: Uint8Array): Promise<Uint8Array> {
  return encodeHandshakeFrame(
    HANDSHAKE_KIND.commit,
    encodeCommitFrame(
      commit,
      api.sealEntries(await api.deriveEntryKey(source), encodeLedgerEntries([])),
    ),
  )
}

test('empty topic starts at current state then peers CAS / real-mls', async () => {
  const groupID = `hub-move-cas-${crypto.randomUUID()}`
  const { real, member, memberKey, fixture } = await currentMember(groupID)
  const old = new FakeHub()
  const destination = new FakeHub()
  const target = { targetID: 'old-hub', topicID: `old/${groupID}` }
  let active: LiveOwner | undefined
  try {
    // An old-hub position past every destination position: kept, it would skip the new log.
    await fixture.installRows({
      key: memberKey,
      control: {
        cursor: { position: '000000099999' as LogPosition, epoch: Number(member.handle.epoch) },
      },
    })
    active = await liveOwner(fixture, {
      key: memberKey,
      hub: old,
      target,
      resolveTarget: async () => {
        throw new Error('Live binding expected')
      },
    })
    await active.owner.ready
    // The selected binding names the destination commit topic; rendezvous/checkpoint stay derived.
    const topic = `moved/${groupID}`
    const mls = await api.createRegistryGroupMLS({
      registry: fixture.registry,
      key: memberKey,
      recovery: fixture.environment,
      identity: fixture.identity,
      entrySlot: api.createLedgerEntrySlot(),
      target,
    })
    const safety = safetyFor(fixture, mls, destination, `moved/${groupID}`)
    const epochBefore = (await fixture.device.groups.loadState(memberKey)) as { epoch: number }
    expect(
      await safety.recover(memberKey, {
        mode: 'resync',
        target: moveTarget(destination, `moved/${groupID}`),
      }),
    ).toEqual(memberKey)
    expect(destination.published.filter((frame) => frame.topicID === topic)).toEqual([])
    const source = real.committer.handle
    const first = await commitKeyRotation(source)
    const second = await commitKeyRotation(source)
    // The first publisher on an empty topic starts the log at the state it is current on.
    const firstRow = await destination.publish({
      topicID: topic,
      senderDID: real.committer.identity.id,
      retain: 'log',
      expectedHead: null,
      payload: await commitPayload(source, first.commitMessage),
    })
    await expect(
      destination.publish({
        topicID: topic,
        senderDID: real.committer.identity.id,
        retain: 'log',
        expectedHead: null,
        payload: await commitPayload(source, second.commitMessage),
      }),
    ).rejects.toMatchObject({ name: 'HeadMismatchError' })
    await active.owner.peer()?.replay()
    await expect
      .poll(async () => (await fixture.device.groups.loadState(memberKey)) as { epoch: number }, {
        timeout: 10000,
      })
      .toMatchObject({ epoch: epochBefore.epoch + 1 })
    expect((await fixture.device.groups.ports(memberKey).control.load()).cursor).toMatchObject({
      position: firstRow.sequenceID,
      epoch: epochBefore.epoch + 1,
    })
    expect(old.published.filter((frame) => frame.topicID === topic)).toEqual([])
  } finally {
    await active?.close()
    await fixture.close()
  }
}, 60000)

test('move carries rendezvous and checkpoint workers / real-mls', async () => {
  const groupID = `hub-move-workers-${crypto.randomUUID()}`
  const { member, memberKey, fixture } = await currentMember(groupID)
  const old = new FakeHub()
  const destination = new FakeHub()
  const target = { targetID: 'old-hub', topicID: `old/${groupID}` }
  let active: LiveOwner | undefined
  try {
    active = await liveOwner(fixture, {
      key: memberKey,
      hub: old,
      target,
      resolveTarget: async () => {
        throw new Error('Live binding expected')
      },
      recovery: { timeoutMs: 100, deadlineMs: 300, getDelayMs: () => 0 },
    })
    await active.owner.ready
    const secret = await api.deriveRecoverySecret(member.handle)
    const topics = {
      checkpoint: checkpointTopic(secret),
      rendezvous: rendezvousTopic(secret),
    }
    await vi.waitFor(
      () => expect(old.published.some((frame) => frame.topicID === topics.checkpoint)).toBe(true),
      { timeout: 10000 },
    )
    const mls = await api.createRegistryGroupMLS({
      registry: fixture.registry,
      key: memberKey,
      recovery: fixture.environment,
      identity: fixture.identity,
      entrySlot: api.createLedgerEntrySlot(),
      target,
    })
    const safety = safetyFor(fixture, mls, destination, `moved/${groupID}`)
    expect(
      await safety.recover(memberKey, {
        mode: 'resync',
        target: moveTarget(destination, `moved/${groupID}`),
      }),
    ).toEqual(memberKey)
    const oldAfterMove = old.published.length
    // The retained checkpoint publication follows the move with its exact frame.
    await vi.waitFor(
      () =>
        expect(
          destination.published.some(
            (frame) =>
              frame.topicID === topics.checkpoint && frame.senderDID === member.identity.id,
          ),
        ).toBe(true),
      { timeout: 10000 },
    )
    const oldFrame = old.published.find((frame) => frame.topicID === topics.checkpoint)
    const movedFrame = destination.published.find((frame) => frame.topicID === topics.checkpoint)
    expect(movedFrame?.payload).toEqual(oldFrame?.payload)
    await active.owner.peer()?.recover()
    expect(destination.published.some((frame) => frame.topicID === topics.rendezvous)).toBe(true)
    expect(old.published).toHaveLength(oldAfterMove)
    expect(active.hubs).toEqual([old, destination])
  } finally {
    await active?.close()
    await fixture.close()
  }
}, 60000)
