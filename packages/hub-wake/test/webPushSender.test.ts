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

  test('the VAPID JWT signature verifies against the configured public key', async () => {
    const { calls, fetchImpl } = recordingFetch(201)
    const sender = createWebPushSender({ vapid, fetch: fetchImpl })

    await sender.send({ registration, body })

    const headers = new Headers(calls[0].init.headers)
    const authorization = headers.get('authorization')
    if (authorization == null) throw new Error('expected an authorization header')
    const { signature, signingInput } = decodeJwt(authorization)
    const digest = sha256(new TextEncoder().encode(signingInput))
    expect(p256.verify(signature, digest, vapid.publicKey, { prehash: false })).toBe(true)
  })

  test('404 and 410 are gone', async () => {
    for (const status of [404, 410]) {
      const { fetchImpl } = recordingFetch(status)
      const sender = createWebPushSender({ vapid, fetch: fetchImpl })
      await expect(sender.send({ registration, body })).resolves.toBe('gone')
    }
  })

  test('429 and 5xx are retry', async () => {
    for (const status of [429, 500, 503]) {
      const { fetchImpl } = recordingFetch(status)
      const sender = createWebPushSender({ vapid, fetch: fetchImpl })
      await expect(sender.send({ registration, body })).resolves.toBe('retry')
    }
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
