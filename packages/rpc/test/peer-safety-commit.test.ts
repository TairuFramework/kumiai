import { afterEach, expect, test, vi } from 'vitest'

import * as appLaneModule from '../src/app-lane.js'
import { GroupSafetyHeldError } from '../src/errors.js'
import { encodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import { commitTopic } from '../src/topic.js'
import { publishCommit } from './fixtures/commits.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { memoryEntryID } from './fixtures/memory-group-mls.js'
import { latchPeerSafety, makeMLSPeer, rollBackForkHalt, type TestPeer } from './fixtures/peer.js'

const secret = new Uint8Array(32).fill(49)
const peers: Array<TestPeer> = []
afterEach(async () => {
  for (const member of peers.splice(0)) {
    await member.peer.dispose()
    await member.peer.drained()
  }
  vi.restoreAllMocks()
})
async function fixture() {
  const hub = new FakeHub()
  const member = makeMLSPeer(hub, 'bob', secret)
  peers.push(member)
  await member.peer.replay()
  return { hub, member }
}
async function append(hub: FakeHub) {
  return publishCommit({
    hub,
    senderDID: 'alice',
    recoverySecret: secret,
    epoch: 1,
    entries: ['role:carol=admin'],
    adds: ['carol'],
  })
}
function observe(member: TestPeer) {
  return {
    header: vi.spyOn(member.mls, 'readCommitHeader'),
    process: vi.spyOn(member.mls, 'processCommit'),
    open: vi.spyOn(member.crypto, 'openEntries'),
    anchor: vi.spyOn(member.anchorStore, 'save'),
    exportSecret: vi.spyOn(member.crypto, 'exportSecret'),
  }
}

test.each(
  (['fork-halted', 'recovery-unavailable'] as const).flatMap((reason) =>
    (['commit', 'unsupported'] as const).map((frame) => [reason, frame] as const),
  ),
)('commit fetch continuation obeys volatile latch (%s, %s)', async (reason, frame) => {
  const { hub, member } = await fixture()
  const before = await member.control.load()
  const head = member.controlWalk.head()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const fetch = hub.fetchTopic.bind(hub)
  vi.spyOn(hub, 'fetchTopic').mockImplementation(async (params) => {
    const page = await fetch(params)
    if (params.topicID === commitTopic(secret) && page.messages.length > 0) {
      entered.resolve()
      await release.promise
    }
    return page
  })
  if (frame === 'commit') await append(hub)
  else
    await hub.publish({
      senderDID: 'alice',
      topicID: commitTopic(secret),
      retain: 'log',
      payload: encodeHandshakeFrame(HANDSHAKE_KIND.commit, new Uint8Array([255, 0, 0, 0, 0])),
    })
  await entered.promise
  const calls = observe(member)
  const epoch = vi.spyOn(member.mls, 'readEpoch')
  const halt = reason === 'fork-halted' ? await rollBackForkHalt(member) : undefined
  if (reason === 'recovery-unavailable') latchPeerSafety(member, reason)
  release.resolve()
  await member.peer.replay()
  expect(epoch).not.toHaveBeenCalled()
  for (const call of Object.values(calls)) expect(call).not.toHaveBeenCalled()
  expect((await member.control.load()).cursor).toEqual(before.cursor)
  expect((await member.control.load()).strand).toBeNull()
  expect((await member.control.load()).applied).toEqual(before.applied)
  expect(member.controlWalk.head()).toBe(head)
  await member.peer.dispose()
  await halt?.settled
})

test.each(
  (['fork-halted', 'recovery-unavailable'] as const).flatMap((reason) =>
    (['drain', 'roster'] as const).map((boundary) => [reason, boundary] as const),
  ),
)(
  'pre-adoption drain and roster continuations obey volatile latch (%s, %s)',
  async (reason, boundary) => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let armed = false
    if (boundary === 'drain') {
      const create = appLaneModule.createAppLane
      vi.spyOn(appLaneModule, 'createAppLane').mockImplementation((params) => {
        const lane = create(params)
        const deliver = lane.deliver
        lane.deliver = async (...args) => {
          await deliver(...args)
          if (armed) {
            entered.resolve()
            await release.promise
          }
        }
        return lane
      })
    }
    const { hub, member } = await fixture()
    if (boundary === 'roster') {
      const roster = member.mls.rosterEntries.bind(member.mls)
      vi.spyOn(member.mls, 'rosterEntries').mockImplementation(async () => {
        const result = await roster()
        if (armed) {
          entered.resolve()
          await release.promise
        }
        return result
      })
    }
    const before = await member.control.load()
    const head = member.controlWalk.head()
    armed = true
    await append(hub)
    await entered.promise
    const calls = observe(member)
    const epoch = vi.spyOn(member.mls, 'readEpoch')
    const halt = reason === 'fork-halted' ? await rollBackForkHalt(member) : undefined
    if (reason === 'recovery-unavailable') latchPeerSafety(member, reason)
    release.resolve()
    await member.peer.replay()
    expect(epoch).not.toHaveBeenCalled()
    expect(calls.process).not.toHaveBeenCalled()
    expect(calls.open).not.toHaveBeenCalled()
    expect(calls.anchor).not.toHaveBeenCalled()
    expect(calls.exportSecret).not.toHaveBeenCalled()
    const after = await member.control.load()
    expect(after.cursor).toEqual(before.cursor)
    expect(after.strand).toBeNull()
    expect(after.applied).toEqual(before.applied)
    expect(member.controlWalk.head()).toBe(head)
    await member.peer.dispose()
    await halt?.settled
  },
)

