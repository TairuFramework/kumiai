import {
  encodeBase64url,
  type WakeSender,
  type WakeSendParams,
  type WakeVerdict,
} from '@kumiai/hub-protocol'
import { p256 } from '@noble/curves/nist.js'
import { sha256 } from '@noble/hashes/sha2.js'

export type VapidParams = {
  /** `mailto:` or `https:` contact the push service can reach you at. RFC 8292 requires one. */
  subject: string
  /** VAPID private key, 32 bytes. */
  privateKey: Uint8Array
  /** VAPID public key, raw uncompressed P-256 point, 65 bytes. */
  publicKey: Uint8Array
}

export type WebPushSenderParams = {
  vapid: VapidParams
  /** Seconds the push service may hold the message. Default: 86 400. */
  ttl?: number
  /** Injected for tests. Default: global `fetch`. */
  fetch?: typeof globalThis.fetch
  /** Seconds the VAPID JWT stays valid. Default: 43 200 (RFC 8292's 12-hour ceiling). */
  jwtLifetime?: number
}

function vapidToken(vapid: VapidParams, audience: string, lifetime: number): string {
  const header = encodeBase64url(
    new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })),
  )
  const claims = encodeBase64url(
    new TextEncoder().encode(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + lifetime,
        sub: vapid.subject,
      }),
    ),
  )
  const signingInput = `${header}.${claims}`
  const digest = sha256(new TextEncoder().encode(signingInput))
  // ES256 wants the raw 64-byte r||s pair, which is exactly what noble v2's sign returns.
  const signature = p256.sign(digest, vapid.privateKey, { prehash: false })
  return `${signingInput}.${encodeBase64url(signature)}`
}

/**
 * A sender for any endpoint speaking RFC 8030 Web Push: browser push services, UnifiedPush
 * distributors, ntfy, or a self-hosted relay. It POSTs the sealed body untouched — the encryption
 * already happened in `sealWakeHint`, and this layer never sees inside it.
 */
export function createWebPushSender(params: WebPushSenderParams): WakeSender {
  const fetchImpl = params.fetch ?? globalThis.fetch
  const ttl = params.ttl ?? 86_400
  const jwtLifetime = params.jwtLifetime ?? 43_200

  return {
    async send({ registration, body }: WakeSendParams): Promise<WakeVerdict> {
      let response: Response
      try {
        const url = new URL(registration.endpoint)
        response = await fetchImpl(registration.endpoint, {
          method: 'POST',
          headers: {
            authorization: `vapid t=${vapidToken(params.vapid, url.origin, jwtLifetime)}, k=${encodeBase64url(params.vapid.publicKey)}`,
            'content-encoding': 'aes128gcm',
            'content-type': 'application/octet-stream',
            ttl: String(ttl),
          },
          body: body as BodyInit,
        })
      } catch {
        // A network failure is transient by definition — never a reason to drop a registration.
        return 'retry'
      }
      if (response.status === 404 || response.status === 410) return 'gone'
      if (response.status >= 200 && response.status < 300) return 'delivered'
      return 'retry'
    },
  }
}
