import type { HubStore, HubStoreEvents } from '@kumiai/hub-protocol'
import { describe, expect, test } from 'vitest'

export type PurgeRaceHarness = {
  /** The first retained-log minimum read pauses at cut. */
  purger: HubStore
  /** Same database, separate connection. */
  publisher: HubStore
  reader: HubStore
  cut: { reached: Promise<void>; release: () => void }
  /** Wait until publication completes or blocks on the purger's lock. */
  publisherSettled?: (publication: Promise<unknown>) => Promise<void>
  close: () => Promise<void>
}

export type HubStorePurgeRaceParams = {
  createHarness: () => Promise<PurgeRaceHarness>
  setTime: (milliseconds: number) => void
}

export function testHubStorePurgeRaceConformance(params: HubStorePurgeRaceParams): void {
  describe('HubStore purge concurrency', () => {
    test.each([false, true])(
      'logs after an empty log cut survive (topic row: %s)',
      async (hasTopicRow) => {
        const harness = await params.createHarness()
        const { purger, publisher, reader, cut } = harness
        const topicID = 'topic:purge-race'
        const subscriberDID = 'did:test:reader'
        const publish = async (
          store: HubStore,
          time: number,
          retain: 'log' | 'mailbox' = 'log',
        ) => {
          params.setTime(time)
          return (
            await store.publish({
              senderDID: 'did:test:sender',
              topicID,
              payload: new Uint8Array([1]),
              retain,
            })
          ).sequenceID
        }
        let pending: Promise<Array<string>> | undefined
        let publication: Promise<Array<string>> | undefined
        try {
          params.setTime(1000)
          await reader.subscribe({ subscriberDID, topicID })
          const prefix = hasTopicRow ? await publish(reader, 1000) : null
          const mailbox = await publish(reader, 1000, 'mailbox')
          const events: Array<HubStoreEvents['purge']> = []
          purger.events.on('purge', (event) => {
            events.push(event)
          })
          params.setTime(12000)
          pending = purger.purge({ olderThan: 5 })
          void pending.catch(() => {})
          let cutReached = false
          void cut.reached.then(() => {
            cutReached = true
          })
          await expect.poll(() => cutReached, { timeout: 5000 }).toBe(true)
          publication = (async () => {
            const retained = await publish(publisher, 10000)
            const later = await publish(publisher, 1000)
            return [retained, later]
          })()
          void publication.catch(() => {})
          await harness.publisherSettled?.(publication)
          cut.release()
          const [retained, later] = await publication
          const removed = prefix == null ? [mailbox] : [prefix, mailbox]
          expect(await pending).toEqual(removed)
          expect(events).toEqual([{ sequenceIDs: removed }])
          const page = await reader.fetchTopic({ subscriberDID, topicID })
          expect(page.messages.map((message) => message.sequenceID)).toEqual([retained, later])
          expect(page).toMatchObject({ head: later, oldest: retained, gap: hasTopicRow })
          const deliveries = await reader.fetch({ recipientDID: subscriberDID })
          expect(deliveries.messages.map((message) => message.sequenceID)).toEqual([
            retained,
            later,
          ])
        } finally {
          cut.release()
          await Promise.allSettled([pending, publication])
          await harness.close()
        }
      },
      30000,
    )
  })
}
