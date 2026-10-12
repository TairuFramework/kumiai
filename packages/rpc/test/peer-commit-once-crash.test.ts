import { expect, test } from 'vitest'

import { commitTopic, rendezvousTopic } from '../src/topic.js'
import { FakeHub } from './fixtures/fake-hub.js'
import {
  buildInviteCommit,
  makeMLSPeer,
  reconstructMemoryPeer,
  seedBuiltOperation,
} from './fixtures/peer.js'

const secret = new Uint8Array(32).fill(0x63)

test('restart after remote acceptance searches before own walk', async () => {
  const hub = new FakeHub()
  const original = makeMLSPeer(hub, 'alice', secret)
  await original.peer.resync()
  await original.peer.dispose()
  await original.peer.drained()
  const operation = await seedBuiltOperation(original, buildInviteCommit(original, 'bob'))
  await hub.publish({
    senderDID: 'alice',
    topicID: commitTopic(secret),
    payload: operation.slot.payload,
    publishID: operation.slot.publishID,
    retain: 'log',
    expectedHead: null,
  })
  const restarted = await reconstructMemoryPeer(hub, 'alice', secret, original.database)
  try {
    await restarted.peer.replay()
    const saved = await restarted.control.load()
    expect(restarted.mls.epoch()).toBe(2)
    expect(saved.commitOnce).toBeNull()
    expect(saved.operations).toEqual([])
    expect(saved.applied).toEqual([
      expect.objectContaining({ payloadDigest: operation.slot.payloadDigest, opID: operation.id }),
    ])
    expect(saved.cursor).toEqual({ position: hub.published[0]?.sequenceID, epoch: 2 })
    expect(saved.outcomes).toEqual([
      expect.objectContaining({ kind: 'landed', opID: operation.id }),
    ])
    expect(restarted.welcomes).toEqual([operation.id])
    expect(hub.published.filter((row) => row.topicID === commitTopic(secret))).toHaveLength(1)
    expect(hub.published.filter((row) => row.topicID === rendezvousTopic(secret))).toEqual([])
  } finally {
    await restarted.peer.dispose()
    await restarted.peer.drained()
  }
})

test('accepted restart rechecks checkpoint suffix before adoption or Welcome', async () => {
  const hub = new FakeHub()
  const original = makeMLSPeer(hub, 'alice', secret)
  await original.peer.resync()
  await original.peer.dispose()
  await original.peer.drained()
  const operation = await seedBuiltOperation(
    original,
    buildInviteCommit(original, 'bob'),
    '000000000001',
  )
  await hub.publish({
    senderDID: 'alice',
    topicID: commitTopic(secret),
    payload: operation.slot.payload,
    retain: 'log',
  })
  hub.trim(commitTopic(secret), '999999999999')
  const restarted = await reconstructMemoryPeer(hub, 'alice', secret, original.database)
  try {
    await restarted.peer.replay()
    expect(restarted.mls.epoch()).toBe(1)
    expect((await restarted.control.load()).commitOnce).toEqual(operation.slot)
    expect((await restarted.control.load()).controlHold?.reason).toBe('acceptance-unknown')
    expect(restarted.welcomes).toEqual([])
    expect(hub.published.filter((row) => row.topicID === rendezvousTopic(secret))).toEqual([])
  } finally {
    await restarted.peer.dispose()
    await restarted.peer.drained()
  }
})
