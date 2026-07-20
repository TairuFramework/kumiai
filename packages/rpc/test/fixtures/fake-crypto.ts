import type { Unwrap } from '@kumiai/broadcast'
import { sha256 } from '@noble/hashes/sha2.js'
import { fromUTF, toUTF } from '@sozai/codec'

import type { GroupCrypto } from '../../src/crypto.js'
import { APP_TOPIC_LABEL } from '../../src/topic.js'
import { decodeMemoryCommit } from './memory-group-mls.js'

export type FakeCryptoOptions = {
  epoch?: number
  /** The base `exportSecret` is derived from, per epoch AND per label. Defaults to {@link FAKE_BASE_SECRET}. */
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
 * What {@link createFakeCrypto} exports at `epoch` for `label`: the base secret with the epoch
 * AND the label mixed in, so a different epoch is different bytes and — the property the widened
 * port signature exists to provide — a different label at the SAME epoch is different bytes too.
 * A fake that mixed in only the epoch would be exactly the port this repo used to have: every
 * label collapsing onto one value, silent cross-domain key reuse the moment a second consumer
 * asked this method for anything. See `GroupCrypto.exportSecret`'s doc for why that must fail
 * loudly rather than quietly, and `@kumiai/rpc-conformance`'s `PER-LABEL` clause (in
 * `group-crypto.ts`) for the exact property this is pinned against.
 *
 * `label` defaults to {@link APP_TOPIC_LABEL} — the one label `@kumiai/rpc`'s own peer ever
 * passes — so every pre-existing call site that only cared about the epoch (there are many, all
 * computing "the topic the anchor names at this epoch") keeps computing the same thing without
 * naming the label at every call. The default is a convenience of THIS helper, not of the port:
 * {@link createFakeCrypto}'s own `exportSecret` never uses it, and takes `label` from its caller
 * like any other implementation must.
 *
 * Exported because a test that wants the topic the group is on needs the secret of the ANCHOR
 * epoch, which the live handle has usually run past — the same reason the anchor is persisted.
 *
 * The epoch mix is a XOR, NOT a ratchet: it models none of MLS's one-wayness, and a member
 * holding one epoch's bytes can trivially compute another's for the same label. That truth is
 * real only where the crypto is (see `@kumiai/mls`); here the fake is a double for wiring and
 * must not pretend otherwise. The label mix (a SHA-256 of the label, cycled across the output) is
 * not modelling anything MLS does either — it exists only so two labels are two different
 * keystreams, deterministically and with nothing exchanged, which is all any clause here asks of
 * domain separation.
 */
export function fakeEpochSecret(
  epoch: number,
  label: string = APP_TOPIC_LABEL,
  length: number = FAKE_BASE_SECRET.length,
  base: Uint8Array = FAKE_BASE_SECRET,
): Uint8Array {
  const mask = sha256(fromUTF(label))
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) {
    const baseByte = base[i % base.length] as number
    const maskByte = mask[i % mask.length] as number
    out[i] = (baseByte ^ ((epoch + i) & 0xff) ^ maskByte) & 0xff
  }
  return out
}

