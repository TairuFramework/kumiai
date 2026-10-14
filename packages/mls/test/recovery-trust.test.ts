import { randomIdentity } from '@kokuin/token'
import { nodeTypes } from 'ts-mls'
import { expect, test, vi } from 'vitest'

import { readGroupAnchorExtension } from '../src/anchor.js'
import { nobleCryptoProvider } from '../src/crypto.js'
import { createGroup } from '../src/group.js'
import * as mls from '../src/index.js'
import { pipelineGroup } from './fixtures/lifecycle-pipeline.js'

async function captureFixture() {
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

test('requests and verdicts use retained public trust without private state', async () => {
  const fixture = await captureFixture()
  const verified = await mls.verifyRecoveryRequest(fixture.held.request)
  expect(verified.groupID).toBe(fixture.trust.groupID)
  expect(verified.requesterDID).toBe(fixture.identity.id)
  expect(fixture.held.requestKey).toHaveLength(32)
  const verdict = {
    groupID: fixture.trust.groupID,
    requestID: 'capture',
    position: 'opaque',
    commitDigest: 'digest',
    verdict: 'refused' as const,
    reason: 'policy' as const,
  }
  const sealed = await mls.sealRecoveryVerdict({
    group: fixture.group,
    identity: fixture.identity,
    request: fixture.held.request,
    verdict,
  })
  const params = {
    trust: fixture.trust,
    sealed,
    requestID: 'capture',
    requestKey: fixture.held.requestKey,
    options: {},
  }
  expect(await mls.openRecoveryVerdictFromTrust(params)).toEqual({
    signer: fixture.identity.id,
    verdict,
  })
  expect(await mls.openRecoveryVerdictFromTrust(params)).toEqual({
    signer: fixture.identity.id,
    verdict,
  })
  await expect(
    mls.openRecoveryVerdictFromTrust({ ...params, trust: { ...fixture.trust, signerTree: [] } }),
  ).rejects.toThrow()
  expect(await fixture.open(sealed)).toBeNull()
  const ledger = await mls.sealLedger({ group: fixture.group, request: fixture.held.request })
  expect(ledger[0]).toBe(1)
  expect(await fixture.open(ledger)).toBeNull()
  await expect(mls.openRecoveryVerdictFromTrust({ ...params, sealed: ledger })).rejects.toThrow()
  const captured = await mls.sealCapturedGroupInfo({
    group: fixture.group,
    identity: fixture.identity,
    request: fixture.held.request,
    captureHead: null,
  })
  await expect(
    mls.openSealedLedger({
      group: fixture.group,
      sealed: captured,
      requestID: 'capture',
      ephemeralPrivateKey: fixture.held.requestKey,
    }),
  ).rejects.toThrow()
  await expect(mls.openRecoveryVerdictFromTrust({ ...params, sealed: captured })).rejects.toThrow()
})

test('retained group, anchor, signer and owner bindings refuse substitutions', async () => {
  const fixture = await captureFixture()
  const sealed = await mls.sealCapturedGroupInfo({
    group: fixture.group,
    identity: fixture.identity,
    request: fixture.held.request,
    captureHead: null,
  })
  for (const change of [
    { groupID: 'other' },
    { genesisAnchor: new TextEncoder().encode('{}') },
    { signerTree: [] },
    { credential: { ...fixture.trust.credential, id: randomIdentity().id } },
    { credential: { ...fixture.trust.credential, groupID: 'other' } },
  ])
    expect(await fixture.open(sealed, { ...fixture.trust, ...change })).toBeNull()
  await expect(
    mls.createRecoveryRequestFromTrust({
      trust: fixture.trust,
      identity: randomIdentity(),
      requestID: 'other',
    }),
  ).rejects.toThrow()
})

test('lifecycle trust enforces retained signer binding, floors and denials', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(150_000)
  try {
    const { group, identity } = await pipelineGroup()
    const anchor = readGroupAnchorExtension(group)?.extensionData
    if (!(anchor instanceof Uint8Array)) throw new Error('Missing anchor')
    const own = group.state.ratchetTree[0]
    if (own?.nodeType !== nodeTypes.leaf) throw new Error('Missing leaf')
    const { parseMLSCredentialIdentity } = await import('../src/credential.js')
    if (!('identity' in own.leaf.credential)) throw new Error('Missing identity')
    const binding = parseMLSCredentialIdentity(own.leaf.credential.identity).controller
    if (binding == null) throw new Error('Missing binding')
    const trust = {
      groupID: group.groupID,
      genesisAnchor: anchor,
      signerTree: structuredClone(group.state.ratchetTree),
      registry: structuredClone(group.registry),
      credential: group.credential,
      binding,
      ledger: group.ledgerTokens,
      ciphersuiteName: 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
    }
    const held = await mls.createRecoveryRequestFromTrust({
      trust,
      identity,
      requestID: 'lifecycle',
    })
    const sealed = await mls.sealCapturedGroupInfo({
      group,
      identity,
      request: held.request,
      captureHead: 'head',
    })
    const params = {
      trust,
      sealed,
      requestID: 'lifecycle',
      requestKey: held.requestKey,
      options: {},
    }
    expect((await mls.authenticateRecoveryReply(params))?.captureHead).toBe('head')
    const verdict = {
      groupID: group.groupID,
      requestID: 'lifecycle',
      position: 'head',
      commitDigest: 'digest',
      verdict: 'superseded' as const,
    }
    const verdictSeal = await mls.sealRecoveryVerdict({
      group,
      identity,
      request: held.request,
      verdict,
    })
    for (const change of [
      { binding: null },
      { binding: { ...binding, id: 'did:kokuin:other' } },
      {
        registry: {
          ...trust.registry,
          devices: new Map([[identity.id, { controller: binding.id, status: 'revoked' as const }]]),
        },
      },
      {
        registry: {
          ...trust.registry,
          controllers: new Map([[binding.id, { recordedLog: [], genFloor: 1, timeFloor: 0 }]]),
        },
      },
      {
        registry: {
          ...trust.registry,
          controllers: new Map([[binding.id, { recordedLog: [], genFloor: 0, timeFloor: 201 }]]),
        },
      },
    ]) {
      expect(
        await mls.authenticateRecoveryReply({ ...params, trust: { ...trust, ...change } }),
      ).toBeNull()
      await expect(
        mls.openRecoveryVerdictFromTrust({
          ...params,
          sealed: verdictSeal,
          trust: { ...trust, ...change },
        }),
      ).rejects.toThrow()
    }
  } finally {
    now.mockRestore()
  }
})

