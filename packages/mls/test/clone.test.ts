import { leafNodeSources, nodeTypes } from 'ts-mls'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { cloneData } from '../src/clone.js'
import { parseMLSCredentialIdentity } from '../src/credential.js'
import { renewLeaf } from '../src/group-lifecycle.js'
import { carryReceiveFixture } from './fixtures/carry-receive-progress.js'
import { joinBoundDevice } from './fixtures/device-harness.js'
import { pipelineGroup, timedBinding } from './fixtures/lifecycle-pipeline.js'

const utf8 = new TextEncoder()

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('cloneData', () => {
  test('returns primitives unchanged', () => {
    for (const value of [
      null,
      undefined,
      true,
      false,
      42,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      'hello',
      7n,
      Symbol('x'),
    ]) {
      expect(cloneData(value)).toBe(value)
    }
  })

  test('recursively copies arrays and plain objects', () => {
    const value = { items: [{ bytes: new Uint8Array([1, 2]), absent: undefined, lifetime: 7n }] }
    const copy = cloneData(value)
    expect(copy).toEqual(structuredClone(value))
    expect(copy).not.toBe(value)
    expect(copy.items).not.toBe(value.items)
    const item = copy.items[0]
    const original = value.items[0]
    expect(item).toBeDefined()
    expect(original).toBeDefined()
    if (item == null || original == null) throw new Error('Missing item')
    expect(item).not.toBe(original)
    item.bytes.fill(0)
    expect(original.bytes).toEqual(new Uint8Array([1, 2]))
  })

  test('copies null-prototype objects and own __proto__ data', () => {
    const value = Object.create(null) as Record<string, unknown>
    value.nested = { bytes: new Uint8Array([3]) }
    Object.defineProperty(value, '__proto__', {
      value: { bytes: new Uint8Array([4]) },
      enumerable: true,
    })
    const copy = cloneData(value)
    expect(copy).toEqual(value)
    expect(copy).not.toBe(value)
    expect(copy.nested).not.toBe(value.nested)
    expect(Object.hasOwn(copy, '__proto__')).toBe(true)
    expect(Object.getOwnPropertyDescriptor(copy, '__proto__')?.value).not.toBe(
      Object.getOwnPropertyDescriptor(value, '__proto__')?.value,
    )
  })

  test('copies only the bytes of a Uint8Array subarray into an independent buffer', () => {
    const value = new Uint8Array(new ArrayBuffer(16), 3, 5)
    value.set([1, 2, 3, 4, 5])
    const copy = cloneData(value)
    expect(copy).toEqual(value)
    expect(copy.byteOffset).toBe(0)
    expect(copy.buffer.byteLength).toBe(5)
    expect(copy.buffer).not.toBe(value.buffer)
    copy.fill(0)
    expect(value).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
  })

  test.each([
    ['Map', new Map()],
    ['Set', new Set()],
    ['Date', new Date()],
    ['class instance', new (class X {})()],
    ['function', () => undefined],
    ['Uint16Array', new Uint16Array(2)],
    ['ArrayBuffer', new ArrayBuffer(2)],
  ])('rejects unsupported %s values', (_name, value) => {
    expect(() => cloneData(value)).toThrow(new TypeError('cloneData: unsupported value'))
  })

  test('clones an expanded MLS secret tree without sharing application secrets', async () => {
    const { deviceGroup } = await joinBoundDevice()
    await deviceGroup.encrypt(utf8.encode('expand sender secrets'))
    const tree = deviceGroup.state.secretTree
    const index = deviceGroup.state.privatePath.leafIndex * 2
    const original = tree.leafNodes[index]
    expect(original).toBeDefined()
    if (original == null) throw new Error('Missing sender secrets')
    const snapshot = original.application.secret.slice()
    expect(snapshot.some((byte) => byte !== 0)).toBe(true)
    const copy = cloneData(tree)
    expect(copy).toEqual(structuredClone(tree))
    const cloned = copy.leafNodes[index]
    expect(cloned).toBeDefined()
    if (cloned == null) throw new Error('Missing cloned sender secrets')
    cloned.application.secret.fill(0)
    expect(original.application.secret).toEqual(snapshot)
  })

  test('preserves a joined key-package leaf and its bigint lifetime', async () => {
    const { deviceGroup } = await joinBoundDevice()
    const node = deviceGroup.state.ratchetTree[deviceGroup.state.privatePath.leafIndex * 2]
    expect(node?.nodeType).toBe(nodeTypes.leaf)
    if (node?.nodeType !== nodeTypes.leaf) throw new Error('Missing joined leaf')
    expect(node.leaf.leafNodeSource).toBe(leafNodeSources.key_package)
    if (node.leaf.leafNodeSource !== leafNodeSources.key_package) {
      throw new Error('Expected key-package leaf')
    }
    expect(typeof node.leaf.lifetime.notAfter).toBe('bigint')
    const copy = cloneData(node)
    expect(copy).toEqual(structuredClone(node))
    expect(copy).not.toBe(node)
    expect(copy.leaf.leafNodeSource).toBe(leafNodeSources.key_package)
    if (copy.leaf.leafNodeSource !== leafNodeSources.key_package) {
      throw new Error('Expected cloned key-package leaf')
    }
    expect(copy.leaf.lifetime.notAfter).toBe(node.leaf.lifetime.notAfter)
    expect(typeof copy.leaf.lifetime.notAfter).toBe('bigint')
  })
})

