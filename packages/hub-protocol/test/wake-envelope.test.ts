import { p256 } from '@noble/curves/nist.js'
import { describe, expect, test } from 'vitest'

import {
  openWakeHint,
  sealRecord,
  sealWakeHint,
  WAKE_HINT_VERSION,
  WAKE_RECORD_SIZE,
} from '../src/wake-envelope.js'

const b64uToBytes = (value: string) => new Uint8Array(Buffer.from(value, 'base64url'))
const bytesToB64u = (value: Uint8Array) => Buffer.from(value).toString('base64url')

// RFC 8188 section 2: the last (and, for a single-record aes128gcm body, only) record ends with a
// 0x02 delimiter octet. No padding is required beyond it.
const RECORD_DELIMITER = 2

function buildRecord(plaintext: Uint8Array): Uint8Array {
  const record = new Uint8Array(plaintext.length + 1)
  record.set(plaintext, 0)
  record[plaintext.length] = RECORD_DELIMITER
  return record
}

function createRecipient() {
  const privateKey = p256.utils.randomSecretKey()
  return {
    privateKey,
    publicKey: p256.getPublicKey(privateKey, false),
    authSecret: crypto.getRandomValues(new Uint8Array(16)),
  }
}

describe('sealWakeHint', () => {
  // The published worked example from RFC 8291 section 5, sealed via sealRecord directly since
  // sealWakeHint always pads to a fixed record length and the RFC's own record is unpadded.
  // Reproducing it byte for byte is what proves the key derivation matches every browser's,
  // rather than merely round-tripping against our own opener.
  test('reproduces the RFC 8291 section 5 test vector', () => {
    const record = buildRecord(
      new TextEncoder().encode('When I grow up, I want to be a watermelon'),
    )
    const body = sealRecord(
      record,
      4096,
      {
        publicKey: b64uToBytes(
          'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
        ),
        authSecret: b64uToBytes('BTBZMqHH6r4Tts7J_aSIgg'),
      },
      {
        senderPrivateKey: b64uToBytes('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
        salt: b64uToBytes('DGv6ra1nlYgDCS1FRnbzlw'),
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
  // a longer body for a longer topic would be reading topic length off the wire. The exact byte
  // count (86-byte header + 496-byte padded record + 16-byte GCM tag) makes that assertion
  // verifiable rather than merely self-consistent.
  test('body size does not vary with hint contents', () => {
    const recipient = createRecipient()
    const short = sealWakeHint({ topicID: 'ab', sequenceID: '1', count: 1 }, recipient)
    const long = sealWakeHint(
      { topicID: 'x'.repeat(256), sequenceID: '0'.repeat(32), count: 9999 },
      recipient,
    )
    expect(short.length).toBe(598)
    expect(long.length).toBe(598)
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
    const record = buildRecord(
      new TextEncoder().encode(
        JSON.stringify({ v: WAKE_HINT_VERSION + 1, topicID: 'a', sequenceID: '1', count: 1 }),
      ),
    )
    const body = sealRecord(record, WAKE_RECORD_SIZE, recipient)
    expect(() => openWakeHint(body, recipient)).toThrow(/version/)
  })
})
