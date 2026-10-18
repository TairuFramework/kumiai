import { verifyRecoveryRequest } from '@kumiai/mls'
import {
  checkpointTopic,
  commitTopic,
  createGroupPeer,
  decodeHandshakeFrame,
  decodeRecoveryRequest,
  encodeHandshakeFrame,
  encodeRecoveryReply,
  encodeRecoveryRequest,
  forkEventID,
  GroupSafetyHeldError,
  HANDSHAKE_KIND,
  type LogPosition,
  type RecoveryEvent,
  recoveryUnavailableEventID,
  rendezvousTopic,
  SendNotAdmissibleError,
} from '@kumiai/rpc'
import { afterEach, expect, test, vi } from 'vitest'

import { createCheckpointService } from '../../../packages/mls-rpc/src/checkpoint.js'
import { entryCapability } from '../../../packages/mls-rpc/src/entry-capability.js'
import {
  createControlValidationPort,
  createGroupCrypto,
  createLedgerEntrySlot,
  createRecoveryContinuationPort,
  createRegistryGroupMLS,
  createRegistryPeer,
  type RegistryPeerOptions,
  SpentSetCorruptError,
} from '../../../packages/mls-rpc/src/index.js'
import { capturedRecord } from '../../../packages/mls-rpc/test/fixtures/captured-recovery.js'
import { createAsyncLocalOwnershipContext } from '../../../packages/mls-rpc/test/fixtures/ownership-context.js'
import {
  createNotMemberFixture,
  type RegistryFixture,
} from '../../../packages/mls-rpc/test/fixtures/registry.js'
import { FakeHub } from '../../../packages/rpc/test/fixtures/fake-hub.js'
import { createCapturedRecoveryFixture } from './fixtures/fork-halt.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})

async function start(
  f: RegistryFixture,
  hub: FakeHub,
  events: Array<RecoveryEvent> = [],
  observeMLS?: (options: RegistryPeerOptions) => void,
) {
  const [lifetime] = await f.device.groups.list()
  if (lifetime?.activeIncarnation == null) throw new Error('Missing active fixture')
  const key = { groupID: lifetime.groupID, incarnation: lifetime.activeIncarnation }
  const initial = await createRegistryGroupMLS({
    registry: f.registry,
    key,
    identity: f.identity,
    entrySlot: createLedgerEntrySlot(),
    recovery: f.environment,
    target: { targetID: 'diagnostic-hub', topicID: 'diagnostic-commits' },
  })
  const target = {
    targetID: 'diagnostic-hub',
    topicID: commitTopic(await initial.exportRecoverySecret()),
  }
  const created: Array<RegistryPeerOptions> = []
  const owner = await createRegistryPeer({
    registry: f.registry,
    key,
    target,
    recovery: f.environment,
    continuation: createRecoveryContinuationPort({
      registry: f.registry,
      persistence: f.device.groups,
    }),
    onRecovery: (event) => {
      events.push(event)
    },
    createMLS: (current) =>
      createRegistryGroupMLS({
        registry: f.registry,
        key: current,
        identity: f.identity,
        entrySlot: createLedgerEntrySlot(),
        recovery: f.environment,
        target,
      }),
    createPeer: async (current, options) => {
      created.push(options)
      observeMLS?.(options)
      const access = await f.registry.access(current.groupID)
      const ports = f.device.groups.ports(current)
      return createGroupPeer({
        ...options,
        hub,
        crypto: createGroupCrypto({ access }),
        control: ports.control,
        anchorStore: ports.anchor,
        appCursorStore: ports.cursor,
        appOutbox: ports.outbox,
        appOutboxLimit: 16,
        localDID: f.identity.id,
        protocols: {},
        handlers: {},
        validation: createControlValidationPort({
          identity: f.identity,
          options: f.environment.options,
          restoreCandidate: async () => {
            throw new Error('No own candidate expected')
          },
        }),
        readEvidence: () => f.device.groups.readEvidence(current),
        prepareBuild: async () => {
          throw new Error('No control build expected')
        },
        adopt: async () => {
          throw new Error('No control adoption expected')
        },
        deliverWelcome: async () => {},
        recovery: { timeoutMs: 500, deadlineMs: 3000, getDelayMs: () => 0 },
      })
    },
  })
  cleanup.push(async () => {
    owner.dispose()
    await owner.drained()
  })
  await owner.ready
  await owner.peer()?.replay()
  return { owner, created, target }
}

async function setup(openNotice = true, params: Parameters<typeof createNotMemberFixture>[0] = {}) {
  const f = await createNotMemberFixture(params)
  cleanup.push(() => f.close())
  const hub = new FakeHub()
  const remoteService = createCheckpointService({
    registry: f.remote.registry,
    key: f.remoteKey,
    identity: f.remote.identity,
  })
  const [splitFrame] = await remoteService.exportCheckpoints(f.remoteKey, [10])
  if (splitFrame === undefined) throw new Error('Missing split checkpoint')
  const localService = f.service()
  const { decodeEpochRosterFact } = await import('@kumiai/mls')
  const ownAtNine = await localService.checkpointFact(f.key, 9)
  const remoteAtNine = await remoteService.checkpointFact(f.remoteKey, 9)
  if (ownAtNine === null || remoteAtNine === null) throw new Error('Missing shared ancestry')
  expect(decodeEpochRosterFact(ownAtNine).authHash).toBe(
    decodeEpochRosterFact(remoteAtNine).authHash,
  )
  for (const row of await localService.readRecords())
    if (row.kind === 'fact') await localService.signInstalled(row.id)
  if (openNotice) {
    await localService.importCheckpoint(f.key, splitFrame)
    expect(await localService.forkNotices(f.key.groupID)).toEqual(
      expect.arrayContaining([expect.objectContaining({ splitEpoch: 10, closedAt: null })]),
    )
  }
  return { f, hub }
}

test('advanced losing device removed on continuing branch surfaces not-member', async () => {
  const { f, hub } = await setup()
  const checkpointID = checkpointTopic(await f.mls().exportRecoverySecret())
  const publish = hub.publish.bind(hub)
  vi.spyOn(hub, 'publish').mockImplementation(async (params) => {
    if (params.topicID === checkpointID) throw new Error('Checkpoint delivery unavailable')
    return await publish(params)
  })
  const remote = await start(f.remote, hub)
  const events: Array<RecoveryEvent> = []
  const comparisons: Array<number | undefined> = []
  const local = await start(f.local(), hub, events, (options) => {
    const create = options.mls.createRecoveryRequest
    options.mls.createRecoveryRequest = async (...args) => {
      comparisons.push(args[2])
      return await create(...args)
    }
  })
  const before = await f.local().device.groups.ports(f.key).control.load()
  await local.owner.peer()?.recover()
  await expect
    .poll(() => local.owner.status())
    .toMatchObject({
      kind: 'not-member',
      evidence: { epoch: 12 },
      retrying: true,
      pendingReason: 'no-eligible-responder',
    })
  expect(await f.local().safety().status(f.key)).toMatchObject({
    hold: null,
    condition: 'not-member',
  })
  const beforeClear = await f.local().safety().status(f.key)
  await f.local().safety().clearHold(f.key)
  expect(await f.local().safety().status(f.key)).toEqual(beforeClear)
  expect(comparisons).toContain(10)
  const after = await f.local().device.groups.ports(f.key).control.load()
  expect(after.rejoin).toEqual(before.rejoin)
  expect(after.recoveryEpochFloor).toEqual(before.recoveryEpochFloor)
  const count = events.length
  await expect.poll(() => events.length, { timeout: 5000 }).toBeGreaterThan(count)
  expect(remote.owner.status().kind).toBe('running')
})

