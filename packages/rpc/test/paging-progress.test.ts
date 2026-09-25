import type { HubFetchTopicParams, HubFetchTopicResult } from '@kumiai/hub-tunnel'
import { describe, expect, test } from 'vitest'

import { createAppLane } from '../src/app-lane.js'
import { asLogPosition, assertForwardPage } from '../src/cursor.js'
import { APP_TOPIC_LABEL, commitTopic } from '../src/topic.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { createFakeCrypto, fakeEpochSecret } from './fixtures/fake-crypto.js'
import { buildLedgerCommit, chat, makeMLSPeer } from './fixtures/peer.js'

const secret = new Uint8Array(32).fill(0x93)
const repeated = Array.from({ length: 100 }, (_, index) => ({
  sequenceID: String(index + 1).padStart(12, '0'),
  payload: new Uint8Array(),
}))

describe('hub log paging', () => {
  test('rejects positions that move backward within one page', () => {
    expect(() =>
      assertForwardPage(asLogPosition('000000000001'), [
        { sequenceID: '000000000003' },
        { sequenceID: '000000000002' },
      ]),
    ).toThrow(/non-increasing log positions/)
  })
  test('the app drain rejects a repeated full page after its cursor', async () => {
    let fetches = 0
    const lane = createAppLane({
      mux: {
        retainTopic() {},
        async fetchTopic() {
          if (++fetches > 2) throw new Error('fixture cutoff')
          return {
            messages: repeated,
            head: repeated.at(-1)?.sequenceID,
            oldest: repeated[0]?.sequenceID,
          }
        },
      } as never,
      crypto: createFakeCrypto({ localDID: 'bob' }),
      localDID: 'bob',
      protocols: { chat },
      eventHandlers: new Map(),
      retentionSeconds: 60,
      anchor: () => ({ epoch: 1, secret: fakeEpochSecret(1, APP_TOPIC_LABEL) }),
      groupID: () => 'group',
    })
    await expect(lane.deliver()).rejects.toThrow(/non-increasing log positions/)
    expect(fetches).toBe(2)
    lane.dispose()
  })

  test('the commit walk rejects a repeated full page after its cursor', async () => {
    class RepeatingHub extends DurableFakeHub {
      fetches = 0
      armed = false
      override async fetchTopic(params: HubFetchTopicParams): Promise<HubFetchTopicResult> {
        if (!this.armed || params.topicID !== commitTopic(secret)) return super.fetchTopic(params)
        if (++this.fetches > 2) throw new Error('fixture cutoff')
        return {
          messages: repeated as HubFetchTopicResult['messages'],
          head: repeated.at(-1)?.sequenceID ?? null,
          oldest: repeated[0]?.sequenceID ?? null,
        }
      }
    }
    const hub = new RepeatingHub()
    const bob = makeMLSPeer(hub, 'bob', secret)
    await bob.peer.protocol('chat').to('alice')
    hub.armed = true
    await expect(bob.peer.commit(buildLedgerCommit(bob, []))).rejects.toThrow(
      /non-increasing log positions/,
    )
    expect(hub.fetches).toBe(2)
    await bob.peer.dispose()
  })
})
