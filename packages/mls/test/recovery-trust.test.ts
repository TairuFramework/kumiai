import { randomIdentity } from '@kokuin/token'
import { nodeTypes } from 'ts-mls'
import { expect, test, vi } from 'vitest'

import { readGroupAnchorExtension } from '../src/anchor.js'
import { parseMLSCredentialIdentity } from '../src/credential.js'
import { nobleCryptoProvider } from '../src/crypto.js'
import { deriveGroup } from '../src/group-handle.js'
import * as mls from '../src/index.js'
import { recoverySignerEligibleFromPublic } from '../src/recovery-verdict.js'
import {
  agent,
  controllerID,
  lowLevelWelcome,
  pipelineGroup,
  rawAdd,
  timedBinding,
} from './fixtures/lifecycle-pipeline.js'
import { captureFixture, signedCapture } from './fixtures/recovery-capture.js'

test('controller-less capture authenticates an origin member without controller eligibility', async () => {
  const fixture = await captureFixture({ standard: true })
  const signer = agent(52)
  const added = await rawAdd(fixture.group, signer)
  const author = deriveGroup(fixture.group, added.result.newState)
  const trust = { ...fixture.trust, signerTree: structuredClone(author.state.ratchetTree) }
  expect(
    recoverySignerEligibleFromPublic({
      tree: trust.signerTree,
      anchor: author.anchor,
      known: trust.registry,
      signer: signer.id,
    }),
  ).toBe(false)
  const sealed = await signedCapture({ fixture: { ...fixture, group: author, identity: signer } })
  expect((await fixture.open(sealed, trust))?.signer).toBe(signer.id)
  expect(await fixture.open(sealed)).toBeNull()
})

test('controller-less verdicts leave confirmation authority to the tuple and require origin membership for refusals', async () => {
  const fixture = await captureFixture({ standard: true })
  const signer = agent(52)
  const added = await rawAdd(fixture.group, signer)
  const author = deriveGroup(fixture.group, added.result.newState)
  const memberTrust = { ...fixture.trust, signerTree: structuredClone(author.state.ratchetTree) }
  const signerGroup = (await mls.createGroup(signer, author.groupID)).group
  const binding = {
    groupID: author.groupID,
    requestID: 'capture',
    position: 'opaque',
    commitDigest: 'digest',
  }
  for (const verdict of [
    { ...binding, verdict: 'confirmed' as const, epoch: Number(author.epoch), tag: 'tuple-tag' },
    { ...binding, verdict: 'refused' as const, reason: 'policy' as const },
  ]) {
    const sealed = await mls.sealRecoveryVerdict({
      group: signerGroup,
      identity: signer,
      request: fixture.held.request,
      verdict,
    })
    const params = {
      trust: memberTrust,
      sealed,
      requestID: 'capture',
      requestKey: fixture.held.requestKey,
      options: {},
    }
    await expect(mls.openRecoveryVerdictFromTrust(params)).resolves.toEqual({
      signer: signer.id,
      verdict,
    })
    const absent = mls.openRecoveryVerdictFromTrust({ ...params, trust: fixture.trust })
    if (verdict.verdict === 'confirmed')
      await expect(absent).resolves.toEqual({ signer: signer.id, verdict })
    else await expect(absent).rejects.toMatchObject({ reason: 'unauthenticated' })
  }
})

