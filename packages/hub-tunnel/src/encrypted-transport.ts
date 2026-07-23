import type { TransportType } from '@enkaku/transport'
import type { StoredMessage } from '@kumiai/hub-protocol'
import { fromB64, toB64 } from '@sozai/codec'

import type { Encryptor } from './encryptor.js'
import { decodeEnvelope, encodeEnvelope, type TunnelEnvelope } from './envelope.js'
import { DecryptError, EncryptError, EnvelopeDecodeError } from './errors.js'
import type { ObservabilityEventListener } from './events.js'
import {
  createHubTunnelTransport,
  type HubReceiveOptions,
  type HubReceiveSubscription,
  type HubSubscribeOptions,
  type HubTunnelTransportParams,
  type MailboxHub,
  type MailboxPublishParams,
} from './transport.js'

export type EncryptedHubTunnelTransportParams = HubTunnelTransportParams & {
  encryptor: Encryptor
  groupID: string
}

type WrapHubParams = {
  hub: MailboxHub
  encryptor: Encryptor
  groupID: string
  onEvent?: ObservabilityEventListener
  onEncryptError: (error: EncryptError) => void
}

function wrapHub({ hub, encryptor, groupID, onEvent, onEncryptError }: WrapHubParams): MailboxHub {
  const wrapped: MailboxHub = {
    async publish(params: MailboxPublishParams): Promise<{ sequenceID: string }> {
      let ciphertextBytes: Uint8Array
      try {
        ciphertextBytes = await encryptor.encrypt(params.payload)
      } catch (cause) {
        const err = new EncryptError('encrypt failed', { cause })
        onEncryptError(err)
        throw err
      }
      const envelope: TunnelEnvelope = {
        v: 1,
        groupID,
        ciphertext: toB64(ciphertextBytes),
      }
      return await hub.publish({
        senderDID: params.senderDID,
        topicID: params.topicID,
        payload: encodeEnvelope(envelope),
      })
    },
    subscribe(
      subscriberDID: string,
      topicID: string,
      options?: HubSubscribeOptions,
    ): Promise<void> | void {
      return hub.subscribe(subscriberDID, topicID, options)
    },
    unsubscribe(subscriberDID: string, topicID: string): Promise<void> | void {
      return hub.unsubscribe?.(subscriberDID, topicID)
    },
    receive(subscriberDID: string, options?: HubReceiveOptions): HubReceiveSubscription {
      const inner = hub.receive(subscriberDID, options)
      const innerIterator = inner[Symbol.asyncIterator]()

      // A hub's ack may be synchronous, so it may throw synchronously — before `Promise.resolve`
      // ever sees it, which is why the rejection guard alone is not enough (same hole, same fix,
      // as `ackUpstream` in `rpc/src/hub-mux.ts`). Escaping here would kill this drain over a
      // frame it is about to drop anyway.
      const ackHandled = (sequenceID: string): void => {
        try {
          void Promise.resolve(inner.ack?.(sequenceID)).catch(() => {})
        } catch {
          // ignore
        }
      }

      const iterator: AsyncIterator<StoredMessage> = {
        async next(): Promise<IteratorResult<StoredMessage>> {
          while (true) {
            const result = await innerIterator.next()
            if (result.done) {
              return { value: undefined as unknown as StoredMessage, done: true }
            }
            const message = result.value
            let envelope: TunnelEnvelope
            try {
              envelope = decodeEnvelope(message.payload)
            } catch (error) {
              if (error instanceof EnvelopeDecodeError) {
                onEvent?.({ type: 'envelope-decode-failed', error })
                onEvent?.({ type: 'frame-dropped', reason: 'envelope-decode' })
                // Consumed off the inner subscription and never handed further: the read pump's
                // single ack site can never see this sequenceID, so it must be acked here or it
                // is undecodable forever and never durably handled.
                ackHandled(message.sequenceID)
                continue
              }
              throw error
            }
            // WHY: the envelope states its group in the clear and we stamp ours on publish, so a
            // frame addressed to another group is dropped before we ever hand it to the cipher.
            // Honestly: against a working AEAD this catches little — a foreign group's frame is
            // encrypted under a key we do not hold and would fail to decrypt anyway. What it does
            // catch is the same-key case the cipher cannot see: a misroute or a configuration
            // error that puts two groups on one key or one topic, where the bytes authenticate
            // perfectly and are still not ours. It is one string compare, before any crypto, so
            // the cost of keeping it is nil and the cost of trusting the cipher alone for a
            // property the envelope states outright is a silent cross-group delivery.
            if (envelope.groupID !== groupID) {
              onEvent?.({ type: 'frame-dropped', reason: 'group-mismatch' })
              // Permanently unhandleable — this reader will never hold the right key — so leaving
              // it unacked would mean the hub redelivers it on every reconnect until the age
              // bound, with the mailbox entry never reclaimed.
              ackHandled(message.sequenceID)
              continue
            }
            let plaintext: Uint8Array
            try {
              plaintext = await encryptor.decrypt(fromB64(envelope.ciphertext))
            } catch (cause) {
              const err = new DecryptError('decrypt failed', { cause })
              onEvent?.({ type: 'decrypt-failed', error: err })
              onEvent?.({ type: 'frame-dropped', reason: 'decrypt' })
              // Same reasoning as the other two drop paths: dropped here, never reaching the
              // pump's ack site. Unlike those two, this is not permanent by construction — it's
              // a property of the key this reader currently holds, not of the bytes. Safe only
              // because `Encryptor` has no rotation and is fixed for the transport's life; an
              // epoch-keyed encryptor would make acking here discard a frame a later key could
              // open, so that change must revisit this.
              ackHandled(message.sequenceID)
              continue
            }
            const decrypted: StoredMessage = {
              sequenceID: message.sequenceID,
              senderDID: message.senderDID,
              topicID: message.topicID,
              payload: plaintext,
              // Carried through: this wrapper re-writes the payload and nothing else, and dropping
              // the log position here would silently strip it from every lane behind an encrypting
              // hub — leaving a reader unable to advance a log cursor over a frame it was pushed.
              ...(message.logPosition != null ? { logPosition: message.logPosition } : {}),
            }
            return { value: decrypted, done: false }
          }
        },
        return(): Promise<IteratorResult<StoredMessage>> {
          innerIterator.return?.()
          return Promise.resolve({ value: undefined as unknown as StoredMessage, done: true })
        },
      }

      return {
        [Symbol.asyncIterator]() {
          return iterator
        },
        return() {
          inner.return?.()
        },
        // Carried through for the same reason `logPosition` is above: this wrapper re-writes the
        // payload and nothing else. Dropping it severs the durable-ack contract for every lane
        // behind an encrypting hub. The same guarded helper the drop paths above use: a
        // synchronous throw from `inner.ack` must not escape here either.
        ...(inner.ack != null ? { ack: ackHandled } : {}),
      }
    },
  }
  if (hub.events != null) {
    wrapped.events = hub.events
  }
  return wrapped
}

export function createEncryptedHubTunnelTransport<R, W>(
  params: EncryptedHubTunnelTransportParams,
): TransportType<R, W> {
  const { hub, encryptor, groupID, onEvent, signal: externalSignal, ...rest } = params

  const internalController = new AbortController()
  if (externalSignal != null) {
    if (externalSignal.aborted) {
      internalController.abort(externalSignal.reason)
    } else {
      externalSignal.addEventListener(
        'abort',
        () => {
          internalController.abort(externalSignal.reason)
        },
        { once: true },
      )
    }
  }

  const wrappedHub = wrapHub({
    hub,
    encryptor,
    groupID,
    onEvent,
    onEncryptError: (err) => {
      internalController.abort(err)
    },
  })

  return createHubTunnelTransport<R, W>({
    ...rest,
    hub: wrappedHub,
    signal: internalController.signal,
    onEvent,
  })
}
