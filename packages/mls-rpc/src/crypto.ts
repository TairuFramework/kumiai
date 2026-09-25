import { type GroupHandle, readMessageAAD, readMessageEpoch } from '@kumiai/mls'
import {
  AppFrameStorageError,
  FrameEpochError,
  type GroupCrypto,
  type PendingAppFrame,
  type PendingAppFrames,
  sortPendingAppFrames,
} from '@kumiai/rpc'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { createRuntime, type Runtime } from '@sozai/runtime'

import type { HandleAccess } from './access.js'

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

export function deriveEntryKey(handle: GroupHandle, label?: string): Promise<Uint8Array> {
  return handle.exportSecret(label ?? ENTRY_SEAL_LABEL, new Uint8Array(), SECRET_LENGTH)
}

export function sealEntries(
  key: Uint8Array,
  entries: Uint8Array,
  runtime: Runtime = createRuntime(),
): Uint8Array {
  // Random per seal: two members can frame a commit at the same epoch.
  const nonce = runtime.getRandomValues(new Uint8Array(ENTRY_NONCE_BYTES))
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(entries)
  const sealed = new Uint8Array(1 + nonce.length + ciphertext.length)
  sealed[0] = ENTRY_VERSION
  sealed.set(nonce, 1)
  sealed.set(ciphertext, 1 + nonce.length)
  return sealed
}

function assertSealedEntryBlob(sealed: Uint8Array): void {
  if (sealed.length <= 1 + ENTRY_NONCE_BYTES) throw new Error('openEntries: not a sealed blob')
  if (sealed[0] !== ENTRY_VERSION) {
    throw new Error(`openEntries: unsupported blob version ${sealed[0]}`)
  }
}

export function openEntries(key: Uint8Array, sealed: Uint8Array): Uint8Array {
  assertSealedEntryBlob(sealed)
  return xchacha20poly1305(key, sealed.subarray(1, 1 + ENTRY_NONCE_BYTES)).decrypt(
    sealed.subarray(1 + ENTRY_NONCE_BYTES),
  )
}

export type GroupCryptoParams = {
  access: HandleAccess
  /**
   * Override the ledger-entry seal's exporter label. Members must agree on it, or they can't
   * apply each other's commits.
   */
  entryLabel?: string
  /** Runtime providing platform primitives. Defaults to `createRuntime()`. */
  runtime?: Runtime
  /** Atomic host store for post-open handle state and the pending record. */
  pending?: {
    persistOpened(stagedState: Uint8Array, record: PendingAppFrame): Promise<void>
    list(): Promise<Array<PendingAppFrame>>
    complete(id: string): Promise<void>
  }
}

/**
 * {@link GroupCrypto} over a live {@link GroupHandle} — the real port, against real MLS.
 *
 * ## Where this diverges from the fake in `@kumiai/rpc`'s test fixtures
 *
 * 1. `unwrap` gates the frame epoch before ts-mls's bounded past-window decrypt.
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
export function createGroupCrypto(
  params: GroupCryptoParams & { pending: NonNullable<GroupCryptoParams['pending']> },
): GroupCrypto & { pending: PendingAppFrames }
export function createGroupCrypto(params: GroupCryptoParams): GroupCrypto
export function createGroupCrypto(params: GroupCryptoParams): GroupCrypto {
  const { access, entryLabel = ENTRY_SEAL_LABEL, runtime = createRuntime(), pending } = params

  return {
    epoch: () => access.epoch(),

    // Passed straight through to the handle's exporter, except `entryLabel`: reusing it would
    // not be an independent export — it's the exact exporter call `sealEntries`/`openEntries`
    // make below (same context, same `SECRET_LENGTH`), so it would hand back the ledger-entry
    // seal key under another name. Refused here, loudly, rather than left to the doc alone.
    exportSecret: (label, length = SECRET_LENGTH) => {
      if (label === entryLabel) {
        throw new Error(`exportSecret: label '${label}' is reserved for the ledger-entry seal`)
      }
      return access.read(async (group) => ({
        secret: await group.exportSecret(label, EXPORT_CONTEXT, length),
        epoch: Number(group.epoch),
      }))
    },

    wrap: (bytes, opts) => access.mutate((group) => group.encrypt(bytes, opts)),

    sealEntries: async (bytes) => {
      const { key, epoch } = await access.read(async (group) => ({
        key: await deriveEntryKey(group, entryLabel),
        epoch: Number(group.epoch),
      }))
      try {
        return { sealed: sealEntries(key, bytes, runtime), epoch }
      } finally {
        key.fill(0)
      }
    },

    openEntries: async (sealed) => {
      assertSealedEntryBlob(sealed)
      const key = await access.read((group) => deriveEntryKey(group, entryLabel))
      try {
        return openEntries(key, sealed)
      } finally {
        key.fill(0)
      }
    },

    unwrap: async (bytes, opts) => {
      if (opts?.frame != null) {
        if (pending == null) throw new Error('unwrap: pending store required for durable open')
        const frame = opts.frame
        const opened = await access.open(
          async (group, persistOpened) => {
            const epoch = Number(group.epoch)
            const frameEpoch = readMessageEpoch(bytes)
            if (frameEpoch != null && Number(frameEpoch) !== epoch) {
              throw new FrameEpochError(Number(frameEpoch), epoch)
            }
            const result = await group.decryptStaged(bytes, opts, async (stagedState, result) => {
              try {
                await persistOpened(stagedState, {
                  frame,
                  payload: result.payload,
                  senderDID: result.senderDID,
                })
              } catch (error) {
                throw new AppFrameStorageError('failed to persist opened app frame', {
                  cause: error,
                })
              }
            })
            return { ...result, epoch }
          },
          (state, record) => pending.persistOpened(state, record),
        )
        return { payload: opened.payload, senderDID: opened.senderDID, epoch: opened.epoch }
      }
      const { payload, senderDID, epoch } = await access.mutate(async (group) => {
        const epoch = Number(group.epoch)
        const frameEpoch = readMessageEpoch(bytes)
        if (frameEpoch != null && Number(frameEpoch) !== epoch) {
          throw new FrameEpochError(Number(frameEpoch), epoch)
        }
        const opened = await group.decrypt(bytes, opts)
        return { ...opened, epoch }
      })
      if (senderDID == null) {
        throw new Error('unwrap: opened frame has no authenticated sender')
      }
      return { payload, senderDID, epoch }
    },

    frameEpoch: (bytes) => {
      // Total by contract: readMessageEpoch never throws and answers without a key.
      const epoch = readMessageEpoch(bytes)
      return epoch == null ? null : Number(epoch)
    },
    frameAAD: (bytes) => readMessageAAD(bytes),
    ...(pending == null
      ? {}
      : {
          pending: {
            list: async () => sortPendingAppFrames(await pending.list()),
            complete: (id: string) => pending.complete(id),
          },
        }),
  }
}
