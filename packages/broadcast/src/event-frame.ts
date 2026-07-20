import { type BroadcastMessage, encodeFrame } from './transport.js'

/**
 * Build the canonical fire-and-forget event message a producer publishes to a broadcast topic:
 * `{ payload: { typ: 'event', prc, data } }`. The single source of that shape (and the empty-`data`
 * default) shared by {@link BroadcastClient.dispatch} and any other producer that must match it.
 */
export function buildEventMessage(
  prc: string,
  data: Record<string, unknown> = {},
): BroadcastMessage {
  return { payload: { typ: 'event', prc, data } }
}

/**
 * Encode an event to the exact plaintext bytes the broadcast transport produces before wrapping —
 * `encodeFrame(buildEventMessage(prc, data))`. A producer that publishes an event off the transport
 * (e.g. a log-retained lane) uses this so its bytes stay byte-identical to a live dispatch, keeping
 * the receive side (`unwrap` then decode) symmetric across both — including the wire version stamp,
 * which `encodeFrame` is the one place to write.
 */
export function encodeEventFrame(prc: string, data: Record<string, unknown> = {}): Uint8Array {
  return encodeFrame(buildEventMessage(prc, data))
}