test('retained authority checks a distinct signer and refuses malformed tree bindings', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(150_000)
  try {
    const { group, identity } = await pipelineGroup()
    const signer = agent(52)
    const { author, joined } = await lowLevelWelcome(
      group,
      signer,
      await timedBinding({ identity: signer, iat: 100, exp: 180 }),
    )
    const anchor = readGroupAnchorExtension(author)?.extensionData
    if (!(anchor instanceof Uint8Array)) throw new Error('Missing anchor')
    const owner = author.state.ratchetTree[0]
    if (owner?.nodeType !== nodeTypes.leaf || !('identity' in owner.leaf.credential))
      throw new Error('Missing owner')
    const binding = parseMLSCredentialIdentity(owner.leaf.credential.identity).controller
    if (binding == null) throw new Error('Missing binding')
    const trust = {
      groupID: author.groupID,
      genesisAnchor: anchor,
      signerTree: structuredClone(author.state.ratchetTree),
      registry: structuredClone(author.registry),
      credential: author.credential,
      binding,
      ledger: author.ledgerTokens,
      ciphersuiteName: 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
    }
    const held = await mls.createRecoveryRequestFromTrust({
      trust,
      identity,
      requestID: 'distinct',
    })
    const sealed = await mls.sealCapturedGroupInfo({
      group: joined,
      identity: signer,
      request: held.request,
      captureHead: 'distinct',
    })
    const verdict = await mls.sealRecoveryVerdict({
      group: joined,
      identity: signer,
      request: held.request,
      verdict: {
        groupID: author.groupID,
        requestID: 'distinct',
        position: 'head',
        commitDigest: 'digest',
        verdict: 'superseded',
      },
    })
    const params = {
      trust,
      sealed,
      requestID: 'distinct',
      requestKey: held.requestKey,
      options: {},
    }
    expect((await mls.authenticateRecoveryReply(params))?.signer).toBe(signer.id)
    expect((await mls.openRecoveryVerdictFromTrust({ ...params, sealed: verdict })).signer).toBe(
      signer.id,
    )
    for (const registry of [
      {
        ...trust.registry,
        devices: new Map([[signer.id, { controller: controllerID, status: 'revoked' as const }]]),
      },
      {
        ...trust.registry,
        controllers: new Map([[controllerID, { recordedLog: [], genFloor: 1, timeFloor: 0 }]]),
      },
      {
        ...trust.registry,
        controllers: new Map([[controllerID, { recordedLog: [], genFloor: 0, timeFloor: 190 }]]),
      },
    ]) {
      expect(
        await mls.authenticateRecoveryReply({ ...params, trust: { ...trust, registry } }),
      ).toBeNull()
      await expect(
        mls.openRecoveryVerdictFromTrust({
          ...params,
          sealed: verdict,
          trust: { ...trust, registry },
        }),
      ).rejects.toThrow(/denied-id|Ineligible retained recovery signer/)
    }
    for (const identity of [
      new TextEncoder().encode('{'),
      new TextEncoder().encode(
        JSON.stringify({ id: agent(63).id, controller: { ...binding, capability: 'malformed' } }),
      ),
      new TextEncoder().encode(
        JSON.stringify({ id: agent(63).id, controller: { ...binding, capability: 1 } }),
      ),
    ]) {
      const tree = structuredClone(trust.signerTree)
      const extra = structuredClone(owner)
      extra.leaf.credential = { credentialType: 1, identity }
      tree.push(undefined, extra)
      const changed = { ...params, trust: { ...trust, signerTree: tree } }
      expect(
        recoverySignerEligibleFromPublic({
          tree,
          anchor: author.anchor,
          known: trust.registry,
          signer: signer.id,
        }),
      ).toBe(false)
      expect(await mls.authenticateRecoveryReply(changed)).toBeNull()
      await expect(
        mls.openRecoveryVerdictFromTrust({ ...changed, sealed: verdict }),
      ).rejects.toMatchObject({ reason: 'unauthenticated' })
    }
    for (const credential of [null, 'malformed']) {
      const tree = structuredClone(trust.signerTree)
      const extra = structuredClone(owner)
      Reflect.set(extra.leaf, 'credential', credential)
      tree.push(undefined, extra)
      const changed = { ...params, trust: { ...trust, signerTree: tree } }
      expect(await mls.authenticateRecoveryReply(changed)).toBeNull()
      await expect(
        mls.openRecoveryVerdictFromTrust({ ...changed, sealed: verdict }),
      ).rejects.toMatchObject({ reason: 'unauthenticated' })
    }
    const failure = new Error('unrelated credential reader unavailable')
    const tree = structuredClone(trust.signerTree)
    const extra = structuredClone(owner)
    Object.defineProperty(extra.leaf.credential, 'identity', {
      get() {
        throw failure
      },
    })
    tree.push(undefined, extra)
    const changed = { ...params, trust: { ...trust, signerTree: tree } }
    await expect(mls.authenticateRecoveryReply(changed)).rejects.toBe(failure)
    await expect(mls.openRecoveryVerdictFromTrust({ ...changed, sealed: verdict })).rejects.toBe(
      failure,
    )
  } finally {
    now.mockRestore()
  }
})

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
