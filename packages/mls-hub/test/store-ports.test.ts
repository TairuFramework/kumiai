import { randomIdentity } from '@kokuin/token'
import {
  createLastResortKeyPackageBundle,
  encodeKeyPackage,
  encodePrivateKeyPackage,
} from '@kumiai/mls'
import { describe, expect, test } from 'vitest'

import { createKeyPackagePool } from '../src/pool.js'
import { createMemoryKeyPackagePoolStore, type KeyPackagePoolStore } from '../src/pool-store.js'
import { createLastResortProvisioner } from '../src/provisioner.js'
import { createMemoryLastResortStore, type LastResortStore } from '../src/store.js'

const identity = randomIdentity()

/**
 * Both ports carry secret key material under different lifecycles — an ordinary package is
 * single-use, a last-resort package is reused until it rotates. Wiring one store to both mixes
 * them, and the type system is the only thing between a host and that mistake: the records are
 * structurally near-identical, so without a discriminant `LastResortStore` is assignable to
 * `KeyPackagePoolStore` and the wrong half of the wiring draws no diagnostic.
 *
 * Neither function below is invoked: the assertion IS the compile error, checked by `test:types`.
 */
describe('the two storage ports are not interchangeable', () => {
  test('a LastResortStore is refused where a pool store is wanted', () => {
    const lastResort: LastResortStore = createMemoryLastResortStore()
    const wire = (): void => {
      createKeyPackagePool({
        identity,
        client: {} as never,
        // @ts-expect-error a LastResortStore is not a KeyPackagePoolStore: the records differ in kind
        store: lastResort,
      })
    }
    expect(wire).toBeTypeOf('function')
  })

  test('a KeyPackagePoolStore is refused where a last-resort store is wanted', () => {
    const pool: KeyPackagePoolStore = createMemoryKeyPackagePoolStore()
    const wire = (): void => {
      createLastResortProvisioner({
        identity,
        client: {} as never,
        // @ts-expect-error a KeyPackagePoolStore is not a LastResortStore: the records differ in kind
        store: pool,
      })
    }
    expect(wire).toBeTypeOf('function')
  })
})

/**
 * The type check above is the whole defence only for a TypeScript host that never widens. A
 * JavaScript host, or a store adapter that persists its own columns and forgets to write `kind`
 * back, reaches these paths with a foreign record and no compiler in the way. Refusing loudly is
 * the same ruling `toBundles` already makes for a record that does not round-trip: a store that
 * breaks its contract is not quietly narrowed to "you appear to have fewer packages".
 */
describe('a foreign record is refused at the store boundary', () => {
  /**
   * A record that round-trips perfectly and is wrong only in its `kind` — so the guard under test
   * is the only thing that can reject it. A record built from placeholder strings would be thrown
   * out by `toBundles`' decode check instead, and the test would pass without the guard existing.
   */
  async function foreignRecord(kind: string, ref: string) {
    const bundle = await createLastResortKeyPackageBundle(identity)
    return {
      kind,
      ref,
      keyPackage: encodeKeyPackage(bundle.publicPackage),
      privatePackage: encodePrivateKeyPackage(bundle.privatePackage),
      notAfter: Math.floor(Date.now() / 1000) + 86_400,
      uploadedAt: null,
    } as never
  }

  /** Answers the two status shapes either caller reads, so no hub failure can confound the check. */
  const client = {
    keyPackageStatus: async () => ({ count: 100, lastResort: null }),
    uploadKeyPackages: async () => undefined,
    uploadLastResortKeyPackage: async () => undefined,
  } as never

  test('the provisioner refuses an ordinary record', async () => {
    const store = createMemoryLastResortStore()
    await store.put(identity.id, await foreignRecord('ordinary', 'from-the-pool'))
    const provisioner = createLastResortProvisioner({ identity, client, store })

    await expect(provisioner.ensureProvisioned()).rejects.toThrow(
      /from-the-pool.*last-resort.*ordinary/,
    )
  })

  test('the pool refuses a last-resort record', async () => {
    const store = createMemoryKeyPackagePoolStore()
    await store.put(identity.id, await foreignRecord('last-resort', 'from-the-slot'))
    const pool = createKeyPackagePool({ identity, client, store })

    await expect(pool.ensureStocked()).rejects.toThrow(/from-the-slot.*ordinary.*last-resort/)
  })

  test('bundles() refuses one too, so a join cannot read across the ports', async () => {
    const store = createMemoryKeyPackagePoolStore()
    await store.put(identity.id, await foreignRecord('last-resort', 'from-the-slot'))
    const pool = createKeyPackagePool({ identity, client, store })

    await expect(pool.bundles()).rejects.toThrow(/from-the-slot.*ordinary.*last-resort/)
  })
})
