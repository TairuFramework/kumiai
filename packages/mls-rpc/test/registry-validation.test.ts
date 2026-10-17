import { type OwnIdentity, randomIdentity } from '@kokuin/token'
import {
  buildGroupAnchorExtension,
  type ControllerBinding,
  createGroup,
  encodeClientState,
  GroupHandle,
  type GroupOptions,
  readGroupAnchorExtension,
  restoreGroup,
  signLedgerEntry,
} from '@kumiai/mls'
import { describe, expect, test } from 'vitest'

import type { GroupRecoveryTrust, GroupStateRecord } from '../src/persistence-types.js'
import { recoveryTrustFor } from '../src/registry/trust.js'
import { registryOptions, validateRegistryHandle } from '../src/registry/validation.js'
import { createRealGroup } from './fixtures/real-group.js'

const ciphersuiteName = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'

async function setup() {
  const identity = randomIdentity()
  const options: GroupOptions = {
    keyRetention: { retainKeysForGenerations: 1000, maximumForwardRatchetSteps: 1000 },
    commitPolicy: () => 'accept',
    resolveLedgerEntries: async () => [],
    onLedgerEntries: () => {},
  }
  const { group: handle } = await createGroup(identity, 'registry-validation', options)
  const token = await signLedgerEntry(identity, {
    type: 'kumiai.role',
    groupID: handle.groupID,
    subject: identity.id,
    value: 'admin',
  })
  await handle.applyLedgerEntries([token, token])
  const key = { groupID: handle.groupID, incarnation: 1 }
  const anchor = readGroupAnchorExtension(handle)?.extensionData
  if (!(anchor instanceof Uint8Array)) throw new Error('Missing fixture anchor')
  const trust: GroupRecoveryTrust = {
    groupID: key.groupID,
    genesisAnchor: anchor.slice(),
    installed: {
      ...key,
      epoch: 0,
      authenticator: handle.state.keySchedule.epochAuthenticator.slice(),
    },
    signerTree: structuredClone(handle.state.ratchetTree),
    registry: structuredClone(handle.registry),
    credential: { ...handle.credential },
    binding: null,
    ledger: [token, token],
    ciphersuiteName,
    spentEpochAuthenticators: [handle.state.keySchedule.epochAuthenticator.slice()],
  }
  const record: GroupStateRecord & { deleted: false } = {
    ...key,
    version: 1,
    deleted: false,
    terminal: false,
    epoch: 0,
    epochAuthenticator: handle.state.keySchedule.epochAuthenticator.slice(),
    state: encodeClientState(handle.state),
    credential: { ...handle.credential },
    ledger: [token, token],
    senderHWM: 16,
  }
  const params = {
    handle,
    key,
    record,
    trust,
    environment: { identity, options },
    ownerDID: identity.id,
  }
  return { ...params, params, token }
}

describe('registry retention defaults and floors', () => {
  test('supplies generation and forward window floors while preserving other options', () => {
    expect(registryOptions({}).keyRetention).toEqual({
      retainKeysForEpochs: 4,
      retainKeysForGenerations: 1000,
      maximumForwardRatchetSteps: 1000,
    })
    const options: GroupOptions = { keyRetention: { retainKeysForEpochs: 8 } }
    expect(registryOptions(options).keyRetention).toEqual({
      retainKeysForEpochs: 8,
      retainKeysForGenerations: 1000,
      maximumForwardRatchetSteps: 1000,
    })
    expect(options.keyRetention).toEqual({ retainKeysForEpochs: 8 })
    expect(
      registryOptions({
        keyRetention: { retainKeysForGenerations: 1001, maximumForwardRatchetSteps: 2000 },
      }).keyRetention,
    ).toEqual({
      retainKeysForEpochs: 4,
      retainKeysForGenerations: 1001,
      maximumForwardRatchetSteps: 2000,
    })
  })

  test.each(['retainKeysForGenerations', 'maximumForwardRatchetSteps'] as const)(
    'refuses invalid or insufficient %s',
    (field) => {
      for (const value of [
        999,
        Number.NaN,
        1000.5,
        -1,
        Number.POSITIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
      ]) {
        expect(() => registryOptions({ keyRetention: { [field]: value } })).toThrow()
      }
      expect(() =>
        Reflect.apply(registryOptions, undefined, [{ keyRetention: { [field]: null } }]),
      ).toThrow()
    },
  )
})

