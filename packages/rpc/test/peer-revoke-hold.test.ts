import { expect, test, vi } from 'vitest'

import { OperationOutcomeError, OperationRejectedError } from '../src/errors.js'
import { commitTopic } from '../src/topic.js'
import { FakeHub } from './fixtures/fake-hub.js'
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
  await expect(
    member.peer.commit(
      buildLedgerCommit(member, [], {
        revokes: true,
        onBuild: () => {
          throw new OperationRejectedError('Cannot build')
        },
      }),
    ),
  ).rejects.toBeInstanceOf(OperationOutcomeError)
  expect((await member.control.load()).operations).toEqual([])
  await member.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'released' } })
  await vi.waitFor(() => expect(apps(hub)).toHaveLength(1))
  await close(member)
})
