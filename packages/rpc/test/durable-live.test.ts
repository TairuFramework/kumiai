import type { StoredMessage } from '@kumiai/hub-protocol'
import { fromUTF } from '@sozai/codec'
import { describe, expect, test, vi } from 'vitest'

import { encodeAppAAD } from '../src/app-aad.js'
import type { PendingAppFrame } from '../src/crypto.js'
import { APP_TOPIC_LABEL, protocolTopic } from '../src/topic.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { createFakeCrypto, fakeEpochSecret } from './fixtures/fake-crypto.js'
import { buildLedgerCommit, makeMLSPeer } from './fixtures/peer.js'

const topicID = protocolTopic(fakeEpochSecret(1, APP_TOPIC_LABEL), 1, 'chat')
const payload = (text: string) =>
  fromUTF(JSON.stringify({ payload: { typ: 'event', prc: 'chat/posted', data: { text } } }))

class PushMetadataHub extends DurableFakeHub {
  transform: (message: StoredMessage) => StoredMessage = (message) => message

  override receive(did: string) {
    const source = super.receive(did)
    const transform = this.transform
    return {
      ack: source.ack,
      return: source.return,
      async *[Symbol.asyncIterator]() {
        for await (const message of source) yield did === 'bob' ? transform(message) : message
      },
    }
  }
}

function pendingStore() {
  const records = new Map<string, PendingAppFrame>()
  return {
    records,
    port: {
      async persistOpened(_state: Uint8Array, record: PendingAppFrame) {
        records.set(record.frame.id, record)
      },
      async list() {
        return [...records.values()]
      },
      async complete(id: string) {
        records.delete(id)
      },
    },
  }
}

async function setup(hub = new DurableFakeHub(), handlers: Record<string, unknown> = {}) {
  const store = pendingStore()
  const crypto = createFakeCrypto({ epoch: 1, localDID: 'bob', pending: store.port })
  const unwrap = vi.spyOn(crypto, 'unwrap')
  const bob = makeMLSPeer(hub, 'bob', new Uint8Array(32).fill(0x91), { crypto, handlers })
  await bob.peer.protocol('chat').to('alice')
  const alice = createFakeCrypto({ epoch: 1, localDID: 'alice' })
  const publish = async (text: string, retain: 'log' | 'ephemeral' = 'log') =>
    hub.publish({
      topicID,
      senderDID: 'alice',
      payload: await alice.wrap(payload(text), {
        aad: encodeAppAAD({ topicID, intent: retain }),
      }),
      retain: retain === 'log' ? 'log' : 'mailbox',
    })
  return { hub, bob, store, unwrap, publish }
}