describe('foreign owner and mismatched context refuse', () => {
  test('accepts cold restoration with supplied references and repeated ordered ledger', async () => {
    const s = await setup()
    const restored = await restoreGroup({
      state: s.handle.state,
      credential: s.handle.credential,
      ledgerEntries: s.record.ledger,
      options: s.environment.options,
    })
    expect(restored.ledgerTokens).toEqual([s.token, s.token])
    expect(() => validateRegistryHandle({ ...s.params, handle: restored })).not.toThrow()
    expect(() =>
      validateRegistryHandle({ ...s.params, record: undefined, trust: null }),
    ).not.toThrow()
  })

  test('refuses foreign persistence owners and recovery identities', async () => {
    const s = await setup()
    const foreign = randomIdentity()
    expect(() => validateRegistryHandle({ ...s.params, ownerDID: foreign.id })).toThrow()
    expect(() =>
      validateRegistryHandle({ ...s.params, environment: { ...s.environment, identity: foreign } }),
    ).toThrow()
    const handle = new GroupHandle({
      state: s.handle.state,
      context: s.handle.context,
      credential: { id: foreign.id, groupID: s.key.groupID },
      ledger: s.handle.ledger,
    })
    expect(() => validateRegistryHandle({ ...s.params, handle })).toThrow()
  })

  test('refuses replaced policy, resolver and callback references', async () => {
    const s = await setup()
    for (const options of [
      { ...s.environment.options, commitPolicy: undefined },
      { ...s.environment.options, resolveLedgerEntries: async () => [] },
      { ...s.environment.options, onLedgerEntries: () => {} },
    ]) {
      expect(() =>
        validateRegistryHandle({ ...s.params, environment: { ...s.environment, options } }),
      ).toThrow()
    }
  })

  test('refuses effective retention, context suite and immutable anchor mismatches', async () => {
    const s = await setup()
    for (const keyRetention of [
      { retainKeysForGenerations: 1001 },
      { maximumForwardRatchetSteps: 1001 },
      { retainKeysForEpochs: 8 },
    ]) {
      expect(() =>
        validateRegistryHandle({
          ...s.params,
          environment: { ...s.environment, options: { ...s.environment.options, keyRetention } },
        }),
      ).toThrow()
    }
    expect(() =>
      validateRegistryHandle({
        ...s.params,
        environment: {
          ...s.environment,
          options: {
            ...s.environment.options,
            ciphersuiteName: 'MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519',
          },
        },
      }),
    ).toThrow()
    const trust = structuredClone(s.trust)
    trust.genesisAnchor[0] = (trust.genesisAnchor[0] ?? 0) ^ 1
    expect(() => validateRegistryHandle({ ...s.params, trust })).toThrow()
    expect(() =>
      validateRegistryHandle({
        ...s.params,
        trust: { ...s.trust, ciphersuiteName: 'foreign-suite' },
      }),
    ).toThrow()
  })

  test('refuses cold metadata and current trust disagreements or unavailable surviving trust', async () => {
    const s = await setup()
    for (const record of [
      { ...s.record, groupID: 'foreign-group' },
      { ...s.record, incarnation: 2 },
      { ...s.record, epoch: 1 },
      { ...s.record, epochAuthenticator: new Uint8Array(32) },
      { ...s.record, credential: { ...s.record.credential, id: randomIdentity().id } },
      { ...s.record, ledger: [s.token] },
      { ...s.record, deleted: true } as const,
      { ...s.record, state: null },
    ])
      expect(() => validateRegistryHandle({ ...s.params, record })).toThrow()
    for (const installed of [
      { ...s.trust.installed, incarnation: 2 },
      { ...s.trust.installed, epoch: 1 },
      { ...s.trust.installed, authenticator: new Uint8Array(32) },
    ])
      expect(() =>
        validateRegistryHandle({ ...s.params, trust: { ...s.trust, installed } }),
      ).toThrow()
    expect(() => validateRegistryHandle({ ...s.params, trust: null })).toThrow()
    expect(() =>
      validateRegistryHandle({ ...s.params, trust: { ...s.trust, spentEpochAuthenticators: [] } }),
    ).toThrow()
    expect(() => recoveryTrustFor(s.handle, { ...s.key, incarnation: 2 }, null)).toThrow()
  })

  test('installations compare immutable trust without requiring the destination to equal the source', async () => {
    const s = await setup()
    const key = { ...s.key, incarnation: 2 }
    expect(() => validateRegistryHandle({ ...s.params, key, record: undefined })).not.toThrow()
    expect(recoveryTrustFor(s.handle, key, s.trust).installed.incarnation).toBe(2)
    const trust = structuredClone(s.trust)
    trust.genesisAnchor[0] = (trust.genesisAnchor[0] ?? 0) ^ 1
    expect(() => recoveryTrustFor(s.handle, key, trust)).toThrow()
  })
})

