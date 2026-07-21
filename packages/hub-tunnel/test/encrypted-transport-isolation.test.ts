import { describe, expect, test } from 'vitest'

import { createEncryptedHubTunnelTransport } from '../src/encrypted-transport.js'
import { DecryptError } from '../src/errors.js'
import type { ObservabilityEvent } from '../src/events.js'
import { FakeEncryptor } from './fixtures/fake-encryptor.js'
import { FakeHub } from './fixtures/fake-hub.js'

const OUR_KEY = new Uint8Array([0x42, 0x13, 0x37, 0x99])
const FOREIGN_KEY = new Uint8Array([0x7b, 0xc1, 0x0e, 0x54])

type Msg = { header: Record<string, unknown>; payload: { typ: string; msg: string } }

describe('createEncryptedHubTunnelTransport cross-group isolation', () => {
  test('a frame encrypted under a foreign key is rejected on the receive path', async () => {
    const hub = new FakeHub()
    const sessionID = 'session-isolation-key'
    const groupID = 'group-isolation'
    const foreignDID = 'did:peer:foreign'
    const ourDID = 'did:peer:ours'
    const receiverDID = 'did:peer:receiver'
    const inboundTopic = 'topic:inbound'
    const outboundTopic = 'topic:outbound'

    const events: Array<ObservabilityEvent> = []

    const receiverTransport = createEncryptedHubTunnelTransport<Msg, Msg>({
      hub,
      sessionID,
      localDID: receiverDID,
      sendTopicID: outboundTopic,
      receiveTopicID: inboundTopic,
      encryptor: new FakeEncryptor({ key: OUR_KEY }),
      groupID,
      onEvent: (event) => {
        events.push(event)
      },
    })
    // WHY: same group, same session, same topic — the ONLY thing that differs is the key, so
    // nothing but the cipher's authentication can reject this frame.
    const foreignTransport = createEncryptedHubTunnelTransport<Msg, Msg>({
      hub,
      sessionID,
      localDID: foreignDID,
      sendTopicID: inboundTopic,
      receiveTopicID: outboundTopic,
      encryptor: new FakeEncryptor({ key: FOREIGN_KEY }),
      groupID,
    })
    const ourTransport = createEncryptedHubTunnelTransport<Msg, Msg>({
      hub,
      sessionID,
      localDID: ourDID,
      sendTopicID: inboundTopic,
      receiveTopicID: outboundTopic,
      encryptor: new FakeEncryptor({ key: OUR_KEY }),
      groupID,
    })

    try {
      await foreignTransport.write({ header: {}, payload: { typ: 'test', msg: 'foreign' } })
      await ourTransport.write({ header: {}, payload: { typ: 'test', msg: 'ours' } })

      const received = await receiverTransport.read()
      expect(received.done).toBe(false)
      expect(received.value?.payload.msg).toBe('ours')

      const decryptFailed = events.filter((e) => e.type === 'decrypt-failed')
      expect(decryptFailed.length).toBe(1)
      const first = decryptFailed[0]
      if (first?.type !== 'decrypt-failed') throw new Error('expected decrypt-failed')
      expect(first.error).toBeInstanceOf(DecryptError)
      expect(
        events.filter((e) => e.type === 'frame-dropped' && e.reason === 'decrypt').length,
      ).toBe(1)
    } finally {
      for (const transport of [receiverTransport, foreignTransport, ourTransport]) {
        try {
          await transport.dispose()
        } catch {
          // ignore
        }
      }
      hub.disconnect(receiverDID)
      hub.disconnect(foreignDID)
      hub.disconnect(ourDID)
    }
  })

  test('a frame for another groupID is dropped even though it decrypts cleanly', async () => {
    const hub = new FakeHub()
    const sessionID = 'session-isolation-group'
    const ourGroupID = 'group-ours'
    const otherGroupID = 'group-theirs'
    const otherDID = 'did:peer:other-group'
    const ourDID = 'did:peer:same-group'
    const receiverDID = 'did:peer:receiver'
    const inboundTopic = 'topic:inbound'
    const outboundTopic = 'topic:outbound'

    const events: Array<ObservabilityEvent> = []

    const receiverTransport = createEncryptedHubTunnelTransport<Msg, Msg>({
      hub,
      sessionID,
      localDID: receiverDID,
      sendTopicID: outboundTopic,
      receiveTopicID: inboundTopic,
      encryptor: new FakeEncryptor({ key: OUR_KEY }),
      groupID: ourGroupID,
      onEvent: (event) => {
        events.push(event)
      },
    })
    // WHY: same key and same session — this frame decrypts and parses cleanly. Only the envelope's
    // groupID says it is not ours, which is exactly the misroute the cipher cannot see.
    const otherGroupTransport = createEncryptedHubTunnelTransport<Msg, Msg>({
      hub,
      sessionID,
      localDID: otherDID,
      sendTopicID: inboundTopic,
      receiveTopicID: outboundTopic,
      encryptor: new FakeEncryptor({ key: OUR_KEY }),
      groupID: otherGroupID,
    })
    const ourTransport = createEncryptedHubTunnelTransport<Msg, Msg>({
      hub,
      sessionID,
      localDID: ourDID,
      sendTopicID: inboundTopic,
      receiveTopicID: outboundTopic,
      encryptor: new FakeEncryptor({ key: OUR_KEY }),
      groupID: ourGroupID,
    })

    try {
      await otherGroupTransport.write({ header: {}, payload: { typ: 'test', msg: 'theirs' } })
      await ourTransport.write({ header: {}, payload: { typ: 'test', msg: 'ours' } })

      const received = await receiverTransport.read()
      expect(received.done).toBe(false)
      expect(received.value?.payload.msg).toBe('ours')

      expect(
        events.filter((e) => e.type === 'frame-dropped' && e.reason === 'group-mismatch').length,
      ).toBe(1)
      expect(events.filter((e) => e.type === 'decrypt-failed').length).toBe(0)
    } finally {
      for (const transport of [receiverTransport, otherGroupTransport, ourTransport]) {
        try {
          await transport.dispose()
        } catch {
          // ignore
        }
      }
      hub.disconnect(receiverDID)
      hub.disconnect(otherDID)
      hub.disconnect(ourDID)
    }
  })
})
