import * as mls from '@kumiai/mls'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { openWelcome } from '../src/join.js'
import { createKeyPackagePool } from '../src/pool.js'
import { createMemoryKeyPackagePoolStore } from '../src/pool-store.js'
import { createLastResortProvisioner } from '../src/provisioner.js'
import { createMemoryLastResortStore } from '../src/store.js'
import { createTestHub } from './fixtures/hub.js'
import { holderlessWelcome } from './fixtures/welcome.js'

vi.mock('@kumiai/mls', { spy: true })
afterEach(() => vi.restoreAllMocks())

const ownerDID = 'did:key:consume-owner'
const record = {
  kind: 'ordinary' as const,
  ref: 'package-ref',
  keyPackage: 'public-package',
  privatePackage: 'private-package',
  notAfter: 100,
}

// Fail the receipt write after the transaction has staged its deletion.
function failReceiptWrite() {
  const set = Map.prototype.set
  return vi.spyOn(Map.prototype, 'set').mockImplementation(function (
    this: Map<unknown, unknown>,
    key,
    value,
  ) {
    if (value?.groupID === 'group:consumed') throw new Error('receipt write failed')
    return set.call(this, key, value)
  })
}

function ambiguousCommit() {
  const set = Map.prototype.set
  return vi.spyOn(Map.prototype, 'set').mockImplementation(function (
    this: Map<unknown, unknown>,
    key,
    value,
  ) {
    const result = set.call(this, key, value)
    if (value?.receipts instanceof Map && value.receipts.has(record.ref)) {
      const error = new Error('commit acknowledgement lost')
      error.name = 'StorageOutcomeUnknownError'
      throw error
    }
    return result
  })
}

describe('consume', () => {
  test('consume atomic (pool store)', async () => {
    const store = createMemoryKeyPackagePoolStore()
    await store.put(ownerDID, record)
    const fault = failReceiptWrite()
    await expect(store.consume(record.ref, 'group:consumed')).rejects.toThrow(
      'receipt write failed',
    )
    fault.mockRestore()
    expect(await store.list(ownerDID)).toEqual([record])
    expect(await store.receipt(record.ref)).toBeNull()
  })

  test('consume atomic (bundle source)', async () => {
    const hub = createTestHub()
    try {
      const store = createMemoryKeyPackagePoolStore()
      await store.put(hub.identity.id, record)
      const pool = createKeyPackagePool({
        sourceID: 'ordinary',
        identity: hub.identity,
        client: hub.client,
        store,
      })
      const fault = failReceiptWrite()
      await expect(pool.consume(record.ref, 'group:consumed')).rejects.toThrow(
        'receipt write failed',
      )
      fault.mockRestore()
      expect(await store.list(hub.identity.id)).toEqual([record])
      expect(await pool.receipt(record.ref)).toBeNull()
    } finally {
      await hub.dispose()
    }
  })

  test('consume ambiguous reads back', async () => {
    const store = createMemoryKeyPackagePoolStore()
    await store.put(ownerDID, record)
    const fault = ambiguousCommit()
    await expect(store.consume(record.ref, 'group:consumed')).resolves.toBeUndefined()
    fault.mockRestore()
    expect(await store.list(ownerDID)).toEqual([])
    expect(await store.receipt(record.ref)).toEqual({ groupID: 'group:consumed' })
  })

  test('source reads back a commit-then-reject from its store', async () => {
    const hub = createTestHub()
    try {
      const inner = createMemoryKeyPackagePoolStore()
      await inner.put(hub.identity.id, record)
      const pool = createKeyPackagePool({
        sourceID: 'ordinary',
        identity: hub.identity,
        client: hub.client,
        store: {
          ...inner,
          async consume(ref, groupID) {
            await inner.consume(ref, groupID)
            const error = new Error('commit acknowledgement lost')
            error.name = 'StorageOutcomeUnknownError'
            throw error
          },
        },
      })
      await expect(pool.consume(record.ref, 'group:consumed')).resolves.toBeUndefined()
      expect(await inner.list(hub.identity.id)).toEqual([])
      expect(await pool.receipt(record.ref)).toEqual({ groupID: 'group:consumed' })
    } finally {
      await hub.dispose()
    }
  })

  test('receipted ref is alreadyJoined without decrypt', async () => {
    const hub = createTestHub()
    try {
      const store = createMemoryKeyPackagePoolStore()
      const pool = createKeyPackagePool({
        sourceID: 'ordinary',
        identity: hub.identity,
        client: hub.client,
        store,
        target: 1,
        lowWater: 1,
      })
      await pool.ensureStocked().value
      const [bundle] = await pool.bundles()
      if (bundle == null) throw new Error('Missing bundle')
      const ref = await mls.keyPackageRef(bundle.publicPackage)
      await pool.consume(ref, 'group:joined')
      const decrypt = vi.mocked(mls.processWelcome)
      decrypt.mockClear()
      const result = await openWelcome([pool], {
        identity: hub.identity,
        invite: {
          groupID: 'untrusted',
          inviterID: hub.identity.id,
          recipientDID: hub.identity.id,
          ledgerEntries: [],
        },
        welcome: {
          cipherSuite: 1,
          secrets: [
            {
              newMember: Uint8Array.from(Buffer.from(ref, 'base64')),
              encryptedGroupSecrets: { kemOutput: new Uint8Array(), ciphertext: new Uint8Array() },
            },
          ],
          encryptedGroupInfo: new Uint8Array(),
        },
      })
      expect(result).toEqual({ alreadyJoined: 'group:joined' })
      expect(decrypt).not.toHaveBeenCalled()
    } finally {
      await hub.dispose()
    }
  })

  test('last-resort consume keeps package', async () => {
    const hub = createTestHub()
    try {
      const store = createMemoryLastResortStore()
      const source = createLastResortProvisioner({
        sourceID: 'fallback',
        identity: hub.identity,
        client: hub.client,
        store,
      })
      const { ref } = await source.ensureProvisioned().value
      const before = await store.list(hub.identity.id)
      await source.consume(ref, 'group:joined')
      expect(await store.list(hub.identity.id)).toEqual(before)
      expect(await source.receipt(ref)).toBeNull()
      expect(await store.receipt(ref)).toBeNull()
      await store.consume(ref, 'group:direct')
      expect(await store.receipt(ref)).toBeNull()
      await source.consume(ref, 'group:another')
      expect(await store.list(hub.identity.id)).toEqual(before)
      expect(await source.receipt(ref)).toBeNull()
    } finally {
      await hub.dispose()
    }
  })
})

test('holder evidence is required before a package can be consumed', async () => {
  const { identity, bundle, welcome, invite } = await holderlessWelcome()
  const hub = createTestHub(identity)
  try {
    const store = createMemoryKeyPackagePoolStore()
    const ref = await mls.keyPackageRef(bundle.publicPackage)
    await store.put(identity.id, {
      kind: 'ordinary',
      ref,
      keyPackage: mls.encodeKeyPackage(bundle.publicPackage),
      privatePackage: mls.encodePrivateKeyPackage(bundle.privatePackage),
      notAfter: Number(bundle.publicPackage.leafNode.lifetime.notAfter),
    })
    const pool = createKeyPackagePool({ sourceID: 'ordinary', identity, client: hub.client, store })
    await expect(openWelcome([pool], { identity, welcome, invite })).rejects.toMatchObject({
      reason: 'missing-holder-evidence',
    })
    expect((await store.list(identity.id)).map((record) => record.ref)).toEqual([ref])
    expect(await pool.receipt(ref)).toBeNull()
  } finally {
    await hub.dispose()
  }
})
