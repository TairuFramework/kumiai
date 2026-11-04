import { encodeEventFrame } from '@kumiai/broadcast'
import type { HubFetchTopicParams } from '@kumiai/hub-tunnel'
import { expect, test, vi } from 'vitest'

import { encodeAppAAD } from '../src/app-aad.js'
import { createAppLane } from '../src/app-lane.js'
import { APP_TOPIC_LABEL, protocolTopic } from '../src/topic.js'
import { testAppLaneParams } from './fixtures/app-lane.js'
import {
  createDurableTestCrypto,
  createFakeCrypto,
  fakeEpochSecret,
} from './fixtures/fake-crypto.js'
import { chat } from './fixtures/peer.js'

async function fixture(count: number) {
  const groupKey = { groupID: 'ingress-opening', incarnation: 1 }
  const anchor = { epoch: 1, secret: fakeEpochSecret(1, APP_TOPIC_LABEL) }
  const topicID = protocolTopic(anchor.secret, anchor.epoch, 'chat')
  const crypto = createDurableTestCrypto({ localDID: 'bob' })
  const sender = createFakeCrypto({ localDID: 'alice' })
  const messages: Array<{ sequenceID: string; senderDID: string; payload: Uint8Array }> = []
  for (let index = 0; index < count; index++) {
    messages.push({
      sequenceID: String(index + 1).padStart(12, '0'),
      senderDID: 'alice',
      payload: await sender.wrap(encodeEventFrame('chat/posted', { index }), {
        aad: encodeAppAAD({ topicID, intent: 'log' }),
      }),
    })
  }
  const fetch = vi.fn(async ({ after, limit }: HubFetchTopicParams) => ({
    messages: messages.filter((frame) => after == null || frame.sequenceID > after).slice(0, limit),
    head: messages.at(-1)?.sequenceID ?? null,
    oldest: messages[0]?.sequenceID ?? null,
    gap: false,
  }))
  const startDelivery = vi.fn()
  const lane = createAppLane(
    testAppLaneParams({
      groupKey,
      mux: { retainTopic() {}, fetchTopic: fetch } as never,
      crypto,
      localDID: 'bob',
      protocols: { chat },
      retentionSeconds: 60,
      anchor: () => anchor,
      appliedEpoch: () => 1,
      groupID: () => groupKey.groupID,
      // Handler completion is deliberately held while opening continues.
      scheduleDelivery: startDelivery,
    }),
  )
  return { lane, crypto, fetch, startDelivery }
}

test.each(['fetch', 'open'] as const)(
  'ingress joins a retained %s already owned by another drain',
  async (hold) => {
    const { lane, crypto, fetch } = await fixture(1)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const unwrap = crypto.unwrap.bind(crypto)
    const fetchTopic = fetch.getMockImplementation()
    if (fetchTopic === undefined) throw new Error('Missing fetch implementation')
    if (hold === 'open') {
      vi.spyOn(crypto, 'unwrap').mockImplementation(async (...args) => {
        entered.resolve()
        await release.promise
        return unwrap(...args)
      })
    } else {
      fetch.mockImplementation(async (params) => {
        entered.resolve()
        await release.promise
        return fetchTopic(params)
      })
    }
    const first = lane.deliver()
    let fenced = false
    let fence: Promise<void> | undefined
    try {
      await entered.promise
      fence = lane.openRetained().then(() => {
        fenced = true
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(fenced).toBe(false)
      release.resolve()
      await Promise.all([first, fence])
      expect(crypto.starts.unwrap).toBe(1)
      expect(await crypto.pending?.list()).toHaveLength(1)
    } finally {
      release.resolve()
      await Promise.allSettled([first, ...(fence === undefined ? [] : [fence])])
      lane.dispose()
    }
  },
)

test.each([800, 1_001])(
  'ingress follows bounded pull continuations without awaiting handlers (%s frames)',
  async (count) => {
    const { lane, crypto, fetch } = await fixture(count)
    try {
      await lane.openRetained()
      expect(crypto.starts.unwrap).toBe(Math.min(count, 1_000))
      expect(await crypto.pending?.list()).toHaveLength(Math.min(count, 1_000))
      expect(fetch.mock.calls.length).toBeGreaterThan(4)
      expect(fetch.mock.calls.every(([params]) => (params.limit ?? 0) <= 100)).toBe(true)
    } finally {
      lane.dispose()
    }
  },
)

test('ingress continuations yield and back off when every fetched frame is refused', async () => {
  const { lane, fetch } = await fixture(0)
  let requests = 0
  fetch.mockImplementation(async () => {
    requests++
    return {
      messages: Array.from({ length: 100 }, (_, index) => ({
        sequenceID: String((requests - 1) * 100 + index + 1).padStart(12, '0'),
        senderDID: 'alice',
        payload: new Uint8Array(),
      })),
      head: null,
      oldest: null,
      gap: false,
    }
  })
  const opening = lane.openRetained()
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(requests).toBeGreaterThan(0)
    expect(requests).toBeLessThanOrEqual(4)
  } finally {
    lane.dispose()
    await opening
  }
})
