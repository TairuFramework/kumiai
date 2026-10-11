import { describe, expect, test } from 'vitest'

import { commitTopic } from '../src/topic.js'
import { publishCommit } from './fixtures/commits.js'
import { FakeHub } from './fixtures/fake-hub.js'
import {
  buildInviteCommit,
  buildLedgerCommit,
  buildRemoveCommit,
  makeMLSPeer,
} from './fixtures/peer.js'

const secret = new Uint8Array(32).fill(0x35)

describe('operation replay', () => {
  test.each(['ledger', 'invite', 'remove'] as const)(
    'a saved %s intent survives its builder process and retries against the winner',
    async (kind) => {
      const hub = new FakeHub()
      const seed = makeMLSPeer(hub, 'alice', secret, { members: ['alice', 'mallory'] })
      await seed.peer.resync()
      const request =
        kind === 'ledger'
          ? buildLedgerCommit(seed, ['role=admin'])
          : kind === 'invite'
            ? buildInviteCommit(seed, 'dave')
            : buildRemoveCommit(seed, 'mallory')
      seed.database.seam('after-apply', () => {
        void seed.peer.dispose()
      })
      await seed.peer.enqueue(request).catch(() => {})
      await seed.peer.dispose()
      await seed.peer.drained()
      await publishCommit({ hub, senderDID: 'zoe', recoverySecret: secret, epoch: 1 })
      const restarted = makeMLSPeer(hub, 'alice', secret, { restartOf: seed })
      await expect
        .poll(async () => (await restarted.peer.outcomes()).map((row) => row.kind))
        .toEqual(['landed'])
      expect(restarted.mls.epoch()).toBe(3)
      if (kind === 'invite') expect(restarted.mls.leaves()).toContain('dave')
      if (kind === 'remove') expect(restarted.mls.leaves()).not.toContain('mallory')
      await restarted.peer.dispose()
    },
  )

  test('an unknown publish retains its exact payload until a later retry', async () => {
    const hub = new FakeHub()
    const publish = hub.publish.bind(hub)
    let fail = true
    hub.publish = async (params) => {
      if (params.topicID === commitTopic(secret) && fail) throw new Error('Offline')
      return publish(params)
    }
    const seed = makeMLSPeer(hub, 'alice', secret)
    const request = buildLedgerCommit(seed, ['role=admin'])
    await seed.peer.enqueue(request).catch(() => {})
    await expect.poll(async () => (await seed.control.load()).operations[0]?.stage).toBe('built')
    const builtSnapshot = await seed.control.load()
    const built = builtSnapshot.operations[0]
    await seed.peer.dispose()
    await seed.peer.drained()
    fail = false
    const restarted = makeMLSPeer(hub, 'alice', secret, { restartOf: seed })
    await expect.poll(async () => (await restarted.peer.outcomes()).length).toBe(1)
    if (built?.stage !== 'built') throw new Error('Expected saved build')
    expect(hub.published.find((row) => row.topicID === commitTopic(secret))?.payload).toEqual(
      builtSnapshot.commitOnce?.payload,
    )
    await restarted.peer.dispose()
  })

  test('a target already in the wanted state is rejected instead of enacted twice', async () => {
    const member = makeMLSPeer(new FakeHub(), 'alice', secret, { members: ['alice', 'dave'] })
    const request = buildInviteCommit(member, 'dave')
    await member.peer.enqueue(request)
    await expect.poll(async () => (await member.peer.outcomes())[0]?.kind).toBe('rejected')
    expect(member.mls.epoch()).toBe(1)
    await member.peer.dispose()
  })
})
