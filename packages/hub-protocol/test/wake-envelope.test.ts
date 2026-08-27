import { p256 } from '@noble/curves/nist.js'
import { describe, expect, test } from 'vitest'

import {
  openWakeHint,
  sealRecord,
  sealWakeHint,
  WAKE_HINT_VERSION,
  WAKE_RECORD_SIZE,
  wakeRecipientKeyProblem,
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
  // count (86-byte header + 495-byte padded record + 16-byte GCM tag) makes that assertion
  // verifiable rather than merely self-consistent.
  test('body size does not vary with hint contents', () => {
    const recipient = createRecipient()
    const short = sealWakeHint({ topicID: 'ab', sequenceID: '1', count: 1 }, recipient)
    const long = sealWakeHint(
      { topicID: 'x'.repeat(256), sequenceID: '0'.repeat(32), count: 9999 },
      recipient,
    )
    expect(short.length).toBe(597)
    expect(long.length).toBe(597)
  })

  // RFC 8291 section 4: "An application server MUST set the 'rs' parameter ... to a size that is
  // greater than the sum of the lengths of the plaintext, the padding delimiter (1 octet), any
  // padding, and the authentication tag (16 octets)." That whole sum IS the ciphertext length, so
  // the MUST reduces to `rs > ciphertext.length` — and it must be strict. Chromium and http_ece
  // tolerate equality; a stricter user agent refusing it would be a silent 100% delivery failure
  // on the web target, with nothing here to say why.
  test('the declared rs is STRICTLY greater than the ciphertext it describes (RFC 8291 section 4)', () => {
    const recipient = createRecipient()
    const body = sealWakeHint({ topicID: 'topic-a', sequenceID: '1', count: 1 }, recipient)

    const rs = new DataView(body.buffer, body.byteOffset).getUint32(16)
    expect(rs).toBe(WAKE_RECORD_SIZE)
    const keyIDLength = body[20]
    const ciphertextLength = body.length - (21 + keyIDLength)
    expect(rs).toBeGreaterThan(ciphertextLength)
  })

  // The randomness that makes each seal unique is the sender keypair and the salt — together the
  // AES-GCM key and nonce. Pinning either (which a caller could do while `sealWakeHint` still took
  // overrides) reuses one key/nonce pair across every wake to every device, which forfeits GCM's
  // integrity and confidentiality outright. Identical inputs producing identical bytes is the
  // observable symptom.
  test('sealing the same hint for the same recipient twice produces different bytes', () => {
    const recipient = createRecipient()
    const hint = { topicID: 'topic-a', sequenceID: '001', count: 1 }
    const first = sealWakeHint(hint, recipient)
    const second = sealWakeHint(hint, recipient)

    expect(first.length).toBe(second.length)
    expect(Array.from(first)).not.toEqual(Array.from(second))
    // Named explicitly so a failure says WHICH input stopped varying: the salt is the first 16
    // bytes of the header, the sender public key the 65 that follow the key-id length.
    expect(Array.from(first.subarray(0, 16))).not.toEqual(Array.from(second.subarray(0, 16)))
    expect(Array.from(first.subarray(21, 86))).not.toEqual(Array.from(second.subarray(21, 86)))
    // Both still open: varying inputs must not have broken the derivation.
    expect(openWakeHint(second, recipient)).toEqual(hint)
  })

  test('refuses a hint too large for the record', () => {
    const recipient = createRecipient()
    expect(() =>
      sealWakeHint({ topicID: 'x'.repeat(600), sequenceID: '1', count: 1 }, recipient),
    ).toThrow(/too large/)
  })

  // The schema now caps `topicID` at 43 base64url characters (`topicIDSchema` in protocol.ts), so
  // no wire value reaches this size. Pinned anyway as headroom: the seal record holds far more than
  // the schema admits, and 256 ASCII characters — roughly six times the cap — still seals with room
  // to spare.
  test('seals a 256-ASCII-character topicID: raw record headroom above the 43-char schema cap', () => {
    const recipient = createRecipient()
    const hint = { topicID: 'x'.repeat(256), sequenceID: '000000000042', count: 9999 }
    expect(() => sealWakeHint(hint, recipient)).not.toThrow()
    expect(openWakeHint(sealWakeHint(hint, recipient), recipient)).toEqual(hint)
  })

  // The record's raw ASCII ceiling, pinned so it cannot drift silently. 433 is derived from this
  // hint's fixed 12-character `sequenceID` and 4-digit `count`; a longer sequenceID from a host
  // store spends the slack one byte for one byte. The schema caps `topicID` at 43 base64url
  // characters, so this ceiling is now headroom the wire never approaches — but if this number ever
  // moves, the hint's shape moved with it.
  test('the record holds a 433-character ASCII topicID, and refuses 434', () => {
    const recipient = createRecipient()
    const at = (length: number) => ({
      topicID: 'x'.repeat(length),
      sequenceID: '000000000042',
      count: 9999,
    })
    expect(() => sealWakeHint(at(433), recipient)).not.toThrow()
    expect(() => sealWakeHint(at(434), recipient)).toThrow(/too large/)
  })

  // The record holds JSON bytes, and byte cost per character is what turns one into many. `"`, `\`
  // and `\n` cost 2 (JSON escape) and cap the record at 216; a raw CJK character costs 3 (UTF-8)
  // and caps it at 144; a control character with no short escape serialises as a six-byte `\uXXXX`
  // and caps it at 72; a non-BMP character (an emoji, a surrogate pair) costs 4 (UTF-8) and caps it
  // at 108. None of these characters is schema-legal in a topicID any more — `topicIDSchema`'s
  // `pattern` admits only base64url — so no such value can reach the record over the wire. They are
  // pinned as the seal function's own last-line byte guard, below the 43-character cap: the fix
  // that closed the hazard was that pattern, not a bigger record, since inflating every body to
  // ~1700 bytes for a case the schema now forbids would trade the constant, small ciphertext this
  // design is built on for nothing. All four ceilings are pinned below so none of them can drift
  // silently.
  test('a 256-character topicID of JSON-escaping characters does NOT fit', () => {
    const recipient = createRecipient()
    const hint = { topicID: '"'.repeat(256), sequenceID: '000000000042', count: 9999 }
    expect(() => sealWakeHint(hint, recipient)).toThrow(/too large/)
    // …and where that ceiling actually sits for a 2-byte escape.
    expect(() => sealWakeHint({ ...hint, topicID: '"'.repeat(216) }, recipient)).not.toThrow()
    expect(() => sealWakeHint({ ...hint, topicID: '"'.repeat(217) }, recipient)).toThrow(
      /too large/,
    )
  })

  test('a raw CJK topicID (3-byte UTF-8) seals at 144 and refuses 145', () => {
    const recipient = createRecipient()
    const at = (length: number) => ({
      topicID: '龍'.repeat(length),
      sequenceID: '000000000042',
      count: 9999,
    })
    expect(() => sealWakeHint(at(144), recipient)).not.toThrow()
    expect(() => sealWakeHint(at(145), recipient)).toThrow(/too large/)
  })

  test('a control character with no short JSON escape (six-byte \\u) seals at 72 and refuses 73', () => {
    const recipient = createRecipient()
    const at = (length: number) => ({
      topicID: String.fromCharCode(1).repeat(length),
      sequenceID: '000000000042',
      count: 9999,
    })
    expect(() => sealWakeHint(at(72), recipient)).not.toThrow()
    expect(() => sealWakeHint(at(73), recipient)).toThrow(/too large/)
  })

  // The character class whose byte cost diverges most sharply from its code-point count: a non-BMP
  // character costs 4 UTF-8 bytes but is 1 code point. No longer schema-legal (the pattern admits
  // only base64url); pinned as the record's own byte guard.
  test('a non-BMP topicID (4-byte UTF-8 surrogate pair) seals at 108 and refuses 109', () => {
    const recipient = createRecipient()
    const at = (length: number) => ({
      topicID: '\u{1F600}'.repeat(length),
      sequenceID: '000000000042',
      count: 9999,
    })
    expect(() => sealWakeHint(at(108), recipient)).not.toThrow()
    expect(() => sealWakeHint(at(109), recipient)).toThrow(/too large/)
  })
})

