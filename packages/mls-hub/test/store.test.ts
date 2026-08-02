import { describe, expect, test } from 'vitest'

import { createMemoryLastResortStore, type LastResortRecord } from '../src/store.js'

const ALICE = 'did:key:alice'
const BOB = 'did:key:bob'

function record(ref: string, notAfter = 1_000): LastResortRecord {
  return {
    kind: 'last-resort',
    ref,
    keyPackage: `kp-${ref}`,
    privatePackage: `priv-${ref}`,
    notAfter,
    uploadedAt: null,
  }
}

describe('createMemoryLastResortStore', () => {
  test('put then list returns the record', async () => {
    const store = createMemoryLastResortStore()
    await store.put(ALICE, record('a'))
    expect(await store.list(ALICE)).toEqual([record('a')])
  })

  test('an owner with no records lists empty', async () => {
    const store = createMemoryLastResortStore()
    expect(await store.list(ALICE)).toEqual([])
  })

  /**
   * The provisioner re-puts the SAME ref with `uploadedAt` set as the second write of its upload
   * sequence. A store that appended instead of replacing would grow a duplicate per rotation and
   * make `list` ambiguous about which copy reached the hub.
   */
  test('put replaces a record with the same ref rather than duplicating it', async () => {
    const store = createMemoryLastResortStore()
    await store.put(ALICE, record('a'))
    await store.put(ALICE, { ...record('a'), uploadedAt: 42 })
    const listed = await store.list(ALICE)
    expect(listed).toHaveLength(1)
    expect(listed[0]?.uploadedAt).toBe(42)
  })

  /**
   * The `WHERE owner = ?` trap, and the reason it is tested rather than trusted: these records hold
   * PRIVATE KEY MATERIAL, so a list that crossed owners would be worse than any of the hub-store
   * scoping bugs the hub conformance suite pins.
   */
  test("one owner's records are never listed for another", async () => {
    const store = createMemoryLastResortStore()
    await store.put(ALICE, record('a'))
    expect(await store.list(BOB)).toEqual([])
  })

  test('delete removes only the named record for the named owner', async () => {
    const store = createMemoryLastResortStore()
    await store.put(ALICE, record('a'))
    await store.put(ALICE, record('b'))
    await store.put(BOB, record('a'))

    await store.delete(ALICE, 'a')

    expect((await store.list(ALICE)).map((r) => r.ref)).toEqual(['b'])
    expect((await store.list(BOB)).map((r) => r.ref)).toEqual(['a'])
  })

  test('deleting a ref the owner does not hold is a no-op', async () => {
    const store = createMemoryLastResortStore()
    await store.put(ALICE, record('a'))
    await store.delete(ALICE, 'missing')
    expect((await store.list(ALICE)).map((r) => r.ref)).toEqual(['a'])
  })

  /** A returned record must not alias stored state, or a caller's edit silently rewrites the store. */
  test('mutating a listed record does not change what is stored', async () => {
    const store = createMemoryLastResortStore()
    await store.put(ALICE, record('a'))
    const [listed] = await store.list(ALICE)
    if (listed != null) listed.uploadedAt = 999
    expect((await store.list(ALICE))[0]?.uploadedAt).toBeNull()
  })
})
