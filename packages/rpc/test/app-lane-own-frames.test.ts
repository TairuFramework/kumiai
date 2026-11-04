import { encodeEventFrame } from '@kumiai/broadcast'
import { expect, test, vi } from 'vitest'

import { encodeAppAAD } from '../src/app-aad.js'
import type { GroupCrypto } from '../src/crypto.js'
import { APP_TOPIC_LABEL, protocolTopic } from '../src/topic.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import {
  createDurableTestCrypto,
  createFakeCrypto,
  fakeEpochSecret,
} from './fixtures/fake-crypto.js'
import { makeMLSPeer } from './fixtures/peer.js'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

test('the app-log drain never opens a frame the hub attributes to this member', async () => {
  const hub = new DurableFakeHub()
  const topicID = protocolTopic(fakeEpochSecret(1, APP_TOPIC_LABEL), 1, 'chat')
  const aad = encodeAppAAD({ topicID, intent: 'log' })

  // A member reads its own retained frames back on a history pull. MLS cannot open a message
  // its own sender ratchet sealed, so opening one is a guaranteed failure reported as an open
  // failure, never a delivery.
  const bobSealed = await createFakeCrypto({ epoch: 1, localDID: 'bob' }).wrap(
    encodeEventFrame('chat/posted', { text: 'mine' }),
    { aad },
  )
  await hub.publish({ senderDID: 'bob', topicID, payload: bobSealed, retain: 'log' })
  const carolSealed = await createFakeCrypto({ epoch: 1, localDID: 'carol' }).wrap(
    encodeEventFrame('chat/posted', { text: 'from carol' }),
    { aad },
  )
  await hub.publish({ senderDID: 'carol', topicID, payload: carolSealed, retain: 'log' })

  const base = createDurableTestCrypto({ epoch: 1, localDID: 'bob' })
  const opened: Array<Uint8Array> = []
  const crypto: typeof base = Object.assign(Object.create(base) as typeof base, {
    unwrap: ((bytes, opts) => {
      opened.push(bytes)
      return base.unwrap(bytes, opts)
    }) satisfies GroupCrypto['unwrap'],
  })
  const seen: Array<unknown> = []
  const bob = makeMLSPeer(hub, 'bob', new Uint8Array(32).fill(0x77), {
    epoch: 1,
    crypto,
    handlers: { 'chat/posted': (ctx: { data: unknown }) => void seen.push(ctx.data) },
  })
  await vi.waitFor(() => expect(seen).toEqual([{ text: 'from carol' }]))

  expect(seen).toEqual([{ text: 'from carol' }])
  expect(opened).toEqual([carolSealed])

  // Skipped, not stuck: the cursor passed it, so a restart reads neither frame again.
  await bob.peer.dispose()
  const restarted = makeMLSPeer(hub, 'bob', new Uint8Array(32).fill(0x77), {
    restartOf: bob,
    handlers: { 'chat/posted': (ctx: { data: unknown }) => void seen.push(ctx.data) },
  })
  await flush()
  expect(seen).toEqual([{ text: 'from carol' }])
  expect(opened).toEqual([carolSealed])

  await restarted.peer.dispose()
})
