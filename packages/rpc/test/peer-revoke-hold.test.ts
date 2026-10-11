import { setImmediate } from 'node:timers/promises'
import { expect, test, vi } from 'vitest'

import { revokeHeld } from '../src/control/operations.js'
import { OperationOutcomeError, OperationRejectedError } from '../src/errors.js'
import { commitTopic } from '../src/topic.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryHostDatabase } from './fixtures/host-db.js'
import { buildLedgerCommit, makeMLSPeer, type TestPeer } from './fixtures/peer.js'

function gate() {
  let release = () => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
const secret = new Uint8Array(32).fill(0x79)
const topic = commitTopic(secret)
const apps = (hub: FakeHub) =>
  hub.published.filter((frame) => frame.topicID !== topic && frame.logPosition != null)
async function close(member: TestPeer) {
  await member.peer.dispose()
  await member.peer.drained()
}

test('the revoke hold derives from unsettled operations, not retained outcomes', async () => {
  const database = createMemoryHostDatabase()
  const control = database.control('alice')
  const ordinary = {
    id: crypto.randomUUID(),
    kind: 'ledger' as const,
    revokes: false,
    body: new Uint8Array([1]),
    seq: 1,
    enqueuedAt: Date.now(),
    deadline: Date.now() + 30_000,
    stage: 'intent' as const,
  }
  const revoke = { ...ordinary, id: crypto.randomUUID(), seq: 2, revokes: true }
  await control.apply({ putOperations: [ordinary] }, crypto.randomUUID())
  expect(revokeHeld(await control.load())).toBe(false)
  await control.apply({ putOperations: [revoke] }, crypto.randomUUID())
  expect(revokeHeld(await control.load())).toBe(true)
  await control.apply(
    {
      deleteOperations: [revoke.id],
      putOutcomes: [
        { id: revoke.id, opID: revoke.id, at: Date.now(), kind: 'rejected', reason: 'Refused' },
      ],
    },
    crypto.randomUUID(),
  )
  expect(revokeHeld(await control.load())).toBe(false)
})

test('a durable revoke holds sends before its enqueue storage call returns', async () => {
  const hub = new FakeHub()
  const member = makeMLSPeer(hub, 'alice', secret)
  const pause = gate()
  let persisted = false
  await member.peer.outcomes()
  member.database.seam('after-apply', async () => {
    persisted = true
    await pause.promise
  })
  const enqueued = member.peer.enqueue(buildLedgerCommit(member, ['proof'], { revokes: true }))
  try {
    await vi.waitFor(() => expect(persisted).toBe(true))
    expect((await member.control.load()).operations.some((op) => op.revokes)).toBe(true)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await member.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'held' } })
    await vi.advanceTimersByTimeAsync(20)
    expect(apps(hub)).toEqual([])
  } finally {
    vi.useRealTimers()
    pause.release()
    await enqueued
    await close(member)
  }
})

test('a failed revoke enqueue releases the hold when no intent was persisted', async () => {
  const hub = new FakeHub()
  const member = makeMLSPeer(hub, 'alice', secret)
  try {
    await member.peer.outcomes()
    member.database.failNext('mid-apply')
    await expect(
      member.peer.enqueue(buildLedgerCommit(member, ['proof'], { revokes: true })),
    ).rejects.toThrow('Injected transaction failure')
    expect((await member.control.load()).operations).toEqual([])
    await member.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'released' } })
    await vi.waitFor(() => expect(apps(hub)).toHaveLength(1))
  } finally {
    await close(member)
  }
})

test('a delayed empty snapshot cannot release a newer revoke hold', async () => {
  const hub = new FakeHub()
  const database = createMemoryHostDatabase()
  const control = database.control('alice')
  const load = control.load.bind(control)
  const snapshotPause = gate()
  const buildPause = gate()
  let delayNext = false
  let snapshotHeld = false
  let building = false
  control.load = async () => {
    const snapshot = await load()
    if (delayNext) {
      delayNext = false
      snapshotHeld = true
      await snapshotPause.promise
    }
    return snapshot
  }
  const member = makeMLSPeer(hub, 'alice', secret, {
    database,
    control,
    onOutcome: () => {
      delayNext = true
    },
  })
  try {
    await member.peer.commit(buildLedgerCommit(member, ['first']))
    await vi.waitFor(() => expect(snapshotHeld).toBe(true))
    const enqueued = member.peer.enqueue(
      buildLedgerCommit(member, ['revoke'], {
        revokes: true,
        onBuild: async () => {
          building = true
          await buildPause.promise
        },
      }),
    )
    await setImmediate()
    snapshotPause.release()
    await enqueued
    await vi.waitFor(() => expect(building).toBe(true))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await member.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'held' } })
    await vi.advanceTimersByTimeAsync(20)
    expect((await load()).operations.some((op) => op.revokes)).toBe(true)
    expect(apps(hub)).toEqual([])
  } finally {
    vi.useRealTimers()
    delayNext = false
    snapshotPause.release()
    buildPause.release()
    await close(member)
  }
})

