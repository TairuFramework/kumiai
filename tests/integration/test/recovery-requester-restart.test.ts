import type { OwnIdentity } from '@kokuin/token'
import type { GroupHandle } from '@kumiai/mls'
import type { LedgerEntrySlot } from '@kumiai/mls-rpc'
import { commitTopic } from '@kumiai/rpc'
import { afterEach, expect, test, vi } from 'vitest'

import { type Member, makeMember, restoreMemberHandle } from './app-lane-e2e.js'
import { createCapturedRecoveryFixture } from './fixtures/fork-halt.js'
import { createWireHub } from './log-hub-over-wire.js'

const close: Array<() => Promise<unknown>> = []
afterEach(async () => {
  await Promise.all(close.splice(0).map((fn) => fn()))
  vi.restoreAllMocks()
})

test.each(['built', 'published', 'confirmed', 'adopted'] as const)(
  'real requester restart resumes its %s record with the stored candidate and request key',
  async (stage) => {
    const { createRealGroup } = (await import(
      new URL('../../../packages/mls-rpc/test/fixtures/real-group.ts', import.meta.url).href
    )) as {
      createRealGroup(
        size: number,
        id: string,
      ): Promise<{
        members: Array<{ identity: OwnIdentity; handle: GroupHandle; slot: LedgerEntrySlot }>
      }>
    }
    const group = await createRealGroup(2, `requester-restart-${stage}`)
    const aliceGroup = group.members[0]
    const bobGroup = group.members[1]
    if (aliceGroup == null || bobGroup == null) throw new Error('Missing members')
    const hub = createWireHub()
    close.push(() => hub.dispose())
    const live: Array<Member> = []
    close.push(async () => {
      await Promise.all(live.map(({ peer }) => peer.dispose()))
      await Promise.all(live.map(({ peer }) => peer.drained()))
    })
    const recovery = { timeoutMs: 3000, deadlineMs: 15_000, getDelayMs: () => 0 }
    const alice = makeMember({
      hub,
      identity: aliceGroup.identity,
      group: aliceGroup.handle,
      entrySlot: aliceGroup.slot,
      recovery,
    })
    const externalPayloads: Array<Uint8Array> = []
    const topicID = commitTopic(await alice.mls.exportRecoverySecret())
    const connect = hub.connect.bind(hub)
    vi.spyOn(hub, 'connect').mockImplementation((identity) => {
      const connection = connect(identity)
      if (identity.id === bobGroup.identity.id) {
        const publish = connection.publish.bind(connection)
        connection.publish = (params) => {
          if (params.topicID === topicID) externalPayloads.push(params.payload)
          return publish(params)
        }
      }
      return connection
    })
    const bob = makeMember({
      hub,
      identity: bobGroup.identity,
      group: bobGroup.handle,
      entrySlot: bobGroup.slot,
      recovery,
    })
    live.push(alice, bob)
    await alice.peer.replay()
    await bob.peer.replay()
    const apply = bob.control.apply.bind(bob.control)
    vi.spyOn(bob.control, 'apply').mockImplementation(async (changes, id) => {
      await apply(changes, id)
      if (changes.putRejoin?.stage === stage) void bob.peer.dispose()
    })
    if (stage === 'adopted')
      bob.stateStore.database.seam('after-save', () => {
        void bob.peer.dispose()
        throw new Error('Crash after adoption transaction')
      })
    await expect(bob.peer.recover()).rejects.toThrow()
    await bob.peer.dispose()
    await bob.peer.drained()
    const record = (await bob.control.load()).rejoin
    const sourceEpoch =
      record == null
        ? undefined
        : 'format' in record
          ? record.source.identity?.epoch
          : record.source.epoch
    if (record != null && 'format' in record) {
      expect(record.source.key.groupID).toBe(bobGroup.handle.groupID)
      expect(record.target.groupInfoEpoch + 1).toBe(record.epochAfter)
    }
    expect(record?.stage).toBe(stage)
    vi.mocked(bob.control.apply).mockRestore()
    const restored = await restoreMemberHandle(bob, bob.entrySlot)
    expect(Number(restored.epoch)).toBe(stage === 'adopted' ? record?.epochAfter : sourceEpoch)
    const again = makeMember({
      hub,
      identity: bob.identity,
      group: restored,
      entrySlot: bob.entrySlot,
      restartOf: bob,
      recovery,
    })
    live.push(again)
    await expect
      .poll(
        async () => ({
          rejoin: (await again.control.load()).rejoin,
          epoch: await again.mls.readEpoch(),
          responderEpoch: await alice.mls.readEpoch(),
          anchorEpoch: again.peer.anchorEpoch(),
        }),
        { timeout: 10_000 },
      )
      .toEqual({
        rejoin: null,
        epoch: record?.epochAfter,
        responderEpoch: record?.epochAfter,
        anchorEpoch: record?.epochAfter,
      })
    expect(await again.mls.readEpoch()).toBe(await alice.mls.readEpoch())
    expect((await again.control.load()).applied).toEqual([
      expect.objectContaining({
        digest: record?.digest,
        payloadDigest: record?.payloadDigest,
        opID: null,
      }),
    ])
    expect(externalPayloads).toHaveLength(1)
    expect(externalPayloads[0]).toEqual(record?.payload)
    expect(again.peer.anchorEpoch()).toBe(await again.mls.readEpoch())
  },
)

