import { normalizeDID, randomIdentity } from '@kokuin/token'
import { nodeTypes } from 'ts-mls'
import { afterEach, expect, test, vi } from 'vitest'

import { asControllerLog } from '../src/controller-log.js'
import { denyEffects, revokeChain } from './fixtures/controller-chain.js'

afterEach(() => vi.restoreAllMocks())

import { createGroup } from '../src/group.js'
import { makeMLSCredential } from '../src/group-credential.js'
import { createRecoveryRequest, openSealedGroupInfo, sealGroupInfo } from '../src/recovery.js'
import {
  confirmationKey,
  confirmationTag,
  openRecoveryVerdict,
  recoverySignerEligible,
  sealRecoveryVerdict,
} from '../src/recovery-verdict.js'
import { registryForLog } from '../src/registry.js'
import { buildEpoch } from './fixtures/controller-epoch.js'
import { pipelineGroup } from './fixtures/lifecycle-pipeline.js'

test('recovery signer with an effective membership leaf is eligible', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(150_000)
  const f = await buildEpoch({ members: 1, renewEvery: 1000 })
  const member = f.members[0]
  if (member == null) throw new Error('Missing member')
  const { group } = await pipelineGroup()
  const own = group.state.ratchetTree[0]
  if (own?.nodeType !== nodeTypes.leaf) throw new Error('Missing leaf')
  own.leaf.credential = makeMLSCredential(member.identity, {
    id: f.did,
    prefix: f.log.chain,
    member: { add: member.add, g: 0 },
    iat: 9000,
  })
  own.leaf.signaturePublicKey = member.identity.publicKey
  const known = registryForLog(f.did, f.log)
  const params = { group, known, signer: normalizeDID(member.did), now: 500 }
  expect(recoverySignerEligible(params)).toBe(true)
  expect(recoverySignerEligible({ ...params, now: 1301 })).toBe(false)
  expect(recoverySignerEligible({ ...params, known: { ...known, controllers: new Map() } })).toBe(
    false,
  )
})

test('verdicts authenticate the signer and bind the signed request without consuming its key', async () => {
  const identity = randomIdentity()
  const { group } = await createGroup(identity, 'verdict-crypto')
  const held = await createRecoveryRequest({ group, identity, requestID: 'request' })
  const verdict = {
    groupID: group.groupID,
    requestID: 'request',
    position: 'position',
    commitDigest: 'digest',
    verdict: 'confirmed' as const,
    epoch: Number(group.epoch),
    tag: confirmationTag(await confirmationKey(group, 'position', 'digest'), 'request'),
  }
  const sealed = await sealRecoveryVerdict({ group, identity, request: held.request, verdict })
  const params = {
    group,
    sealed,
    requestID: 'request',
    ephemeralPrivateKey: held.ephemeralPrivateKey,
  }
  expect(await openRecoveryVerdict(params)).toEqual({ signer: identity.id, verdict })
  expect(await openRecoveryVerdict(params)).toEqual({ signer: identity.id, verdict })
  await expect(openRecoveryVerdict({ ...params, requestID: 'other' })).rejects.toThrow()
  await expect(
    openRecoveryVerdict({
      ...params,
      sealed: await sealGroupInfo({ group, identity, request: held.request }),
    }),
  ).rejects.toThrow()
  await expect(openSealedGroupInfo(params)).rejects.toThrow()
  const corrupt = sealed.slice()
  corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1] as number) ^ 1
  await expect(openRecoveryVerdict({ ...params, sealed: corrupt })).rejects.toThrow()
  for (const change of [{ groupID: 'other' }, { requestID: 'other' }]) {
    await expect(
      sealRecoveryVerdict({
        group,
        identity,
        request: held.request,
        verdict: { ...verdict, ...change },
      }),
    ).rejects.toThrow()
  }
})

test('exporter context frames every binding and tags authenticate the request', async () => {
  const identity = randomIdentity()
  const { group } = await createGroup(identity, 'verdict-exporter')
  const key = await confirmationKey(group, 'a', 'bc')
  const fields = [group.groupID, 'a', 'bc'].map((value) => {
    const bytes = Buffer.from(value, 'utf8')
    const length = Buffer.alloc(4)
    length.writeUInt32BE(bytes.length)
    return Buffer.concat([length, bytes])
  })
  expect(key).toEqual(await group.exportSecret('kumiai.rejoin-confirm', Buffer.concat(fields), 32))
  const { createHmac } = await import('node:crypto')
  const { encodeMultibase } = await import('@kokuin/token')
  expect(confirmationTag(key, 'request')).toBe(
    encodeMultibase(createHmac('sha256', key).update('request').digest()),
  )
  expect(key).toHaveLength(32)
  expect(await confirmationKey(group, 'a', 'bc')).toEqual(key)
  expect(await confirmationKey(group, 'ab', 'c')).not.toEqual(key)
  expect(await confirmationKey(group, 'a', 'other')).not.toEqual(key)
  expect(confirmationTag(key, 'request')).not.toBe(confirmationTag(key, 'other'))
  expect(confirmationTag(new Uint8Array(32), 'request')).not.toBe(confirmationTag(key, 'request'))
})

