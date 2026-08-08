import { p256 } from '@noble/curves/nist.js'
import { describe, expect, test } from 'vitest'

import { openWakeHint, sealWakeHint, WAKE_HINT_VERSION } from '../src/wake-envelope.js'

const b64uToBytes = (value: string) => new Uint8Array(Buffer.from(value, 'base64url'))
const bytesToB64u = (value: Uint8Array) => Buffer.from(value).toString('base64url')

function createRecipient() {
  const privateKey = p256.utils.randomSecretKey()
  return {
    privateKey,
    publicKey: p256.getPublicKey(privateKey, false),
    authSecret: crypto.getRandomValues(new Uint8Array(16)),
  }
}

describe('sealWakeHint', () => {
  // The published worked example from RFC 8291 section 5. Reproducing it byte for byte is what
  // proves the key derivation matches every browser's, rather than merely round-tripping against
  // our own opener.
  test('reproduces the RFC 8291 section 5 test vector', () => {
    const body = sealWakeHint(
      { topicID: 'unused', sequenceID: 'unused', count: 1 },
      {
        publicKey: b64uToBytes(
          'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
        ),
        authSecret: b64uToBytes('BTBZMqHH6r4Tts7J_aSIgg'),
      },
      {
        // Test-only overrides. Production callers never pass these.
        senderPrivateKey: b64uToBytes('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
        salt: b64uToBytes('DGv6ra1nlYgDCS1FRnbzlw'),
        recordSize: 4096,
        plaintext: new TextEncoder().encode('When I grow up, I want to be a watermelon'),
      },
    )
    expect(bytesToB64u(body)).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    )
  })

  test('round-trips a hint', () => {
    const recipient = createRecipient()
    const hint = { topicID: 'topic-a', sequenceID: '000000000042', count: 3 }
    const body = sealWakeHint(hint, recipient)
    expect(openWakeHint(body, recipient)).toEqual(hint)
  })

  // The body's LENGTH is the one thing padding cannot hide by accident. A provider that could see
  // a longer body for a longer topic would be reading topic length off the wire.
  test('body size does not vary with hint contents', () => {
    const recipient = createRecipient()
    const short = sealWakeHint({ topicID: 'ab', sequenceID: '1', count: 1 }, recipient)
    const long = sealWakeHint(
      { topicID: 'x'.repeat(256), sequenceID: '0'.repeat(32), count: 9999 },
      recipient,
    )
    expect(short.length).toBe(long.length)
  })

  test('refuses a hint too large for the record', () => {
    const recipient = createRecipient()
    expect(() =>
      sealWakeHint({ topicID: 'x'.repeat(600), sequenceID: '1', count: 1 }, recipient),
    ).toThrow(/too large/)
  })
})

describe('openWakeHint', () => {
  test('fails under the wrong key', () => {
    const body = sealWakeHint({ topicID: 'a', sequenceID: '1', count: 1 }, createRecipient())
    expect(() => openWakeHint(body, createRecipient())).toThrow()
  })

  test('rejects an unknown hint version', () => {
    const recipient = createRecipient()
    const body = sealWakeHint({ topicID: 'a', sequenceID: '1', count: 1 }, recipient, {
      plaintext: new TextEncoder().encode(
        JSON.stringify({ v: WAKE_HINT_VERSION + 1, topicID: 'a', sequenceID: '1', count: 1 }),
      ),
    })
    expect(() => openWakeHint(body, recipient)).toThrow(/version/)
  })
})
