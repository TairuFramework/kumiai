import {
  encodeBase64url,
  type WakeSender,
  type WakeSendParams,
  type WakeVerdict,
} from '@kumiai/hub-protocol'

export type ExpoSenderParams = {
  /** Expo access token, when the project enforces one. */
  accessToken?: string
  /** Injected for tests. Default: global `fetch`. */
  fetch?: typeof globalThis.fetch
  /** Placeholder title the Notification Service Extension REPLACES once it opens the hint. */
  placeholderTitle?: string
}

type ExpoTicket = { status?: string; details?: { error?: string } }

const EXPO_ENDPOINT = 'https://exp.host/--/api/v2/push/send'

/**
 * A sender for the Expo Push API — a plain HTTPS POST, so no vendor SDK is pulled in.
 *
 * Expo (and APNs or FCM behind it) sees the device token, the timing, and a constant-size
 * ciphertext. It never sees a topic, a DID, or content: `data.w` is the sealed body and nothing
 * else travels.
 *
 * `mutableContent` is what lets an iOS Notification Service Extension open the hint and rewrite the
 * title before display. `contentAvailable` asks for a background wake, which iOS throttles — so the
 * placeholder alert, not the background pass, is what the user is guaranteed to see.
 */
export function createExpoSender(params: ExpoSenderParams = {}): WakeSender {
  const fetchImpl = params.fetch ?? globalThis.fetch
  const title = params.placeholderTitle ?? 'New activity'

  return {
    async send({ registration, body }: WakeSendParams): Promise<WakeVerdict> {
      try {
        const response = await fetchImpl(EXPO_ENDPOINT, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            ...(params.accessToken != null
              ? { authorization: `Bearer ${params.accessToken}` }
              : {}),
          },
          body: JSON.stringify({
            to: registration.endpoint,
            title,
            mutableContent: true,
            contentAvailable: true,
            data: { w: encodeBase64url(body) },
          }),
        })
        if (!response.ok) return 'retry'
        // A 2xx response body is not guaranteed to be the shape we expect — Expo could answer
        // with `null` or something else malformed. `?.` all the way down, and the extraction stays
        // inside the try, keeps that a `retry` rather than a thrown exception out of `send`.
        const payload = (await response.json()) as { data?: Array<ExpoTicket> } | null
        const ticket = payload?.data?.[0]
        if (ticket?.status === 'ok') return 'delivered'
        if (ticket?.details?.error === 'DeviceNotRegistered') return 'gone'
        return 'retry'
      } catch {
        return 'retry'
      }
    },
  }
}