test('carried current and earlier epoch secrets survive zeroing the live buffers', async () => {
  const { aliceGroup, candidate, earlierSender } = await carryReceiveFixture('clone-history')
  const index = aliceGroup.state.privatePath.leafIndex * 2
  const earlier = earlierSender.epoch
  await aliceGroup.encrypt(utf8.encode('current'))
  await aliceGroup.decrypt(await earlierSender.encrypt(utf8.encode('earlier')))
  vi.stubGlobal('structuredClone', undefined)
  await aliceGroup.carryReceiveProgress(candidate)

  const liveCurrent = aliceGroup.state.secretTree.leafNodes[index]
  const liveEarlier =
    aliceGroup.state.historicalReceiverData.get(earlier)?.secretTree.leafNodes[index]
  const copiedCurrent = candidate.state.historicalReceiverData.get(aliceGroup.epoch)?.secretTree
    .leafNodes[index]
  const copiedEarlier =
    candidate.state.historicalReceiverData.get(earlier)?.secretTree.leafNodes[index]
  expect(liveCurrent).toBeDefined()
  expect(liveEarlier).toBeDefined()
  expect(copiedCurrent).toBeDefined()
  expect(copiedEarlier).toBeDefined()
  if (
    liveCurrent == null ||
    liveEarlier == null ||
    copiedCurrent == null ||
    copiedEarlier == null
  ) {
    throw new Error('Missing retained secrets')
  }
  const currentSnapshot = copiedCurrent.application.secret.slice()
  const earlierSnapshot = copiedEarlier.application.secret.slice()
  expect(currentSnapshot.some((byte) => byte !== 0)).toBe(true)
  expect(earlierSnapshot.some((byte) => byte !== 0)).toBe(true)
  liveCurrent.application.secret.fill(0)
  liveEarlier.application.secret.fill(0)
  expect(copiedCurrent.application.secret).toEqual(currentSnapshot)
  expect(copiedEarlier.application.secret).toEqual(earlierSnapshot)
})

test('renews a leaf without structuredClone or mutating the original tree node', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(150_000)
  const { group, identity } = await pipelineGroup()
  const index = group.state.privatePath.leafIndex * 2
  const original = group.state.ratchetTree[index]
  const snapshot = structuredClone(original)
  const binding = await timedBinding({ identity, iat: 150, exp: 250 })
  vi.stubGlobal('structuredClone', undefined)
  const result = await renewLeaf(group, binding)
  expect(result.epoch).toBe(group.epoch + 1n)
  expect(group.state.ratchetTree[index]).toBe(original)
  expect(original).toEqual(snapshot)
  const renewed = result.newGroup.state.ratchetTree[index]
  expect(renewed?.nodeType).toBe(nodeTypes.leaf)
  if (renewed?.nodeType !== nodeTypes.leaf || !('identity' in renewed.leaf.credential)) {
    throw new Error('Missing renewed credential')
  }
  expect(renewed).not.toBe(original)
  expect(parseMLSCredentialIdentity(renewed.leaf.credential.identity).controller).toEqual(binding)
})