test('trust builder keeps public history and defensively copies revocations, floors and spent bytes', async () => {
  const s = await setup()
  const leaf = s.handle.state.ratchetTree[0]
  if (leaf == null || leaf.nodeType !== 1) throw new Error('Missing fixture leaf')
  Object.assign(leaf, { privateKey: new Uint8Array([91]) })
  Object.assign(leaf.leaf, { signaturePrivateKey: new Uint8Array([92]) })
  const registry = s.trust.registry
  const revoked = { controller: s.environment.identity.id, status: 'revoked' as const }
  const projection = { recordedLog: [], genFloor: 7, timeFloor: 9 }
  registry.devices = new Map([['revoked-device', revoked]])
  registry.controllers = new Map([['controller', projection]])
  const candidate = s.handle.registry
  candidate.devices = new Map([['revoked-device', { ...revoked, status: 'active' }]])
  candidate.controllers = new Map([['controller', { recordedLog: [], genFloor: 3, timeFloor: 12 }]])
  const trust = recoveryTrustFor(s.handle, s.key, s.trust)
  expect(trust.ledger).toEqual([s.token, s.token])
  expect(trust.signerTree[0]).not.toHaveProperty('privateKey')
  expect(trust.signerTree[0]).not.toHaveProperty('leaf.signaturePrivateKey')
  expect(trust.registry.devices.get('revoked-device')?.status).toBe('revoked')
  expect(trust.registry.controllers.get('controller')).toMatchObject({ genFloor: 7, timeFloor: 12 })
  expect(trust.spentEpochAuthenticators).toEqual([s.record.epochAuthenticator])
  const spent = trust.spentEpochAuthenticators[0]
  if (spent == null) throw new Error('Missing retained spent authenticator')
  spent.fill(0)
  trust.installed.authenticator.fill(0)
  trust.genesisAnchor.fill(0)
  trust.credential.id = 'changed'
  trust.ledger.pop()
  const publicLeaf = trust.signerTree[0]
  if (publicLeaf?.nodeType !== 1) throw new Error('Missing public leaf')
  publicLeaf.leaf.signaturePublicKey.fill(0)
  const copiedRevoked = trust.registry.devices.get('revoked-device')
  const copiedProjection = trust.registry.controllers.get('controller')
  if (copiedRevoked == null || copiedProjection == null) throw new Error('Missing registry history')
  copiedRevoked.status = 'active'
  copiedProjection.genFloor = 0
  expect(s.trust.spentEpochAuthenticators[0]).toEqual(s.record.epochAuthenticator)
  expect(s.handle.state.keySchedule.epochAuthenticator).toEqual(s.record.epochAuthenticator)
  expect(s.handle.credential.id).toBe(s.environment.identity.id)
  expect(s.handle.ledgerTokens).toEqual([s.token, s.token])
  expect(leaf.leaf.signaturePublicKey).toEqual(s.environment.identity.publicKey)
  expect(revoked.status).toBe('revoked')
  expect(projection.genFloor).toBe(7)
  expect(candidate.controllers.get('controller')?.timeFloor).toBe(12)
})

test('only absent first installation starts an empty spent set', async () => {
  const s = await setup()
  const trust = recoveryTrustFor(s.handle, s.key, null)
  expect(trust.spentEpochAuthenticators).toEqual([])
  expect(trust.installed).toEqual({
    ...s.key,
    epoch: 0,
    authenticator: s.record.epochAuthenticator,
  })
  expect(trust.ciphersuiteName).toBe(ciphersuiteName)
  expect(trust.binding).toBeNull()
  expect(() =>
    recoveryTrustFor(s.handle, s.key, { ...s.trust, spentEpochAuthenticators: [] }),
  ).toThrow()
})

