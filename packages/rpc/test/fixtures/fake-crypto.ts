import type { Unwrap } from '@kumiai/broadcast'
import { fromUTF, toUTF } from '@sozai/codec'

import type { GroupCrypto } from '../../src/crypto.js'

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
 * STRICTER THAN REAL MLS, deliberately, and it must stay that way. A real handle also opens a
 * few epochs BELOW its current one (ts-mls keeps four); this opens the current epoch and nothing
 * else. That is not an omission — it is the port contract in `crypto.ts` enforced: group-rpc may
 * only ever require the CURRENT epoch, and reads every retained frame ahead of the commit that
 * ratchets past it. Anything that passes against this fake therefore passes against a real
 * handle, whose window is a superset. Loosening it here would let a past-epoch dependency in
 * silently, and the walk spends the real window it would be leaning on.
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
   * The epoch a frame says it was sealed at, read from the two bytes `wrap` writes in the clear —
   * a stand-in for the epoch a real MLS PrivateMessage carries in its own cleartext (which is what
   * `@kumiai/mls`'s `readMessageEpoch` reads).
   *
   * Never throws, and answers for bytes this member cannot open — that is the whole of what it is
   * for. Bytes too short to hold the field are not a sealed frame: `null`.
   */
  const frameEpoch: GroupCrypto['frameEpoch'] = (bytes) => {
    if (bytes.length < 2) return null
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(0, true)
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

  return {
    epoch: () => epoch,
    exportSecret: () => fakeEpochSecret(epoch, secret),
    wrap,
    unwrap,
    frameEpoch,
    setEpoch: (n) => {
      epoch = n
    },
  }
}
