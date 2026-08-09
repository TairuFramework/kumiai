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
  /**
   * Whether this endpoint may be POSTed to. Default: `https:` only.
   *
   * The check lives here, not at registration: the hub's rule is that it never parses an endpoint,
   * and the sender is where provider knowledge already sits. Without it an authenticated DID can
   * register any string and have the hub issue requests to it — an internal host, a loopback
   * admin port, a `file:` URL — and then read the outcome back through `unregisterWake()`, since a
   * `gone` verdict deletes the registration and any other verdict does not.
   *
   * Widen it to run a self-hosted push service over plain HTTP, or narrow it to an allowlist of
   * origins. A predicate that throws is treated as a rejection.
   */
  allowEndpoint?: (url: URL) => boolean
}

/**
 * RFC 8030 endpoints are HTTPS. Anything else is either a misconfiguration or an attempt to aim
 * the hub at something that is not a push service.
 */
function isHttpsEndpoint(url: URL): boolean {
  return url.protocol === 'https:'
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
  const allowEndpoint = params.allowEndpoint ?? isHttpsEndpoint

  return {
    async send({ registration, body }: WakeSendParams): Promise<WakeVerdict> {
      let response: Response
      try {
        const url = new URL(registration.endpoint)
        // `retry`, not `gone`, and the distinction is not cosmetic. `gone` DELETES the
        // registration, and it means the endpoint is dead — a fact about the endpoint. A policy
        // refusal is a fact about this hub's configuration, which a redeploy can reverse: under
        // `gone`, widening `allowEndpoint` after a misconfiguration would find every device that
        // published in the meantime already unsubscribed, silently and unrecoverably. `retry`
        // keeps the registration and reports through `onStoreError`, so the operator sees the
        // misconfiguration instead of losing the registry to it. The cost is a rejected endpoint
        // re-failing on every frame — local, never a network call, and loud.
        if (!allowEndpoint(url)) return 'retry'
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