test.each([
  { mode: 'real-mls', context: 'supplied' },
  { mode: 'real-mls', context: 'absent' },
  { mode: 'double', context: 'supplied' },
  { mode: 'double', context: 'absent' },
] as const)(
  'no open notice signs oldest retained comparison and diagnoses requester 20 responder 12 / $mode / $context',
  async ({ mode, context }) => {
    const { f, hub } = await setup(false, {
      mode,
      ownershipContext: context === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
    })
    const checkpointID = checkpointTopic(await f.mls().exportRecoverySecret())
    const publish = hub.publish.bind(hub)
    let blockedTopic: string | undefined
    vi.spyOn(hub, 'publish').mockImplementation(async (params) => {
      if (params.topicID === checkpointID) throw new Error('Checkpoint delivery unavailable')
      if (
        params.topicID === blockedTopic &&
        params.senderDID === f.local().identity.id &&
        params.retain === 'log'
      )
        throw new Error('Commit delivery temporarily unavailable')
      return await publish(params)
    })
    const continuing = await start(await f.continuing(), hub)
    const events: Array<RecoveryEvent> = []
    const comparisons: Array<number | undefined> = []
    const local = await start(f.local(), hub, events, (options) => {
      const create = options.mls.createRecoveryRequest
      options.mls.createRecoveryRequest = async (...args) => {
        const held = await create(...args)
        comparisons.push(
          (await verifyRecoveryRequest(new TextDecoder().decode(held.request))).comparisonEpoch,
        )
        return held
      }
    })
    blockedTopic = local.target.topicID
    await expect(local.owner.peer()?.recover()).rejects.toThrow(
      'Commit delivery temporarily unavailable',
    )
    const saved = await f.local().device.groups.ports(f.key).control.load()
    expect(saved.rejoin).toMatchObject({ format: 2, stage: 'built' })
    expect(saved.recoveryEpochFloor).toBe(20)
    expect(comparisons.every((epoch) => epoch === 9)).toBe(true)
    continuing.owner.dispose()
    await continuing.owner.drained()
    blockedTopic = undefined
    await start(f.remote, hub)
    expect(await f.service().forkNotices(f.key.groupID)).toEqual([])
    expect((await f.service().checkpointCoverage(f.key.groupID)).effectiveFloor).toBe(9)
    await local.owner.peer()?.recover()
    await expect
      .poll(() => local.owner.status())
      .toMatchObject({ kind: 'not-member', evidence: { epoch: 12 }, retrying: true })
    expect(comparisons).toEqual(expect.arrayContaining([9]))
    expect(comparisons.every((epoch) => epoch === 9)).toBe(true)
    const count = comparisons.length
    await expect.poll(() => comparisons.length, { timeout: 5000 }).toBeGreaterThan(count)
    const after = await f.local().device.groups.ports(f.key).control.load()
    expect(after.rejoin).toEqual(saved.rejoin)
    expect(after.recoveryEpochFloor).toBe(20)
    expect(await f.service().forkNotices(f.key.groupID)).toEqual([])
    local.owner.dispose()
    await local.owner.drained()
    await f.restart()
    const restarted = await start(f.local(), hub, events, (options) => {
      const create = options.mls.createRecoveryRequest
      options.mls.createRecoveryRequest = async (...args) => {
        const held = await create(...args)
        comparisons.push(
          (await verifyRecoveryRequest(new TextDecoder().decode(held.request))).comparisonEpoch,
        )
        return held
      }
    })
    const restartRequests = comparisons.length
    await restarted.owner.peer()?.recover()
    await expect.poll(() => comparisons.length, { timeout: 5000 }).toBeGreaterThan(restartRequests)
    expect(comparisons.every((epoch) => epoch === 9)).toBe(true)
    expect(restarted.owner.status()).toMatchObject({
      kind: 'not-member',
      evidence: { epoch: 12 },
      retrying: true,
    })
    const reopened = await f.local().device.groups.ports(f.key).control.load()
    expect(reopened.rejoin).toEqual(saved.rejoin)
    expect(reopened.recoveryEpochFloor).toBe(20)
    expect(await f.service().forkNotices(f.key.groupID)).toEqual([])
  },
)

test('hub withholding from one responder leaves requester pending', async () => {
  const { f, hub } = await setup()
  const local = await start(f.local(), hub)
  await local.owner.peer()?.recover()
  expect(local.owner.status()).toMatchObject({ kind: 'pending', reason: 'no-reply' })
  expect(await f.local().safety().status(f.key)).toMatchObject({ condition: null })
})

test('not member retains pending reason', async () => {
  const { f, hub } = await setup()
  const remote = await start(f.remote, hub)
  const local = await start(f.local(), hub)
  await local.owner.peer()?.recover()
  await expect.poll(() => local.owner.status().kind).toBe('not-member')
  remote.owner.dispose()
  await remote.owner.drained()
  await local.owner.peer()?.recover()
  expect(local.owner.status()).toMatchObject({
    kind: 'not-member',
    pendingReason: 'no-reply',
    retrying: true,
  })
})

test('not member device exits only through an explicit admitted successor', async () => {
  const { f, hub } = await setup()
  await start(f.remote, hub)
  const device = f.local()
  const local = await start(device, hub)
  await local.owner.peer()?.recover()
  await expect.poll(() => local.owner.status().kind).toBe('not-member')
  const { evidence } = await device.safety().status(f.key)
  expect(evidence).not.toBeNull()
  // The diagnosis is non-terminal: kumiai never retires or tombstones on its own.
  expect(await device.device.groups.load(f.key.groupID)).toMatchObject({
    activeIncarnation: f.key.incarnation,
  })
  const successor = await device.registry.seed(await device.makeHandle(0, 'not-member-successor'), {
    packageUse: null,
  })
  const successorState = await device.device.groups.loadState(successor)
  expect(await device.safety().recover(f.key, { mode: 'successor', successor })).toEqual(successor)
  await expect.poll(() => local.owner.peer()).toBeNull()
  const sent = () => hub.published.filter((frame) => frame.senderDID === device.identity.id).length
  const before = sent()
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(sent()).toBe(before)
  expect(await device.device.groups.loadState(successor)).toEqual(successorState)
  expect(await device.safety().status(f.key)).toMatchObject({
    evidence,
    manualRecovery: { kind: 'completed' },
  })
  await expect(
    device.registry.seed(await device.makeHandle(2, f.key.groupID), {
      replace: true,
      packageUse: { sourceID: 'source', ref: 'old-welcome', kind: 'ordinary' },
    }),
  ).rejects.toMatchObject({ name: 'SeedAdmissionRefusedError', reason: 'successor-tombstone' })
})