describe('durable live app delivery', () => {
  test('a live log push is acked and only the fetched copy opens, in fetched order', async () => {
    const hub = new PushMetadataHub()
    const { bob, store, unwrap, publish } = await setup(hub)
    const fetch = hub.fetchTopic.bind(hub)
    let releaseFetch: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve
    })
    vi.spyOn(hub, 'fetchTopic').mockImplementation(async (params) => {
      if (params.topicID === topicID) await gate
      return fetch(params)
    })
    hub.detach('bob')
    const a = await publish('A')
    // The pushed B lies about its position, claiming A's fetched position.
    hub.transform = (message) => ({ ...message, logPosition: a.sequenceID })
    hub.reattach('bob')
    await publish('B')
    await vi.waitFor(() => expect(hub.ackedCount('bob')).toBe(1))
    expect(unwrap).not.toHaveBeenCalled()
    releaseFetch?.()
    await vi.waitFor(() => expect(store.records.size).toBe(2))
    expect([...store.records.values()].map((record) => record.frame.position)).toEqual([
      a.sequenceID,
      hub.published.at(-1)?.sequenceID,
    ])
    expect(unwrap).toHaveBeenCalledTimes(2)
    expect(unwrap.mock.calls.every(([, opts]) => opts?.frame != null)).toBe(true)
    expect(hub.ackedCount('bob')).toBe(1)
    await bob.peer.dispose()
  })

  test('a log push without logPosition still wakes the pull', async () => {
    const hub = new PushMetadataHub()
    hub.transform = (message) => ({ ...message, logPosition: undefined })
    const { bob, store, publish } = await setup(hub)
    const message = await publish('without-position')
    await vi.waitFor(() => expect(store.records.size).toBe(1))
    expect([...store.records.values()][0]?.frame.position).toBe(message.sequenceID)
    await bob.peer.dispose()
  })

  test('a failed fetch retries with no further push', async () => {
    const hub = new DurableFakeHub()
    const { bob, store, publish } = await setup(hub)
    const fetch = hub.fetchTopic.bind(hub)
    let failures = 0
    vi.spyOn(hub, 'fetchTopic').mockImplementation(async (params) => {
      if (params.topicID === topicID && failures++ === 0) throw new Error('transient fetch')
      return fetch(params)
    })
    await publish('retry')
    await vi.waitFor(() => expect(store.records.size).toBe(1), { timeout: 2500 })
    expect(failures).toBeGreaterThanOrEqual(2)
    await bob.peer.dispose()
  })

  test('a failed durable open retries with no further push', async () => {
    const { bob, store, publish } = await setup()
    vi.spyOn(store.port, 'persistOpened').mockRejectedValueOnce(new Error('transient storage'))
    await publish('retry storage')
    await vi.waitFor(() => expect(store.records.size).toBe(1), { timeout: 2500 })
    await bob.peer.dispose()
  })

  test('a failed commit walk resumes without another hub push', async () => {
    const { hub, bob, store, publish } = await setup()
    hub.detach('bob')
    await publish('before commit')
    vi.spyOn(store.port, 'persistOpened').mockRejectedValueOnce(new Error('transient storage'))
    await expect(bob.peer.commit(buildLedgerCommit(bob, []))).rejects.toThrow(
      'failed to persist opened app frame',
    )
    await vi.waitFor(() => expect(store.records.size).toBe(1), { timeout: 2500 })
    await bob.peer.dispose()
  })

  test('the pull after listener registration finds a publication in the startup gap', async () => {
    const hub = new DurableFakeHub()
    const alice = createFakeCrypto({ epoch: 1, localDID: 'alice' })
    const bytes = await alice.wrap(payload('gap'), {
      aad: encodeAppAAD({ topicID, intent: 'log' }),
    })
    const fetch = hub.fetchTopic.bind(hub)
    let inserted = false
    vi.spyOn(hub, 'fetchTopic').mockImplementation(async (params) => {
      const result = await fetch(params)
      if (params.topicID === topicID && !inserted) {
        inserted = true
        void hub.publish({ topicID, senderDID: 'alice', payload: bytes, retain: 'log' })
      }
      return result
    })
    const { bob, store } = await setup(hub)
    await vi.waitFor(() => expect(store.records.size).toBe(1))
    expect(inserted).toBe(true)
    await bob.peer.dispose()
  })

  test('an ephemeral push stays live even when the hub adds a log position', async () => {
    const hub = new PushMetadataHub()
    hub.transform = (message) => ({ ...message, logPosition: '000000000000' })
    const seen: Array<unknown> = []
    const { bob, store, unwrap } = await setup(hub, {
      'chat/changed': (context: { data: unknown }) => {
        seen.push(context.data)
      },
    })
    // The declared ephemeral procedure remains on the live path regardless of pushed metadata.
    const alice = makeMLSPeer(hub, 'alice', new Uint8Array(32).fill(0x91))
    await alice.peer.protocol('chat').dispatch('chat/changed', { data: { text: 'live' } })
    await vi.waitFor(() => expect(seen).toEqual([{ text: 'live' }]))
    expect(store.records.size).toBe(0)
    expect(unwrap.mock.calls.some(([, opts]) => opts?.frame == null)).toBe(true)
    await alice.peer.dispose()
    await bob.peer.dispose()
  })
})