test.each(['built', 'published', 'confirmed', 'adopted'] as const)(
  'registry reconstruction resumes captured %s with the original request, candidate and switch identity',
  { timeout: 90_000 },
  async (stage) => {
    const s = await createCapturedRecoveryFixture({ timeoutMs: 5000, deadlineMs: 30_000 })
    close.push(() => s.close())
    const bob = s.bob
    const source = bob.peer
    const payloads: Array<Uint8Array> = []
    const publish = s.hub.publish.bind(s.hub)
    vi.spyOn(s.hub, 'publish').mockImplementation(async (params) => {
      if (
        params.senderDID === bob.identity.id &&
        params.topicID === s.topicID &&
        params.retain === 'log'
      )
        payloads.push(params.payload.slice())
      return publish(params)
    })
    let release = () => {}
    const pause = new Promise<void>((resolve) => {
      release = resolve
    })
    close.push(async () => release())
    if (stage === 'adopted')
      bob.hooks.beforePeer = async (key) => {
        if (key.incarnation === 2) await pause
      }
    else {
      const apply = bob.control.apply.bind(bob.control)
      vi.spyOn(bob.control, 'apply').mockImplementation(async (changes, mutationID) => {
        await apply(changes, mutationID)
        if (changes.putRejoin?.stage === stage) void source.dispose()
      })
    }
    const recovering = source.recover()
    void recovering.catch(() => {})
    await expect
      .poll(async () => (await bob.control.load()).rejoin?.stage, { timeout: 30_000 })
      .toBe(stage)
    bob.owner.dispose()
    release()
    await bob.owner.drained()
    await recovering.catch(() => {})
    const record = (await bob.control.load()).rejoin
    if (record === null || !('format' in record)) throw new Error('Missing captured attempt')
    expect(record.format).toBe(2)
    expect(record.target.captureHead).toBeNull()
    expect(record.captureHead).toBeNull()
    expect(record.searchFrom).toBeNull()
    expect(record.requestKey.byteLength).toBeGreaterThan(0)
    expect(record.candidate.byteLength).toBeGreaterThan(0)
    if (stage !== 'adopted') vi.mocked(bob.control.apply).mockRestore()
    bob.hooks.beforePeer = undefined
    await bob.restart()
    await vi.waitFor(
      async () => {
        expect(bob.owner.installedKey().incarnation).toBe(2)
        expect((await bob.control.load()).rejoin).toBeNull()
        expect(await bob.mls.readEpoch()).toBe(record.epochAfter)
        expect(await s.alice.mls.readEpoch()).toBe(record.epochAfter)
      },
      { timeout: 30_000 },
    )
    expect(payloads).toEqual([record.payload])
    const destination = await bob.fixture.device.groups.loadState(bob.owner.installedKey())
    expect(destination).toMatchObject({ deleted: false, epoch: record.epochAfter })
    expect(
      (await bob.fixture.safety().events(record.source.key)).filter(
        (event) => event.kind === 'branch-abandoned',
      ),
    ).toEqual([])
    expect((await bob.control.load()).recoveryEpochFloor).toBe(record.target.groupInfoEpoch)
  },
)
