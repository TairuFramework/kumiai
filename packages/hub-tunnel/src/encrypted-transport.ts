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
  drainTimeoutMs?: number
}

type WrapHubParams = {
  hub: MailboxHub
  encryptor: Encryptor
  groupID: string
  onEvent?: ObservabilityEventListener
  onEncryptError: (error: EncryptError) => void
  drainTimeoutMs: number
  drains: Set<Promise<void>>
}

function wrapHub({
  hub,
  encryptor,
  groupID,
  onEvent,
  onEncryptError,
  drainTimeoutMs,
  drains,
}: WrapHubParams): MailboxHub {
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
      const ackedOnDecrypt = new Set<string>()
      const inFlightDecrypts = new Set<Promise<void>>()
      let closing = false
      let closePromise: Promise<IteratorResult<StoredMessage>> | undefined

      // A hub's ack may be synchronous and throw synchronously, before `Promise.resolve` sees it —
      // so the rejection guard alone is not enough (same fix as `ackUpstream` in `rpc/src/hub-mux.ts`).
      const ackHandled = (sequenceID: string, decrypted = false): void => {
        if (ackedOnDecrypt.delete(sequenceID)) return
        if (inner.ack == null) return
        if (decrypted) ackedOnDecrypt.add(sequenceID)
        try {
          void Promise.resolve(inner.ack(sequenceID)).catch((error: unknown) => {
            onEvent?.({ type: 'ack-failed', sequenceID, error })
          })
        } catch (error) {
          onEvent?.({ type: 'ack-failed', sequenceID, error })
        }
      }

      const iterator: AsyncIterator<StoredMessage> = {
        async next(): Promise<IteratorResult<StoredMessage>> {
          while (true) {
            if (closing) return { value: undefined, done: true }
            const result = await innerIterator.next()
            if (closing) return { value: undefined, done: true }
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
            const decryptWork = (async () => {
              const plaintext = await encryptor.decrypt(fromB64(envelope.ciphertext))
              // The receive key is spent now, even if the pump cannot deliver this frame.
              ackHandled(message.sequenceID, true)
              return plaintext
            })()
            const settled = decryptWork.then(
              () => {},
              () => {},
            )
            inFlightDecrypts.add(settled)
            let plaintext: Uint8Array
            try {
              plaintext = await decryptWork
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
            } finally {
              inFlightDecrypts.delete(settled)
            }
            if (closing) {
              ackedOnDecrypt.delete(message.sequenceID)
              return { value: undefined, done: true }
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
          if (closePromise != null) return closePromise
          closing = true
          closePromise = (async () => {
            if (inFlightDecrypts.size > 0) {
              let timer: ReturnType<typeof setTimeout> | undefined
              const expiry = new Promise<'expired'>((resolve) => {
                timer = setTimeout(() => resolve('expired'), drainTimeoutMs)
              })
              const outcome = await Promise.race([
                Promise.allSettled([...inFlightDecrypts]).then(() => 'drained' as const),
                expiry,
              ])
              if (timer != null) clearTimeout(timer)
              if (outcome === 'expired') {
                onEvent?.({ type: 'decrypt-drain-timeout', timeoutMs: drainTimeoutMs })
              }
            }
            ackedOnDecrypt.clear()
            try {
              // A wire hub may leave return() parked behind an idle next().
              const result = innerIterator.return?.()
              if (result != null) void Promise.resolve(result).catch(() => {})
            } catch {
              // Closing is best effort.
            }
            return { value: undefined, done: true }
          })()
          const drain = closePromise.then(() => {})
          drains.add(drain)
          void drain.then(
            () => drains.delete(drain),
            () => drains.delete(drain),
          )
          return closePromise
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
    ...(hub.events != null ? { events: hub.events } : {}),
  }
  return wrapped
}

export function createEncryptedHubTunnelTransport<R, W>(
  params: EncryptedHubTunnelTransportParams,
): TransportType<R, W> {
  const {
    hub,
    encryptor,
    groupID,
    onEvent,
    signal: externalSignal,
    drainTimeoutMs = 5000,
    ...rest
  } = params
  const drains = new Set<Promise<void>>()

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
    drainTimeoutMs,
    drains,
    onEncryptError: (err) => {
      internalController.abort(err)
    },
  })

  const transport = createHubTunnelTransport<R, W>({
    ...rest,
    hub: wrappedHub,
    signal: internalController.signal,
    onEvent,
  })
  // Enkaku awaits disposed listeners; the pump starts return() in its earlier listener.
  transport.events.on('disposed', async () => {
    await Promise.allSettled([...drains])
  })
  return transport
}