test('durable revoke holds log sends through build and releases after adoption', async () => {
  const hub = new FakeHub()
  const member = makeMLSPeer(hub, 'alice', secret)
  const pause = gate()
  let entered = false
  const request = buildLedgerCommit(member, ['proof'], {
    revokes: true,
    onBuild: async () => {
      entered = true
      await pause.promise
    },
  })
  const committed = member.peer.commit(request)
  await vi.waitFor(() => expect(entered).toBe(true))
  await member.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'held' } })
  expect(apps(hub)).toEqual([])
  pause.release()
  await committed
  await vi.waitFor(() => expect(apps(hub)).toHaveLength(1))
  const firstApp = apps(hub)[0]
  if (firstApp == null) throw new Error('Missing released app frame')
  expect(member.crypto.frameEpoch(firstApp.payload)).toBe(2)
  await close(member)
})

test('one settled revoke does not lift another queued revoke', async () => {
  const hub = new FakeHub()
  const member = makeMLSPeer(hub, 'alice', secret)
  const pause = gate()
  const first = buildLedgerCommit(member, ['first'], { revokes: true })
  const second = buildLedgerCommit(member, ['second'], {
    revokes: true,
    onBuild: async () => pause.promise,
  })
  await member.peer.enqueue(first)
  await member.peer.enqueue(second)
  await member.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'held' } })
  await vi.waitFor(async () => expect((await member.peer.outcomes()).length).toBe(1))
  expect(apps(hub)).toEqual([])
  pause.release()
  await vi.waitFor(async () => expect((await member.peer.outcomes()).length).toBe(2))
  await vi.waitFor(() => expect(apps(hub)).toHaveLength(1))
  await close(member)
})

test('a submitted log publish settles before the revoke is published', async () => {
  const hub = new FakeHub()
  const pause = gate()
  const publish = hub.publish.bind(hub)
  let submitted = false
  hub.publish = async (params) => {
    if (params.topicID !== topic && params.retain === 'log') {
      submitted = true
      await pause.promise
    }
    return publish(params)
  }
  const member = makeMLSPeer(hub, 'alice', secret)
  await member.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'in flight' } })
  await vi.waitFor(() => expect(submitted).toBe(true))
  let built = false
  const operation = member.peer.commit(
    buildLedgerCommit(member, ['proof'], {
      revokes: true,
      onBuild: () => {
        built = true
      },
    }),
  )
  await vi.waitFor(() => expect(built).toBe(true))
  expect(hub.published.filter((row) => row.topicID === topic)).toEqual([])
  pause.release()
  await operation
  expect(hub.published.filter((row) => row.logPosition != null).map((row) => row.topicID)).toEqual([
    apps(hub)[0]?.topicID,
    topic,
  ])
  await close(member)
})

test('unknown publication restores the hold before startup delivery', async () => {
  const hub = new FakeHub()
  const publish = hub.publish.bind(hub)
  let fail = true
  hub.publish = async (params) => {
    if (params.topicID === topic && fail) throw new Error('Offline')
    return publish(params)
  }
  const member = makeMLSPeer(hub, 'alice', secret)
  await member.peer.enqueue(buildLedgerCommit(member, ['proof'], { revokes: true }))
  await vi.waitFor(async () =>
    expect((await member.control.load()).operations[0]?.stage).toBe('built'),
  )
  await member.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'restart' } })
  await close(member)
  const replacement = makeMLSPeer(hub, 'alice', secret, { restartOf: member })
  await replacement.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'second' } })
  expect(apps(hub)).toEqual([])
  fail = false
  await replacement.peer.replay()
  await vi.waitFor(() => expect(apps(hub)).toHaveLength(2))
  expect(hub.published.filter((row) => row.logPosition != null)[0]?.topicID).toBe(topic)
  await close(replacement)
})

test('a rejected build settles the revoke and releases sends', async () => {
  const hub = new FakeHub()
  const member = makeMLSPeer(hub, 'alice', secret)
  const pause = gate()
  let building = false
  const rejected = expect(
    member.peer.commit(
      buildLedgerCommit(member, [], {
        revokes: true,
        onBuild: async () => {
          building = true
          await pause.promise
          throw new OperationRejectedError('Cannot build')
        },
      }),
    ),
  ).rejects.toBeInstanceOf(OperationOutcomeError)
  try {
    await vi.waitFor(() => expect(building).toBe(true))
    await member.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'held' } })
    expect(apps(hub)).toEqual([])
    pause.release()
    await rejected
    const snapshot = await member.control.load()
    expect(snapshot.operations).toEqual([])
    expect(snapshot.outcomes[0]?.kind).toBe('rejected')
    await vi.waitFor(() => expect(apps(hub)).toHaveLength(1))
    const released = apps(hub)[0]
    if (released == null) throw new Error('Missing released app frame')
    expect(member.crypto.frameEpoch(released.payload)).toBe(1)
  } finally {
    pause.release()
    await rejected
    await close(member)
  }
})
