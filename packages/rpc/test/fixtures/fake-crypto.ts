import type { Unwrap } from '@kumiai/broadcast'
import { fromUTF, toUTF } from '@sozai/codec'

import type { GroupCrypto } from '../../src/crypto.js'
import { decodeMemoryCommit } from './memory-group-mls.js'

export type FakeCryptoOptions = {
  epoch?: number
  /** The base `exportSecret` is derived from, per epoch. Defaults to {@link FAKE_BASE_SECRET}. */
  secret?: Uint8Array
  /** XOR key byte. Must be non-zero to be observable. Shared by all members. */
  key?: number
  /** The local member DID stamped into every wrapped message. */
  localDID?: string
}

export type FakeCrypto = GroupCrypto & { setEpoch: (n: number) => void }

/** The base secret every fake member shares, so members at the same epoch export the same bytes. */
export const FAKE_BASE_SECRET = new Uint8Array(32).fill(0xab)

/**
 * What {@link createFakeCrypto} exports at `epoch`: the base secret with the epoch mixed in, so
 * that a different epoch is different bytes. That one property is the whole of it, and the port
 * contract names it — `exportSecret` is an epoch-bound topic-derivation secret, and a fake that
 * returned a fixed value would be a lifelong secret plus a guessable epoch number, the exact
 * shape the app-lane topic must not have.
 *
 * Exported because a test that wants the topic the group is on needs the secret of the ANCHOR
 * epoch, which the live handle has usually run past — the same reason the anchor is persisted.
 *
 * A mix, NOT a ratchet: it models none of MLS's one-wayness, and a member holding one epoch's
 * bytes can trivially compute another's. That truth is real only where the crypto is (see
 * `@kumiai/mls`); here the fake is a double for wiring and must not pretend otherwise.
 */
export function fakeEpochSecret(epoch: number, base: Uint8Array = FAKE_BASE_SECRET): Uint8Array {
  const out = new Uint8Array(base.length)
  for (let i = 0; i < base.length; i++) out[i] = (base[i] as number) ^ ((epoch + i) & 0xff)
  return out
}

/**
 * Deterministic GroupCrypto for tests. `wrap` seals under the CURRENT epoch's key:
 * `[epoch(2)][ xor( [didLen][localDID][payload], key ^ epoch ) ]`; `unwrap` reverses it
 * and returns the recovered `localDID` as `senderDID` — modelling MLS authenticating the
 * sender from the ciphertext.
 *
 * The epoch is load-bearing, not decoration: an MLS member holds the epoch secret of the
 * epoch it is AT, so bytes sealed under any other epoch will not open for it — including
 * every frame from before it joined. `unwrap` throws for those, which is what a member
 * walking a log full of them has to survive without calling them corrupt.
 *
 * CURRENT EPOCH ONLY, and it must stay that way — because that is what the real port does too,
 * not because it is a margin. ts-mls is documented as retaining a few epochs' key material, but
 * nothing reaches it through this surface: a real `unwrap` goes through ts-mls's `processMessage`,
 * which resolves against the CURRENT epoch's secret tree alone. So this is the port contract in
 * `crypto.ts` enforced at parity, not above it: group-rpc may only ever require the current epoch,
 * and reads every retained frame ahead of the commit that ratchets past it. There is no safety
 * margin underneath, so loosening this would let in a dependency the real port cannot serve.
 *
 * NOT real encryption. All members in a test share `key` so they can decrypt each other
 * at a shared epoch; different keys model different groups.
 */
