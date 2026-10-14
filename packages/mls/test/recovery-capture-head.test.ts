import { expect, test } from 'vitest'

import * as mls from '../src/index.js'
import { captureFixture, signedCapture } from './fixtures/recovery-capture.js'

test('an independently sealed captured attestation authenticates', async () => {
  const fixture = await captureFixture()
  const reply = await fixture.open(await signedCapture({ fixture }))
  expect(reply?.signer).toBe(fixture.identity.id)
  expect(reply?.captureHead).toBe('opaque/組合')
})

for (const length of [0, 1, 63, 65]) {
  test(`malformed Ed25519 signature length ${length} is a refused delivery`, async () => {
    const fixture = await captureFixture()
    const sealed = await signedCapture({
      fixture,
      transformToken: (token) => {
        const parts = token.split('.')
        parts[2] = Buffer.alloc(length).toString('base64url')
        return parts.join('.')
      },
    })
    expect(await fixture.open(sealed)).toBeNull()
  })
}

test('an alg:none captured attestation is refused', async () => {
  const fixture = await captureFixture()
  const sealed = await signedCapture({
    fixture,
    transformToken: (token) => {
      const parts = token.split('.')
      parts[0] = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
      parts[2] = ''
      return parts.join('.')
    },
  })
  expect(await fixture.open(sealed)).toBeNull()
})

for (const captureHead of ['', 'x'.repeat(65)]) {
  test(`sealing refuses invalid capture head of length ${captureHead.length}`, async () => {
    const fixture = await captureFixture()
    await expect(
      mls.sealCapturedGroupInfo({
        group: fixture.group,
        identity: fixture.identity,
        request: fixture.held.request,
        captureHead,
      }),
    ).rejects.toBeInstanceOf(TypeError)
  })
}

test('sealing refuses a wrong-length committed authenticator', async () => {
  const fixture = await captureFixture()
  fixture.group.state.keySchedule.epochAuthenticator = new Uint8Array(31)
  await expect(
    mls.sealCapturedGroupInfo({
      group: fixture.group,
      identity: fixture.identity,
      request: fixture.held.request,
      captureHead: null,
    }),
  ).rejects.toBeInstanceOf(TypeError)
})

for (const captureHead of [null, 'opaque/組合 🚀', '0', 'x'.repeat(64), '🚀'.repeat(32)]) {
  test(`captured reply preserves exact head ${JSON.stringify(captureHead)} and committed authenticator`, async () => {
    const fixture = await captureFixture()
    const sealed = await mls.sealCapturedGroupInfo({
      group: fixture.group,
      identity: fixture.identity,
      request: fixture.held.request,
      captureHead,
    })
    expect(sealed[0]).toBe(2)
    const reply = await fixture.open(sealed)
    expect(reply?.captureHead).toBe(captureHead)
    expect(reply?.groupInfoAuthenticator).toEqual(
      fixture.group.state.keySchedule.epochAuthenticator,
    )
    expect(reply?.signer).toBe(fixture.identity.id)
    // Independently open with the specified domains and inspect the signed wire payload.
    const plaintext = await mlsOpen(fixture, sealed)
    const tokenLength = new DataView(plaintext.buffer, plaintext.byteOffset).getUint32(0)
    const token = new TextDecoder().decode(plaintext.slice(4, 4 + tokenLength))
    const payload = Buffer.from(token.split('.')[1] as string, 'base64url').toString()
    expect(payload.indexOf('"captureHead"')).toBeLessThan(payload.indexOf('"groupID"'))
    expect(JSON.parse(payload).groupInfoAuthenticator).toBe(
      Buffer.from(fixture.group.state.keySchedule.epochAuthenticator).toString('base64url'),
    )
    const legacy = await mls.sealGroupInfo({
      group: fixture.group,
      identity: fixture.identity,
      request: fixture.held.request,
    })
    expect(legacy[0]).toBe(1)
    expect(await fixture.open(legacy)).toBeNull()
    expect(
      await mls.openSealedGroupInfo({
        group: fixture.group,
        sealed: legacy,
        requestID: 'capture',
        ephemeralPrivateKey: fixture.held.requestKey,
      }),
    ).toBeInstanceOf(Uint8Array)
  })
}

async function mlsOpen(fixture: Awaited<ReturnType<typeof captureFixture>>, sealed: Uint8Array) {
  const { openSealedReply } = await import('../src/recovery.js')
  return openSealedReply({
    kind: {
      hpkeInfo: new TextEncoder().encode('kumiai/mls/recovery/v2'),
      aadDomain: new TextEncoder().encode('kumiai/mls/recovery-aad/v2'),
      version: 2,
      fail: (_reason, message) => new Error(message),
    },
    group: fixture.group,
    sealed,
    requestID: 'capture',
    ephemeralPrivateKey: fixture.held.requestKey,
  })
}

for (const fields of [
  { captureHead: undefined },
  { captureHead: 1 },
  { captureHead: '' },
  { captureHead: 'x'.repeat(65) },
  { groupInfoAuthenticator: undefined },
  { groupInfoAuthenticator: null },
  { groupInfoAuthenticator: 7 },
  { groupInfoAuthenticator: '' },
  { groupInfoAuthenticator: Buffer.alloc(31).toString('base64url') },
  { groupInfoAuthenticator: `${Buffer.alloc(32).toString('base64url')}=` },
  { groupInfoAuthenticator: `${Buffer.alloc(32).toString('base64url').slice(0, -1)}B` },
  { groupInfoAuthenticator: '/'.repeat(43) },
  { groupID: 'other' },
  { requestID: 'other' },
  { groupInfoDigest: 'wrong' },
]) {
  test(`refuses signed invalid capture fields ${JSON.stringify(fields)}`, async () => {
    const fixture = await captureFixture()
    expect(await fixture.open(await signedCapture({ fixture, fields }))).toBeNull()
  })
}

for (const options of [
  { info: 'kumiai/mls/recovery/v1' },
  { aad: 'kumiai/mls/recovery-aad/v1' },
  { tamper: true },
]) {
  test(`refuses wrong domains or tampered signed head ${JSON.stringify(options)}`, async () => {
    const fixture = await captureFixture()
    expect(await fixture.open(await signedCapture({ fixture, ...options }))).toBeNull()
  })
}
