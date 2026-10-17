import { decodeClientState, type GroupHandle, restoreGroup } from '@kumiai/mls'
import {
  checkpointTopic,
  decodeCommitFrame,
  decodeHandshakeFrame,
  digestAppliedCommit,
} from '@kumiai/rpc'
import { expect, type MockInstance, test, vi } from 'vitest'

import {
  createControlAdoptionPort,
  createControlValidationPort,
  createGroupCrypto,
  createLedgerEntrySlot,
  createRecoveryContinuationPort,
  createRegistryGroupMLS,
  createRegistryHandleAccess,
  createRegistryPeer,
  type HandleAccess,
  type RegistryPeer,
} from '../../../packages/mls-rpc/src/index.js'
import { decodeStoredValue } from '../../../packages/mls-rpc/src/persistence-codec.js'
import { createForkRecoveryRealFixture } from '../../../packages/mls-rpc/test/fixtures/captured-recovery.js'
import type { RegistryFixture } from '../../../packages/mls-rpc/test/fixtures/registry.js'
import { createGroupPeerWithControlWalk } from '../../../packages/rpc/src/peer.js'
import { FakeHub } from '../../../packages/rpc/test/fixtures/fake-hub.js'

for (const transactional of [false, true]) {
  test(`hub repair moves advanced losing branch / transactional ${transactional}`, async () => {
    const f = await createForkRecoveryRealFixture(transactional)
    const repairedHub = new FakeHub()
    try {
      const exactX = await f.saveX()
      expect(exactX.target.groupInfoEpoch).toBe(20)
      const capture = await f.reply()
      const authority = await f
        .requester()
        .capturedRecovery?.authoriseForkRecovery?.(capture, f.noticeID)
      if (authority == null) throw new Error('Missing bound real branch reply')
      const y = await f.build(authority, capture)
      if (y === null) throw new Error('Missing repaired candidate')
      expect(y.record.target.groupInfoEpoch).toBe(12)
      const result = await f.installY(y, async (record) => {
        repairedHub.subscribe('continuing-member', record.target.topicID)
        const published = await repairedHub.publish({
          senderDID: 'rejoining-device',
          topicID: record.target.topicID,
          payload: record.payload,
          retain: 'log',
          publishID: record.publishID,
          expectedHead: record.expectedHead,
        })
        const delivered = await repairedHub.fetchTopic({
          subscriberDID: 'continuing-member',
          topicID: record.target.topicID,
          limit: 32,
        })
        const frame = delivered.messages.find((frame) => frame.sequenceID === published.sequenceID)
        if (frame === undefined) throw new Error('Repaired hub did not deliver external commit')
        expect(
          digestAppliedCommit(
            decodeCommitFrame(decodeHandshakeFrame(frame.payload).payload).commit,
          ),
        ).toBe(record.digest)
        return published.sequenceID
      })
      expect(result.applied).toMatchObject({ applied: true, advanced: true, epochAfter: 13 })
      const installed = await f.local().device.groups.loadState(result.destination)
      expect(installed).toMatchObject({ epoch: 13, terminal: false })
      const abandonment = (await f.local().safety().events(result.sourceKey)).filter(
        (event) => event.kind === 'branch-abandoned',
      )
      expect(abandonment).toHaveLength(1)
      expect(abandonment[0]).toMatchObject({
        noticeID: f.noticeID,
        epochs: { from: 10, through: 20 },
        ownMessages: [],
        othersSeen: 0,
        membersAdded: [],
        membersRemoved: [],
        coverage: {
          ancestry: { kind: 'complete' },
          ephemeral: { kind: 'partial', reasons: ['ephemeral-uncovered'] },
        },
      })
      expect((await f.snapshot()).recoveryEpochFloor).toBe(20)
      expect(
        (await f.local().device.groups.ports(result.sourceKey).control.load()).forkRecoveryAttempt,
      ).toBeNull()
      const history = (await f.service().readRecords()).find(
        (row) => row.kind === 'superseded-rejoin',
      )
      expect(history?.kind === 'superseded-rejoin' ? history.record : null).toEqual(exactX)
    } finally {
      await f.close()
    }
  })
}

test('unproven branch exception stays visibly target behind', async () => {
  const f = await createForkRecoveryRealFixture(true)
  try {
    const exactX = await f.saveX()
    const before = await f.snapshot()
    const port = f.requester().capturedRecovery
    if (port === undefined) throw new Error('Missing real captured recovery')
    for (let round = 0; round < 9; round++) {
      const reply = await f.reply(12, 'other', true)
      expect(await port.authoriseForkRecovery?.(reply, f.noticeID)).toBeNull()
      expect(await port.reconcileCapture(exactX, reply)).toEqual({
        kind: 'retry',
        reason: 'target-behind',
      })
      expect(await f.snapshot()).toEqual(before)
    }
    expect((await f.snapshot()).settledRejoins).toEqual([])
  } finally {
    await f.close()
  }
})

