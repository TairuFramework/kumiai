import { Transport, type TransportType } from '@enkaku/transport'
import { fromUTF, toUTF } from '@sozai/codec'

import type { BroadcastBus } from './bus.js'

/**
 * The version every broadcast frame this build writes carries, and the only one it reads.
 *
 * Broadcast is loose JSON, so adding a field needs no version bump. What the discriminant buys is
 * removing or reinterpreting one: `ReplyData.from` was reinterpreted — taken off the wire, its
 * meaning ("who sent this") replaced by transport-level `senderDID`, settable only by an
 * authenticating `unwrap`. A v0 frame reaching a v1 reader would present a self-asserted name
 * where the reader now expects an authenticated one, so an unrecognised version is REFUSED, not
 * best-effort.
 */
export const BROADCAST_VERSION = 1

/** Message shape carried on a broadcast topic. */
export type BroadcastMessage = {
  payload: { typ: string; prc?: string; data?: unknown; [key: string]: unknown }
  /**
   * WHO SENT THIS, as established by the transport — never by the frame's own contents.
   *
   * On an authenticating transport (one with `unwrap`), this is set only from what `unwrap`
   * recovered from the ciphertext; a `senderDID` present in the encoded bytes is discarded, since
   * on such a transport it's a claim anyone could have written. Without an `unwrap` there's no
   * authority to appeal to, so the wire-carried value stands instead — that's the memory bus, and
   * why `BroadcastResponderParams.from` still exists.
   *
   * Absent means "this transport couldn't say who sent it". Consumers that attribute — notably
   * `BroadcastClient.gather`, which dedups on this — drop such a message rather than attribute it
   * to nobody.
   */
  senderDID?: string
}

export type ByteTransform = (bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>

/** Result of unwrapping inbound bytes: plaintext plus the recovered sender. */
export type UnwrapResult = { payload: Uint8Array; senderDID?: string }

/**
 * Inbound transform. May return raw plaintext bytes (no sender) or an
 * {@link UnwrapResult} carrying the authenticated `senderDID` recovered from the
 * ciphertext (the producer embeds it via `wrap`/encryption).
 */
export type Unwrap = (
  bytes: Uint8Array,
) => Uint8Array | UnwrapResult | Promise<Uint8Array | UnwrapResult>

export type BroadcastTransportParams = {
  topicID: string
  bus: BroadcastBus
  wrap?: ByteTransform
  unwrap?: Unwrap
  signal?: AbortSignal
}

const identityWrap: ByteTransform = (bytes) => bytes
const identityUnwrap: Unwrap = (bytes) => bytes

function encode(value: unknown): Uint8Array {
  return fromUTF(JSON.stringify(value))
}

/**
 * Encode a message to the exact plaintext bytes a broadcast write produces before wrapping:
 * the message stamped with {@link BROADCAST_VERSION}. The single place the version is written,
 * so no producer can forget it — including `encodeEventFrame`, whose whole purpose is to be
 * byte-identical to a live dispatch.
 */
export function encodeFrame(message: BroadcastMessage): Uint8Array {
  // Stamp applied last, so it always wins — a message that somehow carried its own `v` gets
  // overwritten rather than published under its claimed value.
  return encode({ ...message, v: BROADCAST_VERSION })
}

/**
 * Decode plaintext broadcast bytes, refusing any version this build does not speak.
 *
 * Message-bearing on purpose: every other failure on this path is an opaque JSON or decrypt
 * error, and a reader that reported them alike couldn't tell a frame from a future build apart
 * from one belonging to another group. The transport handles both the same way — drop the frame,
 * keep the subscription — so this changes what an operator sees, not what happens.
 */
export function decodeFrame(bytes: Uint8Array): BroadcastMessage {
  const { v, ...message } = JSON.parse(toUTF(bytes)) as BroadcastMessage & { v?: unknown }
  if (v !== BROADCAST_VERSION) {
    throw new Error(
      `Unsupported broadcast frame version ${String(v)}; this build reads v${BROADCAST_VERSION}`,
    )
  }
  return message
}

function normalizeUnwrap(result: Uint8Array | UnwrapResult): UnwrapResult {
  return result instanceof Uint8Array ? { payload: result } : result
}

/**
 * Create a `TransportType` bound to a single broadcast topic. Writes fan out to
 * every transport subscribed to the topic; reads merge inbound topic messages.
 * Only fire-and-forget event traffic is meaningful here — request/stream/channel
 * `rid` correlation does not survive 1→N fan-out (the `BroadcastClient` models
 * anycast on top of events instead). When `unwrap` recovers a `senderDID`, it is
 * attached to the enqueued message.
 */
export function createBroadcastTransport<R = BroadcastMessage, W = BroadcastMessage>(
  params: BroadcastTransportParams,
): TransportType<R, W> {
  const { topicID, bus, wrap = identityWrap, unwrap = identityUnwrap, signal } = params
  /**
   * Whether this transport can establish who sent a frame — true iff `unwrap` is configured. Asked
   * this way rather than "did this unwrap return a sender", because the two differ: an
   * authenticating transport whose `unwrap` recovered nothing has established that it doesn't
   * know, which isn't the same as having no authority and falling back to the frame's own claim.
   */
  const authenticating = params.unwrap != null

  let unsubscribe: (() => void) | undefined
  let readableController: ReadableStreamDefaultController<R> | undefined
  let readerClosed = false

  function closeReadable() {
    if (!readerClosed) {
      readerClosed = true
      try {
        readableController?.close()
      } catch {
        // already closed or errored — ignore
      }
    }
  }

  const readable = new ReadableStream<R>({
    start(controller) {
      readableController = controller
      unsubscribe = bus.subscribe(topicID, (payload, ack) => {
        Promise.resolve(unwrap(payload))
          .then((result) => {
            const { payload: bytes, senderDID } = normalizeUnwrap(result)
            const message = decodeFrame(bytes)
            if (authenticating) {
              // The recovered sender is the ONLY sender here and REPLACES what the bytes claimed
              // even when nothing was recovered — else a forged claim would survive exactly when
              // the open failed to contradict it. Left alone on a non-authenticating transport,
              // where the wire value is all there is.
              if (senderDID == null) delete message.senderDID
              else message.senderDID = senderDID
            }
            controller.enqueue(message as R)
          })
          .catch(() => {
            // Drop this message and keep the subscription alive — expected for messages from
            // other groups/epochs where decryption fails.
          })
          .finally(() => {
            // Both branches above are handled outcomes: a frame from another group or epoch is
            // dropped on purpose, and leaving it unacked redelivers the same undecryptable bytes
            // on every reconnect.
            ack?.()
          })
      })
    },
    cancel() {
      unsubscribe?.()
      unsubscribe = undefined
      readerClosed = true
    },
  })

  const writable = new WritableStream<W>({
    async write(value) {
      const typ = (value as BroadcastMessage | undefined)?.payload?.typ
      if (typ !== 'event') {
        throw new Error(
          `Broadcast transport only carries 'event' payloads; got '${typ ?? 'undefined'}'`,
        )
      }
      const bytes = await wrap(encodeFrame(value as BroadcastMessage))
      await bus.publish(topicID, bytes)
    },
    close() {
      unsubscribe?.()
      unsubscribe = undefined
      closeReadable()
    },
  })

  return new Transport<R, W>({ stream: { readable, writable }, signal })
}
