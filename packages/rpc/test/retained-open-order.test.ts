import { encodeEventFrame } from '@kumiai/broadcast'
import { describe, expect, test, vi } from 'vitest'

import { encodeAppAAD } from '../src/app-aad.js'
import type { PendingAppFrame } from '../src/crypto.js'
import { createGroupPeer } from '../src/peer.js'
import { APP_TOPIC_LABEL, protocolTopic } from '../src/topic.js'
import { createMemoryAnchorStore } from './fixtures/anchor.js'
import { createMemoryAppCursorStore } from './fixtures/app-cursor.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { createFakeCrypto, fakeEpochSecret } from './fixtures/fake-crypto.js'
import { createMemoryCommitJournal } from './fixtures/journal.js'
import { createMemoryGroupMLS } from './fixtures/memory-group-mls.js'
import { createMemoryAppOutbox } from './fixtures/outbox.js'
import { adoptJournalledBlob, chat } from './fixtures/peer.js'

function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('retained pushes precede later group opens', () => {
  test.each(['chat', 'live'])('a slow pull cannot be overtaken on %s', async (liveName) => {
    const hub = new DurableFakeHub()
    const records = new Map<string, PendingAppFrame>()
    const persisted: Array<PendingAppFrame> = []
    const seen: Array<string> = []
    const opened: Array<string> = []
    const crypto = createFakeCrypto({
      localDID: 'bob',
      pending: {
        async persistOpened(_state, record) {
          records.set(record.frame.id, record)
          persisted.push(record)
        },
        async list() {
          return [...records.values()]
        },
        async complete(id) {
          records.delete(id)
        },
      },
    })
    const unwrap = crypto.unwrap.bind(crypto)
    const secret = fakeEpochSecret(1, APP_TOPIC_LABEL)
    const retainedTopic = protocolTopic(secret, 1, 'chat')
    const liveTopic = protocolTopic(secret, 1, liveName)
    const alice = createFakeCrypto({ localDID: 'alice' })
    const a = await alice.wrap(encodeEventFrame('chat/posted', { text: 'A' }), {
      aad: encodeAppAAD({ topicID: retainedTopic, intent: 'log' }),
    })
    const b = await alice.wrap(encodeEventFrame('chat/changed', { text: 'B' }), {
      aad: encodeAppAAD({ topicID: liveTopic, intent: 'ephemeral' }),
    })
    const openFailures: Array<unknown> = []
    vi.spyOn(crypto, 'unwrap').mockImplementation(async (bytes, opts) => {
      const name = bytes === a ? 'A' : bytes === b ? 'B' : 'other'
      // Model an evicted skipped key: opening B first makes A permanently unavailable.
      if (name === 'A' && opened.includes('B')) {
        const error = new Error('Desired gen in the past')
        openFailures.push(error)
        throw error
      }
      const result = await unwrap(bytes, opts)
      opened.push(name)
      return result
    })
    const handlers = {
      'chat/posted': () => {
        seen.push('A')
      },
      'chat/changed': () => {
        seen.push('B')
      },
      'chat/echo': () => ({}),
    }
    const mls = createMemoryGroupMLS({
      recoverySecret: new Uint8Array(32).fill(0x91),
      localDID: 'bob',
      onAdvance: crypto.setEpoch,
    })
    const peer = createGroupPeer({
      hub,
      crypto,
      mls,
      localDID: 'bob',
      protocols: { chat, live: chat },
      handlers: { chat: handlers, live: handlers },
      journal: createMemoryCommitJournal(),
      adoptJournalled: async (blob) => adoptJournalledBlob(mls, blob),
      anchorStore: createMemoryAnchorStore(),
      appCursorStore: createMemoryAppCursorStore(),
      appOutbox: createMemoryAppOutbox(),
      appOutboxLimit: 128,
    })
    const fetchEntered = deferred()
    const releaseFetch = deferred()
    try {
      await peer.protocol('chat').to('alice')
      const fetch = hub.fetchTopic.bind(hub)
      vi.spyOn(hub, 'fetchTopic').mockImplementation(async (params) => {
        if (params.topicID === retainedTopic) {
          fetchEntered.resolve()
          await releaseFetch.promise
        }
        return fetch(params)
      })
      await hub.publish({
        topicID: retainedTopic,
        senderDID: 'alice',
        payload: a,
        retain: 'log',
      })
      await fetchEntered.promise
      hub.redeliver('bob')
      await hub.publish({
        topicID: liveTopic,
        senderDID: 'alice',
        payload: b,
        retain: 'mailbox',
      })
      // Let the mux deliver B and all queued open microtasks while the fetch remains held.
      await new Promise((resolve) => setTimeout(resolve, 0))
      releaseFetch.resolve()
      await vi.waitFor(() => expect(seen.toSorted()).toEqual(['A', 'B']))
      expect(openFailures).toEqual([])
      expect(opened).toEqual(['A', 'B'])
      await vi.waitFor(() => expect(records.size).toBe(0))
      await vi.waitFor(() => expect(hub.ackedCount('bob')).toBe(2))
      // Both pushed copies and their pulls share one durable open and one handler call.
      expect(persisted).toHaveLength(1)
      expect(seen.toSorted()).toEqual(['A', 'B'])
      expect(opened).toEqual(['A', 'B'])
    } finally {
      releaseFetch.resolve()
      await peer.dispose()
    }
  })
})
