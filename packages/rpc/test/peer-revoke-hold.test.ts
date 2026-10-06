import type { HubPublishParams } from '@kumiai/hub-tunnel'
import { expect, test, vi } from 'vitest'

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

test('hold starts while queued, covers build and resumes ordered log sends after adoption', async () => {
  const hub = new FakeHub()
  const member = makeMLSPeer(hub, 'alice', secret)
  const pause = gate()
  let entered = false
  const earlier = member.peer.commit(
    buildLedgerCommit(member, ['earlier'], {
      onBuild: async () => {
        entered = true
        await pause.promise
      },
    }),
  )
  await vi.waitFor(() => expect(entered).toBe(true))
  const fetched = vi.spyOn(hub, 'fetchTopic')
  const seals = vi.spyOn(member.crypto, 'wrap')
  const held = member.peer.commit(buildLedgerCommit(member, ['proof']), { holdLogSends: true })
  try {
    await member.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'first' } })
    await member.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'second' } })
    await vi.waitFor(() => expect(fetched).toHaveBeenCalled())
    expect(seals).not.toHaveBeenCalled()
    expect(apps(hub)).toHaveLength(0)
    pause.release()
    await earlier
    await held
    await vi.waitFor(() => expect(apps(hub)).toHaveLength(2))
    expect(
      hub.published.filter((frame) => frame.logPosition != null).map((frame) => frame.topicID),
    ).toEqual([topic, topic, apps(hub)[0]?.topicID, apps(hub)[1]?.topicID])
  } finally {
    pause.release()
    await earlier.catch(() => {})
    await held.catch(() => {})
    await close(member)
  }
})

test('a prepared attempt whose durable write finishes during a hold is resealed after landing', async () => {
  const hub = new FakeHub()
  const member = makeMLSPeer(hub, 'alice', secret)
  await member.peer.replay()
  const putPause = gate()
  const buildPause = gate()
  let putEntered = false
  let buildEntered = false
  const put = member.appOutbox.put
  member.appOutbox.put = async (entry) => {
    if (entry.lastAttempt != null && !putEntered) {
      putEntered = true
      await putPause.promise
    }
    await put(entry)
  }
  await member.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'queued' } })
  await vi.waitFor(() => expect(putEntered).toBe(true))
  const operation = member.peer.commit(
    buildLedgerCommit(member, ['proof'], {
      onBuild: async () => {
        buildEntered = true
        await buildPause.promise
      },
    }),
    { holdLogSends: true },
  )
  try {
    await vi.waitFor(() => expect(buildEntered).toBe(true))
    putPause.release()
    await vi.waitFor(async () =>
      expect((await member.appOutbox.list())[0]?.lastAttempt).not.toBeNull(),
    )
    expect(apps(hub)).toHaveLength(0)
    buildPause.release()
    await operation
    await vi.waitFor(() => expect(apps(hub)).toHaveLength(1))
    const published = apps(hub)[0]
    if (published == null) throw new Error('No log publication')
    expect(member.crypto.frameEpoch(published.payload)).toBe(2)
  } finally {
    putPause.release()
    buildPause.release()
    await operation.catch(() => {})
    await close(member)
  }
})

test('a submitted log publish settles before a held commit is journalled', async () => {
  const hub = new FakeHub()
  const pause = gate()
  const publish = hub.publish.bind(hub)
  let submitted = false
  hub.publish = async (params: HubPublishParams) => {
    if (params.topicID !== topic && params.retain === 'log') {
      submitted = true
      await pause.promise
    }
    return publish(params)
  }
  const member = makeMLSPeer(hub, 'alice', secret)
  await member.peer.replay()
  await member.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'in flight' } })
  await vi.waitFor(() => expect(submitted).toBe(true))
  let built = false
  const operation = member.peer.commit(
    buildLedgerCommit(member, ['proof'], {
      onBuild: () => {
        built = true
      },
    }),
    { holdLogSends: true },
  )
  try {
    await vi.waitFor(() => expect(built).toBe(true))
    expect(member.journal.puts()).toBe(0)
    expect(hub.published.filter((frame) => frame.topicID === topic)).toHaveLength(0)
    pause.release()
    await operation
    expect(
      hub.published.filter((frame) => frame.logPosition != null).map((frame) => frame.topicID),
    ).toEqual([apps(hub)[0]?.topicID, topic])
  } finally {
    pause.release()
    await operation.catch(() => {})
    await close(member)
  }
})

test('unknown publication keeps the journal hold across restart until replay adopts', async () => {
  const hub = new FakeHub()
  const publish = hub.publish.bind(hub)
  let fail = true
  hub.publish = async (params) => {
    if (params.topicID === topic && fail) throw new Error('disconnected')
    return publish(params)
  }
  const member = makeMLSPeer(hub, 'alice', secret)
  await expect(
    member.peer.commit(buildLedgerCommit(member, ['proof']), { holdLogSends: true }),
  ).rejects.toThrow('disconnected')
  expect(member.journal.slot()?.holdsLogSends).toBe(true)
  await member.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'restart' } })
  await close(member)
  const replacement = makeMLSPeer(hub, 'alice', secret, { restartOf: member })
  try {
    await replacement.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'second' } })
    expect(apps(hub)).toHaveLength(0)
    fail = false
    await replacement.peer.replay()
    await vi.waitFor(() => expect(apps(hub)).toHaveLength(2))
    expect(hub.published.filter((frame) => frame.logPosition != null)[0]?.topicID).toBe(topic)
    expect(replacement.journal.slot()).toBeNull()
  } finally {
    await close(replacement)
  }
})

test('a pre-journal build failure releases the hold', async () => {
  const hub = new FakeHub()
  const member = makeMLSPeer(hub, 'alice', secret)
  try {
    await expect(
      member.peer.commit(
        async () => {
          throw new Error('cannot build')
        },
        { holdLogSends: true },
      ),
    ).rejects.toThrow('cannot build')
    expect(member.journal.slot()).toBeNull()
    await member.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'released' } })
    await vi.waitFor(() => expect(apps(hub)).toHaveLength(1))
  } finally {
    await close(member)
  }
})

test('a journalled hold known unlanded releases sends after replay reports the loss', async () => {
  const hub = new FakeHub()
  const member = makeMLSPeer(hub, 'alice', secret)
  await member.peer.replay()
  const pending = await buildLedgerCommit(member, ['proof'])()
  await member.journal.put({
    publishID: 'lost-proof',
    expectedHead: 'not-the-head',
    epoch: 1,
    holdsLogSends: true,
    commit: pending.commit,
    bodies: pending.bodies,
    kind: pending.kind,
    journal: pending.journal,
  })
  try {
    await member.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'released' } })
    expect((await member.peer.replay()).lost).toMatchObject({ kind: 'ledger', tokens: ['proof'] })
    await vi.waitFor(() => expect(apps(hub)).toHaveLength(1))
    expect(member.journal.slot()).toBeNull()
  } finally {
    await close(member)
  }
})