/**
 * Deterministic GroupCrypto for tests. `wrap` seals under the CURRENT epoch's key:
 * `[epoch(2)][ xor( [generation(4)][didLen(2)][localDID][payload], key ^ epoch ) ]`; `unwrap`
 * reverses it and returns the recovered `localDID` as `senderDID` — modelling MLS authenticating
 * the sender from the ciphertext.
 *
 * The GENERATION and the spend of it below are the ratchet, modelled. Real MLS derives one
 * message key per sender per generation and DELETES it as it opens: a frame opens exactly once,
 * and a second open of the same bytes fails with the key gone rather than with anything wrong
 * with the frame. This double was a pure XOR — every frame opened forever, for free — and that is
 * how the peer came to open every live frame twice on two transports, passing all 288 tests here
 * and delivering nothing at all over a real handle. A double that cannot refuse the second open
 * cannot see that class of defect, so it refuses it.
 *
 * The counter is per SENDER, matching MLS's own per-sender chains, and the spend is per RECEIVER:
 * each member holds its own copy of every other member's ratchet, so two members opening the same
 * frame is normal and one member opening it twice is not.
 *
 * The epoch is load-bearing, not decoration: an MLS member holds the epoch secret of the
 * epoch it is AT, so bytes sealed under any other epoch will not open for it — including
 * every frame from before it joined. `unwrap` throws for those, which is what a member
 * walking a log full of them has to survive without calling them corrupt.
 *
 * CURRENT EPOCH ONLY, and it must stay that way — but this IS stricter than the real port, and the
 * margin underneath is real. An earlier note here claimed parity on the grounds that
 * `GroupHandle.decrypt` delegates to ts-mls's `processMessage`, which resolves against the current
 * epoch's secret tree alone. That is wrong, and observing it is what corrected it: a real handle
 * advanced by `processMessage` still holds the previous epochs' key material and opens a frame
 * sealed below it (a frame sealed at epoch 3 opens against the same handle at epoch 4; six
 * transitions on, the same read is refused with ts-mls's own "Cannot process message, epoch too
 * old"). Only a handle REPLACED wholesale — adopting the derived handle of a commit this member
 * authored — starts with no history, which is why the case looked like parity.
 *
 * So this is the port contract in `crypto.ts` enforced ABOVE the floor, deliberately: group-rpc
 * may only ever require the current epoch, and reads every retained frame ahead of the commit that
 * ratchets past it. The window is spent by epoch TRANSITIONS rather than by time, so leaning on it
 * would make correctness turn on how far behind a peer happened to fall. Loosening this would let
 * a dependency in that the real port serves only sometimes, which is worse than not at all.
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

  /** Bytes of the per-sender generation counter, inside the sealed region. */
  const GENERATION_BYTES = 4
  /** The sealed region's fixed header: the generation and the sender-DID length. */
  const FRAMED_HEADER_BYTES = GENERATION_BYTES + 2

  /** This sender's own sending chain: one generation per frame, never reused. */
  let generation = 0
  /**
   * The generations this RECEIVER has already spent, as `epoch:senderDID:generation`. A real
   * handle deletes the message key as it opens; this remembers instead, which refuses the same
   * second open for the same reason.
   */
  const spent = new Set<string>()

  const wrap: GroupCrypto['wrap'] = (bytes) => {
    const did = fromUTF(localDID)
    const framed = new Uint8Array(FRAMED_HEADER_BYTES + did.length + bytes.length)
    const framedView = new DataView(framed.buffer)
    framedView.setUint32(0, generation++, true)
    framedView.setUint16(GENERATION_BYTES, did.length, true)
    framed.set(did, FRAMED_HEADER_BYTES)
    framed.set(bytes, FRAMED_HEADER_BYTES + did.length)
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
   * STRUCTURE IS CHECKED, not just length. A sealed frame is `[epoch(2)][ xor([generation(4)]
   * [didLen(2)][did][payload]) ]`, so it is at least eight bytes long and its own length holds the
   * sender it declares — a check every member can make, because the epoch and the XOR key are in
   * the clear.
   * Without it any two bytes are an epoch, and garbage whose leading bytes read as a number the
   * commit log justifies is indistinguishable from a frame sealed ahead of the walk: the reader
   * keeps its place and the cursor rests behind it. The port's word for bytes that are not a
   * readable sealed frame is `null`, and a double that invents a plausible one instead is a double
   * that can never be asked this question.
   */
  const frameEpoch: GroupCrypto['frameEpoch'] = (bytes) => {
    const commit = decodeMemoryCommit(bytes)
    if (commit != null) return commit.epoch
    if (bytes.length < 2 + FRAMED_HEADER_BYTES) return null
    const sealedAt = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(
      0,
      true,
    )
    const framed = xor(bytes.subarray(2), sealedAt)
    const didLen = new DataView(framed.buffer).getUint16(GENERATION_BYTES, true)
    return FRAMED_HEADER_BYTES + didLen <= framed.length ? sealedAt : null
  }

  const unwrap: Unwrap = (bytes) => {
    if (bytes.length < 2 + FRAMED_HEADER_BYTES) throw new Error('cannot open: not sealed bytes')
    const sealedAt = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(
      0,
      true,
    )
    if (sealedAt !== epoch) {
      // This member does not hold that epoch's secret — it is not at that epoch.
      throw new Error(`cannot open bytes sealed at epoch ${sealedAt}: this member is at ${epoch}`)
    }
    const framed = xor(bytes.subarray(2), sealedAt)
    const framedView = new DataView(framed.buffer, framed.byteOffset, framed.byteLength)
    const sealedGeneration = framedView.getUint32(0, true)
    const didLen = framedView.getUint16(GENERATION_BYTES, true)
    if (FRAMED_HEADER_BYTES + didLen > framed.length) {
      throw new Error('cannot open: not a well-formed sealed frame')
    }
    const senderDID = toUTF(framed.subarray(FRAMED_HEADER_BYTES, FRAMED_HEADER_BYTES + didLen))
    // The ratchet key, spent. A real handle deletes the message key as it opens, so the second
    // open of a frame fails with the key GONE — not with anything wrong with the frame — and a
    // lane that gave two consumers an `unwrap` each has them race for one key. See the class doc.
    const key = `${sealedAt}:${senderDID}:${sealedGeneration}`
    if (spent.has(key)) {
      throw new Error(
        `cannot open: the message key for generation ${sealedGeneration} from ${senderDID} at epoch ${sealedAt} is spent`,
      )
    }
    spent.add(key)
    const payload = framed.subarray(FRAMED_HEADER_BYTES + didLen)
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
   *
   * Under its OWN label, {@link FAKE_ENTRY_LABEL} — never {@link APP_TOPIC_LABEL} or whatever
   * label a caller passes `exportSecret`. The real port makes the identical choice (a separate
   * `ENTRY_SEAL_LABEL`, asked of the handle directly rather than routed through its own
   * `exportSecret`), for the reason `GroupCrypto`'s doc gives: sharing one exported secret
   * between a topic name and a ledger key would make every holder of the name a reader of the
   * bodies.
   */
  const FAKE_ENTRY_LABEL = 'kumiai/fake-entries/v1'
  const entryKey = (at: number): Uint8Array =>
    fakeEpochSecret(at, FAKE_ENTRY_LABEL, secret.length, secret)

  const entryStream = (bytes: Uint8Array, key: Uint8Array): Uint8Array => {
    const out = new Uint8Array(bytes.length)
    for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ (key[i % key.length] as number)
    return out
  }

  const ENTRY_TAG_BYTES = 8

  /**
   * A keyed tag over the CIPHERTEXT, not a copy of the key's first bytes.
   *
   * The earlier tag named the epoch and nothing else, so it refused another epoch's blob and
   * opened a tampered one — which is not what an AEAD does, and the lane leans on the difference:
   * a commit whose entries will not resolve is filed as poison, stepped over and never re-read,
   * because "a blob this peer cannot open is one no member at this epoch can". Tampering breaks
   * that reasoning, so a double that cannot refuse tampering cannot see the failure.
   *
   * One tag for every failure, deliberately: a real AEAD cannot tell "wrong key" from "wrong
   * bytes", and a double that reported them differently would let a test depend on a distinction
   * the real port does not offer.
   */
  const entryTag = (ciphertext: Uint8Array, key: Uint8Array): Uint8Array => {
    const tag = new Uint8Array(ENTRY_TAG_BYTES)
    for (let i = 0; i < ENTRY_TAG_BYTES; i++) tag[i] = key[i] as number
    for (let i = 0; i < ciphertext.length; i++) {
      const slot = i % ENTRY_TAG_BYTES
      // Position-dependent, so reordering or truncating the ciphertext changes the tag.
      tag[slot] = ((tag[slot] as number) ^ ((ciphertext[i] as number) + i)) & 0xff
    }
    return tag
  }

  const sealEntries: GroupCrypto['sealEntries'] = (bytes) => {
    const key = entryKey(epoch)
    const ciphertext = entryStream(bytes, key)
    const sealed = new Uint8Array(ENTRY_TAG_BYTES + ciphertext.length)
    sealed.set(entryTag(ciphertext, key), 0)
    sealed.set(ciphertext, ENTRY_TAG_BYTES)
    return sealed
  }

  const openEntries: GroupCrypto['openEntries'] = (sealed) => {
    if (sealed.length < ENTRY_TAG_BYTES) throw new Error('cannot open: not a sealed entry blob')
    const key = entryKey(epoch)
    const ciphertext = sealed.subarray(ENTRY_TAG_BYTES)
    const expected = entryTag(ciphertext, key)
    for (let i = 0; i < ENTRY_TAG_BYTES; i++) {
      if (sealed[i] !== expected[i]) {
        throw new Error(`cannot open entry blob: wrong epoch or tampered (at epoch ${epoch})`)
      }
    }
    return entryStream(ciphertext, key)
  }

  return {
    epoch: () => epoch,
    // `label` is the CALLER's, taken as given and never defaulted or ignored here — a fake that
    // fell back to a default for an omitted label would hide the exact caller mistake the port's
    // required parameter exists to make loud. See {@link fakeEpochSecret}: its own default label
    // is a convenience for OTHER test call sites, not something this method may lean on.
    exportSecret: (label, length = secret.length) => fakeEpochSecret(epoch, label, length, secret),
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