test('replayed former member request does not re seal', async () => {
  const { f, hub } = await setup()
  const seal = vi.fn()
  const remote = await start(f.remote, hub, [], (options) => {
    const port = options.mls.capturedRecovery
    const original = port?.sealRosterAbsence
    if (port === undefined || original === undefined) throw new Error('Missing sealer')
    port.sealRosterAbsence = async (...args) => {
      seal()
      return await original(...args)
    }
  })
  const local = await start(f.local(), hub)
  let request: Parameters<FakeHub['publish']>[0] | undefined
  const publish = hub.publish.bind(hub)
  vi.spyOn(hub, 'publish').mockImplementation(async (params) => {
    try {
      const frame = decodeHandshakeFrame(params.payload)
      if (
        frame.kind === HANDSHAKE_KIND.recoveryRequest &&
        params.senderDID === f.local().identity.id
      )
        request ??= params
    } catch {
      /* Checkpoints have independent framing. */
    }
    return publish(params)
  })
  await local.owner.peer()?.recover()
  expect(seal).toHaveBeenCalledTimes(1)
  if (request === undefined) throw new Error('Missing request')
  const decoded = decodeRecoveryRequest(decodeHandshakeFrame(request.payload).payload)
  expect(decoded.requestID).toBeTruthy()
  local.owner.dispose()
  await local.owner.drained()
  const replayed = request
  await Promise.all(
    Array.from({ length: 16 }, () => publish({ ...replayed, publishID: crypto.randomUUID() })),
  )
  await new Promise((resolve) => setTimeout(resolve, 500))
  await remote.owner.peer()?.replay()
  expect(seal).toHaveBeenCalledTimes(1)
})

test.each([
  {
    name: 'losing branch absence keeps retrying and continuing recovery clears condition',
    outcome: 'install',
  },
  { name: 'head-only recovery clears not-member', outcome: 'head-only' },
] as const)('$name', async ({ outcome }) => {
  const f = await createNotMemberFixture({ localEpoch: 12, remoteEpoch: 13 })
  cleanup.push(() => f.close())
  const hub = new FakeHub()
  const continuing = await f.continuing()
  const survivor = await start(continuing, hub)
  const events: Array<RecoveryEvent> = []
  const local = await start(f.local(), hub, events)
  const publish = hub.publish.bind(hub)
  let blockCommit = true
  vi.spyOn(hub, 'publish').mockImplementation(async (params) => {
    if (
      blockCommit &&
      params.topicID === local.target.topicID &&
      params.senderDID === f.local().identity.id &&
      params.retain === 'log'
    )
      throw new Error('Commit delivery temporarily unavailable')
    return await publish(params)
  })
  await expect(local.owner.peer()?.recover()).rejects.toThrow(
    'Commit delivery temporarily unavailable',
  )
  const saved = await f.local().device.groups.ports(f.key).control.load()
  expect(saved.rejoin).toMatchObject({ format: 2, stage: 'built' })
  expect(saved.recoveryEpochFloor).toBe(12)
  survivor.owner.dispose()
  await survivor.owner.drained()
  const excluding = await start(f.remote, hub)
  await local.owner.peer()?.recover()
  await expect
    .poll(() => local.owner.status())
    .toMatchObject({ kind: 'not-member', evidence: { epoch: 13 }, retrying: true })
  const diagnosed = await f.local().device.groups.ports(f.key).control.load()
  expect(diagnosed.rejoin).toEqual(saved.rejoin)
  expect(diagnosed.recoveryEpochFloor).toBe(saved.recoveryEpochFloor)
  const requests = events.length
  await expect.poll(() => events.length, { timeout: 5000 }).toBeGreaterThan(requests)
  excluding.owner.dispose()
  await excluding.owner.drained()
  const resumed = await start(continuing, hub)
  if (outcome !== 'install') {
    const port = local.created[0]?.mls
    const responder = resumed.created[0]?.mls
    const record = saved.rejoin
    if (
      port?.capturedRecovery === undefined ||
      responder === undefined ||
      record === null ||
      !('format' in record)
    )
      throw new Error('Missing saved captured recovery')
    const requestID = crypto.randomUUID()
    const held = await port.createRecoveryRequest(requestID, undefined, 10)
    const sealed = await responder.sealGroupInfo(held.request, null)
    const admission = port.sendAdmission()
    expect(
      await port.capturedRecovery.reconcileCapture(record, {
        sealed,
        requestID,
        requestKey: held.requestKey,
        epochFloor: 12,
      }),
    ).toEqual({ kind: 'head-only', head: null })
    expect(await f.local().safety().status(f.key)).toMatchObject({
      condition: null,
      evidence: null,
    })
    expect(port.sendAdmission()).toEqual(admission)
    expect(local.owner.installedKey().incarnation).toBe(1)
    const after = await f.local().device.groups.ports(f.key).control.load()
    expect(after.rejoin).toEqual(saved.rejoin)
    expect(after.cursor).toEqual(saved.cursor)
    return
  }
  blockCommit = false
  await local.owner.peer()?.recover()
  await expect.poll(() => local.owner.installedKey().incarnation, { timeout: 10000 }).toBe(2)
  expect(await f.local().safety().status(f.key)).toMatchObject({ condition: null, evidence: null })
  expect(
    (await f.local().safety().events(f.key)).some((event) => event.kind === 'not-member'),
  ).toBe(true)
})