describe('wakeRecipientKeyProblem', () => {
  test('accepts real RFC 8291 material', () => {
    const recipient = createRecipient()
    expect(
      wakeRecipientKeyProblem({
        publicKey: bytesToB64u(recipient.publicKey),
        authSecret: bytesToB64u(recipient.authSecret),
      }),
    ).toBeNull()
  })

  test('rejects a wrong-length publicKey, including a compressed point', () => {
    const recipient = createRecipient()
    const authSecret = bytesToB64u(recipient.authSecret)
    expect(wakeRecipientKeyProblem({ publicKey: 'AAAA', authSecret })).toMatch(/65-byte/)
    // 33 bytes is a valid P-256 point in compressed form — and exactly what a caller reaching for
    // the wrong noble flag produces. RFC 8291 wants the uncompressed encoding.
    const compressed = p256.getPublicKey(recipient.privateKey, true)
    expect(compressed).toHaveLength(33)
    expect(wakeRecipientKeyProblem({ publicKey: bytesToB64u(compressed), authSecret })).toMatch(
      /65-byte/,
    )
  })

  // The case a length check alone cannot see: 65 bytes, correct 0x04 prefix, not on the curve.
  // It fails inside `sealWakeHint` exactly as a short key does, and just as silently.
  test('rejects 65 bytes that are not a point on P-256', () => {
    const recipient = createRecipient()
    const offCurve = new Uint8Array(65).fill(7)
    offCurve[0] = 4
    expect(
      wakeRecipientKeyProblem({
        publicKey: bytesToB64u(offCurve),
        authSecret: bytesToB64u(recipient.authSecret),
      }),
    ).toMatch(/not a point/)
    // The premise: these bytes really do break the seal, so refusing them is refusing a failure.
    expect(() =>
      sealWakeHint(
        { topicID: 'a', sequenceID: '1', count: 1 },
        {
          publicKey: offCurve,
          authSecret: recipient.authSecret,
        },
      ),
    ).toThrow()
  })

  test('rejects a wrong-length authSecret', () => {
    const recipient = createRecipient()
    expect(
      wakeRecipientKeyProblem({
        publicKey: bytesToB64u(recipient.publicKey),
        authSecret: 'BBBB',
      }),
    ).toMatch(/16 bytes/)
  })

  test('rejects material that is not base64url at all', () => {
    const recipient = createRecipient()
    expect(
      wakeRecipientKeyProblem({
        publicKey: '!!!not base64!!!',
        authSecret: bytesToB64u(recipient.authSecret),
      }),
    ).toMatch(/base64url/)
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
