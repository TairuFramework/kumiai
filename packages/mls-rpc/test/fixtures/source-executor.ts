import { randomIdentity } from '@kokuin/token'
import { vi } from 'vitest'

import { entryCapability } from '../../src/entry-capability.js'
import { createMemoryDevicePersistence } from '../../src/memory-device-persistence.js'
import { createMemoryTransaction } from '../../src/memory-transaction.js'
import type { OwnershipContextPort } from '../../src/persistence-types.js'
import { createSourceExecutor } from '../../src/registry/source-executor.js'
import { deferred } from '../../src/runtime.js'
import { createDeterministicAtRestCodec } from './at-rest.js'
import { installSeed, makeStorageSeed, nextChange } from './storage-seed.js'

// A real event-loop checkpoint drains ready continuations without resolving paused work.
export function flushReady(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

export async function sourceExecutorFixture(
  options: { ownershipContext?: OwnershipContextPort } = {},
) {
  const identity = randomIdentity()
  const codec = createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(41) })
  const original = createMemoryTransaction({ rows: {} })
  const warm = createMemoryDevicePersistence({
    db: original,
    atRest: codec,
    ownerDID: identity.id,
    providerID: 'source-executor',
  })
  const seed = await makeStorageSeed({
    id: crypto.randomUUID(),
    incarnation: 1,
    epoch: 2,
    mode: 'double',
    identity,
  })
  await installSeed(warm.groups, seed, 'source-seed')
  const db = createMemoryTransaction({ rows: original.snapshot() })
  const opens: Array<string> = []
  let unreadable: string | undefined
  let missingMetadata = false
  const atRest = {
    seal: codec.seal,
    async open(bytes: Uint8Array, aad: Uint8Array) {
      const address = JSON.parse(new TextDecoder().decode(aad)) as Array<unknown>
      const namespace = String(address[3])
      opens.push(namespace)
      if (
        (unreadable === 'state-version' &&
          namespace === 'meta' &&
          address[4] === JSON.stringify(['state-version'])) ||
        namespace === unreadable
      )
        throw new Error('Unreadable fixture metadata')
      const value = await codec.open(bytes, aad)
      return namespace === 'meta' &&
        address[4] === JSON.stringify(['state-version']) &&
        missingMetadata
        ? new TextEncoder().encode('null')
        : value
    },
  }
  const persistence = createMemoryDevicePersistence({
    db,
    atRest,
    ownerDID: identity.id,
    providerID: 'source-executor',
    ...options,
  })
  const entry = entryCapability(persistence.groups)
  if (entry === null) throw new Error('Missing registered entry')
  const lifecycle = {
    beforeUse: vi.fn(async () => {
      const device = await persistence.load()
      if (device.restoreWork !== null) throw new Error('Device is quarantined')
    }),
    assertCurrent: vi.fn(() => {}),
  }
  const environment = { identity, options: {} }
  const source = createSourceExecutor({
    persistence,
    entry,
    lifecycle,
    environment,
  })
  const transactions = vi.spyOn(db, 'transact')
  return {
    ...source,
    environment,
    seed,
    db,
    persistence,
    entry,
    lifecycle,
    opens,
    transactions,
    flushReady,
    reopenPersistence() {
      return createMemoryDevicePersistence({
        db: createMemoryTransaction({ rows: db.snapshot() }),
        atRest,
        ownerDID: identity.id,
        providerID: persistence.providerID,
        ...options,
      })
    },
    unreadable(namespace?: string) {
      unreadable = namespace
    },
    missingMetadata() {
      missingMetadata = true
    },
    pauseBarrier() {
      const entered = deferred<void>()
      const release = deferred<void>()
      const original = db.completionBarrier.bind(db)
      const spy = vi.spyOn(db, 'completionBarrier').mockImplementation(async (scope) => {
        if (scope.groupID === null) return await original(scope)
        entered.resolve()
        await release.promise
        await original(scope)
      })
      return {
        entered: entered.promise,
        release: () => release.resolve(),
        restore: () => spy.mockRestore(),
      }
    },
    async save(change: 'terminal' | 'restore' | 'progress' | 'replacement') {
      const mutationID = crypto.randomUUID()
      if (change === 'replacement') {
        const replacement = await makeStorageSeed({
          id: seed.key.groupID,
          incarnation: 2,
          epoch: 3,
          mode: 'double',
          identity,
        })
        replacement.trust.spentEpochAuthenticators.push(
          ...seed.trust.spentEpochAuthenticators.map((bytes) => bytes.slice()),
        )
        await installSeed(persistence.groups, replacement, mutationID)
        return
      }
      const request = await nextChange(persistence.groups, seed.key.groupID, mutationID)
      await persistence.groups.transition(request, async (stores) => {
        if (change === 'restore') {
          const lifetime = await stores.lifetime.load()
          if (lifetime === null) throw new Error('Missing lifetime')
          await stores.lifetime.save({
            ...lifetime,
            restorePending: true,
            revision: lifetime.revision + 1,
            mutationID,
          })
        } else {
          const state = await stores.incarnation(1).state.load()
          if (state === null || state.deleted) throw new Error('Missing source')
          await stores
            .incarnation(1)
            .state.save({ ...state, version: state.version + 1, terminal: change === 'terminal' })
        }
      })
    },
  }
}
