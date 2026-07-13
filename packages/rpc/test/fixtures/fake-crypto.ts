import type { Unwrap } from '@kumiai/broadcast'
import { fromUTF, toUTF } from '@sozai/codec'

import type { GroupCrypto } from '../../src/crypto.js'

export type FakeCryptoOptions = {
  epoch?: number
  secret?: Uint8Array
  /** XOR key byte. Must be non-zero to be observable. Shared by all members. */
  key?: number
  /** The local member DID stamped into every wrapped message. */
  localDID?: string
}

export type FakeCrypto = GroupCrypto & { setEpoch: (n: number) => void }

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
 * NOT real encryption. All members in a test share `key` so they can decrypt each other
 * at a shared epoch; different keys model different groups.
 */
export function createFakeCrypto(options: FakeCryptoOptions = {}): FakeCrypto {
  let epoch = options.epoch ?? 1
  const secret = options.secret ?? new Uint8Array(32).fill(0xab)
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
    exportSecret: () => secret,
    wrap,
    unwrap,
    setEpoch: (n) => {
      epoch = n
    },
  }
}