test('external replacement reports denied subjects as invalid and tree-time regression as floor', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(150_000)
  const { pipelineGroup, agent, timedBinding, lowLevelWelcome, lowLevelExternal } = await import(
    './fixtures/lifecycle-pipeline.js'
  )
  const { controllerSeed, controllerID, inception } = await import('./fixtures/lifecycle-ledger.js')
  const { signLedgerEntry } = await import('../src/ledger.js')
  const initial = await pipelineGroup()
  const bob = agent(61)
  const { author } = await lowLevelWelcome(
    initial.group,
    bob,
    await timedBinding({ identity: bob, iat: 110, exp: 200 }),
  )
  const issuer = agent(81)
  const parent = (await timedBinding({ identity: issuer, iat: 100, exp: 200 })).capability
  const regression = await lowLevelExternal({
    group: author,
    identity: bob,
    binding: await timedBinding({ identity: bob, iat: 110, exp: 200, issuer, parent }),
  })
  await expect(author.processMessage(regression)).rejects.toMatchObject({ reason: 'floor' })
  const message = await lowLevelExternal({
    group: author,
    identity: bob,
    binding: await timedBinding({ identity: bob, iat: 110, exp: 200 }),
  })
  const revoke = revokeChain({
    seed: controllerSeed,
    profile: 0,
    did: controllerID,
    chain: [inception],
    subject: bob.id,
  })
  const token = await signLedgerEntry(initial.identity, {
    groupID: author.groupID,
    type: 'kumiai.device',
    subject: controllerID,
    value: {
      effects: denyEffects([revoke], bob.id),
      removed: [],
      op: 'revoke',
      proof: asControllerLog([revoke]),
      revoked: [{ did: bob.id }],
    },
  })
  await author.applyLedgerEntries([token])
  await expect(author.processMessage(message)).rejects.toMatchObject({ reason: 'invalid' })
})

test('opening checks signature, token kind and signed bindings even inside a valid HPKE seal', async () => {
  const { stringifyToken } = await import('@kokuin/token')
  const { sealToRequest } = await import('../src/recovery.js')
  const identity = randomIdentity()
  const { group } = await createGroup(identity, 'verdict-open-bindings')
  const held = await createRecoveryRequest({ group, identity, requestID: 'request' })
  const kind = {
    hpkeInfo: new TextEncoder().encode('kumiai/mls/recovery-verdict/v1'),
    aadDomain: new TextEncoder().encode('kumiai/mls/recovery-verdict-aad/v1'),
    version: 1,
    fail: (_reason: unknown, message: string) => new Error(message),
  }
  const base = {
    type: 'kumiai.recovery-verdict',
    groupID: group.groupID,
    requestID: 'request',
    position: 'position',
    commitDigest: 'digest',
    verdict: 'refused',
    reason: 'policy',
  }
  for (const change of [
    { groupID: 'other' },
    { requestID: 'other' },
    { type: 'other' },
    { reason: 'unknown' },
    { position: 5 },
  ]) {
    const token = stringifyToken(
      await identity.signToken({ ...base, ...change }, { embedLongForm: true }),
    )
    const sealed = await sealToRequest({
      kind,
      group,
      request: held.request,
      plaintext: new TextEncoder().encode(token),
    })
    await expect(
      openRecoveryVerdict({
        group,
        sealed,
        requestID: 'request',
        ephemeralPrivateKey: held.ephemeralPrivateKey,
      }),
    ).rejects.toThrow()
  }
  const signed = stringifyToken(await identity.signToken(base, { embedLongForm: true }))
  const parts = signed.split('.')
  const signature = Buffer.from(parts[2] as string, 'base64url')
  signature[0] = (signature[0] as number) ^ 1
  parts[2] = signature.toString('base64url')
  const sealed = await sealToRequest({
    kind,
    group,
    request: held.request,
    plaintext: new TextEncoder().encode(parts.join('.')),
  })
  await expect(
    openRecoveryVerdict({
      group,
      sealed,
      requestID: 'request',
      ephemeralPrivateKey: held.ephemeralPrivateKey,
    }),
  ).rejects.toThrow()
})
