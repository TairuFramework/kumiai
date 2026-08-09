import type { WakeRegistration } from '@kumiai/hub-protocol'
import { decodeBase64url } from '@kumiai/hub-protocol'
import { p256 } from '@noble/curves/nist.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { describe, expect, test } from 'vitest'

import { createWebPushSender } from '../src/webPushSender.js'

const vapidPrivateKey = p256.utils.randomSecretKey()
const vapid = {
  subject: 'mailto:ops@example.com',
  privateKey: vapidPrivateKey,
  publicKey: p256.getPublicKey(vapidPrivateKey, false),
}

const registration: WakeRegistration = {
  did: 'did:key:alice',
  kind: 'webpush',
  endpoint: 'https://push.example.com/send/abc',
  publicKey: 'cHVibGlj',
  authSecret: 'YXV0aA',
}

const body = new Uint8Array(597).fill(7)

function recordingFetch(status: number) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(null, { status })
  }
  return { calls, fetchImpl }
}

function decodeJwt(authorization: string): {
  header: Record<string, unknown>
  claims: Record<string, unknown>
  signature: Uint8Array
  signingInput: string
  /** The `k=` public key transmitted alongside the token — the key a push service actually checks against. */
  transmittedKey: Uint8Array
} {
  const match = authorization.match(/^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/)
  if (match == null) throw new Error('authorization header does not match the vapid scheme')
  const token = match[1]
  const [headerPart, claimsPart, signaturePart] = token.split('.')
  return {
    header: JSON.parse(new TextDecoder().decode(decodeBase64url(headerPart))),
    claims: JSON.parse(new TextDecoder().decode(decodeBase64url(claimsPart))),
    signature: decodeBase64url(signaturePart),
    signingInput: `${headerPart}.${claimsPart}`,
    transmittedKey: decodeBase64url(match[2]),
  }
}