test.each([
  'success',
  'rollback',
  'pending-rollback',
  'pending-commit',
  'different-epoch',
  'different-authenticator',
  'missing-state',
  'nonforward',
  'held-before-proof',
  'stranded',
] as const)(
  'successful re-anchor clears not-member only after cursor proof: %s',
  async (outcome) => {
    const f = await createNotMemberFixture({
      localEpoch: 12,
      remoteEpoch: outcome === 'different-authenticator' ? 12 : 13,
    })
    cleanup.push(() => f.close())
    const hub = new FakeHub()
    const otherBranch = outcome === 'different-epoch' || outcome === 'different-authenticator'
    const continuing = await start(
      await f.continuing({
        divergent: otherBranch,
        epoch: outcome === 'different-epoch' ? 13 : 12,
      }),
      hub,
    )
    const responder = continuing.created[0]?.mls
    const port = f.mls()
    const captured = port.capturedRecovery
    if (responder === undefined || captured === undefined) throw new Error('Missing captured ports')
    const requestID = crypto.randomUUID()
    const held = await port.createRecoveryRequest(
      requestID,
      undefined,
      outcome === 'different-authenticator' ? undefined : 10,
    )
    const sealed = await responder.sealGroupInfo(held.request, null)
    let pending: Awaited<ReturnType<typeof captured.applyRecovery>>
    if (outcome === 'different-authenticator') {
      await expect(
        captured.applyRecovery(sealed, requestID, held.requestKey),
      ).rejects.toMatchObject({
        name: 'RecoveryTargetBehindError',
      })
      // Retained v2 X predates the ordinary construction guard.
      const { buildRecoveryCandidate } = await import('../../../packages/mls-rpc/src/recovery.js')
      pending = await buildRecoveryCandidate({
        source: await f.local().registry.recoverySource(f.key.groupID),
        sealed,
        requestID,
        requestKey: held.requestKey,
        target: { targetID: 'diagnostic-hub', topicID: 'diagnostic-commits' },
        environment: {
          ...f.local().environment,
          accept: async () => {
            throw new Error('Re-anchor cannot install')
          },
        },
      })
    } else pending = await captured.applyRecovery(sealed, requestID, held.requestKey)
    if (pending === null || 'renewalRequired' in pending) throw new Error('Missing saved X')
    const record = capturedRecord(pending, held.request, held.requestKey, requestID)
    await f
      .local()
      .installRows({ key: f.key, control: { putRejoin: record, recoveryEpochFloor: 12 } })
    await f.diagnose(await f.proof())
    const beforeStatus = await f.local().safety().status(f.key)
    expect(beforeStatus.condition).toBe('not-member')
    let beforeControl = await f.local().device.groups.ports(f.key).control.load()
    let beforeState = await f.local().device.groups.loadState(f.key)
    const beforeFacts = (await f.service().readRecords()).filter((row) => row.kind === 'fact')
    const published = await hub.publish({
      topicID: continuing.target.topicID,
      senderDID: f.local().identity.id,
      payload: new Uint8Array([0]),
      retain: 'log',
    })
    await continuing.owner.peer()?.replay()
    const head = (
      await hub.fetchTopic({
        topicID: continuing.target.topicID,
        subscriberDID: f.remote.identity.id,
      })
    ).head
    expect(head).toBe(published.sequenceID)
    if (head === null) throw new Error('Missing retained head')
    const { asLogPosition } = await import('@kumiai/rpc')
    const freshID = crypto.randomUUID()
    const fresh = await port.createRecoveryRequest(freshID, undefined, 10)
    const reply = {
      sealed: await responder.sealGroupInfo(fresh.request, asLogPosition(head)),
      requestID: freshID,
      requestKey: fresh.requestKey,
      epochFloor: 12,
    }
    if (outcome === 'missing-state') {
      await f.local().removeStateBytes(f.key)
      beforeState = null
    }
    if (outcome === 'nonforward') {
      const later = await hub.publish({
        topicID: continuing.target.topicID,
        senderDID: f.local().identity.id,
        payload: new Uint8Array([0]),
        retain: 'log',
      })
      await f.local().installRows({
        key: f.key,
        control: { cursor: { position: asLogPosition(later.sequenceID), epoch: 12 } },
      })
      beforeControl = await f.local().device.groups.ports(f.key).control.load()
      beforeState = await f.local().device.groups.loadState(f.key)
    }
    if (outcome === 'stranded') {
      await f.local().installRows({
        key: f.key,
        control: {
          cursor: { position: null, epoch: 12, stranded: true },
          strand: { reason: 'lost-state' },
        },
      })
      beforeControl = await f.local().device.groups.ports(f.key).control.load()
      beforeState = await f.local().device.groups.loadState(f.key)
    }
    const beforeAdmission = port.sendAdmission()
    if (outcome === 'held-before-proof') {
      const recovery = await import('../../../packages/mls-rpc/src/recovery.js')
      const original = recovery.reconcileRecoveryCapture
      let calls = 0
      vi.spyOn(recovery, 'reconcileRecoveryCapture').mockImplementation(async (params) => {
        const result = await original(params)
        if (++calls === 1)
          await f.local().installRows({
            key: f.key,
            control: {
              forkHalt: {
                eventID: 'held-during-capture',
                detectedAt: Date.now(),
                evidence: {
                  kind: 'unexplained-own-commit',
                  epoch: 12,
                  position: head,
                  digest: record.digest,
                },
              },
            },
          })
        return result
      })
    }
    const beforeRows = await f.local().inspectRows()
    const fault = outcome.startsWith('pending') ? f.local().armNextWorkFault('pending') : undefined
    if (outcome === 'rollback') f.local().armNextWorkFault('before-commit')
    const attempt = captured.reconcileCapture(record, reply)
    void attempt.catch(() => {})
    if (fault !== undefined) {
      await Promise.race([
        fault.rejected,
        attempt.then(() => {
          throw new Error('Proof fault was not reached')
        }),
      ])
      expect(await f.local().inspectRows()).toEqual(beforeRows)
      let observed = false
      const reading = f
        .local()
        .safety()
        .status(f.key)
        .then((value) => {
          observed = true
          return value
        })
      await Promise.resolve()
      expect(observed).toBe(false)
      await fault.finish(outcome === 'pending-commit' ? 'commit' : 'rollback')
      if (outcome === 'pending-rollback') {
        await expect(attempt).rejects.toThrow()
        expect(await reading).toEqual(beforeStatus)
      } else {
        await expect(attempt).resolves.toEqual({ kind: 'head-only', head })
        expect(await reading).toMatchObject({ condition: null, evidence: null })
      }
    } else if (outcome === 'rollback' || outcome === 'held-before-proof')
      await expect(attempt).rejects.toThrow()
    else await expect(attempt).resolves.toEqual({ kind: 'head-only', head })
    const afterControl = await f.local().device.groups.ports(f.key).control.load()
    if (outcome === 'success' || outcome === 'pending-commit' || outcome === 'stranded') {
      expect(beforeControl.cursor?.position ?? null).toBeNull()
      expect(afterControl.cursor).toEqual({ ...beforeControl.cursor, position: head, epoch: 12 })
      expect(await f.local().safety().status(f.key)).toMatchObject({
        condition: null,
        evidence: null,
      })
    } else if (outcome === 'rollback' || outcome === 'pending-rollback') {
      expect(afterControl).toEqual(beforeControl)
      expect(await f.local().safety().status(f.key)).toEqual(beforeStatus)
    } else if (outcome === 'held-before-proof') {
      expect(afterControl.cursor).toEqual(beforeControl.cursor)
      expect(await f.local().safety().status(f.key)).toMatchObject({
        condition: beforeStatus.condition,
        evidence: beforeStatus.evidence,
      })
    } else {
      expect(afterControl.cursor).toEqual(beforeControl.cursor)
      expect(await f.local().safety().status(f.key)).toMatchObject({
        condition: null,
        evidence: null,
      })
    }
    if (outcome === 'stranded') {
      expect(port.sendAdmission()).toEqual(beforeAdmission)
      expect(afterControl.strand).toEqual(beforeControl.strand)
    }
    expect(afterControl.rejoin).toEqual(beforeControl.rejoin)
    expect(afterControl.recoveryEpochFloor).toBe(12)
    const afterState = await f.local().device.groups.loadState(f.key)
    if (beforeState === null) expect(afterState).toBeNull()
    else {
      expect(afterState).toEqual({ ...beforeState, version: afterState?.version })
    }
    expect((await f.service().readRecords()).filter((row) => row.kind === 'fact')).toEqual(
      beforeFacts,
    )
    expect((await f.local().device.groups.load(f.key.groupID))?.activeIncarnation).toBe(1)
    expect(
      (await f.local().safety().events(f.key)).some((event) => event.kind === 'not-member'),
    ).toBe(true)
  },
)

test('roster reply flood shares bounded group admission', async () => {
  const { f, hub } = await setup()
  let release!: () => void
  const pause = new Promise<void>((resolve) => {
    release = resolve
  })
  let active = 0
  let maximum = 0
  let calls = 0
  await start(f.remote, hub, [], (options) => {
    const original = options.mls.sealGroupInfo
    options.mls.sealGroupInfo = async (request: Uint8Array, head?: LogPosition | null) => {
      calls++
      active++
      maximum = Math.max(maximum, active)
      try {
        await pause
        return await original(request, head ?? null)
      } finally {
        active--
      }
    }
  })
  const topicID = rendezvousTopic(await f.mls().exportRecoverySecret())
  const requests = await Promise.all(
    Array.from({ length: 24 }, async (_, index) => {
      const requestID = crypto.randomUUID()
      const requester = index % 2 === 0 ? f.mls() : f.remoteMLS
      const held = await requester.createRecoveryRequest(requestID, undefined, 10)
      return {
        topicID,
        senderDID: f.local().identity.id,
        payload: encodeHandshakeFrame(
          HANDSHAKE_KIND.recoveryRequest,
          encodeRecoveryRequest(requestID, held.request),
        ),
      }
    }),
  )
  try {
    await Promise.all(requests.map((request) => hub.publish(request)))
    await expect.poll(() => active).toBe(8)
    expect(maximum).toBe(8)
    expect(calls).toBe(8)
  } finally {
    release()
  }
  await expect.poll(() => active).toBe(0)
  await Promise.all(requests.slice(0, 8).map((request) => hub.publish(request)))
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(calls).toBe(8)
})

