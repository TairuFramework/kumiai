import {
  checkpointTopic,
  commitTopic,
  createGroupPeer,
  decodeHandshakeFrame,
  decodeRecoveryRequest,
  encodeHandshakeFrame,
  encodeRecoveryReply,
  encodeRecoveryRequest,
  HANDSHAKE_KIND,
  type LogPosition,
  type RecoveryEvent,
  rendezvousTopic,
} from '@kumiai/rpc'
import { afterEach, expect, test, vi } from 'vitest'

import { createCheckpointService } from '../../../packages/mls-rpc/src/checkpoint.js'
import {
  createControlValidationPort,
  createGroupCrypto,
  createLedgerEntrySlot,
  createRecoveryContinuationPort,
  createRegistryGroupMLS,
  createRegistryHandleAccess,
  createRegistryPeer,
  type RegistryPeerOptions,
} from '../../../packages/mls-rpc/src/index.js'
import {
  createNotMemberFixture,
  type RegistryFixture,
} from '../../../packages/mls-rpc/test/fixtures/registry.js'
import { FakeHub } from '../../../packages/rpc/test/fixtures/fake-hub.js'

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
      const access = createRegistryHandleAccess({
        access: await f.registry.access(current.groupID),
      })
      const ports = f.device.groups.ports(current)
      return createGroupPeer({
        ...options,
        hub,
        crypto: createGroupCrypto({
          access: {
            ...access,
            open: async () => {
              throw new Error('No application frames expected')
            },
          },
        }),
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

async function setup() {
  const f = await createNotMemberFixture()
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
  await localService.importCheckpoint(f.key, splitFrame)
  expect(await localService.forkNotices(f.key.groupID)).toEqual(
    expect.arrayContaining([expect.objectContaining({ splitEpoch: 10, closedAt: null })]),
  )
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
  expect(comparisons).toContain(10)
  const after = await f.local().device.groups.ports(f.key).control.load()
  expect(after.rejoin).toEqual(before.rejoin)
  expect(after.recoveryEpochFloor).toEqual(before.recoveryEpochFloor)
  const count = events.length
  await expect.poll(() => events.length, { timeout: 5000 }).toBeGreaterThan(count)
  expect(remote.owner.status().kind).toBe('running')
})

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
  { name: 'successful re-anchor clears not-member', outcome: 're-anchor' },
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
    expect((await f.local().device.groups.ports(f.key).control.load()).rejoin).toEqual(saved.rejoin)
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
