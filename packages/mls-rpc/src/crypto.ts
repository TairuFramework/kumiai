import type { GroupHandle } from '@kumiai/mls'
import { readMessageEpoch } from '@kumiai/mls'
import type { GroupCrypto } from '@kumiai/rpc'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { createRuntime, type Runtime } from '@sozai/runtime'

/**
 * Label the ledger-entry seal key is exported under. Distinct from any label a caller passes to
 * `exportSecret`: that names a topic secret handed to anything that derives one, while this key
 * opens the group's control-ledger bodies — sharing one exported secret between the two would
 * make every holder of the topic label a reader of the ledger. `exportSecret` refuses this label
 * from a caller (see below).
 */
export const ENTRY_SEAL_LABEL = 'kumiai/ledger-entries/v1'

/** The exporter context. Fixed: the label already separates each consumer. */
const EXPORT_CONTEXT = new Uint8Array()

/**
 * Exporter output length: 32 bytes, since XChaCha20-Poly1305 takes a 256-bit key — not the
 * ciphersuite's KDF length. RFC 9420 §8.5's exporter is HKDF-Expand with a caller-chosen output
 * length bound into the info field, so 32 bytes come back under any suite; deriving this from
 * the suite instead would return 48 on SHA-384 and break every seal.
 */
const SECRET_LENGTH = 32

/** XChaCha20-Poly1305's nonce, carried in the clear ahead of the ciphertext. */
const ENTRY_NONCE_BYTES = 24

/**
 * Sealed blob format version, first byte, in the clear: [ VERSION(1) | NONCE(24) | CIPHERTEXT ]
 *
 * Inside the blob, not the frame header: an unknown blob version fails only the OPEN, which a
 * peer survives (commit filed as poison, stepped over). An unknown FRAME version would fail the
 * decode before the frame is ever classified, so the peer never learns the group moved past it.
 * See `rpc/src/handshake.ts`.
 *
 * Unauthenticated by necessity — read to decide how to open, so it can't be under the seal; a
 * hub that rewrites it only changes which error is reported. Buys diagnosis, not compatibility:
 * no v1 peer can read a v2 blob regardless, but the failure reads as "unsupported version"
 * rather than an AEAD refusal indistinguishable from a wrong epoch or a tampered frame.
 */
const ENTRY_VERSION = 1

export type GroupCryptoParams = {
  /**
   * The peer's current handle. A function, not a value: the handle is replaced when the peer
   * adopts its own commit, and closing over a fixed handle would silently seal at a dead epoch.
   */
  handle: () => GroupHandle
  /**
   * Override the ledger-entry seal's exporter label. Members must agree on it, or they can't
   * apply each other's commits.
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
 * 1. `unwrap` refuses any epoch the handle hasn't REACHED, but opens a bounded window below it
 *    via ts-mls's retained key material (the fake refuses everything but its current epoch, so
 *    the fake is stricter — both are valid implementations of the port; group-rpc must not
 *    depend on the window, which is spent by epoch transitions, not time).
 *
 * 2. `exportSecret` is one-way; the fake's is not. The fake XORs epoch and label into a fixed
 *    base, so one epoch's bytes yield every other epoch's for that label. This exports from the
 *    MLS epoch's exporter secret, which a removed member cannot reach forward from — the entire
 *    security property the app-lane topic (and anything else a caller labels) rests on.
 *
 * 3. `wrap` mutates: it consumes a per-message ratchet key from the handle's sending chain, so
 *    sealing the same plaintext twice gives different bytes. The fake's `wrap` is pure — don't
 *    assert byte equality between two seals of the same message.
 *
 * 4. `frameEpoch` reads the cleartext epoch field every MLSMessage carries — the same field for
 *    a sealed app frame and a commit — returning `null` (never throwing) for anything ts-mls
 *    won't decode. The fake answers only for its own two encodings.
 */
export function createGroupCrypto(params: GroupCryptoParams): GroupCrypto {
  const { handle, entryLabel = ENTRY_SEAL_LABEL, runtime = createRuntime() } = params

  return {
    epoch: () => Number(handle().epoch),

    // Passed straight through to the handle's exporter, except `entryLabel`: reusing it would
    // not be an independent export — it's the exact exporter call `sealEntries`/`openEntries`
    // make below (same context, same `SECRET_LENGTH`), so it would hand back the ledger-entry
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
      // Random per seal: two members can frame a commit at the same epoch, and a repeated nonce
      // under one key is a break. 24 bytes makes a collision unreachable without a counter.
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
        // Distinguishable on purpose: every other failure here is an opaque AEAD refusal, and
        // this lets an operator tell "unsupported version" from a wrong epoch or a tampered
        // frame — the lane treats all three the same way (poison, advance, heal) regardless.
        throw new Error(`openEntries: unsupported blob version ${sealed[0]}`)
      }
      // Pure: exporting is epoch-level and touches no handle state, so this may be called from
      // inside the apply of the very commit whose blob it opens — the only place it's called from.
      const key = await handle().exportSecret(entryLabel, EXPORT_CONTEXT, SECRET_LENGTH)
      return xchacha20poly1305(key, sealed.subarray(1, 1 + ENTRY_NONCE_BYTES)).decrypt(
        sealed.subarray(1 + ENTRY_NONCE_BYTES),
      )
    },

    unwrap: async (bytes) => {
      // Throws for any epoch but this handle's — ordinary control flow; the caller drops it.
      const { payload, senderDID } = await handle().decrypt(bytes)
      // `unwrap` requires a sender; `GroupHandle.decrypt` doesn't guarantee one — it can come
      // back absent if the sender-data AEAD open fails or is malformed, no member is found at
      // the authenticated leaf index, or the leaf's credential fails to parse
      // (`group-handle.ts:677,867-872,536-537`, `sender-data.ts:120,123`). `@kumiai/mls` treats
      // all three as "cannot name the author", never "no author" — a shape this port has no case
      // for, so it's refused here rather than passed up with the field missing.
      if (senderDID == null) {
        throw new Error('unwrap: opened frame has no authenticated sender')
      }
      return { payload, senderDID }
    },

    frameEpoch: (bytes) => {
      // Total by contract: readMessageEpoch never throws and answers without a key.
      const epoch = readMessageEpoch(bytes)
      return epoch == null ? null : Number(epoch)
    },
  }
}
