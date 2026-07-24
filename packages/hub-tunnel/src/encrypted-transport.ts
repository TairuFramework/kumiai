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

      // A hub's ack may be synchronous and throw synchronously, before `Promise.resolve` sees it —
      // so the rejection guard alone is not enough (same fix as `ackUpstream` in `rpc/src/hub-mux.ts`).
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
                // Dropped here, never reaching the read pump's ack site — so acked here, or it is
                // undecodable and redelivered forever.
                ackHandled(message.sequenceID)
                continue
              }
              throw error
            }
            // The envelope states its group in the clear and we stamp ours on publish. Against a
            // working AEAD a foreign group's frame would fail to decrypt anyway; what this one string
            // compare catches, before any crypto, is the same-key misroute the cipher cannot see —
            // two groups on one key or topic, bytes authenticating perfectly and still not ours.
            if (envelope.groupID !== groupID) {
              onEvent?.({ type: 'frame-dropped', reason: 'group-mismatch' })
              // Permanently unhandleable — this reader never holds the right key — so acked, else
              // redelivered every reconnect until the age bound.
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
              // Acked like the other drop paths. Unlike them this is not permanent by construction —
              // it's a property of the key this reader holds. Safe only because `Encryptor` is fixed
              // for the transport's life; an epoch-keyed encryptor must revisit this (acking here
              // would discard a frame a later key could open).
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
        // Forwarded through — this wrapper re-writes the payload and nothing else. Dropping it
        // would sever the durable-ack contract for every lane behind an encrypting hub. Uses the
        // guarded helper so a synchronous `inner.ack` throw does not escape.
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