test('provider failures never enter roster absence fallback', async () => {
  const { f, hub } = await setup()
  const absence = vi.fn()
  await start(f.remote, hub, [], (options) => {
    options.mls.sealGroupInfo = async () => {
      throw new Error('Transient provider failure')
    }
    const port = options.mls.capturedRecovery
    if (port === undefined) throw new Error('Missing captured port')
    const seal = port.sealRosterAbsence
    port.sealRosterAbsence = async (...args) => {
      absence()
      return (await seal?.(...args)) ?? null
    }
  })
  const local = await start(f.local(), hub)
  await local.owner.peer()?.recover()
  expect(absence).not.toHaveBeenCalled()
  expect(local.owner.status()).toMatchObject({ kind: 'pending', reason: 'no-reply' })
  expect(await f.local().safety().status(f.key)).toMatchObject({ condition: null })
})

test('silence and ineligible replies have distinct hints', async () => {
  const { f, hub } = await setup()
  const local = await start(f.local(), hub)
  const publish = hub.publish.bind(hub)
  let answer = true
  vi.spyOn(hub, 'publish').mockImplementation(async (params) => {
    const accepted = await publish(params)
    if (!answer || params.senderDID !== f.local().identity.id) return accepted
    let frame: ReturnType<typeof decodeHandshakeFrame>
    try {
      frame = decodeHandshakeFrame(params.payload)
    } catch {
      return accepted
    }
    if (frame.kind !== HANDSHAKE_KIND.recoveryRequest) return accepted
    const { requestID } = decodeRecoveryRequest(frame.payload)
    await publish({
      topicID: params.topicID,
      senderDID: f.remote.identity.id,
      payload: encodeHandshakeFrame(
        HANDSHAKE_KIND.recoveryReply,
        encodeRecoveryReply(requestID, new Uint8Array([0])),
      ),
    })
    return accepted
  })
  const timers = vi.spyOn(globalThis, 'setTimeout')
  for (let turn = 0; turn < 8; turn++) {
    await local.owner.peer()?.recover()
    expect(local.owner.status()).toMatchObject({ kind: 'pending', reason: 'no-eligible-responder' })
  }
  expect(timers.mock.calls.filter(([, delay]) => delay === 15000).length).toBeGreaterThan(1)
  answer = false
  await local.owner.peer()?.recover()
  expect(local.owner.status()).toMatchObject({ kind: 'pending', reason: 'no-reply' })
  expect(await f.local().safety().status(f.key)).toMatchObject({ condition: null })
})

test('dispose drains late condition callbacks', async () => {
  const { f, hub } = await setup()
  const local = await start(f.local(), hub)
  const proof = await f.proof()
  const recovery = await import('../../../packages/mls-rpc/src/recovery.js')
  const original = recovery.verifyRosterAbsence
  let reached!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => {
    reached = resolve
  })
  const pause = new Promise<void>((resolve) => {
    release = resolve
  })
  vi.spyOn(recovery, 'verifyRosterAbsence').mockImplementation(async (params) => {
    reached()
    await pause
    return await original(params)
  })
  const callback = local.created[0]?.onNotMember
  if (callback === undefined) throw new Error('Missing diagnostic callback')
  const pending = callback(proof)
  await started
  local.owner.dispose()
  let drained = false
  const draining = local.owner.drained().then(() => {
    drained = true
  })
  await Promise.resolve()
  expect(drained).toBe(false)
  release()
  await pending
  await draining
  expect(await f.local().safety().status(f.key)).toMatchObject({ condition: null })
})

test('plain peer keeps diagnostic evidence and retries without a persistence callback', async () => {
  const { f, hub } = await setup()
  await start(f.remote, hub)
  const verified: Array<unknown> = []
  const events: Array<RecoveryEvent> = []
  const local = await start(f.local(), hub, events, (options) => {
    options.onNotMember = undefined
    const port = options.mls.capturedRecovery
    const check = port?.checkRosterAbsence
    if (port === undefined || check === undefined) throw new Error('Missing absence verifier')
    port.checkRosterAbsence = async (...args) => {
      const result = await check(...args)
      verified.push(result)
      return result
    }
  })
  await local.owner.peer()?.recover()
  expect(verified).toContainEqual(expect.objectContaining({ epoch: 12 }))
  const count = verified.length
  await expect.poll(() => verified.length, { timeout: 5000 }).toBeGreaterThan(count)
  expect(await f.local().safety().status(f.key)).toMatchObject({ hold: null, condition: null })
  expect(local.owner.status()).toMatchObject({ kind: 'pending', reason: 'no-eligible-responder' })
})

test('diagnostic persistence failure never stops recovery retries', async () => {
  const { f, hub } = await setup()
  await start(f.remote, hub)
  const failed = vi.fn(async () => {
    throw new Error('Diagnostic persistence unavailable')
  })
  const local = await start(f.local(), hub, [], (options) => {
    options.onNotMember = failed
  })
  await local.owner.peer()?.recover()
  expect(failed).toHaveBeenCalledOnce()
  await expect.poll(() => failed.mock.calls.length, { timeout: 5000 }).toBeGreaterThan(1)
  expect(local.owner.status()).toMatchObject({ kind: 'pending', reason: 'no-eligible-responder' })
  expect(await f.local().safety().status(f.key)).toMatchObject({ hold: null, condition: null })
})

test('hard hold installed while sealing prevents roster publication', async () => {
  const { f, hub } = await setup()
  let reached!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => {
    reached = resolve
  })
  const pause = new Promise<void>((resolve) => {
    release = resolve
  })
  await start(f.remote, hub, [], (options) => {
    const port = options.mls.capturedRecovery
    const seal = port?.sealRosterAbsence
    if (port === undefined || seal === undefined) throw new Error('Missing roster sealer')
    port.sealRosterAbsence = async (...args) => {
      const sealed = await seal(...args)
      reached()
      await pause
      return sealed
    }
  })
  const local = await start(f.local(), hub)
  const recovering = local.owner.peer()?.recover()
  try {
    await started
    await f.remote.installRows({
      key: f.remoteKey,
      control: { controlHold: { reason: 'unsupported-version', position: null } },
    })
  } finally {
    release()
  }
  await recovering
  expect(local.owner.status()).toMatchObject({ kind: 'pending', reason: 'no-reply' })
  expect(await f.local().safety().status(f.key)).toMatchObject({ condition: null })
  expect(
    (await f.remote.device.groups.ports(f.remoteKey).control.load()).controlHold,
  ).toMatchObject({ reason: 'unsupported-version' })
})

test('concurrent roster replay remains suppressed after completed-cache expiry', async () => {
  const { f, hub } = await setup()
  let release!: () => void
  const pause = new Promise<void>((resolve) => {
    release = resolve
  })
  const sealing = vi.fn()
  await start(f.remote, hub, [], (options) => {
    const original = options.mls.sealGroupInfo
    options.mls.sealGroupInfo = async (request: Uint8Array, head?: LogPosition | null) => {
      sealing()
      await pause
      return await original(request, head ?? null)
    }
  })
  const requestID = crypto.randomUUID()
  const held = await f.mls().createRecoveryRequest(requestID, undefined, 10)
  const topicID = rendezvousTopic(await f.mls().exportRecoverySecret())
  const frame = {
    topicID,
    senderDID: f.local().identity.id,
    payload: encodeHandshakeFrame(
      HANDSHAKE_KIND.recoveryRequest,
      encodeRecoveryRequest(requestID, held.request),
    ),
  }
  try {
    await hub.publish(frame)
    await expect.poll(() => sealing.mock.calls.length).toBe(1)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30001)
    try {
      await Promise.all(Array.from({ length: 16 }, () => hub.publish(frame)))
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(sealing).toHaveBeenCalledOnce()
    } finally {
      clock.mockRestore()
    }
  } finally {
    release()
  }
})