test('refuses state group, suite and own leaf disagreement even with an owned handle credential', async () => {
  const s = await setup()
  const foreign = (await createGroup(randomIdentity(), s.key.groupID)).group
  for (const state of [
    {
      ...s.handle.state,
      groupContext: {
        ...s.handle.state.groupContext,
        groupId: new TextEncoder().encode('foreign'),
      },
    },
    { ...s.handle.state, groupContext: { ...s.handle.state.groupContext, cipherSuite: 3 } },
    { ...s.handle.state, ratchetTree: foreign.state.ratchetTree },
  ]) {
    const handle = new GroupHandle({
      state,
      credential: s.handle.credential,
      context: s.handle.context,
      ledger: s.handle.ledger,
      ...s.environment.options,
    })
    expect(() => validateRegistryHandle({ ...s.params, handle })).toThrow()
  }
  expect(() =>
    recoveryTrustFor(s.handle, s.key, {
      ...s.trust,
      spentEpochAuthenticators: undefined,
    } as unknown as GroupRecoveryTrust),
  ).toThrow()
})

test('trust copies public parent nodes and preserves blanks without retaining private fields', async () => {
  const real = await createRealGroup(1, 'registry-public-parent')
  const handle = real.committer.handle
  const parent = handle.state.ratchetTree.find((node) => node?.nodeType === 2)
  if (parent?.nodeType !== 2) throw new Error('Missing real parent')
  Object.assign(parent, { privateKey: new Uint8Array([91]) })
  Object.assign(parent.parent, { hpkePrivateKey: new Uint8Array([92]) })
  handle.state.ratchetTree.push(undefined)
  const trust = recoveryTrustFor(handle, { groupID: handle.groupID, incarnation: 1 }, null)
  const copied = trust.signerTree.find((node) => node?.nodeType === 2)
  if (copied?.nodeType !== 2) throw new Error('Missing copied parent')
  expect(copied).not.toHaveProperty('privateKey')
  expect(copied.parent).not.toHaveProperty('hpkePrivateKey')
  expect(copied.parent.parentHash).toEqual(parent.parent.parentHash)
  expect(trust.signerTree.at(-1)).toBeUndefined()
  copied.parent.hpkePublicKey.fill(0)
  copied.parent.unmergedLeaves.push(100)
  expect(parent.parent.hpkePublicKey.some((byte) => byte !== 0)).toBe(true)
  expect(parent.parent.unmergedLeaves).not.toContain(100)
})

test('trust copies installed controller binding and its signed prefix', async () => {
  const fixture = (await import(
    new URL('../../mls/test/fixtures/lifecycle-ledger.ts', import.meta.url).href
  )) as {
    agent(byte: number): OwnIdentity
    bindingFor(identity: OwnIdentity): Promise<ControllerBinding>
  }
  const identity = fixture.agent(91)
  const binding = await fixture.bindingFor(identity)
  const { group } = await createGroup(identity, 'registry-binding', { controller: binding })
  const trust = recoveryTrustFor(group, { groupID: group.groupID, incarnation: 1 }, null)
  expect(trust.binding).toEqual(binding)
  if (trust.binding == null) throw new Error('Missing installed binding')
  trust.binding.prefix.pop()
  expect(group.bindingOfDID(identity.id)?.prefix).toEqual(binding.prefix)
})

test('trust preserves encoded immutable anchor bytes including withheld future app payload', async () => {
  const identity = randomIdentity()
  const extension = buildGroupAnchorExtension({
    creatorDID: identity.id,
    version: 2,
    app: { recoverySeed: 'future-payload' },
  })
  const { group } = await createGroup(identity, 'registry-future-anchor', {
    extensions: [extension],
  })
  expect(group.anchor.app).toBeUndefined()
  expect(
    recoveryTrustFor(group, { groupID: group.groupID, incarnation: 1 }, null).genesisAnchor,
  ).toEqual(extension.extensionData)
})
