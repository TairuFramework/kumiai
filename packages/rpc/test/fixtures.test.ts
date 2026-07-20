import { fromUTF, toUTF } from '@sozai/codec'
import { describe, expect, test } from 'vitest'

import { APP_TOPIC_LABEL } from '../src/topic.js'
import { createMemoryAppCursorStore } from './fixtures/app-cursor.js'
import { createFakeCrypto, fakeEpochSecret } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'

describe('fake crypto', () => {
  test('wrap then unwrap round-trips and recovers the sender', async () => {
    const crypto = createFakeCrypto({ localDID: 'did:key:alice' })
    const plain = fromUTF('hello group')
    const wrapped = await crypto.wrap(plain)
    expect(toUTF(wrapped)).not.toContain('hello group')
    const result = await crypto.unwrap(wrapped)
    const out = result instanceof Uint8Array ? { payload: result, senderDID: undefined } : result
    expect(toUTF(out.payload)).toBe('hello group')
    expect(out.senderDID).toBe('did:key:alice')
  })

  test('exposes epoch and exportSecret, epoch mutable for resync tests', async () => {
    const crypto = createFakeCrypto({ epoch: 1 })
    expect(crypto.epoch()).toBe(1)
    const secret = await crypto.exportSecret(APP_TOPIC_LABEL)
    expect(secret).toBeInstanceOf(Uint8Array)
    crypto.setEpoch(2)
    expect(crypto.epoch()).toBe(2)
  })

  test('exportSecret is bound to the epoch: a different epoch is different bytes', async () => {
    const crypto = createFakeCrypto({ epoch: 1 })
    const atOne = await crypto.exportSecret(APP_TOPIC_LABEL)
    crypto.setEpoch(2)
    const atTwo = await crypto.exportSecret(APP_TOPIC_LABEL)
    // The property the port contract asks for and the app-lane topic rests on. A fake exporting a
    // fixed value would be a lifelong secret plus a guessable epoch number — the one thing a
    // topic derivation must not be, and it would look identical to a correct one from here.
    expect(atTwo).not.toEqual(atOne)
    // Every member is the same function of the epoch, so members AT an epoch agree — and one
    // stuck behind does not follow.
    expect(await createFakeCrypto({ epoch: 2 }).exportSecret(APP_TOPIC_LABEL)).toEqual(atTwo)
    expect(fakeEpochSecret(1)).toEqual(atOne)
  })

  test('exportSecret is bound to the label: two labels at the same epoch are different bytes', async () => {
    const crypto = createFakeCrypto({ epoch: 1 })
    const appSecret = await crypto.exportSecret(APP_TOPIC_LABEL)
    const otherSecret = await crypto.exportSecret('kumiai/fixtures-test/other-label')
    expect(otherSecret).not.toEqual(appSecret)
  })
})

describe('fake crypto reads a frame’s epoch, and refuses to read one out of bytes that are not a frame', () => {
  test('a sealed frame answers with the epoch it was sealed at', async () => {
    const crypto = createFakeCrypto({ epoch: 4, localDID: 'did:key:alice' })
    const sealed = await crypto.wrap(fromUTF('hello group'))
    // Asked by a member at a DIFFERENT epoch, which is the only interesting case: the answer is
    // read from the frame's cleartext, so it does not need the key that opens it.
    expect(createFakeCrypto({ epoch: 9 }).frameEpoch(sealed)).toBe(4)
  })

  test('bytes that are not a frame answer null, however their leading bytes read', () => {
    const crypto = createFakeCrypto({ epoch: 1 })
    expect(crypto.frameEpoch(new Uint8Array([0x03]))).toBeNull()
    // Two bytes that read as a perfectly plausible epoch, and nothing behind them that could be
    // a sender: `null` is the port's answer, and the epoch it would otherwise invent is a claim
    // no publisher made — one the drain would honour by holding its cursor behind it.
    expect(crypto.frameEpoch(new Uint8Array([0x03, 0x00, 0xff, 0xff, 0xff, 0xff]))).toBeNull()
  })
})

describe('the durable app-cursor double refuses what the real store must', () => {
  test('a position older than the one it holds is refused', async () => {
    const store = createMemoryAppCursorStore()
    await store.save('t', '000000000005')
    await expect(store.save('t', '000000000004')).rejects.toThrow(/may not move back/)
    // Refused, not silently ignored, and nothing was written: the guard exists so that a peer
    // that regressed its advance rule cannot leave a store that looks correct.
    expect(store.stored('t')).toBe('000000000005')
    expect(store.history('t')).toEqual(['000000000005'])
    // Forward, and standing still, are both fine.
    await store.save('t', '000000000005')
    await store.save('t', '000000000006')
    expect(store.stored('t')).toBe('000000000006')
  })
})

describe('fake hub', () => {
  test('delivers published payloads to topic subscribers, excluding the sender', async () => {
    const hub = new FakeHub()
    const received: Array<string> = []
    hub.subscribe('bob', 'topic:1')
    void (async () => {
      for await (const msg of hub.receive('bob')) received.push(toUTF(msg.payload))
    })()
    await hub.publish({ senderDID: 'alice', topicID: 'topic:1', payload: fromUTF('hi') })
    await new Promise((r) => setTimeout(r, 10))
    expect(received).toEqual(['hi'])
  })

  test('does not deliver to the sender even if subscribed', async () => {
    const hub = new FakeHub()
    const received: Array<string> = []
    hub.subscribe('alice', 'topic:1')
    void (async () => {
      for await (const msg of hub.receive('alice')) received.push(toUTF(msg.payload))
    })()
    await hub.publish({ senderDID: 'alice', topicID: 'topic:1', payload: fromUTF('hi') })
    await new Promise((r) => setTimeout(r, 10))
    expect(received).toEqual([])
  })

  test('subscriberCount reflects subscribe/unsubscribe', () => {
    const hub = new FakeHub()
    expect(hub.subscriberCount('t')).toBe(0)
    hub.subscribe('a', 't')
    hub.subscribe('b', 't')
    expect(hub.subscriberCount('t')).toBe(2)
    hub.unsubscribe('a', 't')
    expect(hub.subscriberCount('t')).toBe(1)
  })
})
