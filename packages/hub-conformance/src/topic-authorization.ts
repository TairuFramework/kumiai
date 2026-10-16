import { expect, test } from 'vitest'

import type { ConformanceLogHub } from './log-hub.js'

export type TopicAuthorizationConformanceParams = {
  /** Both views use authenticated DIDs and identical policy for the two opaque topics.
   * The denied DID already has subscriptions, but cannot access either topic. Receive opens
   * so the per-topic delivery gate, rather than absence of subscriptions, must deny its frames.
   */
  createFixture(): Promise<{
    commitTopicID: string
    checkpointTopicID: string
    allowed: ConformanceLogHub
    denied: ConformanceLogHub
    dispose(): Promise<void>
  }>
}

/** App-owned topic policy, not a claim that bare LogHub provides authorisation. */
export function testTopicAuthorizationConformance(
  params: TopicAuthorizationConformanceParams,
): void {
  test('commit and checkpoint access use the same configured policy', async () => {
    const fixture = await params.createFixture()
    const { allowed, denied, commitTopicID, checkpointTopicID } = fixture
    const senderDID = 'did:key:alice'
    const subscriberDID = 'did:key:bob'
    const permitted = allowed.receive(subscriberDID)
    const refused = denied.receive(subscriberDID)
    try {
      for (const topicID of [commitTopicID, checkpointTopicID]) {
        await allowed.subscribe(subscriberDID, topicID, { retention: 604_800 })
        await expect(
          Promise.resolve().then(() => denied.subscribe(subscriberDID, topicID)),
        ).rejects.toThrow()
        await expect(denied.fetchTopic({ subscriberDID, topicID })).rejects.toThrow()
        await expect(
          denied.publish({ senderDID, topicID, payload: new Uint8Array([255]), retain: 'log' }),
        ).rejects.toThrow()
      }

      const permittedIterator = permitted[Symbol.asyncIterator]()
      const refusedNext = refused[Symbol.asyncIterator]().next()
      const first = permittedIterator.next()
      const published: Array<string> = []
      for (const topicID of [commitTopicID, checkpointTopicID]) {
        const result = await allowed.publish({
          senderDID,
          topicID,
          payload: new Uint8Array([0, 255, 128]),
          retain: 'log',
        })
        published.push(result.sequenceID)
        const fetched = await allowed.fetchTopic({ subscriberDID, topicID })
        expect(fetched.messages.map((message) => message.sequenceID)).toEqual([result.sequenceID])
        expect(fetched.messages[0]?.payload).toEqual(new Uint8Array([0, 255, 128]))
      }
      const delivered = [await first, await permittedIterator.next()]
      expect(delivered.map((result) => result.value?.topicID)).toEqual([
        commitTopicID,
        checkpointTopicID,
      ])
      expect(delivered.map((result) => result.value?.logPosition)).toEqual(published)

      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const result = await Promise.race([
          refusedNext,
          new Promise<'silent'>((resolve) => {
            timer = setTimeout(() => resolve('silent'), 100)
          }),
        ])
        expect(result).toBe('silent')
      } finally {
        clearTimeout(timer)
      }
    } finally {
      permitted.return?.()
      refused.return?.()
      await fixture.dispose()
    }
  })
}
