import type { MlsContext } from 'ts-mls'

/**
 * PrivateMessage sender-data decrypt, reimplemented from RFC 9420 §6.3.2.
 *
 * ts-mls ships `decryptSenderData` but does not re-export it (its `exports` map exposes
 * only `.`), so this package reproduces the derivation from primitives the live
 * `CiphersuiteImpl` does expose. Frozen wire format — see the backlog note
 * `ts-mls-v2-stable-upgrade.md`: delete this module and delegate to ts-mls once stable
 * re-exports its own.
 */

/** The PrivateMessage fields sender-data decrypt reads, narrowed off a decoded frame. */
export type PrivateCommitFrame = {
  groupId: Uint8Array
  epoch: bigint
  contentType: number
  encryptedSenderData: Uint8Array
  ciphertext: Uint8Array
}

const LABEL_PREFIX = new TextEncoder().encode('MLS 1.0 ')

function concat(parts: Array<Uint8Array>): Uint8Array {
  let length = 0
  for (const part of parts) length += part.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function uint16(n: number): Uint8Array {
  return new Uint8Array([(n >> 8) & 0xff, n & 0xff])
}

function uint64(n: bigint): Uint8Array {
  const out = new Uint8Array(8)
  let value = n
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(value & 0xffn)
    value >>= 8n
  }
  return out
}

/** RFC 9420 opaque<V>: QUIC-style variable-length prefix (RFC 9000 §16), then the bytes. */
function varLen(data: Uint8Array): Uint8Array {
  const len = data.length
  let prefix: Uint8Array
  if (len < 64) {
    prefix = new Uint8Array([len & 0x3f])
  } else if (len < 16384) {
    prefix = new Uint8Array([((len >> 8) & 0x3f) | 0x40, len & 0xff])
  } else if (len < 0x40000000) {
    prefix = new Uint8Array([
      ((len >> 24) & 0x3f) | 0x80,
      (len >> 16) & 0xff,
      (len >> 8) & 0xff,
      len & 0xff,
    ])
  } else {
    throw new Error('sender-data: length too large to encode')
  }
  return concat([prefix, data])
}

/**
 * MLS `ExpandWithLabel(Secret, Label, Context, Length)`: `KDF.Expand` over the KDFLabel
 * struct `{ uint16 length; opaque label<V> = "MLS 1.0 " + Label; opaque context<V> }`.
 */
function expandWithLabel(
  context: MlsContext,
  secret: Uint8Array,
  label: string,
  labelContext: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const kdfLabel = concat([
    uint16(length),
    varLen(concat([LABEL_PREFIX, new TextEncoder().encode(label)])),
    varLen(labelContext),
  ])
  return context.cipherSuite.kdf.expand(secret, kdfLabel, length)
}

/** The ciphertext sample the sender-data key/nonce derive from: the first `KDF.Nh` bytes. */
function sample(context: MlsContext, ciphertext: Uint8Array): Uint8Array {
  const size = context.cipherSuite.kdf.size
  return ciphertext.length < size ? ciphertext : ciphertext.subarray(0, size)
}

/**
 * Decrypt a PrivateMessage's sender-data and return the committer's leaf index, or `null`
 * if the AEAD refuses the bytes or the plaintext is malformed. Non-mutating: the
 * sender-data secret is epoch-level and consumes no per-message ratchet key.
 */
export async function readSenderLeafIndex(
  context: MlsContext,
  senderDataSecret: Uint8Array,
  pm: PrivateCommitFrame,
): Promise<number | null> {
  const { hpke } = context.cipherSuite
  const sampled = sample(context, pm.ciphertext)
  const key = await expandWithLabel(context, senderDataSecret, 'key', sampled, hpke.keyLength)
  const nonce = await expandWithLabel(context, senderDataSecret, 'nonce', sampled, hpke.nonceLength)
  // SenderDataAAD = { opaque group_id<V>; uint64 epoch; ContentType content_type (uint8) }.
  const aad = concat([
    varLen(pm.groupId),
    uint64(pm.epoch),
    new Uint8Array([pm.contentType & 0xff]),
  ])
  let plaintext: Uint8Array
  try {
    plaintext = await hpke.decryptAead(key, nonce, aad, pm.encryptedSenderData)
  } catch {
    return null
  }
  // SenderData = { uint32 leaf_index; uint32 generation; opaque reuse_guard[4] }.
  if (plaintext.length < 4) return null
  return new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength).getUint32(0)
}
