import { fromUTF } from '@sozai/codec'

/** Version 1 binds both destination topic and declared retention intent to an app seal. */
export type AppAAD = { topicID: string; intent: 'ephemeral' | 'log' }

export function encodeAppAAD({ topicID, intent }: AppAAD): Uint8Array {
  if (intent !== 'ephemeral' && intent !== 'log') throw new Error('Invalid app AAD intent')
  const topic = fromUTF(topicID)
  if (new TextDecoder('utf-8', { fatal: true }).decode(topic) !== topicID) {
    throw new Error('App AAD topic must be well-formed UTF-8')
  }
  const encoded = new Uint8Array(2 + topic.length)
  encoded[0] = 1
  encoded[1] = intent === 'log' ? 1 : 0
  encoded.set(topic, 2)
  return encoded
}

/** Decode untrusted cleartext AAD. Its contents become authenticated only after the open. */
export function decodeAppAAD(bytes: Uint8Array): AppAAD | null {
  if (bytes.length < 2 || bytes[0] !== 1 || (bytes[1] !== 0 && bytes[1] !== 1)) return null
  try {
    return {
      topicID: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(2)),
      intent: bytes[1] === 1 ? 'log' : 'ephemeral',
    }
  } catch {
    return null
  }
}