test('provider failures retain their identity and a corrupt own request key is not a refused reply', async () => {
  const fixture = await captureFixture()
  const sealed = await mls.sealCapturedGroupInfo({
    group: fixture.group,
    identity: fixture.identity,
    request: fixture.held.request,
    captureHead: null,
  })
  const failure = new Error('provider unavailable')
  const params = {
    trust: fixture.trust,
    sealed,
    requestID: 'capture',
    requestKey: fixture.held.requestKey,
    options: {
      cryptoProvider: {
        getCiphersuiteImpl: async () => {
          throw failure
        },
      },
    },
  }
  await expect(mls.authenticateRecoveryReply(params)).rejects.toBe(failure)
  await expect(mls.openRecoveryVerdictFromTrust(params)).rejects.toBe(failure)
  await expect(
    mls.authenticateRecoveryReply({
      ...params,
      options: { cryptoProvider: nobleCryptoProvider },
      requestKey: new Uint8Array(3),
    }),
  ).rejects.toThrow('retained')
})

for (const operation of ['open', 'importPrivateKey', 'verify'] as const) {
  test(`retained reply and verdict preserve the ${operation} error boundary`, async () => {
    const fixture = await captureFixture()
    const reply = await mls.sealCapturedGroupInfo({
      group: fixture.group,
      identity: fixture.identity,
      request: fixture.held.request,
      captureHead: null,
    })
    const verdict = await mls.sealRecoveryVerdict({
      group: fixture.group,
      identity: fixture.identity,
      request: fixture.held.request,
      verdict: {
        groupID: fixture.trust.groupID,
        requestID: 'capture',
        position: 'head',
        commitDigest: 'digest',
        verdict: 'superseded',
      },
    })
    const failure = new Error(`${operation} unavailable`)
    const suite = fixture.group.context.cipherSuite
    const changed =
      operation === 'verify'
        ? {
            ...suite,
            signature: {
              ...suite.signature,
              verify: async () => {
                throw failure
              },
            },
          }
        : {
            ...suite,
            hpke: {
              ...suite.hpke,
              [operation]: async () => {
                throw failure
              },
            },
          }
    const params = {
      trust: fixture.trust,
      requestID: 'capture',
      requestKey: fixture.held.requestKey,
      options: { cryptoProvider: { getCiphersuiteImpl: async () => changed } },
    }
    if (operation === 'open') {
      expect(await mls.authenticateRecoveryReply({ ...params, sealed: reply })).toBeNull()
      await expect(
        mls.openRecoveryVerdictFromTrust({ ...params, sealed: verdict }),
      ).rejects.toThrow()
    } else {
      await expect(mls.authenticateRecoveryReply({ ...params, sealed: reply })).rejects.toBe(
        failure,
      )
      await expect(mls.openRecoveryVerdictFromTrust({ ...params, sealed: verdict })).rejects.toBe(
        failure,
      )
    }
  })
}

