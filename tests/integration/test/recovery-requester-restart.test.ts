import type { OwnIdentity } from '@kokuin/token'
import type { GroupHandle } from '@kumiai/mls'
import type { LedgerEntrySlot } from '@kumiai/mls-rpc'
import { commitTopic } from '@kumiai/rpc'
import { afterEach, expect, test, vi } from 'vitest'

import { type Member, makeMember, restoreMemberHandle } from './app-lane-e2e.js'
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
    const recovery = { timeoutMs: 100, deadlineMs: 2000, getDelayMs: () => 0 }
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
    if (record != null && 'format' in record) throw new Error('Expected legacy rejoin')
    expect(record?.stage).toBe(stage)
    vi.mocked(bob.control.apply).mockRestore()
    const restored = await restoreMemberHandle(bob, bob.entrySlot)
    expect(Number(restored.epoch)).toBe(
      stage === 'adopted' ? record?.epochAfter : record?.source.epoch,
    )
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