const rotation = () => ({
  id: crypto.randomUUID(),
  kind: 'rotation' as const,
  revokes: false,
  body: new TextEncoder().encode('{}'),
  timeoutMs: 10000,
})

async function reportAppHold(f: Awaited<ReturnType<typeof createCapturedRecoveryFixture>>) {
  const identity = await f.alice.fixture.safety().epochAuthenticator(f.alice.key)
  if (identity === null) throw new Error('Missing local identity')
  const remote = identity.authenticator.slice()
  remote[0] = (remote[0] ?? 0) ^ 1
  await f.alice.fixture.safety().reportFork(f.alice.key, {
    kind: 'epoch-authenticator',
    epoch: identity.epoch,
    local: identity.authenticator,
    remote,
  })
}

test('clear app halt resumes ordinary walk', async () => {
  const f = await createCapturedRecoveryFixture()
  cleanup.push(() => f.close())
  const original = f.alice.peer
  const before = f.alice.mls.sendAdmission().epoch
  await reportAppHold(f)
  await f.bob.peer.commit(rotation())
  expect(f.alice.mls.sendAdmission().epoch).toBe(before)
  await f.alice.fixture.safety().clearHold(f.alice.key)
  await expect
    .poll(() => f.alice.mls.sendAdmission())
    .toMatchObject({
      epoch: before + 1,
      admissible: true,
    })
  expect(f.alice.peer).toBe(original)
  expect(f.alice.created).toHaveLength(1)
  expect((await f.alice.fixture.device.groups.load(f.alice.key.groupID))?.activeIncarnation).toBe(1)
  await f.alice.peer.commit(rotation())
  await expect.poll(() => f.bob.mls.sendAdmission().epoch).toBe(before + 2)
})

test('clear before proof leaves every live lane closed', async () => {
  const f = await createCapturedRecoveryFixture()
  cleanup.push(() => f.close())
  const before = f.alice.mls.sendAdmission().epoch
  const process = vi.spyOn(f.alice.mls, 'processCommit')
  await reportAppHold(f)
  const fault = f.alice.fixture.armNextWorkFault('commit-then-reject')
  const pending = f.alice.fixture.safety().clearHold(f.alice.key)
  const proof = f.alice.fixture.holdProof(await fault.mutationID)
  try {
    await proof.started
    await f.bob.peer.commit(rotation())
    const chat = f.alice.peer.protocol('chat')
    for (const procedure of ['chat/posted', 'chat/changed'] as const)
      await expect(chat.dispatch(procedure, { data: {} })).rejects.toEqual(
        new SendNotAdmissibleError('fork-halted'),
      )
    await expect(chat.request('chat/double', { param: {} })).rejects.toEqual(
      new SendNotAdmissibleError('fork-halted'),
    )
    await expect(chat.gather('chat/double', { param: {} })).rejects.toEqual(
      new SendNotAdmissibleError('fork-halted'),
    )
    await expect(chat.to(f.bob.identity.id)).rejects.toEqual(
      new SendNotAdmissibleError('fork-halted'),
    )
    await expect(f.alice.peer.enqueue(rotation())).rejects.toEqual(
      new GroupSafetyHeldError('fork-halted'),
    )
    await expect(f.alice.peer.commit(rotation())).rejects.toEqual(
      new GroupSafetyHeldError('fork-halted'),
    )
    expect(() => f.alice.peer.reauthorize()).toThrow(new GroupSafetyHeldError('fork-halted'))
    expect(process).not.toHaveBeenCalled()
    expect(f.alice.mls.sendAdmission().epoch).toBe(before)
  } finally {
    proof.release()
  }
  await pending
  await expect.poll(() => f.alice.mls.sendAdmission().epoch).toBe(before + 1)
  expect(process).toHaveBeenCalled()
})

test('clear resumes a peer whose startup stopped under the app hold', async () => {
  const f = await createCapturedRecoveryFixture()
  cleanup.push(() => f.close())
  f.alice.hooks.beforePeer = async () => {
    await reportAppHold(f)
  }
  await f.alice.restart()
  f.alice.hooks.beforePeer = undefined
  expect(f.alice.mls.sendAdmission()).toMatchObject({ reason: 'fork-halted' })
  await f.alice.fixture.safety().clearHold(f.alice.key)
  await expect.poll(() => f.alice.mls.sendAdmission().admissible).toBe(true)
  const before = f.alice.mls.sendAdmission().epoch
  await f.bob.peer.commit(rotation())
  await expect.poll(() => f.alice.mls.sendAdmission().epoch).toBe(before + 1)
  await f.alice.peer.commit(rotation())
  await expect.poll(() => f.bob.mls.sendAdmission().epoch).toBe(before + 2)
})

test('legacy clear has no live release or network resume', async () => {
  const f = await createCapturedRecoveryFixture()
  cleanup.push(() => f.close())
  await f.alice.fixture.installRows({
    key: f.alice.key,
    control: {
      forkHalt: {
        eventID: forkEventID(f.alice.key),
        detectedAt: 42,
        evidence: { kind: 'unexplained-own-commit', epoch: 0, position: '1', digest: 'legacy' },
      },
    },
  })
  const notifications: Array<unknown> = []
  f.alice.mls.onSafetyChanged?.((reason) => {
    notifications.push(reason)
  })
  const subscribe = vi.spyOn(f.hub, 'subscribe')
  const fetch = vi.spyOn(f.hub, 'fetchTopic')
  await f.alice.fixture.safety().clearHold(f.alice.key)
  await f.alice.peer.replay()
  expect(notifications).toEqual(['fork-halted'])
  expect(subscribe).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
  expect(f.alice.mls.sendAdmission()).toMatchObject({ reason: 'fork-halted' })
})

test('successive app releases serialize an interrupted startup', async () => {
  const f = await createCapturedRecoveryFixture()
  cleanup.push(() => f.close())
  f.alice.hooks.beforePeer = async () => {
    await reportAppHold(f)
  }
  await f.alice.restart()
  f.alice.hooks.beforePeer = undefined
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let started!: () => void
  const starting = new Promise<void>((resolve) => {
    started = resolve
  })
  const original = f.alice.mls.exportRecoverySecret
  const exported = vi.spyOn(f.alice.mls, 'exportRecoverySecret').mockImplementation(async () => {
    started()
    await gate
    return await original()
  })
  try {
    await f.alice.fixture.safety().clearHold(f.alice.key)
    await starting
    await reportAppHold(f)
    await f.alice.fixture.safety().clearHold(f.alice.key)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(exported).toHaveBeenCalledTimes(1)
  } finally {
    release()
  }
  await f.bob.peer.commit(rotation())
  await expect.poll(() => f.alice.mls.sendAdmission().epoch).toBe(f.bob.mls.sendAdmission().epoch)
})

