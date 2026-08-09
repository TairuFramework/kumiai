import type { WakeRegistration } from '@kumiai/hub-protocol'
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
  const calls: Array<{ url: string; body: unknown }> = []
  const fetchImpl = async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
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
    const sender = createExpoSender({ fetch: fetchImpl })

    await expect(sender.send({ registration, body })).resolves.toBe('delivered')

    expect(calls[0].url).toBe('https://exp.host/--/api/v2/push/send')
    const sent = calls[0].body as {
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

  test('carries no cleartext topic, DID or count', async () => {
    const { calls, fetchImpl } = jsonFetch({ data: [{ status: 'ok', id: '1' }] })
    const sender = createExpoSender({ fetch: fetchImpl })
    await sender.send({ registration, body })
    const serialized = JSON.stringify(calls[0].body)
    expect(serialized).not.toContain('did:key:alice')
    expect(serialized).not.toContain('topic')
  })

  test('DeviceNotRegistered is gone', async () => {
    const { fetchImpl } = jsonFetch({
      data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }],
    })
    const sender = createExpoSender({ fetch: fetchImpl })
    await expect(sender.send({ registration, body })).resolves.toBe('gone')
  })

  test('another error status is retry', async () => {
    const { fetchImpl } = jsonFetch({
      data: [{ status: 'error', details: { error: 'MessageRateExceeded' } }],
    })
    const sender = createExpoSender({ fetch: fetchImpl })
    await expect(sender.send({ registration, body })).resolves.toBe('retry')
  })

  test('a non-200 response is retry', async () => {
    const { fetchImpl } = jsonFetch({}, 503)
    const sender = createExpoSender({ fetch: fetchImpl })
    await expect(sender.send({ registration, body })).resolves.toBe('retry')
  })
})
