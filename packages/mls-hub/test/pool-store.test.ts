import { describe, expect, test } from 'vitest'

import { createMemoryKeyPackagePoolStore, type KeyPackageRecord } from '../src/pool-store.js'

const ALICE = 'did:key:alice'
const BOB = 'did:key:bob'

function record(ref: string): KeyPackageRecord {
  return {
    kind: 'ordinary',
    ref,
    keyPackage: `kp-${ref}`,
    privatePackage: `priv-${ref}`,
    notAfter: 100,
  }
}

describe('createMemoryKeyPackagePoolStore', () => {
  test('list is scoped to the owner', async () => {
    const store = createMemoryKeyPackagePoolStore()
    await store.put(ALICE, record('a'))
    await store.put(BOB, record('b'))

    expect((await store.list(ALICE)).map((entry) => entry.ref)).toEqual(['a'])
    expect((await store.list(BOB)).map((entry) => entry.ref)).toEqual(['b'])
  })

  test('put replaces by ref rather than appending', async () => {
    const store = createMemoryKeyPackagePoolStore()
    await store.put(ALICE, record('a'))
    await store.put(ALICE, { ...record('a'), notAfter: 200 })

    const records = await store.list(ALICE)
    expect(records).toHaveLength(1)
    expect(records[0]?.notAfter).toBe(200)
  })

  test('delete is scoped to the owner and no-ops for an unknown ref', async () => {
    const store = createMemoryKeyPackagePoolStore()
    await store.put(ALICE, record('a'))

    await store.delete(BOB, 'a')
    expect(await store.list(ALICE)).toHaveLength(1)

    await expect(store.delete(ALICE, 'missing')).resolves.toBeUndefined()
    await store.delete(ALICE, 'a')
    expect(await store.list(ALICE)).toHaveLength(0)
  })

  test('list does not alias the store own state', async () => {
    const store = createMemoryKeyPackagePoolStore()
    await store.put(ALICE, record('a'))

    const records = await store.list(ALICE)
    // Mutating what a caller was handed must not reach back into the store — this holds SECRET key
    // material, and a shared reference makes one caller's edit everyone's.
    ;(records[0] as KeyPackageRecord).privatePackage = 'tampered'

    expect((await store.list(ALICE))[0]?.privatePackage).toBe('priv-a')
  })

  test('deleted refs remain consumable without admitting unknown refs', async () => {
    const store = createMemoryKeyPackagePoolStore()
    await store.put(ALICE, record('a'))
    await store.delete(BOB, 'a')
    await store.delete(ALICE, 'a')
    expect(await store.list(ALICE)).toEqual([])
    expect(await store.receipt('a')).toBeNull()
    await expect(store.consume('missing', 'group:a')).rejects.toThrow('exactly one owner')
    await store.consume('a', 'group:a')
    expect(await store.receipt('a')).toEqual({ groupID: 'group:a' })
    await expect(store.consume('a', 'group:b')).rejects.toThrow('another group')
  })

  test('a deleted ref still participates in source ownership ambiguity', async () => {
    const store = createMemoryKeyPackagePoolStore()
    await store.put(ALICE, record('a'))
    await store.delete(ALICE, 'a')
    await store.put(BOB, record('a'))
    await expect(store.consume('a', 'group:a')).rejects.toThrow('exactly one owner')
    expect(await store.list(BOB)).toEqual([record('a')])
    expect(await store.receipt('a')).toBeNull()
  })
})
