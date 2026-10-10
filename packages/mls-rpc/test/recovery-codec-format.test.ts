import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { base64ToBytes, bytesToBase64 } from 'ts-mls'
import { expect, test } from 'vitest'

import { decodeRecoveryCandidate } from '../src/recovery-codec.js'
import { createRealBoundRecovery } from './fixtures/real-group.js'

const AAD = new TextEncoder().encode('kumiai/recovery-candidate/v2')

async function envelope() {
  const fixture = await createRealBoundRecovery()
  const { request, requestKey } = await fixture.requester.createRecoveryRequest('format-request')
  const reply = await fixture.responder.sealGroupInfo(request)
  const pending = await fixture.requester.applyRecovery(reply, 'format-request', requestKey)
  if (pending == null || 'renewalRequired' in pending) throw new Error('Expected candidate')
  const bytes = pending.serialize()
  const body = xchacha20poly1305(requestKey, bytes.subarray(1, 25), AAD).decrypt(bytes.subarray(25))
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as Record<
    string,
    unknown
  >
  return { bytes, body, value, requestKey }
}

function seal(body: Uint8Array, requestKey: Uint8Array): Uint8Array {
  const nonce = crypto.getRandomValues(new Uint8Array(24))
  const sealed = xchacha20poly1305(requestKey, nonce, AAD).encrypt(body)
  return new Uint8Array([2, ...nonce, ...sealed])
}

test('encrypted envelope contains complete v2 state and sourceState without a sourceTree fragment', async () => {
  const { bytes, value, requestKey } = await envelope()
  expect(bytes[0]).toBe(2)
  expect(value).toHaveProperty('sourceState')
  expect(value).not.toHaveProperty('sourceTree')
  if (typeof value.state !== 'string' || typeof value.sourceState !== 'string')
    throw new Error('Missing state envelopes')
  expect(base64ToBytes(value.state)[0]).toBe(2)
  expect(base64ToBytes(value.sourceState)[0]).toBe(2)
  expect(decodeRecoveryCandidate(bytes, requestKey).requestID).toBe('format-request')
})

test('refuses malformed UTF-8 inside an authenticated JSON string', async () => {
  const { value, requestKey } = await envelope()
  value.requestID = 'invalid-utf8'
  const json = JSON.stringify(value)
  const body = new TextEncoder().encode(json)
  const offset = new TextEncoder().encode(json.slice(0, json.indexOf('invalid-utf8'))).length
  body[offset] = 0xff
  expect(() => decodeRecoveryCandidate(seal(body, requestKey), requestKey)).toThrow()
})

test.each(['state', 'sourceState'])(
  'refuses noncanonical base64 and v1 envelopes in %s',
  async (field) => {
    const { value, requestKey } = await envelope()
    const encoded = value[field]
    if (typeof encoded !== 'string') throw new Error('Missing state envelope')
    value[field] = `${encoded}\n`
    expect(() =>
      decodeRecoveryCandidate(
        seal(new TextEncoder().encode(JSON.stringify(value)), requestKey),
        requestKey,
      ),
    ).toThrow('Invalid recovery bytes')
    const bytes = base64ToBytes(encoded)
    bytes[0] = 1
    value[field] = bytesToBase64(bytes)
    expect(() =>
      decodeRecoveryCandidate(
        seal(new TextEncoder().encode(JSON.stringify(value)), requestKey),
        requestKey,
      ),
    ).toThrow('unsupported client-state version 1')
  },
)
