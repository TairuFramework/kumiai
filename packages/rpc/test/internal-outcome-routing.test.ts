import { afterEach, expect, test, vi } from 'vitest'

import type { Outcome } from '../src/control/types.js'
import { commitTopic } from '../src/topic.js'
import { FakeHub } from './fixtures/fake-hub.js'
import {
  buildLedgerCommit,
  makeMLSPeer,
  seedBuiltOperation,
  type TestPeer,
} from './fixtures/peer.js'

const peers: Array<TestPeer> = []
const secret = new Uint8Array(32).fill(0x71)
afterEach(async () => {
  for (const member of peers.splice(0)) {
    await member.peer.dispose()
    await member.peer.drained()
  }
  vi.restoreAllMocks()
})

test('restart routes outcomes by operation ID and hides internal rows from public readers', async () => {
  const hub = new FakeHub()
  const seed = makeMLSPeer(hub, 'alice', secret)
  peers.push(seed)
  await seed.peer.replay()
  await seed.peer.dispose()
  await seed.peer.drained()
  const internal: Outcome = {
    id: 'fresh-final-outcome',
    opID: 'kumiai/internal/rotation-1',
    kind: 'unknown',
    at: 100,
  }
  const publicOutcome: Outcome = {
    id: 'kumiai/internal/public-outcome-id',
    opID: 'host-invite',
    kind: 'lost',
    at: 101,
  }
  const recovery: Outcome = {
    id: 'kumiai/internal/recovery-outcome-id',
    opID: null,
    kind: 'reenact',
    tokens: ['public-recovery-entry'],
    at: 102,
  }
  await seed.control.apply(
    { putOutcomes: [internal, publicOutcome, recovery] },
    'persisted-outcomes',
  )
  const onOutcome = vi.fn()
  const onInternalOutcome = vi.fn()
  const member = makeMLSPeer(hub, 'alice', secret, {
    restartOf: seed,
    onOutcome,
    onInternalOutcome,
  })
  peers.push(member)
  expect(await member.peer.replay()).toEqual({})
  await member.peer.replay()
  expect(onInternalOutcome).toHaveBeenCalledExactlyOnceWith(internal)
  expect(onOutcome.mock.calls.map(([outcome]) => outcome)).toEqual([publicOutcome, recovery])
  expect(await member.peer.outcomes()).toEqual([publicOutcome, recovery])
  expect((await member.control.load()).outcomes).toEqual([internal, publicOutcome, recovery])
})

test('clock and final reports for an internal build go only to the internal callback', async () => {
  const hub = new FakeHub()
  const onOutcome = vi.fn()
  const onInternalOutcome = vi.fn()
  const member = makeMLSPeer(hub, 'alice', secret, { onOutcome, onInternalOutcome })
  peers.push(member)
  await member.peer.replay()
  const request = {
    ...buildLedgerCommit(member, []),
    id: 'kumiai/internal/rotation-2',
  }
  const saved = await seedBuiltOperation(member, request)
  vi.spyOn(Date, 'now').mockReturnValue(saved.slot.deadline)
  await member.controlWalk.stepOperation(saved.id)
  const provisional = (await member.control.load()).outcomes[0]
  expect(provisional).toMatchObject({ opID: request.id, kind: 'unknown' })
  await vi.waitFor(() => expect(onInternalOutcome).toHaveBeenCalledExactlyOnceWith(provisional))
  expect(onOutcome).not.toHaveBeenCalled()
  expect(await member.peer.outcomes()).toEqual([])
  await hub.publish({
    senderDID: 'alice',
    topicID: commitTopic(secret),
    payload: saved.slot.payload,
    publishID: saved.slot.publishID,
    retain: 'log',
  })
  await member.peer.replay()
  const final = (await member.control.load()).outcomes[0]
  expect(final).toMatchObject({ opID: request.id, kind: 'landed' })
  expect(final?.id).not.toBe(provisional?.id)
  await vi.waitFor(() =>
    expect(onInternalOutcome.mock.calls.map(([outcome]) => outcome)).toEqual([provisional, final]),
  )
  expect(onOutcome).not.toHaveBeenCalled()
  expect(await member.peer.outcomes()).toEqual([])
})

test('an unbound internal callback waits until the serial refresh finishes', async () => {
  const onInternalOutcome = vi.fn()
  const member = makeMLSPeer(new FakeHub(), 'alice', secret, { onInternalOutcome })
  peers.push(member)
  await member.peer.replay()
  await member.control.apply(
    {
      putOutcomes: [
        { id: 'deferred-report', opID: 'kumiai/internal/deferred', kind: 'lost', at: 100 },
      ],
    },
    'save-deferred',
  )
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const read = member.mls.readEpoch.bind(member.mls)
  const readEpoch = vi.spyOn(member.mls, 'readEpoch').mockImplementation(async () => {
    await gate
    return read()
  })
  const replay = member.peer.replay()
  try {
    await vi.waitFor(() => expect(readEpoch).toHaveBeenCalled())
    expect(onInternalOutcome).not.toHaveBeenCalled()
  } finally {
    release()
    await replay
  }
  await vi.waitFor(() => expect(onInternalOutcome).toHaveBeenCalledOnce())
})

test('an absent internal callback keeps the durable report hidden until a later owner handles it', async () => {
  const hub = new FakeHub()
  const onOutcome = vi.fn()
  const member = makeMLSPeer(hub, 'alice', secret, { onOutcome })
  peers.push(member)
  await member.peer.replay()
  const internal: Outcome = {
    id: 'unhandled-final-outcome',
    opID: 'kumiai/internal/rotation-3',
    kind: 'unknown',
    at: 100,
  }
  await member.control.apply({ putOutcomes: [internal] }, 'unhandled-internal-outcome')
  await member.peer.replay()
  expect(onOutcome).not.toHaveBeenCalled()
  expect(await member.peer.outcomes()).toEqual([])
  expect((await member.control.load()).outcomes).toEqual([internal])
  await member.peer.dispose()
  await member.peer.drained()
  const onInternalOutcome = vi.fn()
  const again = makeMLSPeer(hub, 'alice', secret, {
    restartOf: member,
    onOutcome,
    onInternalOutcome,
  })
  peers.push(again)
  await again.peer.replay()
  expect(onInternalOutcome).toHaveBeenCalledExactlyOnceWith(internal)
  expect(onOutcome).not.toHaveBeenCalled()
  await again.peer.ack(internal.id)
  expect((await again.control.load()).outcomes).toEqual([])
})

test.each(['enqueue', 'commit'] as const)(
  'public %s rejects the reserved internal namespace before persisting an intent',
  async (method) => {
    const hub = new FakeHub()
    const member = makeMLSPeer(hub, 'alice', secret)
    peers.push(member)
    await member.peer.replay()
    const before = await member.control.load()
    const request = {
      ...buildLedgerCommit(member, []),
      id: 'kumiai/internal/host-spoof',
    }
    await expect(member.peer[method](request)).rejects.toMatchObject({
      name: 'TypeError',
    })
    expect(await member.control.load()).toEqual(before)
    expect(hub.published).toEqual([])
  },
)
