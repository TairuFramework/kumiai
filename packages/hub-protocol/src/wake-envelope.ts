import { gcm } from '@noble/ciphers/aes.js'
import { p256 } from '@noble/curves/nist.js'
import { expand, extract } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { randomBytes } from '@noble/hashes/utils.js'

/** The hint schema version, carried INSIDE the sealed JSON as `v`. */
export const WAKE_HINT_VERSION = 1

/**
 * The aes128gcm record size, carried as the header's `rs`. Every sealed body is padded to it, so
 * its length says nothing about the topic or the count. A body is 597 bytes at this size — far
 * under Web Push's 4096 limit.
 */
export const WAKE_RECORD_SIZE = 512

/** What the device learns from a wake, once it has opened it. */
export type WakeHint = {
  /** The topic the frame landed on. The device maps it to a group locally; that map never leaves. */
  topicID: string
  sequenceID: string
  /** Frames seen for this device since its LAST wake ping — not its total backlog. */
  count: number
}

export type WakeRecipient = {
  /** Raw uncompressed P-256 point, 65 bytes. */
  publicKey: Uint8Array
  /** 16 bytes. */
  authSecret: Uint8Array
}

export type WakeOpener = {
  privateKey: Uint8Array
  authSecret: Uint8Array
}

/**
 * base64url, via `atob`/`btoa` rather than `Buffer`: this module is imported by hub-client, which
 * runs under React Native, and by hub-protocol's own `src`, which has no Node types.
 */
export function encodeBase64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export function decodeBase64url(value: string): Uint8Array {
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'))
  const out = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) out[index] = binary.charCodeAt(index)
  return out
}

const KEY_INFO_PREFIX = new TextEncoder().encode('WebPush: info')
const CEK_INFO = new TextEncoder().encode('Content-Encoding: aes128gcm\0')
const NONCE_INFO = new TextEncoder().encode('Content-Encoding: nonce\0')
const RECORD_DELIMITER = 2

function concat(...parts: Array<Uint8Array>): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

// RFC 8291 section 3.4 then RFC 8188 section 2.2: the auth secret salts the ECDH extract, and the
// resulting IKM is what the content-encoding's own salt then extracts over.
function deriveKeys(
  sharedSecret: Uint8Array,
  authSecret: Uint8Array,
  uaPublic: Uint8Array,
  asPublic: Uint8Array,
  salt: Uint8Array,
): { cek: Uint8Array; nonce: Uint8Array } {
  const prkKey = extract(sha256, sharedSecret, authSecret)
  const keyInfo = concat(KEY_INFO_PREFIX, new Uint8Array([0]), uaPublic, asPublic)
  const ikm = expand(sha256, prkKey, keyInfo, 32)
  const prk = extract(sha256, ikm, salt)
  return {
    cek: expand(sha256, prk, CEK_INFO, 16),
    nonce: expand(sha256, prk, NONCE_INFO, 12),
  }
}

/**
 * Seal an already-built RFC 8188 record — content followed by its delimiter octet, padded or not
 * — under `recipient`'s RFC 8291 `aes128gcm` scheme: ECDH P-256, HKDF-SHA256, then AES-128-GCM.
 * `recordSize` is carried in the header's `rs` field; it need not equal `record.length` (the RFC's
 * own worked example declares 4096 while sealing an unpadded, much shorter record).
 *
 * `sealWakeHint` is the only production caller. Test code reaches this directly to reproduce RFC
 * 8291 section 5's worked example without going through wake-hint padding, and every field here
 * is a public-key operation on caller-supplied bytes — there is no wake-specific bypass to guard.
 */
