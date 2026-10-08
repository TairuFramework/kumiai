import { describe, expect, test } from 'vitest'

import { commitTopic, rendezvousTopic } from '../src/topic.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { buildInviteCommit, buildLedgerCommit, makeMLSPeer } from './fixtures/peer.js'

const secret = new Uint8Array(32).fill(0x43)

describe('a group of one survives its first commit crash', () => {
  test.each([false, true])(
    'saved acceptance adopts before the seed walk, with trimmed log: %s',
    async (trim) => {
      const hub = new FakeHub()
      const seed = makeMLSPeer(hub, 'alice', secret)
      await seed.peer.resync()
      const stopBeforeAdopt = (): void => {
        seed.database.seam('after-apply', async () => {
          if ((await seed.control.load()).operations[0]?.stage === 'accepted')
            void seed.peer.dispose()
          else stopBeforeAdopt()
        })
      }
      stopBeforeAdopt()
      await seed.peer.enqueue(buildInviteCommit(seed, 'dave'))
      await expect
        .poll(async () => (await seed.control.load()).operations[0]?.stage)
        .toBe('accepted')
      await seed.peer.dispose()
      await seed.peer.drained()
      if (trim) hub.trim(commitTopic(secret), '999999999999')
      const restarted = makeMLSPeer(hub, 'alice', secret, { restartOf: seed })
      await restarted.peer.resync()
      expect(restarted.mls.epoch()).toBe(2)
      expect((await restarted.control.load()).operations).toEqual([])
      expect((await restarted.control.load()).welcomes).toHaveLength(1)
      expect(hub.published.filter((row) => row.topicID === rendezvousTopic(secret))).toEqual([])
      await restarted.peer.commit(buildLedgerCommit(restarted, ['role=admin']))
      expect(restarted.mls.epoch()).toBe(3)
      expect(hub.published.filter((row) => row.topicID === commitTopic(secret))).toHaveLength(2)
      await restarted.peer.dispose()
    },
  )
})
