import { describe, expect, test } from 'vitest'

import { asLogPosition } from '../src/cursor.js'
import { commitTopic, rendezvousTopic } from '../src/topic.js'
import { FakeHub } from './fixtures/fake-hub.js'
import {
  buildInviteCommit,
  buildLedgerCommit,
  makeMLSPeer,
  reconstructMemoryPeer,
  seedBuiltOperation,
} from './fixtures/peer.js'

const secret = new Uint8Array(32).fill(0x43)

describe('a group of one survives its first commit crash', () => {
  test.each([false, true])(
    'saved acknowledged build waits for its ordinary occurrence, with trimmed log: %s',
    async (trim) => {
      const hub = new FakeHub()
      const seed = makeMLSPeer(hub, 'alice', secret)
      await seed.peer.resync()
      const saved = await seedBuiltOperation(seed, buildInviteCommit(seed, 'dave'))
      await seed.peer.dispose()
      await seed.peer.drained()
      const occurrence = await hub.publish({
        senderDID: 'alice',
        topicID: commitTopic(secret),
        payload: saved.slot.payload,
        publishID: saved.slot.publishID,
        expectedHead: saved.slot.expectedHead,
        retain: 'log',
      })
      await seed.control.apply(
        { commitOnce: { ...saved.slot, acceptedAs: asLogPosition(occurrence.sequenceID) } },
        'acknowledge-before-crash',
      )
      if (trim) hub.trim(commitTopic(secret), '999999999999')
      const restarted = await reconstructMemoryPeer(hub, 'alice', secret, seed.database)
      try {
        await restarted.peer.resync()
        if (trim) {
          const held = await restarted.control.load()
          expect(restarted.mls.epoch()).toBe(1)
          expect(held.controlHold).toBeNull()
          expect(held.commitOnce).toMatchObject({
            ...saved.slot,
            acceptedAs: occurrence.sequenceID,
          })
          expect(held.outcomes).toEqual([])
          expect(held.welcomes).toEqual([])
          expect(restarted.welcomes).toEqual([])
          await restarted.peer.dispose()
          await restarted.peer.drained()
          const again = await reconstructMemoryPeer(hub, 'alice', secret, restarted.database)
          try {
            await again.peer.replay()
            expect((await again.control.load()).commitOnce).toEqual(held.commitOnce)
            expect(again.mls.epoch()).toBe(1)
            expect(again.welcomes).toEqual([])
          } finally {
            await again.peer.dispose()
            await again.peer.drained()
          }
        } else {
          const consumed = await restarted.control.load()
          expect(restarted.mls.epoch()).toBe(2)
          expect(consumed.commitOnce).toBeNull()
          expect(consumed.operations).toEqual([])
          expect(consumed.outcomes).toMatchObject([
            { opID: saved.id, kind: 'landed', position: occurrence.sequenceID },
          ])
          expect(restarted.welcomes).toEqual([saved.id])
          await restarted.peer.commit(buildLedgerCommit(restarted, ['role=admin']))
          expect(restarted.mls.epoch()).toBe(3)
          expect(hub.published.filter((row) => row.topicID === commitTopic(secret))).toHaveLength(2)
        }
        expect(hub.published.filter((row) => row.topicID === rendezvousTopic(secret))).toEqual([])
      } finally {
        await restarted.peer.dispose()
        await restarted.peer.drained()
      }
    },
  )
})