async function startPeerOwner(
  fixture: RegistryFixture,
  hub: FakeHub,
  target: { targetID: string; topicID: string },
  groupID: string,
) {
  const entrySlot = createLedgerEntrySlot()
  const initial = (await fixture.registry.recoverySource(groupID)).key
  return createRegistryPeer({
    registry: fixture.registry,
    key: initial,
    recovery: fixture.environment,
    target,
    continuation: createRecoveryContinuationPort({
      registry: fixture.registry,
      persistence: fixture.device.groups,
    }),
    createMLS: (key) =>
      createRegistryGroupMLS({
        registry: fixture.registry,
        key,
        identity: fixture.identity,
        entrySlot,
        recovery: fixture.environment,
        target,
      }),
    async createPeer(key, options) {
      const ports = fixture.device.groups.ports(key)
      const opened = async () =>
        createRegistryHandleAccess({ access: await fixture.registry.access(key.groupID) })
      const access: HandleAccess = {
        epoch: () => options.mls.sendAdmission().epoch,
        admission: () => options.mls.sendAdmission(),
        read: async (fn) => (await opened()).read(fn),
        readControl: async (fn) => (await opened()).readControl(fn),
        mutate: async (fn, write) => (await opened()).mutate(fn, write),
        replace: async (next, write, prepare) => (await opened()).replace(next, write, prepare),
        open: async () => {
          throw new Error('Application opens are outside recovery')
        },
      }
      const restoreCandidate = async (bytes: Uint8Array) => {
        const value = decodeStoredValue(bytes) as {
          state: Uint8Array
          credential: GroupHandle['credential']
          ledger: Array<string>
        }
        const state = decodeClientState(value.state)
        if (state === undefined) throw new Error('Invalid control candidate')
        return restoreGroup({
          state,
          credential: value.credential,
          ledgerEntries: value.ledger,
          options: fixture.environment.options,
        })
      }
      return createGroupPeerWithControlWalk({
        ...options,
        hub,
        localDID: fixture.identity.id,
        protocols: {},
        handlers: {},
        crypto: createGroupCrypto({ access }),
        control: ports.control,
        prepareBuild: async () => {
          throw new Error('No operations are queued')
        },
        validation: createControlValidationPort({
          identity: fixture.identity,
          options: fixture.environment.options,
          restoreCandidate,
        }),
        adopt: createControlAdoptionPort({ access, control: ports.control, restoreCandidate })
          .adopt,
        readEvidence: () => fixture.device.groups.readEvidence(key),
        anchorStore: ports.anchor,
        appCursorStore: ports.cursor,
        appOutbox: ports.outbox,
        appOutboxLimit: 128,
        deliverWelcome: async () => {
          throw new Error('No Welcome is owed')
        },
        recovery: { timeoutMs: 3000, deadlineMs: 15000, getDelayMs: () => 0 },
      }).peer
    },
  })
}

test.each([
  { saved: false, offeredEpoch: 12 },
  { saved: true, offeredEpoch: 12 },
  { saved: false, offeredEpoch: 19 },
  { saved: true, offeredEpoch: 19 },
])(
  'real peer heals advanced branch and preserves ordinary floor after reconstruction: saved X $saved / F=$offeredEpoch',
  async ({ saved, offeredEpoch }) => {
    const f = await createForkRecoveryRealFixture(true)
    const hub = new FakeHub()
    let local: RegistryPeer | undefined
    let remote: RegistryPeer | undefined
    try {
      if (saved) await f.saveX()
      if (offeredEpoch !== 12) await f.reply(offeredEpoch)
      const before = await f.snapshot()
      remote = await startPeerOwner(f.remote(), hub, f.target, f.key.groupID)
      await remote.ready
      await remote.peer()?.replay()
      local = await startPeerOwner(f.local(), hub, f.target, f.key.groupID)
      await local.ready
      await local.peer()?.recover()
      await expect.poll(() => local?.installedKey().incarnation, { timeout: 20000 }).toBe(2)
      const installed = await f.local().device.groups.loadState(local.installedKey())
      expect(installed).toMatchObject({ epoch: offeredEpoch + 1, terminal: false })
      expect(await f.local().device.groups.ports(local.installedKey()).anchor.load()).toMatchObject(
        {
          anchor: { epoch: offeredEpoch + 1, secret: expect.any(Uint8Array) },
        },
      )
      expect(
        (await f.local().device.groups.ports(local.installedKey()).control.load())
          .recoveryEpochFloor,
      ).toBe(before.recoveryEpochFloor)
      expect(
        (await f.local().device.groups.ports(f.key).control.load()).forkRecoveryAttempt,
      ).toBeNull()
      expect(local.status().kind).not.toBe('failed')
    } finally {
      local?.dispose()
      remote?.dispose()
      await Promise.all([local?.drained(), remote?.drained()])
      await f.close()
    }
  },
)

