import { encodeMultibase, randomIdentity, stringifyToken } from '@kokuin/token'
import { sha256 } from '@noble/hashes/sha2.js'
import { expect, test } from 'vitest'

import { readGroupAnchorExtension } from '../src/anchor.js'
import { createGroup, exportGroupInfo } from '../src/group.js'
import * as mls from '../src/index.js'
import { type SealedReplyKind, sealToRequest } from '../src/recovery.js'

export async function captureFixture() {
  const identity = randomIdentity()
  const { group } = await createGroup(identity, 'captured-recovery')
  const extension = readGroupAnchorExtension(group)
  if (!(extension?.extensionData instanceof Uint8Array)) throw new Error('Missing anchor')
  const trust = {
    groupID: group.groupID,
    genesisAnchor: extension.extensionData.slice(),
    signerTree: structuredClone(group.state.ratchetTree),
    registry: structuredClone(group.registry),
    credential: { ...group.credential },
    binding: null,
    ledger: group.ledgerTokens,
    ciphersuiteName: 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
  }
  const held = await mls.createRecoveryRequestFromTrust({ trust, identity, requestID: 'capture' })
  const open = (sealed: Uint8Array, changed = trust) =>
    mls.authenticateRecoveryReply({
      trust: changed,
      sealed,
      requestID: 'capture',
      requestKey: held.requestKey,
      options: {},
    })
  return { identity, group, trust, held, open }
}

export async function signedCapture(params: {
  fixture: Awaited<ReturnType<typeof captureFixture>>
  fields?: Record<string, unknown>
  omit?: Array<string>
  info?: string
  aad?: string
  tamper?: boolean
}) {
  const { fixture, fields = {}, omit = [] } = params
  const { groupInfo } = await exportGroupInfo({ group: fixture.group })
  const payload: Record<string, unknown> = {
    type: 'kumiai.recovery-groupinfo',
    groupID: fixture.group.groupID,
    requestID: 'capture',
    groupInfoDigest: encodeMultibase(sha256(groupInfo)),
    captureHead: 'opaque/組合',
    groupInfoAuthenticator: Buffer.from(
      fixture.group.state.keySchedule.epochAuthenticator,
    ).toString('base64url'),
    ...fields,
  }
  for (const key of omit) delete payload[key]
  let token = stringifyToken(await fixture.identity.signToken(payload, { embedLongForm: true }))
  if (params.tamper) {
    const parts = token.split('.')
    const body = JSON.parse(Buffer.from(parts[1] as string, 'base64url').toString())
    body.captureHead = 'tampered'
    parts[1] = Buffer.from(JSON.stringify(body)).toString('base64url')
    token = parts.join('.')
  }
  const bytes = new TextEncoder().encode(token)
  const plaintext = new Uint8Array(4 + bytes.length + groupInfo.length)
  new DataView(plaintext.buffer).setUint32(0, bytes.length)
  plaintext.set(bytes, 4)
  plaintext.set(groupInfo, 4 + bytes.length)
  const kind: SealedReplyKind = {
    hpkeInfo: new TextEncoder().encode(params.info ?? 'kumiai/mls/recovery/v2'),
    aadDomain: new TextEncoder().encode(params.aad ?? 'kumiai/mls/recovery-aad/v2'),
    version: 2,
    fail: (_reason, message) => new Error(message),
  }
  return sealToRequest({ kind, group: fixture.group, request: fixture.held.request, plaintext })
}

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
