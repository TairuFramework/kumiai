import { sha256 } from '@noble/hashes/sha2.js'
import { fromUTF, toUTF } from '@sozai/codec'

import type { GroupCrypto } from '../../src/crypto.js'
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

/** Constant-length comparison; no `Buffer`/timing-safe import exists at this layer. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Bytes of the per-sender generation counter, inside the sealed region. */
const GENERATION_BYTES = 4
/** The sealed region's fixed header: the generation and the sender-DID length. */
const FRAMED_HEADER_BYTES = GENERATION_BYTES + 2
/** Bytes of the carried-AAD length, sitting after the header and before the did. */
const AAD_LEN_BYTES = 4
/** Bytes of the keyed tag appended to a sealed app frame's body, authenticating the whole frame. */
const TAG_BYTES = 8
/** Bytes of the keyed tag over an entry's ciphertext. */
const ENTRY_TAG_BYTES = 8

/**
 * A keyed, non-linear tag over `epoch` AND `body` (the WHOLE framed plaintext, AAD included): a
 * SHA-256 of `secret`, `key`, the epoch's 2-byte little-endian encoding, and `body` concatenated,
 * truncated to {@link TAG_BYTES}. This is what makes `wrap`/`unwrap` non-malleable — the XOR
 * keystream alone is not: it is linear, so an attacker who knows any stretch of plaintext (the AAD
 * is often guessable) can flip the matching ciphertext bytes to any value of their choosing and the
 * frame still de-XORs "cleanly", with nothing to detect the change. A hash breaks that: flipping
 * any body byte — AAD, sender, generation, or payload — changes every tag bit unpredictably, and
 * reproducing the tag without `key`/`secret` is what this stands in for an AEAD tag to prevent.
 *
 * `epoch` MUST be covered, not just `body`: the epoch is carried in the sealed prefix's own
 * cleartext (`wrap` below), and `K_epoch = key ^ epoch` (low byte) means `K_E XOR K_E2 = E XOR E2`
 * — so a tag over `body` alone lets an attacker holding one valid frame rewrite the cleartext
 * epoch prefix to a victim's epoch, XOR the remainder by the epoch delta, and hand the victim back
 * its ORIGINAL body and ORIGINAL tag, both still valid, entirely without the key. Mixing the same
 * epoch encoding into the tag input makes that translated frame recompute a DIFFERENT tag, so it
 * is refused rather than silently re-opened at the wrong epoch.
 */
function frameTag(epoch: number, body: Uint8Array, key: number, secret: Uint8Array): Uint8Array {
  const material = new Uint8Array(secret.length + 1 + 2 + body.length)
  material.set(secret, 0)
  material[secret.length] = key & 0xff
  new DataView(material.buffer).setUint16(secret.length + 1, epoch, true)
  material.set(body, secret.length + 1 + 2)
  return sha256(material).subarray(0, TAG_BYTES)
}

/**
 * The label entry seals are keyed under — never {@link APP_TOPIC_LABEL} or whatever label a caller
 * passes `exportSecret`. The real port makes the identical choice (a separate `ENTRY_SEAL_LABEL`,
 * asked of the handle directly rather than routed through its own `exportSecret`), for the reason
 * `GroupCrypto`'s doc gives: sharing one exported secret between a topic name and a ledger key
 * would make every holder of the name a reader of the bodies.
 */