export function sealRecord(
  record: Uint8Array,
  recordSize: number,
  recipient: WakeRecipient,
  overrides: { senderPrivateKey?: Uint8Array; salt?: Uint8Array } = {},
): Uint8Array {
  const senderPrivate = overrides.senderPrivateKey ?? p256.utils.randomSecretKey()
  const senderPublic = p256.getPublicKey(senderPrivate, false)
  const salt = overrides.salt ?? randomBytes(16)
  // getSharedSecret returns a point with a 1-byte prefix; RFC 8291 uses the X coordinate alone.
  const shared = p256.getSharedSecret(senderPrivate, recipient.publicKey, false).slice(1, 33)
  const { cek, nonce } = deriveKeys(
    shared,
    recipient.authSecret,
    recipient.publicKey,
    senderPublic,
    salt,
  )

  const rs = new Uint8Array(4)
  new DataView(rs.buffer).setUint32(0, recordSize)
  const header = concat(salt, rs, new Uint8Array([senderPublic.length]), senderPublic)
  return concat(header, gcm(cek, nonce).encrypt(record))
}

/**
 * Seal a hint for one device, RFC 8291 `aes128gcm`.
 *
 * The scheme is not a free choice: a browser refuses a Web Push body that does not decrypt this
 * way, and one implementation then serves web, Expo, and any later direct-APNs path.
 *
 * Takes no overrides ON PURPOSE. The sender keypair and the salt are the GCM key and nonce; a
 * caller that could pin either — and an object literal contextually types against a parameter, so
 * an unexported options type is no barrier at all — would reuse a key/nonce pair across devices,
 * which is catastrophic for GCM. Tests that need a fixed derivation call `sealRecord`, where every
 * input is already caller-supplied and nothing is defaulted.
 */
export function sealWakeHint(hint: WakeHint, recipient: WakeRecipient): Uint8Array {
  // RFC 8291 section 4: `rs` MUST be GREATER than plaintext + delimiter + padding + tag. The
  // record IS plaintext + delimiter + padding, so subtracting the 16-byte tag alone would make
  // them equal; the seventeenth byte is what makes the inequality strict.
  const recordLength = WAKE_RECORD_SIZE - 17

  // Pad to a fixed length so the body's SIZE carries no information about the hint's contents.
  const plaintext = new TextEncoder().encode(JSON.stringify({ v: WAKE_HINT_VERSION, ...hint }))
  if (plaintext.length + 1 > recordLength) {
    throw new Error(`Wake hint too large: ${plaintext.length + 1} > ${recordLength}`)
  }
  const record = new Uint8Array(recordLength)
  record.set(plaintext, 0)
  record[plaintext.length] = RECORD_DELIMITER

  return sealRecord(record, WAKE_RECORD_SIZE, recipient)
}

/** Open a sealed wake body. Throws on a bad key, a corrupt body, or an unknown hint version. */
export function openWakeHint(body: Uint8Array, opener: WakeOpener): WakeHint {
  const salt = body.subarray(0, 16)
  const keyIDLength = body[20]
  if (keyIDLength == null) {
    throw new Error('Wake body truncated')
  }
  const senderPublic = body.subarray(21, 21 + keyIDLength)
  const ciphertext = body.subarray(21 + keyIDLength)

  const uaPublic = p256.getPublicKey(opener.privateKey, false)
  const shared = p256.getSharedSecret(opener.privateKey, senderPublic, false).slice(1, 33)
  const { cek, nonce } = deriveKeys(shared, opener.authSecret, uaPublic, senderPublic, salt)
  const record = gcm(cek, nonce).decrypt(ciphertext)

  let end = record.length
  while (end > 0 && record[end - 1] === 0) end--
  if (record[end - 1] !== RECORD_DELIMITER) {
    throw new Error('Wake body has no record delimiter')
  }
  const parsed = JSON.parse(new TextDecoder().decode(record.subarray(0, end - 1))) as {
    v?: number
    topicID?: string
    sequenceID?: string
    count?: number
  }
  if (parsed.v !== WAKE_HINT_VERSION) {
    // Rejected rather than best-effort parsed, following TUNNEL_ENVELOPE_VERSION's precedent.
    throw new Error(`Unsupported wake hint version: ${String(parsed.v)}`)
  }
  if (
    typeof parsed.topicID !== 'string' ||
    typeof parsed.sequenceID !== 'string' ||
    typeof parsed.count !== 'number'
  ) {
    throw new Error('Malformed wake hint')
  }
  return { topicID: parsed.topicID, sequenceID: parsed.sequenceID, count: parsed.count }
}
