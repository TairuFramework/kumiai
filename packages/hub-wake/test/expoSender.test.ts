import type { WakeRegistration } from '@kumiai/hub-protocol'
import { createRuntime } from '@sozai/runtime'
import { describe, expect, test } from 'vitest'

import { createExpoSender } from '../src/expoSender.js'

const registration: WakeRegistration = {
  did: 'did:key:alice',
  kind: 'expo',
  endpoint: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]',
  publicKey: 'cHVibGlj',
  authSecret: 'YXV0aA',
}

const body = new Uint8Array(597).fill(7)

function jsonFetch(payload: unknown, status = 200) {
  const calls: Array<{ url: string; body: unknown; headers: Headers }> = []
  const fetchImpl = async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body)),
      headers: new Headers(init?.headers),
    })
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { calls, fetchImpl }
}

describe('createExpoSender', () => {
  test('posts the sealed body base64url in the data field', async () => {
    const { calls, fetchImpl } = jsonFetch({ data: [{ status: 'ok', id: '1' }] })
    const sender = createExpoSender({ runtime: createRuntime({ fetch: fetchImpl }) })

    await expect(sender.send({ registration, body })).resolves.toBe('delivered')

    const [call] = calls
    expect(call?.url).toBe('https://exp.host/--/api/v2/push/send')
    const sent = call?.body as {
      to: string
      data: { w: string }
      mutableContent: boolean
      contentAvailable: boolean
    }
    expect(sent.to).toBe(registration.endpoint)
    expect(sent.mutableContent).toBe(true)
    expect(sent.contentAvailable).toBe(true)
    expect(Buffer.from(sent.data.w, 'base64url')).toHaveLength(body.length)
  })

  // The exact key set, not a list of expected values. The blindness test below greps for the
  // literal DID and the substring `topic`, which a new field carrying `registration.kind` (or a
  // per-group channel, or anything else derived from the registration) sails straight past — and
  // the whole point of this sender is that Expo learns nothing but the token and a constant-size
  // ciphertext. Anything added here has to be added here first.
  test('sends exactly these five fields and nothing else', async () => {
    const { calls, fetchImpl } = jsonFetch({ data: [{ status: 'ok', id: '1' }] })
    const sender = createExpoSender({ runtime: createRuntime({ fetch: fetchImpl }) })

    await sender.send({ registration, body })

    const [call] = calls
    const sent = call?.body as Record<string, unknown>
    expect(Object.keys(sent).sort()).toEqual([
      'contentAvailable',
      'data',
      'mutableContent',
      'title',
      'to',
    ])
    expect(Object.keys(sent.data as Record<string, unknown>)).toEqual(['w'])
  })

  test('the default placeholder title is a construction-time constant', async () => {
    const { calls, fetchImpl } = jsonFetch({ data: [{ status: 'ok', id: '1' }] })
    const sender = createExpoSender({ runtime: createRuntime({ fetch: fetchImpl }) })

    await sender.send({ registration, body })

    const [call] = calls
    expect((call?.body as { title: string } | undefined)?.title).toBe('New activity')
  })

  test('the placeholderTitle override replaces it', async () => {
    const { calls, fetchImpl } = jsonFetch({ data: [{ status: 'ok', id: '1' }] })
    const sender = createExpoSender({
      runtime: createRuntime({ fetch: fetchImpl }),
      placeholderTitle: 'Nudge',
    })

    await sender.send({ registration, body })

    const [call] = calls
    expect((call?.body as { title: string } | undefined)?.title).toBe('Nudge')
  })

  test('carries no cleartext topic, DID or count', async () => {
    const { calls, fetchImpl } = jsonFetch({ data: [{ status: 'ok', id: '1' }] })
    const sender = createExpoSender({ runtime: createRuntime({ fetch: fetchImpl }) })
    await sender.send({ registration, body })
    const [call] = calls
    const serialized = JSON.stringify(call?.body)
    expect(serialized).not.toContain('did:key:alice')
    expect(serialized).not.toContain('topic')
  })

  test('DeviceNotRegistered is gone', async () => {
    const { fetchImpl } = jsonFetch({
      data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }],
    })
    const sender = createExpoSender({ runtime: createRuntime({ fetch: fetchImpl }) })
    await expect(sender.send({ registration, body })).resolves.toBe('gone')
  })

  test('another error status is retry', async () => {
    const { fetchImpl } = jsonFetch({
      data: [{ status: 'error', details: { error: 'MessageRateExceeded' } }],
    })
    const sender = createExpoSender({ runtime: createRuntime({ fetch: fetchImpl }) })
    await expect(sender.send({ registration, body })).resolves.toBe('retry')
  })

  test('a non-200 response is retry', async () => {
    const { fetchImpl } = jsonFetch({ data: [{ status: 'ok', id: '1' }] }, 503)
    const sender = createExpoSender({ runtime: createRuntime({ fetch: fetchImpl }) })
    await expect(sender.send({ registration, body })).resolves.toBe('retry')
  })

  test('a malformed 2xx response (null body) is retry, not an exception', async () => {
    const { fetchImpl } = jsonFetch(null, 200)
    const sender = createExpoSender({ runtime: createRuntime({ fetch: fetchImpl }) })
    await expect(sender.send({ registration, body })).resolves.toBe('retry')
  })

  // The catch-all's verdict, which nothing exercised. `gone` is one word away from `retry` here,
  // and it is the destructive one: the dispatcher DELETES the registration on `gone`, so a network
  // blip or a malformed-JSON throw would silently unsubscribe a live device forever. The Web Push
  // sender has had this test since it was written; this one had none.
  test('a thrown network error is retry, not gone and not an exception', async () => {
    const sender = createExpoSender({
      runtime: createRuntime({
        fetch: async () => {
          throw new Error('ECONNRESET')
        },
      }),
    })
    await expect(sender.send({ registration, body })).resolves.toBe('retry')
  })

  test('no accessToken means no authorization header', async () => {
    const { calls, fetchImpl } = jsonFetch({ data: [{ status: 'ok', id: '1' }] })
    const sender = createExpoSender({ runtime: createRuntime({ fetch: fetchImpl }) })

    await sender.send({ registration, body })

    const [call] = calls
    expect(call?.headers.get('authorization')).toBeNull()
  })

  test('an accessToken is sent as a Bearer token', async () => {
    const { calls, fetchImpl } = jsonFetch({ data: [{ status: 'ok', id: '1' }] })
    const sender = createExpoSender({
      runtime: createRuntime({ fetch: fetchImpl }),
      accessToken: 'secret-token',
    })

    await sender.send({ registration, body })

    const [call] = calls
    expect(call?.headers.get('authorization')).toBe('Bearer secret-token')
  })
})