test('disposing a peer fences an already queued receive', async () => {
  const f = await createCapturedRecoveryFixture()
  cleanup.push(() => f.close())
  await f.hub.publish({
    senderDID: f.bob.identity.id,
    topicID: f.topicID,
    payload: new Uint8Array([255]),
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  const stopped = f.alice.stop()
  await f.hub.publish({
    senderDID: f.bob.identity.id,
    topicID: f.topicID,
    payload: new Uint8Array([254]),
  })
  await stopped
})

test('clear app hold preserves not member evidence and resumes retries', async () => {
  const { f, hub } = await setup()
  await start(f.remote, hub)
  const events: Array<RecoveryEvent> = []
  const local = await start(f.local(), hub, events)
  await local.owner.peer()?.recover()
  await expect
    .poll(() => local.owner.status())
    .toMatchObject({ kind: 'not-member', retrying: true })
  const safety = f.local().safety()
  const identity = await safety.epochAuthenticator(f.key)
  if (identity === null) throw new Error('Missing reported identity')
  const remote = identity.authenticator.slice()
  remote[0] = (remote[0] ?? 0) ^ 1
  await safety.reportFork(f.key, {
    kind: 'epoch-authenticator',
    epoch: identity.epoch,
    local: identity.authenticator,
    remote,
  })
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const before = await safety.status(f.key)
  const count = events.length
  await safety.clearHold(f.key)
  expect(await safety.status(f.key)).toMatchObject({
    hold: null,
    condition: 'not-member',
    evidence: before.evidence,
  })
  await expect.poll(() => events.length, { timeout: 5000 }).toBeGreaterThan(count)
  expect(local.owner.status()).toMatchObject({ kind: 'not-member', retrying: true })
})

test('clear app hold resumes interrupted recovery', async () => {
  const f = await createCapturedRecoveryFixture()
  cleanup.push(() => f.close())
  let started!: () => void
  const starting = new Promise<void>((resolve) => {
    started = resolve
  })
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const original = f.alice.mls.createRecoveryRequest
  const create = vi
    .spyOn(f.alice.mls, 'createRecoveryRequest')
    .mockImplementationOnce(async (...args) => {
      started()
      await gate
      return await original(...args)
    })
  const pending = f.alice.peer.recover().catch((error: unknown) => error)
  await starting
  try {
    await reportAppHold(f)
  } finally {
    release()
  }
  await pending
  await f.alice.fixture.safety().clearHold(f.alice.key)
  await expect.poll(() => create.mock.calls.length, { timeout: 5000 }).toBeGreaterThan(1)
})

test.each(['unreadable', 'empty-spent'] as const)(
  'legacy holds and envelope loss retain exact diagnoses: %s',
  async (damage) => {
    const f = await createCapturedRecoveryFixture()
    cleanup.push(() => f.close())
    await f.alice.fixture.installRows({
      key: f.alice.key,
      control: {
        forkHalt: {
          eventID: forkEventID(f.alice.key),
          detectedAt: 42,
          evidence: { kind: 'unexplained-own-commit', epoch: 0, position: '1', digest: 'legacy' },
        },
      },
    })
    await f.alice.fixture.corruptTrust(f.alice.key.groupID, damage)
    await expect(
      f.alice.fixture.registry.recoverySource(f.alice.key.groupID),
    ).rejects.toMatchObject(
      damage === 'empty-spent'
        ? { name: 'SpentSetCorruptError' }
        : { reason: 'recovery-unavailable' },
    )
    expect(await f.alice.fixture.safety().status(f.alice.key)).toMatchObject({
      hold: 'fork-halted',
      condition: damage === 'empty-spent' ? 'spent-set-corrupt' : null,
    })
    await f.alice.fixture.safety().clearHold(f.alice.key)
    expect(await f.alice.fixture.safety().status(f.alice.key)).toMatchObject({
      hold: 'fork-halted',
      condition: damage === 'empty-spent' ? 'spent-set-corrupt' : null,
    })
    const rows = await f.alice.fixture.inspectRows()
    expect(rows.trust?.size).toBe(1)
  },
)

test.each(['empty-spent', 'missing-spent', 'malformed-spent'] as const)(
  'spent corruption peer startup has a durable status: %s',
  async (damage) => {
    const { f } = await setup(false)
    const fixture = f.local()
    await fixture.corruptTrust(f.key.groupID, damage)
    const created = vi.fn(async () => {
      throw new Error('Corrupt state must never start a peer')
    })
    const owner = await createRegistryPeer({
      registry: fixture.registry,
      key: f.key,
      target: { targetID: 'diagnostic-hub', topicID: 'diagnostic-commits' },
      recovery: fixture.environment,
      continuation: createRecoveryContinuationPort({
        registry: fixture.registry,
        persistence: fixture.device.groups,
      }),
      createMLS: created,
      createPeer: created,
    })
    cleanup.push(async () => {
      owner.dispose()
      await owner.drained()
    })
    await owner.ready
    expect(owner.status()).toMatchObject({ kind: 'spent-set-corrupt', eventID: expect.any(String) })
    expect(owner.peer()).toBeNull()
    expect(created).not.toHaveBeenCalled()
    const event = (await fixture.safety().events(f.key)).find(
      (event) => event.kind === 'spent-set-corrupt',
    )
    expect(event?.id).toBe(
      'eventID' in owner.status() ? Reflect.get(owner.status(), 'eventID') : undefined,
    )
  },
)

async function startDiagnosticPeer(
  fixture: RegistryFixture,
  key: { groupID: string; incarnation: number },
  observe?: (options: RegistryPeerOptions) => void,
) {
  const created = vi.fn(async () => {
    throw new Error('Held or corrupt state must never start a peer')
  })
  const owner = await createRegistryPeer({
    registry: fixture.registry,
    key,
    target: { targetID: 'diagnostic-hub', topicID: 'diagnostic-commits' },
    recovery: fixture.environment,
    continuation: createRecoveryContinuationPort({
      registry: fixture.registry,
      persistence: fixture.device.groups,
    }),
    createMLS: created,
    createPeer: async (_key, options) => {
      observe?.(options)
      return await created()
    },
  })
  const stop = async () => {
    owner.dispose()
    await owner.drained().catch(() => {})
  }
  cleanup.push(stop)
  await owner.ready.catch(() => {})
  return { owner, created, stop }
}

// The not-member fixture's restart rebuilds MLS, which corrupt trust refuses.
async function reopenLocal(fixture: RegistryFixture) {
  const reopened = await fixture.reopen()
  cleanup.push(() => reopened.close())
  return reopened
}

async function activeConditionKinds(fixture: RegistryFixture, groupID: string) {
  const capability = entryCapability(fixture.device.groups)
  if (capability === null) throw new Error('Missing capability')
  return (await capability.read(groupID, (reads) => reads.checkpoints())).flatMap((row) =>
    row.kind === 'condition' && row.active ? [row.event.kind] : [],
  )
}

// A running peer may commit between the fixture's lifetime read and its write.
async function installRecoveryUnavailable(
  fixture: RegistryFixture,
  key: { groupID: string; incarnation: number },
) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fixture.installRows({
        key,
        control: {
          recoveryUnavailable: {
            ...key,
            id: recoveryUnavailableEventID(key),
            kind: 'group:recovery-unavailable',
            reason: 'trust-unreadable',
          },
        },
      })
      return
    } catch (error) {
      if (attempt >= 4 || !(error instanceof Error) || error.message !== 'Group lifetime conflict')
        throw error
    }
  }
}

