import type { Credential, GenerationSecret, SecretTree } from 'ts-mls'
import { defaultCredentialTypes } from 'ts-mls'
import { expect, test } from 'vitest'

import { didFromCredential, mergeReceiveSecretTree } from '../src/index.js'

test('didFromCredentialReadsBasicCredential', () => {
  const credential: Credential = {
    credentialType: defaultCredentialTypes.basic,
    identity: new TextEncoder().encode(JSON.stringify({ id: 'did:key:z6MkABC' })),
  }
  expect(didFromCredential(credential)).toBe('did:key:z6MkABC')
})

test('didFromCredentialNullForOtherTypes', () => {
  const credentials: Array<Credential> = [
    { credentialType: defaultCredentialTypes.x509, certificates: [] },
    { credentialType: 0xbeef, data: new Uint8Array([1, 2, 3]) },
  ]
  for (const credential of credentials) {
    expect(didFromCredential(credential)).toBeNull()
  }
})

test('didFromCredentialNullForEmptyId', () => {
  const credential: Credential = {
    credentialType: defaultCredentialTypes.basic,
    identity: new TextEncoder().encode(JSON.stringify({ id: '' })),
  }
  expect(didFromCredential(credential)).toBeNull()
})

function ratchet(generation: number, unused: Array<number>): GenerationSecret {
  return {
    generation,
    secret: new Uint8Array([generation]),
    unusedGenerations: Object.fromEntries(unused.map((value) => [value, new Uint8Array([value])])),
  }
}

function tree(application: GenerationSecret, handshake = ratchet(0, [])): SecretTree {
  return { leafWidth: 4, intermediateNodes: {}, leafNodes: { 0: { application, handshake } } }
}

test('mergeReceiveSecretTreeKeepsUnconsumedGenerations', () => {
  // Reopened, journal-replayed, duplicate, and stale receivers must not revive spent keys.
  const cases = [
    { target: ratchet(2, []), source: ratchet(0, []), generation: 2, unused: [] },
    { target: ratchet(0, []), source: ratchet(2, [0]), generation: 2, unused: [0] },
    { target: ratchet(2, [0]), source: ratchet(2, []), generation: 2, unused: [] },
    { target: ratchet(2, []), source: ratchet(2, [0]), generation: 2, unused: [] },
    { target: ratchet(2, [0]), source: ratchet(4, [0, 1, 2]), generation: 4, unused: [0, 2] },
    { target: ratchet(4, [0, 1, 2]), source: ratchet(2, [0]), generation: 4, unused: [0, 2] },
    { target: ratchet(3, [0, 1]), source: ratchet(3, [1, 2]), generation: 3, unused: [1] },
  ]
  for (const { target, source, generation, unused } of cases) {
    const targetTree = tree(target, source)
    const sourceTree = tree(source, target)
    const before = structuredClone([targetTree, sourceTree])
    const merged = mergeReceiveSecretTree(targetTree, sourceTree)
    for (const result of [merged.leafNodes[0]?.application, merged.leafNodes[0]?.handshake]) {
      expect(result).toEqual(ratchet(generation, unused))
    }
    expect([targetTree, sourceTree]).toEqual(before)
  }
})

test('mergeReceiveSecretTreeKeepsExpandedBranchesAndSiblingSecrets', () => {
  const target = tree(ratchet(2, []))
  target.intermediateNodes = { 1: new Uint8Array([1]), 3: new Uint8Array([3]) }
  const source: SecretTree = {
    leafWidth: 4,
    intermediateNodes: { 2: new Uint8Array([2]), 5: new Uint8Array([5]) },
    leafNodes: { 4: { application: ratchet(1, []), handshake: ratchet(0, []) } },
  }
  const before = structuredClone([target, source])
  for (const merged of [
    mergeReceiveSecretTree(target, source),
    mergeReceiveSecretTree(source, target),
  ]) {
    expect(merged.leafWidth).toBe(4)
    expect(merged.intermediateNodes).toEqual({ 2: new Uint8Array([2]) })
    expect(Object.keys(merged.leafNodes)).toEqual(['0', '4'])
    expect(merged.leafNodes[0]).toEqual(target.leafNodes[0])
    expect(merged.leafNodes[4]).toEqual(source.leafNodes[4])
  }
  expect([target, source]).toEqual(before)
})

test('mergeReceiveSecretTreeKeepsUnexpandedSiblingBranches', () => {
  const target: SecretTree = {
    leafWidth: 4,
    intermediateNodes: { 3: new Uint8Array([3]) },
    leafNodes: {},
  }
  const source = tree(ratchet(1, []))
  source.intermediateNodes = { 2: new Uint8Array([2]), 5: new Uint8Array([5]) }
  const merged = mergeReceiveSecretTree(target, source)
  expect(merged.intermediateNodes).toEqual({ 2: new Uint8Array([2]), 5: new Uint8Array([5]) })
  expect(merged.leafNodes[0]).toEqual(source.leafNodes[0])
})