export function createFakeCrypto(options: FakeCryptoOptions = {}): FakeCrypto {
  let epoch = options.epoch ?? 1
  const secret = options.secret ?? FAKE_BASE_SECRET
  const key = options.key ?? 0x5a
  const localDID = options.localDID ?? ''

  const xor = (bytes: Uint8Array, at: number): Uint8Array => {
    const epochKey = (key ^ at) & 0xff
    const out = new Uint8Array(bytes.length)
    for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ epochKey
    return out
  }

  const wrap: GroupCrypto['wrap'] = (bytes) => {
    const did = fromUTF(localDID)
    const framed = new Uint8Array(2 + did.length + bytes.length)
    new DataView(framed.buffer).setUint16(0, did.length, true)
    framed.set(did, 2)
    framed.set(bytes, 2 + did.length)
    const sealed = new Uint8Array(2 + framed.length)
    new DataView(sealed.buffer).setUint16(0, epoch, true)
    sealed.set(xor(framed, epoch), 2)
    return sealed
  }

  /**
   * The epoch an MLS MESSAGE says it carries, read from its own cleartext — a stand-in for
   * `@kumiai/mls`'s `readMessageEpoch`, which reads the epoch field every MLSMessage has.
   *
   * BOTH message shapes, because the real one answers for both. A sealed app frame carries it in
   * the two bytes `wrap` writes in the clear; a COMMIT is an MLSMessage too and carries the same
   * field, so a caller bounding a claim against the commit log reads it from here rather than
   * asking a handle to authenticate a commit it is not yet at the epoch to authenticate. The two
   * encodings are distinct here only because the doubles are: in MLS they are one format with one
   * epoch field, and a fake that answered for only one of them would make the epoch of a commit
   * look unreadable when it is the most readable thing about it.
   *
   * Never throws, and answers for bytes this member cannot open — that is the whole of what it is
   * for. Bytes that are neither shape: `null`.
   *
   * STRUCTURE IS CHECKED, not just length. A sealed frame is `[epoch(2)][ xor([didLen(2)][did]
   * [payload]) ]`, so it is at least four bytes long and its own length holds the sender it
   * declares — a check every member can make, because the epoch and the XOR key are in the clear.
   * Without it any two bytes are an epoch, and garbage whose leading bytes read as a number the
   * commit log justifies is indistinguishable from a frame sealed ahead of the walk: the reader
   * keeps its place and the cursor rests behind it. The port's word for bytes that are not a
   * readable sealed frame is `null`, and a double that invents a plausible one instead is a double
   * that can never be asked this question.
   */
  const frameEpoch: GroupCrypto['frameEpoch'] = (bytes) => {
    const commit = decodeMemoryCommit(bytes)
    if (commit != null) return commit.epoch
    if (bytes.length < 4) return null
    const sealedAt = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(
      0,
      true,
    )
    const framed = xor(bytes.subarray(2), sealedAt)
    const didLen = new DataView(framed.buffer).getUint16(0, true)
    return 2 + didLen <= framed.length ? sealedAt : null
  }

  const unwrap: Unwrap = (bytes) => {
    if (bytes.length < 2) throw new Error('cannot open: not sealed bytes')
    const sealedAt = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(
      0,
      true,
    )
    if (sealedAt !== epoch) {
      // This member does not hold that epoch's secret — it is not at that epoch.
      throw new Error(`cannot open bytes sealed at epoch ${sealedAt}: this member is at ${epoch}`)
    }
    const framed = xor(bytes.subarray(2), sealedAt)
    const didLen = new DataView(framed.buffer, framed.byteOffset, framed.byteLength).getUint16(
      0,
      true,
    )
    const senderDID = toUTF(framed.subarray(2, 2 + didLen))
    const payload = framed.subarray(2 + didLen)
    return { payload, senderDID }
  }

  /**
   * The ledger-entry seal, modelled as a keystream XOR under a key derived from the epoch's
   * own secret, with a four-byte tag standing in for an AEAD's.
   *
   * The three properties the port requires, and the ones the tests here rest on:
   *
   * - PER-EPOCH: the key comes from {@link fakeEpochSecret}, so a member at another epoch derives
   *   a different one and its tag check fails.
   * - AGREED: every member at an epoch derives the same bytes from the base secret they share,
   *   with nothing exchanged.
   * - PURE: sealing and opening read `epoch` and touch nothing else, so opening twice gives the
   *   same answer. That is what lets it be called from inside a commit apply, which is the whole
   *   reason it is not `wrap`/`unwrap`.
   *
   * The tag is what makes "not my epoch" a REFUSAL rather than plausible garbage — an AEAD's
   * authentication, modelled — and the blob says nothing in the clear about which epoch it is
   * from, exactly as a real seal does not.
   */
  const entryKey = (at: number): Uint8Array => fakeEpochSecret(at, secret)

  const entryStream = (bytes: Uint8Array, key: Uint8Array): Uint8Array => {
    const out = new Uint8Array(bytes.length)
    for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ (key[i % key.length] as number)
    return out
  }

  const ENTRY_TAG_BYTES = 4

  const sealEntries: GroupCrypto['sealEntries'] = (bytes) => {
    const key = entryKey(epoch)
    const sealed = new Uint8Array(ENTRY_TAG_BYTES + bytes.length)
    sealed.set(key.subarray(0, ENTRY_TAG_BYTES), 0)
    sealed.set(entryStream(bytes, key), ENTRY_TAG_BYTES)
    return sealed
  }

  const openEntries: GroupCrypto['openEntries'] = (sealed) => {
    if (sealed.length < ENTRY_TAG_BYTES) throw new Error('cannot open: not a sealed entry blob')
    const key = entryKey(epoch)
    for (let i = 0; i < ENTRY_TAG_BYTES; i++) {
      if (sealed[i] !== key[i]) {
        throw new Error(`cannot open entry blob: this member is at epoch ${epoch}`)
      }
    }
    return entryStream(sealed.subarray(ENTRY_TAG_BYTES), key)
  }

  return {
    epoch: () => epoch,
    exportSecret: () => fakeEpochSecret(epoch, secret),
    wrap,
    unwrap,
    frameEpoch,
    sealEntries,
    openEntries,
    setEpoch: (n) => {
      epoch = n
    },
  }
}
