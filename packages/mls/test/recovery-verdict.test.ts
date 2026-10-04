import { randomIdentity } from '@kokuin/token'
import { afterEach, expect, test, vi } from 'vitest'

afterEach(() => vi.restoreAllMocks())

import { createGroup } from '../src/group.js'
import { createRecoveryRequest, openSealedGroupInfo, sealGroupInfo } from '../src/recovery.js'
import {
  confirmationKey,
  confirmationTag,
  openRecoveryVerdict,
  sealRecoveryVerdict,
} from '../src/recovery-verdict.js'

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
  const { createRevoke } = await import('@kokuin/controller')
  const { controllerSeed, controllerID, inception } = await import('./fixtures/lifecycle-ledger.js')
  const { signLedgerEntry } = await import('../src/ledger.js')
  const initial = await pipelineGroup()
  const bob = agent(61)
  const { author } = await lowLevelWelcome(initial.group, bob, await timedBinding(bob, 110, 200))
  const issuer = agent(81)
  const parent = (await timedBinding(issuer, 100, 200)).capability
  const regression = await lowLevelExternal(
    author,
    bob,
    await timedBinding(bob, 110, 200, { issuer, parent }),
  )
  await expect(author.processMessage(regression)).rejects.toMatchObject({ reason: 'floor' })
  const message = await lowLevelExternal(author, bob, await timedBinding(bob, 110, 200))
  const revoke = createRevoke({
    seed: controllerSeed,
    profile: 0,
    did: controllerID,
    prior: inception.event,
    target: bob.id,
    keyPosition: { gen: 0, seq: 0 },
  })
  const token = await signLedgerEntry(initial.identity, {
    groupID: author.groupID,
    type: 'kumiai.device',
    subject: bob.id,
    value: { op: 'revoke', proof: [inception, revoke], revoked: [{ did: bob.id }] },
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
    const sealed = await sealToRequest(kind, group, held.request, new TextEncoder().encode(token))
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
  const sealed = await sealToRequest(
    kind,
    group,
    held.request,
    new TextEncoder().encode(parts.join('.')),
  )
  await expect(
    openRecoveryVerdict({
      group,
      sealed,
      requestID: 'request',
      ephemeralPrivateKey: held.ephemeralPrivateKey,
    }),
  ).rejects.toThrow()
})
