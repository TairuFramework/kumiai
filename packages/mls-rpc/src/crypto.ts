import type { GroupHandle } from '@kumiai/mls'
import { readMessageEpoch } from '@kumiai/mls'
import type { GroupCrypto } from '@kumiai/rpc'

/**
 * The label the app-lane topic secret is exported under. Domain separation, in the MLS
 * exporter's own label field: a secret exported here is not the one any other consumer of
 * the same epoch gets, whatever context it asks with.
 */
export const APP_TOPIC_LABEL = 'kumiai/app-topic/v1'

/** The exporter context. Fixed: the label already separates this consumer. */
const APP_TOPIC_CONTEXT = new Uint8Array()

/** Bytes an app-lane topic secret is: the ciphersuite's KDF output length. */
const SECRET_LENGTH = 32

export type GroupCryptoParams = {
  /**
   * The handle the peer is at RIGHT NOW. A function and not a value because the peer's
   * handle is replaced when the peer adopts a commit it authored, and a crypto closing
   * over the handle it was built with would silently seal at a dead epoch forever.
   */
  handle: () => GroupHandle
  /** Override the exporter label. Changing it changes every topic the group derives. */
  label?: string
}

/**
 * {@link GroupCrypto} over a live {@link GroupHandle} — the real port, against real MLS.
 *
 * ## Where this diverges from the fake in `@kumiai/rpc`'s test fixtures
 *
 * 1. **`unwrap` opens strictly at the handle's current epoch, and so does the fake — but
 *    for different reasons.** The fake refuses every other epoch by construction. This one
 *    refuses them because ts-mls does: a frame below the handle's epoch has had its keys
 *    ratcheted away, and one above it has no keys yet. Real MLS is documented as keeping a
 *    four-epoch window, and this implementation does NOT reach into it — `GroupHandle.decrypt`
 *    delegates to ts-mls's `processMessage`, which opens against the current epoch's secret
 *    tree only. So the port contract's "an implementation that opens strictly at the current
 *    epoch is a correct implementation" is what actually ships, not a stricter-than-necessary
 *    double. **The fake is not stricter than the real port here. It is the same.**
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
  const { handle, label = APP_TOPIC_LABEL } = params

  return {
    epoch: () => Number(handle().epoch),

    exportSecret: () => handle().exportSecret(label, APP_TOPIC_CONTEXT, SECRET_LENGTH),

    wrap: (bytes) => handle().encrypt(bytes),

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