test('trust and registry reader failures propagate their original error objects', async () => {
  const fixture = await captureFixture()
  const failure = new Error('trust reader unavailable')
  const sealed = await mls.sealCapturedGroupInfo({
    group: fixture.group,
    identity: fixture.identity,
    request: fixture.held.request,
    captureHead: null,
  })
  const verdict = await mls.sealRecoveryVerdict({
    group: fixture.group,
    identity: fixture.identity,
    request: fixture.held.request,
    verdict: {
      groupID: fixture.trust.groupID,
      requestID: 'capture',
      position: 'head',
      commitDigest: 'digest',
      verdict: 'superseded',
    },
  })
  for (const trust of [
    {
      ...fixture.trust,
      get signerTree(): typeof fixture.trust.signerTree {
        throw failure
      },
    },
    {
      ...fixture.trust,
      registry: {
        ...fixture.trust.registry,
        devices: {
          ...fixture.trust.registry.devices,
          get: () => {
            throw failure
          },
        },
      },
    },
  ]) {
    const params = { trust, requestID: 'capture', requestKey: fixture.held.requestKey, options: {} }
    await expect(mls.authenticateRecoveryReply({ ...params, sealed })).rejects.toBe(failure)
    await expect(mls.openRecoveryVerdictFromTrust({ ...params, sealed: verdict })).rejects.toBe(
      failure,
    )
  }
})

test('a retained credential reader failure keeps its error identity', async () => {
  const fixture = await captureFixture()
  const failure = new Error('credential reader unavailable')
  const sealed = await mls.sealCapturedGroupInfo({
    group: fixture.group,
    identity: fixture.identity,
    request: fixture.held.request,
    captureHead: null,
  })
  const tree = structuredClone(fixture.trust.signerTree)
  const node = tree[0]
  if (node?.nodeType !== nodeTypes.leaf) throw new Error('Missing leaf')
  Object.defineProperty(node.leaf.credential, 'identity', {
    get() {
      throw failure
    },
  })
  await expect(
    mls.authenticateRecoveryReply({
      trust: { ...fixture.trust, signerTree: tree },
      sealed,
      requestID: 'capture',
      requestKey: fixture.held.requestKey,
      options: {},
    }),
  ).rejects.toBe(failure)
})