test('real peer without X or open notice keeps stale capture target behind', async () => {
  const f = await createForkRecoveryRealFixture(true)
  const hub = new FakeHub()
  const checkpointSink = new FakeHub()
  let local: RegistryPeer | undefined
  let remote: RegistryPeer | undefined
  let timers: MockInstance<typeof setTimeout> | undefined
  let publish: MockInstance<FakeHub['publish']> | undefined
  try {
    await f.rewriteNotice((notice) => {
      notice.closedAt = Date.now()
    })
    await f.local().installRows({ key: f.key, control: { recoveryEpochFloor: 20 } })
    const topic = checkpointTopic(await f.requester().exportRecoverySecret())
    const send = hub.publish.bind(hub)
    // Blind non-delivery leaves recovery with no checkpoint authority.
    publish = vi
      .spyOn(hub, 'publish')
      .mockImplementation((params) =>
        params.topicID === topic ? checkpointSink.publish(params) : send(params),
      )
    remote = await startPeerOwner(f.remote(), hub, f.target, f.key.groupID)
    await remote.ready
    await remote.peer()?.replay()
    local = await startPeerOwner(f.local(), hub, f.target, f.key.groupID)
    await local.ready
    await local.peer()?.replay()
    const before = await f.snapshot()
    const state = await f.local().device.groups.loadState(f.key)
    expect(before.rejoin).toBeNull()
    expect(before.forkRecoveryAttempt).toBeNull()
    expect(before.recoveryEpochFloor).toBe(20)
    expect(
      (await f.service().readRecords()).filter(
        (row) => row.kind === 'notice' && row.notice.closedAt === null,
      ),
    ).toEqual([])
    timers = vi.spyOn(globalThis, 'setTimeout')
    for (let round = 0; round < 8; round++) {
      expect(await local.peer()?.recover()).toEqual({ advanced: false, reenact: [] })
      expect(local.status()).toMatchObject({ kind: 'pending', reason: 'target-behind' })
      expect(local.installedKey()).toEqual(f.key)
      expect(await f.snapshot()).toEqual(before)
      expect(await f.local().device.groups.loadState(f.key)).toEqual(state)
    }
    expect(timers.mock.calls.filter(([, delay]) => delay === 15000).length).toBeGreaterThan(1)
    expect(timers.mock.calls.some(([, delay]) => delay === 60000)).toBe(false)
    expect(hub.published.filter((frame) => frame.topicID === f.target.topicID)).toEqual([])
  } finally {
    local?.dispose()
    remote?.dispose()
    await Promise.all([local?.drained(), remote?.drained()])
    timers?.mockRestore()
    publish?.mockRestore()
    await f.close()
  }
})

test.each([false, true])(
  'bound same-number rejoin installs and survives restart: %s',
  async (transactional) => {
    const f = await createForkRecoveryRealFixture(transactional)
    try {
      const exactX = await f.saveX()
      const capture = await f.reply(19)
      const authority = await f
        .requester()
        .capturedRecovery?.authoriseForkRecovery?.(capture, f.noticeID)
      if (authority == null) throw new Error('Missing bound branch reply')
      const y = await f.build(authority, capture)
      if (y === null) throw new Error('Missing bound candidate')
      expect(y.record.source.identity?.epoch).toBe(20)
      expect(y.record.epochAfter).toBe(20)
      const result = await f.installY(y)
      expect(result.applied).toMatchObject({ applied: true, advanced: true, epochAfter: 20 })
      expect(result.responderEpoch).toBe(20)
      expect(result.destination.incarnation).toBe(result.sourceKey.incarnation + 1)
      await f.restart()
      expect(await f.local().device.groups.loadState(f.key)).toMatchObject({
        epoch: 20,
        terminal: false,
      })
      expect((await f.snapshot()).recoveryEpochFloor).toBe(20)
      expect((await f.snapshot()).forkRecoveryAttempt).toBeNull()
      const history = (await f.service().readRecords()).find(
        (row) => row.kind === 'superseded-rejoin',
      )
      expect(history?.kind === 'superseded-rejoin' ? history.record : null).toEqual(exactX)
    } finally {
      await f.close()
    }
  },
)