test.each([false, true])(
  'in-flight commit persists clean cursor after latch (real strand=%s)',
  async (realStrand) => {
    const { hub, member } = await fixture()
    if (realStrand) {
      await member.control.apply(
        { strand: { reason: 'ahead' }, cursor: { position: null, epoch: 1, stranded: true } },
        'real-strand',
      )
      await member.peer.replay()
    }
    const before = await member.control.load()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    // Observe persistence preparation without provider safety gates or changing the atomic save.
    const process = member.mls.processCommit.bind(member.mls)
    vi.spyOn(member.mls, 'processCommit').mockImplementation(async (commit, context) => {
      const entries = await context.resolveLedgerEntries?.([memoryEntryID('role:carol=admin')])
      entered.resolve()
      await release.promise
      return process(commit, { ...context, resolveLedgerEntries: async () => entries ?? [] })
    })
    await append(hub)
    await entered.promise
    const halt = await rollBackForkHalt(member)
    release.resolve()
    await member.peer.replay()
    const after = await member.control.load()
    if (realStrand) {
      expect(after.cursor?.stranded).toBe(true)
      expect(after.strand).toEqual(before.strand)
    } else {
      expect(after.cursor).not.toHaveProperty('stranded')
      expect(after.cursor).toMatchObject({ epoch: 2, position: '000000000001' })
      expect(after.strand).toBeNull()
    }
    expect(after.applied).toHaveLength(1)
    expect(member.mls.epoch()).toBe(2)
    await expect(member.mls.getLedger()).resolves.toEqual(['role:carol=admin'])
    await member.peer.dispose()
    await halt?.settled
  },
)

test.each(['fork-halted', 'recovery-unavailable'] as const)(
  'commit resolver safety refusal stays held (%s)',
  async (reason) => {
    const { hub, member } = await fixture()
    const before = await member.control.load()
    const head = member.controlWalk.head()
    const open = vi
      .spyOn(member.crypto, 'openEntries')
      .mockRejectedValue(new GroupSafetyHeldError(reason))
    await append(hub)
    await vi.waitFor(() => expect(member.controlWalk.safetyHold()).toBe(reason))
    const after = await member.control.load()
    expect(after.cursor).toEqual(before.cursor)
    expect(after.strand).toBeNull()
    expect(after.applied).toEqual([])
    expect(member.controlWalk.head()).toBe(head)
    const fetch = vi.spyOn(hub, 'fetchTopic')
    open.mockClear()
    await member.peer.replay()
    expect(fetch).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  },
)

test.each(['fork-halted', 'recovery-unavailable'] as const)(
  'header safety refusal retains the incoming commit (%s)',
  async (reason) => {
    const { hub, member } = await fixture()
    const before = await member.control.load()
    vi.spyOn(member.mls, 'readCommitHeader').mockRejectedValue(new GroupSafetyHeldError(reason))
    await append(hub)
    await vi.waitFor(() => expect(member.controlWalk.safetyHold()).toBe(reason))
    expect((await member.control.load()).cursor).toEqual(before.cursor)
    expect((await member.control.load()).strand).toBeNull()
  },
)

test.each(['fork-halted', 'recovery-unavailable'] as const)(
  'advance error continuation safety refusal stays held (%s)',
  async (reason) => {
    const { hub, member } = await fixture()
    const before = await member.control.load()
    let failed = false
    const process = member.mls.processCommit.bind(member.mls)
    vi.spyOn(member.mls, 'processCommit').mockImplementation(async (...args) => {
      try {
        return await process(...args)
      } catch (error) {
        failed = true
        throw error
      }
    })
    vi.spyOn(member.crypto, 'openEntries').mockRejectedValue(new Error('resolver unavailable'))
    const read = member.mls.readEpoch.bind(member.mls)
    vi.spyOn(member.mls, 'readEpoch').mockImplementation(() => {
      if (failed) return Promise.reject(new GroupSafetyHeldError(reason))
      return read()
    })
    await append(hub)
    await vi.waitFor(() => expect(member.controlWalk.safetyHold()).toBe(reason))
    const after = await member.control.load()
    expect(after.strand).toBeNull()
    expect(after.cursor).toEqual(before.cursor)
    expect(after.applied).toEqual([])
    const fetch = vi.spyOn(hub, 'fetchTopic')
    await member.peer.replay()
    expect(fetch).not.toHaveBeenCalled()
  },
)
