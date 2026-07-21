import type { GroupHandle } from '@kumiai/mls'
import { readMessageEpoch } from '@kumiai/mls'
import type { GroupCrypto } from '@kumiai/rpc'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { createRuntime, type Runtime } from '@sozai/runtime'

/**
 * The label the ledger-entry seal key is exported under. UNCHANGED by `GroupCrypto.exportSecret`
 * taking a caller-supplied label: `sealEntries`/`openEntries` are their own port members, not
 * routed through `exportSecret`, and this is the label THIS implementation asks the handle's own
 * exporter with for that separate purpose. `createGroupCrypto`'s `exportSecret` refuses this
 * label from a caller (see there) for exactly the reason it must differ from whatever label a
 * caller passes: the topic secret names a topic and is handed to anything that derives one, while
 * this key opens the group's control-ledger bodies, and sharing one exported secret between a
 * name and a key would make every holder of the name a reader of the bodies.
 */
export const ENTRY_SEAL_LABEL = 'kumiai/ledger-entries/v1'

/** The exporter context. Fixed: the label already separates each consumer. */
const EXPORT_CONTEXT = new Uint8Array()

/**
 * Bytes to ask the exporter for: 32, because XChaCha20-Poly1305 takes a 256-bit key.
 *
 * NOT the ciphersuite's KDF output length, though it happens to equal it for every suite this
 * repo can instantiate. The MLS exporter is HKDF-Expand with a caller-chosen output length
 * (RFC 9420 §8.5), capped only at 255·hashLen, and the length is bound into the info field — so
 * 32 bytes come back under any suite, and a same-label export at another length is an
 * independent key. Deriving this from the suite instead would return 48 on a SHA-384 suite and
 * make every seal throw.
 */
const SECRET_LENGTH = 32

/** XChaCha20-Poly1305's nonce, carried in the clear ahead of the ciphertext. */
const ENTRY_NONCE_BYTES = 24

/**
 * The sealed blob's format version, first byte, in the clear:
 *
 *   [ VERSION(1) | NONCE(24) | CIPHERTEXT... ]
 *
 * INSIDE THE BLOB and not in the frame header, because of what each failure costs a peer that
 * cannot read it. An unknown blob version fails the OPEN, which a peer survives: the commit is
 * filed as poison, stepped over, and the next frame — framed at an epoch ahead of it — strands
 * it into a rejoin that re-gathers the whole ledger. An unknown FRAME version would fail the
 * decode instead, before the frame is ever classified, and a peer that steps over every frame
 * without classifying one never learns the group moved past it. See `rpc/src/handshake.ts`.
 *
 * Unauthenticated, necessarily — it is read to decide how to open, so it cannot be under the
 * seal. A hub that rewrites it only changes which error the peer reports; it cannot make bytes
 * open that would not have.
 *
 * It buys diagnosis, not compatibility. There is no version of this a v1 peer can read, and a
 * format change is a flag day whatever this byte says. What it changes is that the failure
 * reads as "this blob is v2 and I speak v1" rather than an AEAD refusal indistinguishable from
 * a wrong epoch or a tampered frame.
 */
const ENTRY_VERSION = 1

export type GroupCryptoParams = {
  /**
   * The handle the peer is at RIGHT NOW. A function and not a value because the peer's
   * handle is replaced when the peer adopts a commit it authored, and a crypto closing
   * over the handle it was built with would silently seal at a dead epoch forever.
   */
  handle: () => GroupHandle
  /**
   * Override the ledger-entry seal's exporter label. Changing it changes the key every commit's
   * entry blob is sealed under, so a group whose members disagree on it cannot apply each other's
   * commits.
   */
  entryLabel?: string
  /** Runtime providing platform primitives. Defaults to `createRuntime()`. */
  runtime?: Runtime
}

/**
 * {@link GroupCrypto} over a live {@link GroupHandle} — the real port, against real MLS.
 *
 * ## Where this diverges from the fake in `@kumiai/rpc`'s test fixtures
 *
 * 1. **`unwrap` refuses every epoch the handle has not REACHED, and opens a bounded window
 *    below it. The fake refuses everything but its current epoch, so the fake IS stricter.**
 *    Above the handle there are no keys yet and both refuse. Below it, this implementation
 *    reaches ts-mls's retained key material: a frame sealed at epoch 3 opens against a handle
 *    that `processMessage` carried to epoch 4, and the same read six transitions later is
 *    refused with ts-mls's own "Cannot process message, epoch too old". An earlier note here
 *    claimed parity with the fake — that `GroupHandle.decrypt` delegating to `processMessage`
 *    resolved against the current epoch's secret tree alone — and that is not what happens.
 *    (It looks true for a handle REPLACED wholesale, as when a member adopts the derived handle
 *    of its own commit: that handle starts with no history.)
 *
 *    The port contract is right either way — "an implementation that opens strictly at the
 *    current epoch is a correct implementation of this port", and group-rpc must not depend on
 *    the window, which is spent by epoch TRANSITIONS rather than by time.
 *
 * 2. **`exportSecret` is one-way; the fake's is not.** The fake XORs the epoch (and the label —
 *    see {@link fakeEpochSecret} in `@kumiai/rpc`'s fixtures) into a fixed base, so any member
 *    holding one epoch's bytes for one label computes every other epoch's for that label. This
 *    exports from the MLS epoch's exporter secret, which a removed member cannot reach forward
 *    from. That difference is the entire security property the app-lane topic (and anything
 *    else a caller labels) rests on, and it is real only here.
 *
 * 3. **`wrap` mutates.** The fake's `wrap` is pure. This one consumes a per-message ratchet
 *    key from the handle's own sending chain, so sealing twice gives different bytes for the
 *    same plaintext, and a handle that has sealed cannot re-seal identically. Nothing in
 *    group-rpc depends on `wrap` being pure, but a test that asserted byte equality between
 *    two seals of the same message would pass against the fake and fail here.
 *
 * 4. **`frameEpoch` answers for real MLS frames only.** The fake answers for its own two
 *    encodings. This reads the cleartext epoch field every MLSMessage carries, so it answers
 *    for a sealed app frame and a commit alike — the same field, one format. It returns `null`
 *    for anything ts-mls will not decode as a message, and never throws, which is the contract.
 */