function appFork(key: { groupID: string; incarnation: number }) {
  return {
    eventID: forkEventID(key),
    detectedAt: 42,
    producer: 'app-report' as const,
    evidence: { kind: 'unexplained-own-commit' as const, epoch: 0, position: '1', digest: 'held' },
  }
}

test('peer startup reports spent corruption over not-member across restart', async () => {
  const { f } = await setup(false)
  await f.diagnose(await f.proof())
  expect(await f.local().safety().status(f.key)).toMatchObject({ condition: 'not-member' })
  await f.local().corruptTrust(f.key.groupID, 'empty-spent')
  const first = await startDiagnosticPeer(f.local(), f.key)
  expect(first.owner.status()).toMatchObject({ kind: 'spent-set-corrupt' })
  expect(first.created).not.toHaveBeenCalled()
  expect(await activeConditionKinds(f.local(), f.key.groupID)).toEqual(
    expect.arrayContaining(['not-member', 'spent-set-corrupt']),
  )
  await first.stop()
  const reopened = await reopenLocal(f.local())
  const second = await startDiagnosticPeer(reopened, f.key)
  expect(second.owner.status()).toMatchObject({ kind: 'spent-set-corrupt' })
  expect(await reopened.safety().status(f.key)).toMatchObject({
    hold: 'spent-set-corrupt',
    condition: 'spent-set-corrupt',
  })
  expect(await activeConditionKinds(reopened, f.key.groupID)).toEqual(
    expect.arrayContaining(['not-member', 'spent-set-corrupt']),
  )
})

test('spent corruption outranks recovery unavailable and pending reasons at runtime and startup', async () => {
  const { f, hub } = await setup()
  let options: RegistryPeerOptions | undefined
  const local = await start(f.local(), hub, [], (value) => {
    options = value
  })
  await local.owner.peer()?.recover()
  expect(local.owner.status()).toMatchObject({ kind: 'pending', reason: 'no-reply' })
  await installRecoveryUnavailable(f.local(), f.key)
  await f.local().corruptTrust(f.key.groupID, 'empty-spent')
  await expect(f.local().registry.recoverySource(f.key.groupID)).rejects.toMatchObject({
    name: 'SpentSetCorruptError',
  })
  await expect.poll(() => local.owner.status().kind).toBe('spent-set-corrupt')
  if (options === undefined) throw new Error('Missing peer options')
  await options.onRecovery?.({
    groupID: local.target.topicID,
    attemptID: 'late-attempt',
    trigger: 'automatic',
    phase: 'failed',
    reason: 'error',
    error: new Error('late'),
    pendingReason: 'no-reply',
  })
  expect(local.owner.status()).toMatchObject({ kind: 'spent-set-corrupt' })
  expect(await f.local().safety().status(f.key)).toMatchObject({
    hold: 'spent-set-corrupt',
    condition: 'spent-set-corrupt',
  })
  local.owner.dispose()
  await local.owner.drained()
  const fixture = await reopenLocal(f.local())
  const reopened = await startDiagnosticPeer(fixture, f.key)
  expect(reopened.owner.status()).toMatchObject({ kind: 'spent-set-corrupt' })
  expect(reopened.created).not.toHaveBeenCalled()
  expect(
    (await fixture.device.groups.ports(f.key).control.load()).recoveryUnavailable,
  ).not.toBeNull()
})

test('pending then recovery unavailable reopens held without a pending status', async () => {
  const { f, hub } = await setup()
  const local = await start(f.local(), hub)
  await local.owner.peer()?.recover()
  expect(local.owner.status()).toMatchObject({ kind: 'pending', reason: 'no-reply' })
  await installRecoveryUnavailable(f.local(), f.key)
  expect(await f.local().safety().status(f.key)).toMatchObject({
    hold: 'recovery-unavailable',
    condition: null,
  })
  local.owner.dispose()
  await local.owner.drained()
  const fixture = await reopenLocal(f.local())
  let options: RegistryPeerOptions | undefined
  const reopened = await startDiagnosticPeer(fixture, f.key, (value) => {
    options = value
  })
  expect(reopened.owner.status()).toMatchObject({
    kind: 'failed',
    error: { message: 'Recovery source is held' },
  })
  expect(options).toBeUndefined()
  expect(reopened.created).not.toHaveBeenCalled()
  expect(await fixture.safety().status(f.key)).toMatchObject({
    hold: 'recovery-unavailable',
    condition: null,
  })
})

test.each([
  { hold: 'fork-halted', warm: false },
  { hold: 'fork-halted', warm: true },
  { hold: 'control-hold', warm: false },
  { hold: 'control-hold', warm: true },
] as const)(
  'hard holds outrank spent corruption at peer startup: $hold / warm $warm',
  async ({ hold, warm }) => {
    const { f } = await setup(false)
    await f.local().installRows({
      key: f.key,
      control:
        hold === 'fork-halted'
          ? { forkHalt: appFork(f.key) }
          : { controlHold: { reason: 'unsupported-version', position: null } },
    })
    await f.local().corruptTrust(f.key.groupID, 'empty-spent')
    if (warm)
      await expect(f.local().registry.recoverySource(f.key.groupID)).rejects.toMatchObject({
        name: 'SpentSetCorruptError',
      })
    const peer = await startDiagnosticPeer(f.local(), f.key)
    expect(peer.owner.status()).toMatchObject({ kind: 'failed' })
    expect(peer.created).not.toHaveBeenCalled()
    expect(await f.local().safety().status(f.key)).toMatchObject({
      hold: hold === 'fork-halted' ? 'fork-halted' : 'spent-set-corrupt',
      condition: 'spent-set-corrupt',
    })
    await peer.stop()
    const fixture = await reopenLocal(f.local())
    const reopened = await startDiagnosticPeer(fixture, f.key)
    expect(reopened.owner.status()).toMatchObject({ kind: 'failed' })
    expect(await fixture.safety().status(f.key)).toMatchObject({
      hold: hold === 'fork-halted' ? 'fork-halted' : 'spent-set-corrupt',
      condition: 'spent-set-corrupt',
    })
  },
)

test('failed condition write at peer startup keeps the spent corruption cause', async () => {
  const { f } = await setup(false)
  await f.local().corruptTrust(f.key.groupID, 'empty-spent')
  f.local().armNextWorkFault('before-commit')
  const peer = await startDiagnosticPeer(f.local(), f.key)
  const status = peer.owner.status()
  expect(status).toMatchObject({ kind: 'failed' })
  expect('error' in status ? status.error : undefined).toBeInstanceOf(SpentSetCorruptError)
  expect(peer.created).not.toHaveBeenCalled()
})

test('running peer keeps a hard control hold over later spent corruption', async () => {
  const { f, hub } = await setup()
  const local = await start(f.local(), hub)
  await local.owner.peer()?.recover()
  for (let attempt = 0; ; attempt++) {
    try {
      await f.local().installRows({
        key: f.key,
        control: { controlHold: { reason: 'unsupported-version', position: null } },
      })
      break
    } catch (error) {
      if (attempt >= 4 || !(error instanceof Error) || error.message !== 'Group lifetime conflict')
        throw error
    }
  }
  await f.local().corruptTrust(f.key.groupID, 'empty-spent')
  await expect(f.local().registry.recoverySource(f.key.groupID)).rejects.toMatchObject({
    name: 'SpentSetCorruptError',
  })
  expect(await activeConditionKinds(f.local(), f.key.groupID)).toContain('spent-set-corrupt')
  // The condition write notifies observers; give the peer's refresh time to land.
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(local.owner.status().kind).not.toBe('spent-set-corrupt')
})