const FAKE_ENTRY_LABEL = 'kumiai/fake-entries/v1'

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
 * `label` is REQUIRED, on this standalone helper same as on the port method it stands in for
 * ({@link createFakeCrypto}'s own `exportSecret`, `:310`). It used to default to
 * {@link APP_TOPIC_LABEL} as a convenience for the many pre-existing call sites that only cared
 * about the epoch (all computing "the topic the anchor names at this epoch"), but a default here
 * is exactly the shape the port's required `label` exists to rule out: a future call site that
 * means a different label and forgets to say so would silently get the app label instead of a
 * compile error. Callers that want the app topic pass {@link APP_TOPIC_LABEL} explicitly.
 *
 * Exported because a test that wants the topic the group is on needs the secret of the ANCHOR
 * epoch, which the live handle has usually run past — the same reason the anchor is persisted.
 *
 * The epoch mix is a XOR, NOT a ratchet: it models none of MLS's one-wayness, and a member
 * holding one epoch's bytes can trivially compute another's for the same label. That truth is
 * real only where the crypto is (see `@kumiai/mls`); here the fake is a double for wiring and
 * must not pretend otherwise. The label-AND-length mix (a SHA-256 of `label` and `length`
 * together, cycled across the output) is not modelling anything MLS does either — it exists only
 * so two labels, or two lengths of the same label, are different keystreams, deterministically and
 * with nothing exchanged, which is all any clause here asks of domain separation. `length` is
 * folded into the same hash as `label` rather than mixed in some other way so that a length-16
 * export is not a prefix of the length-32 one — `GroupCrypto.exportSecret`'s doc claims a
 * same-label export at a different length is an independent key, never a truncation, and a fake
 * whose short export were a prefix of its long one would make that claim false for the one
 * implementation every other test in this repo runs against.
 */
export function fakeEpochSecret(
  epoch: number,
  label: string,
  length: number = FAKE_BASE_SECRET.length,
  base: Uint8Array = FAKE_BASE_SECRET,
): Uint8Array {
  const mask = sha256(fromUTF(`${label}:${length}`))
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
 * `[epoch(2)][ xor( [generation(4)][didLen(2)][aadLen(4)][localDID][AAD][payload][tag(TAG_BYTES)],
 * key ^ epoch ) ]`; `unwrap` reverses it and returns the recovered `localDID` as `senderDID` —
 * modelling MLS authenticating the sender from the ciphertext. The XOR keystream alone would NOT
 * stand in for the AEAD tag — it is linear, so a known-plaintext byte lets an attacker flip the
 * matching ciphertext byte to anything and the frame still de-XORs cleanly, AAD and sender
 * included; worse, `K_epoch = key ^ epoch` (low byte) is itself linear in the epoch, so a tag over
 * the body alone would leave a SECOND lever: rewrite the cleartext epoch prefix and shift the
 * ciphertext by the epoch delta, and a frame sealed at one epoch reopens, byte-for-byte, at
 * another. {@link frameTag} closes both: a keyed, non-linear tag over the epoch AND the whole
 * framed body, appended before the XOR is applied, so tampering with ANY byte — including the
 * epoch prefix and everyone opened at the wrong epoch — is caught on `unwrap` rather than silently
 * accepted. `unwrap` verifies the tag, then compares `expectedAAD` against the recovered AAD,
 * BEFORE spending the generation, mirroring the real handle's pre-open compare — a tampered,
 * cross-epoch-translated, or wrong-topic frame must not burn a ratchet key.
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

  /** This sender's own sending chain: one generation per frame, never reused. */
  let generation = 0
  /**
   * The generations this RECEIVER has already spent, as `epoch:senderDID:generation`. A real
   * handle deletes the message key as it opens; this remembers instead, which refuses the same
   * second open for the same reason.
   */
  const spent = new Set<string>()

  const wrap: GroupCrypto['wrap'] = (bytes, opts) => {
    const did = fromUTF(localDID)
    const aad = opts?.AAD ?? new Uint8Array()
    const framed = new Uint8Array(
      FRAMED_HEADER_BYTES + AAD_LEN_BYTES + did.length + aad.length + bytes.length,
    )
    const framedView = new DataView(framed.buffer)
    framedView.setUint32(0, generation++, true)
    framedView.setUint16(GENERATION_BYTES, did.length, true)
    framedView.setUint32(FRAMED_HEADER_BYTES, aad.length, true)
    let at = FRAMED_HEADER_BYTES + AAD_LEN_BYTES
    framed.set(did, at)
    at += did.length
    framed.set(aad, at)
    at += aad.length
    framed.set(bytes, at)
    // The tag is over `framed` (the whole plaintext body) and is appended BEFORE the XOR, so it
    // is covered by the same keystream as everything else and carries no cleartext signal.
    const tagged = new Uint8Array(framed.length + TAG_BYTES)
    tagged.set(framed, 0)
    tagged.set(frameTag(epoch, framed, key, secret), framed.length)
    const sealed = new Uint8Array(2 + tagged.length)
    new DataView(sealed.buffer).setUint16(0, epoch, true)
    sealed.set(xor(tagged, epoch), 2)
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
   * [didLen(2)][aadLen(4)][did][AAD][payload][tag(TAG_BYTES)]) ]`, so its own length holds the
   * sender, the AAD it declares, AND the trailing tag — a check every member can make, because
   * the epoch and the XOR key are in the clear.
   * Without it any two bytes are an epoch, and garbage whose leading bytes read as a number the
   * commit log justifies is indistinguishable from a frame sealed ahead of the walk: the reader
   * keeps its place and the cursor rests behind it. The port's word for bytes that are not a
   * readable sealed frame is `null`, and a double that invents a plausible one instead is a double
   * that can never be asked this question.
   */
  const frameEpoch: GroupCrypto['frameEpoch'] = (bytes) => {
    const commit = decodeMemoryCommit(bytes)
    if (commit != null) return commit.epoch
    // Bound to the aadLen field AND the trailing tag, so a short frame is `null` rather than an
    // out-of-bounds DataView read — this must never throw.
    if (bytes.length < 2 + FRAMED_HEADER_BYTES + AAD_LEN_BYTES + TAG_BYTES) return null
    const sealedAt = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(
      0,
      true,
    )
    const framed = xor(bytes.subarray(2), sealedAt)
    const didLen = new DataView(framed.buffer).getUint16(GENERATION_BYTES, true)
    const aadLen = new DataView(framed.buffer).getUint32(FRAMED_HEADER_BYTES, true)
    return FRAMED_HEADER_BYTES + AAD_LEN_BYTES + didLen + aadLen + TAG_BYTES <= framed.length
      ? sealedAt
      : null
  }

  const unwrap: GroupCrypto['unwrap'] = (bytes, opts) => {
    if (bytes.length < 2 + FRAMED_HEADER_BYTES + AAD_LEN_BYTES + TAG_BYTES) {
      throw new Error('cannot open: not sealed bytes')
    }
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
    const aadLen = framedView.getUint32(FRAMED_HEADER_BYTES, true)
    const headerEnd = FRAMED_HEADER_BYTES + AAD_LEN_BYTES
    // Structure-check first: the declared did/aad lengths, AND the trailing tag, must fit.
    if (headerEnd + didLen + aadLen + TAG_BYTES > framed.length) {
      throw new Error('cannot open: not a well-formed sealed frame')
    }
    // Tag-verify BEFORE the expectedAAD compare and BEFORE spending the generation: a tampered or
    // forged frame — including one an attacker rewrote by exploiting the XOR's linearity — must
    // not consume the legitimate reader's ratchet key as a side effect of being rejected.
    const body = framed.subarray(0, framed.length - TAG_BYTES)
    const tag = framed.subarray(framed.length - TAG_BYTES)
    if (!bytesEqual(tag, frameTag(sealedAt, body, key, secret))) {
      throw new Error('cannot open: frame authentication tag does not match')
    }
    const senderDID = toUTF(framed.subarray(headerEnd, headerEnd + didLen))
    const aad = framed.subarray(headerEnd + didLen, headerEnd + didLen + aadLen)
    // Pre-spent: a wrong-topic frame is rejected before the generation is consumed, mirroring the
    // real handle's pre-open compare — an attacker replaying a frame under the wrong AAD must not
    // be able to burn the legitimate reader's ratchet key as a side effect.
    if (opts?.expectedAAD != null && !bytesEqual(aad, opts.expectedAAD)) {
      throw new Error('cannot open: frame authenticated data does not match expected AAD')
    }
    // The ratchet key, spent. A real handle deletes the message key as it opens, so the second
    // open of a frame fails with the key GONE — not with anything wrong with the frame — and a
    // lane that gave two consumers an `unwrap` each has them race for one key. See the class doc.
    const spentKey = `${sealedAt}:${senderDID}:${sealedGeneration}`
    if (spent.has(spentKey)) {
      throw new Error(
        `cannot open: the message key for generation ${sealedGeneration} from ${senderDID} at epoch ${sealedAt} is spent`,
      )
    }
    spent.add(spentKey)
    const payload = framed.subarray(headerEnd + didLen + aadLen, framed.length - TAG_BYTES)
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
   * Under its OWN label, {@link FAKE_ENTRY_LABEL}.
   */
  const entryKey = (at: number): Uint8Array =>
    fakeEpochSecret(at, FAKE_ENTRY_LABEL, secret.length, secret)

  const entryStream = (bytes: Uint8Array, key: Uint8Array): Uint8Array => {
    const out = new Uint8Array(bytes.length)
    for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ (key[i % key.length] as number)
    return out
  }

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
