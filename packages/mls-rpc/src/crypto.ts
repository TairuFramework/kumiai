import type { GroupHandle } from '@kumiai/mls'
import { readMessageEpoch } from '@kumiai/mls'
import type { GroupCrypto } from '@kumiai/rpc'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { createRuntime } from '@sozai/runtime'

/**
 * The label the app-lane topic secret is exported under. Domain separation, in the MLS
 * exporter's own label field: a secret exported here is not the one any other consumer of
 * the same epoch gets, whatever context it asks with.
 */
export const APP_TOPIC_LABEL = 'kumiai/app-topic/v1'

/**
 * The label the ledger-entry seal key is exported under. A DIFFERENT label from the app-lane
 * topic's, and that is required rather than tidy: the topic secret names a topic and is handed
 * to anything that derives one, while this key opens the group's control-ledger bodies. Sharing
 * one exported secret between a name and a key would make every holder of the name a reader of
 * the bodies.
 */
export const ENTRY_SEAL_LABEL = 'kumiai/ledger-entries/v1'

/** The exporter context. Fixed: the label already separates each consumer. */
const EXPORT_CONTEXT = new Uint8Array()

/** Bytes an exported secret is: the ciphersuite's KDF output length. */
const SECRET_LENGTH = 32

/** XChaCha20-Poly1305's nonce, carried in the clear ahead of the ciphertext. */
const ENTRY_NONCE_BYTES = 24

const runtime = createRuntime()

export type GroupCryptoParams = {
  /**
   * The handle the peer is at RIGHT NOW. A function and not a value because the peer's
   * handle is replaced when the peer adopts a commit it authored, and a crypto closing
   * over the handle it was built with would silently seal at a dead epoch forever.
   */
  handle: () => GroupHandle
  /** Override the exporter label. Changing it changes every topic the group derives. */
  label?: string
  /**
   * Override the ledger-entry seal's exporter label. Changing it changes the key every commit's
   * entry blob is sealed under, so a group whose members disagree on it cannot apply each other's
   * commits.
   */
  entryLabel?: string
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
 * 2. **`exportSecret` is one-way; the fake's is not.** The fake XORs the epoch into a fixed
 *    base, so any member holding one epoch's bytes computes every other epoch's. This exports
 *    from the MLS epoch's exporter secret, which a removed member cannot reach forward from.
 *    That difference is the entire security property the app-lane topic rests on, and it is
 *    real only here.
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
  const { handle, label = APP_TOPIC_LABEL, entryLabel = ENTRY_SEAL_LABEL } = params

  return {
    epoch: () => Number(handle().epoch),

    exportSecret: () => handle().exportSecret(label, EXPORT_CONTEXT, SECRET_LENGTH),

    wrap: (bytes) => handle().encrypt(bytes),

    sealEntries: async (bytes) => {
      const key = await handle().exportSecret(entryLabel, EXPORT_CONTEXT, SECRET_LENGTH)
      // Random per seal: two members can frame a commit at the same epoch, so the key alone does
      // not bound how many blobs it seals, and a repeated nonce under one key is a break. A
      // 24-byte nonce makes a collision unreachable without any counter to persist.
      const nonce = runtime.getRandomValues(new Uint8Array(ENTRY_NONCE_BYTES))
      const ciphertext = xchacha20poly1305(key, nonce).encrypt(bytes)
      const sealed = new Uint8Array(nonce.length + ciphertext.length)
      sealed.set(nonce, 0)
      sealed.set(ciphertext, nonce.length)
      return sealed
    },

    openEntries: async (sealed) => {
      if (sealed.length < ENTRY_NONCE_BYTES) throw new Error('openEntries: not a sealed blob')
      // PURE: the exporter secret is epoch-level and reading it consumes no ratchet key and
      // touches no handle state, so this may be called from inside the apply of the very commit
      // whose blob it opens — which is the only place it is called from.
      const key = await handle().exportSecret(entryLabel, EXPORT_CONTEXT, SECRET_LENGTH)
      return xchacha20poly1305(key, sealed.subarray(0, ENTRY_NONCE_BYTES)).decrypt(
        sealed.subarray(ENTRY_NONCE_BYTES),
      )
    },

    unwrap: async (bytes) => {
      // Throws for any epoch but this handle's. That is ordinary control flow on the read
      // paths — it is how a retained frame says "not mine" — and the caller drops it.
      const { payload, senderDID } = await handle().decrypt(bytes)
      return { payload, ...(senderDID != null && { senderDID }) }
    },

    frameEpoch: (bytes) => {
      // Total by contract: asked about every frame a log holds, most of which are not this
      // handle's to open. readMessageEpoch never throws and answers without any key.
      const epoch = readMessageEpoch(bytes)
      return epoch == null ? null : Number(epoch)
    },
  }
}