describe('createWebPushSender', () => {
  test('POSTs the body to the endpoint with the aes128gcm headers', async () => {
    const { calls, fetchImpl } = recordingFetch(201)
    const sender = createWebPushSender({ vapid, fetch: fetchImpl })

    await expect(sender.send({ registration, body })).resolves.toBe('delivered')

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://push.example.com/send/abc')
    const headers = new Headers(calls[0].init.headers)
    expect(calls[0].init.method).toBe('POST')
    expect(headers.get('content-encoding')).toBe('aes128gcm')
    expect(headers.get('content-type')).toBe('application/octet-stream')
    expect(headers.get('ttl')).toBe('86400')
    expect(headers.get('authorization')).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/)
  })

  test('POSTs exactly the sealed body bytes, unmodified', async () => {
    const { calls, fetchImpl } = recordingFetch(201)
    const sender = createWebPushSender({ vapid, fetch: fetchImpl })

    await sender.send({ registration, body })

    const sent = calls[0].init.body
    expect(sent).toBeInstanceOf(Uint8Array)
    const sentBytes = sent as Uint8Array
    expect(sentBytes).toHaveLength(body.length)
    expect(Array.from(sentBytes)).toEqual(Array.from(body))
  })

  test('the VAPID JWT aud is the endpoint origin, and sub is the configured subject', async () => {
    const { calls, fetchImpl } = recordingFetch(201)
    const sender = createWebPushSender({ vapid, fetch: fetchImpl })

    await sender.send({ registration, body })

    const headers = new Headers(calls[0].init.headers)
    const authorization = headers.get('authorization')
    if (authorization == null) throw new Error('expected an authorization header')
    const { claims } = decodeJwt(authorization)
    expect(claims.aud).toBe('https://push.example.com')
    expect(claims.sub).toBe(vapid.subject)
  })

  test('the VAPID JWT header is ES256/JWT, and exp is within the default lifetime', async () => {
    const { calls, fetchImpl } = recordingFetch(201)
    const sender = createWebPushSender({ vapid, fetch: fetchImpl })

    const before = Math.floor(Date.now() / 1000)
    await sender.send({ registration, body })
    const now = Math.floor(Date.now() / 1000)

    const headers = new Headers(calls[0].init.headers)
    const authorization = headers.get('authorization')
    if (authorization == null) throw new Error('expected an authorization header')
    const { header, claims } = decodeJwt(authorization)
    expect(header.alg).toBe('ES256')
    expect(header.typ).toBe('JWT')
    const exp = claims.exp as number
    expect(exp).toBeGreaterThan(before)
    expect(exp).toBeLessThanOrEqual(now + 43_200)
  })

  test('the jwtLifetime override changes the JWT exp', async () => {
    const { calls, fetchImpl } = recordingFetch(201)
    const sender = createWebPushSender({ vapid, fetch: fetchImpl, jwtLifetime: 300 })

    const before = Math.floor(Date.now() / 1000)
    await sender.send({ registration, body })
    const now = Math.floor(Date.now() / 1000)

    const headers = new Headers(calls[0].init.headers)
    const authorization = headers.get('authorization')
    if (authorization == null) throw new Error('expected an authorization header')
    const { claims } = decodeJwt(authorization)
    const exp = claims.exp as number
    expect(exp).toBeGreaterThan(before)
    expect(exp).toBeLessThanOrEqual(now + 300)
  })

  test('the ttl override changes the Ttl header', async () => {
    const { calls, fetchImpl } = recordingFetch(201)
    const sender = createWebPushSender({ vapid, fetch: fetchImpl, ttl: 60 })

    await sender.send({ registration, body })

    const headers = new Headers(calls[0].init.headers)
    expect(headers.get('ttl')).toBe('60')
  })

  test('the VAPID JWT signature verifies against the transmitted k= public key', async () => {
    const { calls, fetchImpl } = recordingFetch(201)
    const sender = createWebPushSender({ vapid, fetch: fetchImpl })

    await sender.send({ registration, body })

    const headers = new Headers(calls[0].init.headers)
    const authorization = headers.get('authorization')
    if (authorization == null) throw new Error('expected an authorization header')
    const { signature, signingInput, transmittedKey } = decodeJwt(authorization)
    // Pin k= to the configured key too: a signature check alone would still pass if the sender
    // signed correctly but transmitted a DIFFERENT (still internally-consistent) keypair's public
    // half — which a push service would reject as a key/signature mismatch it can't attribute.
    expect(Array.from(transmittedKey)).toEqual(Array.from(vapid.publicKey))
    const digest = sha256(new TextEncoder().encode(signingInput))
    expect(p256.verify(signature, digest, transmittedKey, { prehash: false })).toBe(true)
  })

  test('carries no cleartext topic or DID in the request', async () => {
    const { calls, fetchImpl } = recordingFetch(201)
    const sender = createWebPushSender({ vapid, fetch: fetchImpl })

    await sender.send({ registration, body })

    const headers = new Headers(calls[0].init.headers)
    const serializedHeaders = JSON.stringify(Object.fromEntries(headers.entries()))
    expect(serializedHeaders).not.toContain('did:key:alice')
    expect(serializedHeaders.toLowerCase()).not.toContain('topic')
  })

  test('404 and 410 are gone', async () => {
    for (const status of [404, 410]) {
      const { fetchImpl } = recordingFetch(status)
      const sender = createWebPushSender({ vapid, fetch: fetchImpl })
      await expect(sender.send({ registration, body })).resolves.toBe('gone')
    }
  })

  // Pinned separately from the 429/5xx case because the failure this guards is a plausible edit,
  // not a typo: 401/403 mean the VAPID credentials were refused, which reads like "this endpoint
  // will never accept us again". It is not — it is one misconfigured key pair away from `gone`
  // deleting every registration on the hub, one send at a time, while the endpoints stay perfectly
  // alive.
  test('401 and 403 are retry — an auth failure is ours, not the endpoint being dead', async () => {
    for (const status of [401, 403]) {
      const { fetchImpl } = recordingFetch(status)
      const sender = createWebPushSender({ vapid, fetch: fetchImpl })
      await expect(sender.send({ registration, body })).resolves.toBe('retry')
    }
  })

  test('429 and 5xx are retry', async () => {
    for (const status of [429, 500, 503]) {
      const { fetchImpl } = recordingFetch(status)
      const sender = createWebPushSender({ vapid, fetch: fetchImpl })
      await expect(sender.send({ registration, body })).resolves.toBe('retry')
    }
  })

  // An endpoint is an opaque string the hub never parses, so an authenticated DID can register
  // anything and have the hub issue requests to it — an internal host, a loopback admin port — and
  // then read the outcome back through `unregisterWake()`, since only `gone` deletes. The default
  // predicate is what stops the request being made at all.
  test('by default a non-https endpoint is rejected without any fetch', async () => {
    for (const endpoint of [
      'http://push.example.com/send/abc',
      'http://127.0.0.1:8080/admin',
      'file:///etc/passwd',
    ]) {
      const { calls, fetchImpl } = recordingFetch(201)
      const sender = createWebPushSender({ vapid, fetch: fetchImpl })

      // `retry`, not `gone`: a policy refusal is a fact about the hub's configuration, which a
      // redeploy can reverse, and `gone` would delete the registration unrecoverably.
      await expect(
        sender.send({ registration: { ...registration, endpoint }, body }),
      ).resolves.toBe('retry')
      // The point of the check — the request never left.
      expect(calls).toHaveLength(0)
    }
  })

  test('https is allowed by default', async () => {
    const { calls, fetchImpl } = recordingFetch(201)
    const sender = createWebPushSender({ vapid, fetch: fetchImpl })

    await expect(sender.send({ registration, body })).resolves.toBe('delivered')
    expect(calls).toHaveLength(1)
  })

  test('a widened allowEndpoint lets a self-hosted http relay through', async () => {
    const { calls, fetchImpl } = recordingFetch(201)
    const seen: Array<string> = []
    const sender = createWebPushSender({
      vapid,
      fetch: fetchImpl,
      allowEndpoint: (url) => {
        seen.push(url.origin)
        return url.origin === 'http://relay.internal:8080'
      },
    })

    await expect(
      sender.send({
        registration: { ...registration, endpoint: 'http://relay.internal:8080/send/abc' },
        body,
      }),
    ).resolves.toBe('delivered')
    expect(calls).toHaveLength(1)
    // The predicate is handed a parsed URL, not the raw string — so a host writes an origin check
    // rather than a substring match it can get wrong.
    expect(seen).toEqual(['http://relay.internal:8080'])
  })

  test('a narrowed allowEndpoint rejects an https endpoint off its allowlist', async () => {
    const { calls, fetchImpl } = recordingFetch(201)
    const sender = createWebPushSender({
      vapid,
      fetch: fetchImpl,
      allowEndpoint: (url) => url.origin === 'https://allowed.example',
    })

    await expect(sender.send({ registration, body })).resolves.toBe('retry')
    expect(calls).toHaveLength(0)
  })

  test('a throwing allowEndpoint is a rejection, not an exception out of send', async () => {
    const { calls, fetchImpl } = recordingFetch(201)
    const sender = createWebPushSender({
      vapid,
      fetch: fetchImpl,
      allowEndpoint: () => {
        throw new Error('host policy lookup failed')
      },
    })

    await expect(sender.send({ registration, body })).resolves.toBe('retry')
    expect(calls).toHaveLength(0)
  })

  test('a thrown network error is retry, not an exception', async () => {
    const sender = createWebPushSender({
      vapid,
      fetch: async () => {
        throw new Error('ECONNRESET')
      },
    })
    await expect(sender.send({ registration, body })).resolves.toBe('retry')
  })
})
