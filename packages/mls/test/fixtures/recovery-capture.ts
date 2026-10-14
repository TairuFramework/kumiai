import { encodeMultibase, randomIdentity, stringifyToken } from '@kokuin/token'
import { sha256 } from '@noble/hashes/sha2.js'

import { readGroupAnchorExtension } from '../../src/anchor.js'
import { createGroup, exportGroupInfo } from '../../src/group.js'
import * as mls from '../../src/index.js'
import { type SealedReplyKind, sealToRequest } from '../../src/recovery.js'
import { timedBinding } from './lifecycle-pipeline.js'

export async function captureFixture(options: { standard?: boolean } = {}) {
  const identity = randomIdentity()
  const now = Math.floor(Date.now() / 1000)
  const binding = options.standard
    ? null
    : await timedBinding({ identity, iat: now, exp: now + 3600 })
  const { group } = await createGroup(
    identity,
    'captured-recovery',
    binding == null ? {} : { controller: binding },
  )
  const extension = readGroupAnchorExtension(group)
  if (!(extension?.extensionData instanceof Uint8Array)) throw new Error('Missing anchor')
  const trust: mls.RecoveryTrustInputs = {
    groupID: group.groupID,
    genesisAnchor: extension.extensionData.slice(),
    signerTree: structuredClone(group.state.ratchetTree),
    registry: structuredClone(group.registry),
    credential: { ...group.credential },
    binding,
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
  transformToken?: (token: string) => string
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
    ledgerDigest: encodeMultibase(sha256(new Uint8Array(4))),
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
  token = params.transformToken?.(token) ?? token
  const bytes = new TextEncoder().encode(token)
  const lifecycle = fixture.group.anchor.controller != null
  const plaintext = new Uint8Array(4 + bytes.length + groupInfo.length + (lifecycle ? 8 : 0))
  new DataView(plaintext.buffer).setUint32(0, bytes.length)
  plaintext.set(bytes, 4)
  if (lifecycle) {
    new DataView(plaintext.buffer).setUint32(4 + bytes.length, groupInfo.length)
    plaintext.set(groupInfo, 8 + bytes.length)
  } else plaintext.set(groupInfo, 4 + bytes.length)
  const kind: SealedReplyKind = {
    hpkeInfo: new TextEncoder().encode(params.info ?? 'kumiai/mls/recovery/v2'),
    aadDomain: new TextEncoder().encode(params.aad ?? 'kumiai/mls/recovery-aad/v2'),
    version: 2,
    fail: (_reason, message) => new Error(message),
  }
  return sealToRequest({ kind, group: fixture.group, request: fixture.held.request, plaintext })
}