export function createGroupCrypto(params: GroupCryptoParams): GroupCrypto {
  const { handle, entryLabel = ENTRY_SEAL_LABEL, runtime = createRuntime() } = params

  return {
    epoch: () => Number(handle().epoch),

    // The caller's label, passed straight through to the handle's own exporter — this
    // implementation chooses no label of its own. It used to: a fixed `label` closed over here
    // was the only value any caller could ever get, and the caller that closed over it
    // (`@kumiai/rpc`'s peer, via `APP_TOPIC_LABEL`) is the one place that value is preserved.
    //
    // ONE label is off limits: `entryLabel` names the exact exporter call `sealEntries`/
    // `openEntries` make below (same context, same `SECRET_LENGTH`), so a caller reaching this
    // method with it back would not get an independent export — it would get the ledger-entry
    // seal key under another name. Refused here, loudly, rather than left to the doc alone.
    exportSecret: (label, length = SECRET_LENGTH) => {
      if (label === entryLabel) {
        throw new Error(`exportSecret: label '${label}' is reserved for the ledger-entry seal`)
      }
      return handle().exportSecret(label, EXPORT_CONTEXT, length)
    },

    wrap: (bytes) => handle().encrypt(bytes),

    sealEntries: async (bytes) => {
      const key = await handle().exportSecret(entryLabel, EXPORT_CONTEXT, SECRET_LENGTH)
      // Random per seal: two members can frame a commit at the same epoch, so the key alone does
      // not bound how many blobs it seals, and a repeated nonce under one key is a break. A
      // 24-byte nonce makes a collision unreachable without any counter to persist.
      const nonce = runtime.getRandomValues(new Uint8Array(ENTRY_NONCE_BYTES))
      const ciphertext = xchacha20poly1305(key, nonce).encrypt(bytes)
      const sealed = new Uint8Array(1 + nonce.length + ciphertext.length)
      sealed[0] = ENTRY_VERSION
      sealed.set(nonce, 1)
      sealed.set(ciphertext, 1 + nonce.length)
      return sealed
    },

    openEntries: async (sealed) => {
      if (sealed.length <= 1 + ENTRY_NONCE_BYTES) throw new Error('openEntries: not a sealed blob')
      if (sealed[0] !== ENTRY_VERSION) {
        // Distinguishable on purpose. Every other failure here is an opaque AEAD refusal, and a
        // peer that reported them alike could not tell a version it does not speak from a wrong
        // epoch or a tampered frame. The lane treats all three the same way — poison, advance,
        // heal from the next frame — so this changes what an operator sees, not what happens.
        throw new Error(`openEntries: unsupported blob version ${sealed[0]}`)
      }
      // PURE: the exporter secret is epoch-level and reading it consumes no ratchet key and
      // touches no handle state, so this may be called from inside the apply of the very commit
      // whose blob it opens — which is the only place it is called from.
      const key = await handle().exportSecret(entryLabel, EXPORT_CONTEXT, SECRET_LENGTH)
      return xchacha20poly1305(key, sealed.subarray(1, 1 + ENTRY_NONCE_BYTES)).decrypt(
        sealed.subarray(1 + ENTRY_NONCE_BYTES),
      )
    },

    unwrap: async (bytes) => {
      // Throws for any epoch but this handle's. That is ordinary control flow on the read
      // paths — it is how a retained frame says "not mine" — and the caller drops it.
      const { payload, senderDID } = await handle().decrypt(bytes)
      // `GroupCrypto.unwrap` REQUIRES a sender (see its doc); `GroupHandle.decrypt` does not
      // guarantee one, and there are three distinct reasons it can come back absent
      // (`packages/mls/src/group-handle.ts:677`, deriving `senderDID` from two calls):
      //   - `readSenderLeafIndex` returns `null` — the sender-data AEAD open fails
      //     (`sender-data.ts:120`) or the opened plaintext is shorter than the 4-byte
      //     leaf-index field it must carry (`sender-data.ts:123`);
      //   - `#didOfLeaf` finds no member at the authenticated leaf index
      //     (`group-handle.ts:867-872`);
      //   - the leaf's credential fails to parse, so `#iterateMembers` skips it
      //     (`group-handle.ts:536-537`, the `continue` in the credential-parse `catch`).
      // `@kumiai/mls`'s own doc treats all three as "I cannot name the author", never "no
      // author". That is not a shape this port may hand upward: group-rpc's app lane has no
      // identity-less case to give it to, so an unnamed sender is treated the same as bytes this
      // handle cannot open — refused here rather than returned with the field missing.
      if (senderDID == null) {
        throw new Error('unwrap: opened frame has no authenticated sender')
      }
      return { payload, senderDID }
    },

    frameEpoch: (bytes) => {
      // Total by contract: asked about every frame a log holds, most of which are not this
      // handle's to open. readMessageEpoch never throws and answers without any key.
      const epoch = readMessageEpoch(bytes)
      return epoch == null ? null : Number(epoch)
    },
  }
}
