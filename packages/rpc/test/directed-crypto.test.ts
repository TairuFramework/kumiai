import { describe, expect, test } from 'vitest'

import { sealDirectedHub } from '../src/directed-crypto.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'

const PLAINTEXT = new TextEncoder().encode('directed-secret')

async function drainOne(sub: ReturnType<FakeHub['receive']>): Promise<{
  senderDID: string
  payload: Uint8Array
}> {
  const { value } = await sub[Symbol.asyncIterator]().next()
  return { senderDID: value.senderDID, payload: value.payload }
}

describe('sealDirectedHub', () => {
  test('publish seals the payload (hub sees ciphertext, not plaintext)', async () => {
    const hub = new FakeHub()
    const alice = createFakeCrypto({ localDID: 'alice' })
    const sealed = sealDirectedHub({ hub, wrap: alice.wrap, unwrap: alice.unwrap })
    await sealed.publish({ senderDID: 'alice', topicID: 't', payload: PLAINTEXT })
    const onWire = hub.published[0].payload
    expect(Buffer.from(onWire).includes(Buffer.from(PLAINTEXT))).toBe(false)
  })

  test('receive opens the payload and stamps the recovered senderDID', async () => {
    const hub = new FakeHub()
    const alice = createFakeCrypto({ localDID: 'alice' })
    const bob = createFakeCrypto({ localDID: 'bob' })
    const bobView = sealDirectedHub({ hub, wrap: bob.wrap, unwrap: bob.unwrap })
    hub.subscribe('bob', 't')
    const sub = bobView.receive('bob')
    await hub.publish({
      senderDID: 'lying-hub',
      topicID: 't',
      payload: await alice.wrap(PLAINTEXT),
    })
    const got = await drainOne(sub)
    expect(got.senderDID).toBe('alice')
    expect(got.payload).toEqual(PLAINTEXT)
  })

  test('receive drops frames whose recovered sender != expectedSenderDID', async () => {
    const hub = new FakeHub()
    const alice = createFakeCrypto({ localDID: 'alice' })
    const mallory = createFakeCrypto({ localDID: 'mallory' })
    const bob = createFakeCrypto({ localDID: 'bob' })
    const bobView = sealDirectedHub({
      hub,
      wrap: bob.wrap,
      unwrap: bob.unwrap,
      expectedSenderDID: 'alice',
    })
    hub.subscribe('bob', 't')
    const sub = bobView.receive('bob')
    await hub.publish({ senderDID: 'hub', topicID: 't', payload: await mallory.wrap(PLAINTEXT) })
    await hub.publish({ senderDID: 'hub', topicID: 't', payload: await alice.wrap(PLAINTEXT) })
    const got = await drainOne(sub)
    expect(got.senderDID).toBe('alice') // mallory's frame was skipped
  })

  test('receive drops frames that unwrap without a recovered sender', async () => {
    const hub = new FakeHub()
    const alice = createFakeCrypto({ localDID: 'alice' })
    const bob = createFakeCrypto({ localDID: 'bob' })
    // An unwrap that discards the recovered sender (returns bare bytes, no senderDID).
    const senderlessUnwrap = async (bytes: Uint8Array): Promise<Uint8Array> => {
      const result = await bob.unwrap(bytes)
      return result instanceof Uint8Array ? result : result.payload
    }
    const bobView = sealDirectedHub({ hub, wrap: bob.wrap, unwrap: senderlessUnwrap })
    hub.subscribe('bob', 't')
    const sub = bobView.receive('bob')
    await hub.publish({ senderDID: 'hub', topicID: 't', payload: await alice.wrap(PLAINTEXT) })
    const race = await Promise.race([
      sub[Symbol.asyncIterator]()
        .next()
        .then(() => 'delivered'),
      new Promise((resolve) => setTimeout(() => resolve('dropped'), 50)),
    ])
    expect(race).toBe('dropped')
  })
})
