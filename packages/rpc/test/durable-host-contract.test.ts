import { fromUTF } from '@sozai/codec'
import { describe, expect, test, vi } from 'vitest'

import { encodeAppAAD } from '../src/app-aad.js'
import { APP_TOPIC_LABEL, protocolTopic } from '../src/topic.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { createFakeCrypto, fakeEpochSecret } from './fixtures/fake-crypto.js'
import { makeMLSPeer } from './fixtures/peer.js'
import { createSingleConnectionHost, deferred } from './fixtures/single-connection-host.js'

const topicID = protocolTopic(fakeEpochSecret(1, APP_TOPIC_LABEL), 1, 'chat')
const payload = (text: string) =>
  fromUTF(JSON.stringify({ payload: { typ: 'event', prc: 'chat/posted', data: { text } } }))
const timeout = (ms = 250): Promise<'timeout'> =>
  new Promise((resolve) => setTimeout(() => resolve('timeout'), ms))

const sender = createFakeCrypto({ epoch: 1, localDID: 'alice' })
async function publish(hub: DurableFakeHub, text: string) {
  await hub.publish({
    topicID,
    senderDID: 'alice',
    payload: await sender.wrap(payload(text), {
      aad: encodeAppAAD({ topicID, intent: 'log' }),
    }),
    retain: 'log',
  })
}

describe('single-connection durable host contract', () => {
  test('an earlier delayed save precedes staged open; stale same-epoch writes cannot overwrite it', async () => {
    const host = createSingleConnectionHost()
    const hub = new DurableFakeHub()
    const before = deferred<void>()
    const handled = deferred<void>()
    const peer = makeMLSPeer(hub, 'bob', new Uint8Array(32).fill(0x91), {
      crypto: createFakeCrypto({ epoch: 1, localDID: 'bob', pending: host.pending }),
      handlers: { 'chat/posted': () => handled.promise },
    })
    await peer.peer.protocol('chat').to('alice')
    const earlierSave = host.saveEarlierState(before.promise)
    await publish(hub, 'opened')
    await vi.waitFor(() => expect(host.persistAttempts()).toBe(1))
    expect(host.records()).toHaveLength(0)
    before.resolve()
    await earlierSave
    await vi.waitFor(() => expect(host.records()).toHaveLength(1))
    expect(host.savedVersion()).toBe(2)
    expect(host.writeOrder()).toEqual(['earlier', 'opened'])
    expect(host.savedState()).toEqual(peer.crypto.saveState())
    handled.resolve()
    await vi.waitFor(() => expect(host.records()).toHaveLength(0))
    expect(await host.saveStaleState()).toBe(false)
    expect(host.savedVersion()).toBe(2)
    expect(host.savedState()).toEqual(peer.crypto.saveState())
    await peer.peer.dispose()
  })

  test('a handler closes its transaction before awaiting the peer while another open uses the connection', async () => {
    const host = createSingleConnectionHost()
    const hub = new DurableFakeHub()
    const entered = deferred<void>()
    const release = deferred<void>()
    const applied: Array<string> = []
    let peer: ReturnType<typeof makeMLSPeer>
    peer = makeMLSPeer(hub, 'bob', new Uint8Array(32).fill(0x91), {
      crypto: createFakeCrypto({ epoch: 1, localDID: 'bob', pending: host.pending }),
      handlers: {
        'chat/posted': async ({ data }: { data: { text: string } }) => {
          await host.transaction(async () => {
            applied.push(data.text)
            if (data.text === 'first') {
              entered.resolve()
              await release.promise
            }
          })
          await peer.peer.replay()
        },
      },
    })
    await peer.peer.protocol('chat').to('alice')
    await publish(hub, 'first')
    await entered.promise
    await publish(hub, 'second')
    await vi.waitFor(() => expect(host.persistAttempts()).toBe(2))
    release.resolve()
    await vi.waitFor(() => expect(applied).toEqual(['first', 'second']), { timeout: 2500 })
    await vi.waitFor(() => expect(host.records()).toHaveLength(0), { timeout: 2500 })
    expect(host.maxConcurrentCalls()).toBe(1)
    await peer.peer.dispose()
  })

  test('holding the sole connection across a peer await wedges the inverse lock order', async () => {
    const host = createSingleConnectionHost()
    const hub = new DurableFakeHub()
    const entered = deferred<void>()
    const startAwait = deferred<void>()
    const abort = deferred<void>()
    const returned = deferred<void>()
    let peer: ReturnType<typeof makeMLSPeer>
    peer = makeMLSPeer(hub, 'bob', new Uint8Array(32).fill(0x91), {
      crypto: createFakeCrypto({ epoch: 1, localDID: 'bob', pending: host.pending }),
      handlers: {
        'chat/posted': async ({ data }: { data: { text: string } }) => {
          if (data.text !== 'first') return
          await host.transaction(async () => {
            entered.resolve()
            await startAwait.promise
            await Promise.race([peer.peer.replay(), abort.promise])
          })
          returned.resolve()
        },
      },
    })
    await peer.peer.protocol('chat').to('alice')
    await publish(hub, 'first')
    await entered.promise
    await publish(hub, 'second')
    await vi.waitFor(() => expect(host.persistAttempts()).toBe(2))
    startAwait.resolve()
    expect(await Promise.race([returned.promise.then(() => 'returned' as const), timeout()])).toBe(
      'timeout',
    )
    expect(host.records()).toHaveLength(1)
    abort.resolve()
    await returned.promise
    await vi.waitFor(() => expect(host.records()).toHaveLength(0), { timeout: 2500 })
    await peer.peer.dispose()
  })
})
