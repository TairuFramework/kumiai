import { describe, expect, test } from 'vitest'

import {
  legacyMigrationFixture,
  legacyMigrationOperation,
  legacyMigrationSlot,
  type MigrationResult,
  testLegacyControlMapping,
} from '../../rpc-conformance/src/control-migration.js'
import { testControlMigrationActivation } from '../../rpc-conformance/src/control-migration-activation.js'
import { createMemoryControlStore } from '../../rpc-conformance/src/memory-control-store.js'
import { createMemoryMigrationBackend } from '../../rpc-conformance/src/memory-migration-backend.js'
import { closeControlBuild } from '../src/control/closure.js'
import type { LegacyControlSnapshot } from '../src/control/legacy-input.js'
import { migrateLegacyControl } from '../src/control/legacy-migration.js'
import { enqueueOperation } from '../src/control/operations.js'
import { asLogPosition, type LogPosition } from '../src/cursor.js'
import { createMemoryHostDatabase } from './fixtures/host-db.js'

test.each(['store', 'database'] as const)(
  'migrated epoch-only marker permits unrelated enqueue (%s)',
  async (kind) => {
    const input = legacyMigrationFixture()
    input.snapshot.spentSource = { epoch: 4 }
    const control =
      kind === 'store'
        ? createMemoryControlStore<LogPosition>(input.source.key, { legacy: input })
        : createMemoryHostDatabase({ legacy: input }).control(
            input.source.key.groupID,
            input.source.key,
          )
    const op = await enqueueOperation(
      { control, now: () => 100, newID: () => crypto.randomUUID() },
      {
        id: 'unrelated',
        kind: 'ledger',
        revokes: false,
        body: new Uint8Array(),
      },
    )
    expect((await control.load()).operations).toEqual([op])
    expect((await control.load()).spentSource).toEqual({ epoch: 4 })
  },
)

testLegacyControlMapping({
  map: (input) =>
    migrateLegacyControl({
      ...input,
      snapshot: input.snapshot as unknown as LegacyControlSnapshot,
      at: 100,
      outcomeID: () => crypto.randomUUID(),
    }) as unknown as MigrationResult,
})

test('later landed closure preserves the independently promoted Welcome without rewriting its bytes', () => {
  const input = legacyMigrationFixture()
  input.snapshot.operations = [legacyMigrationOperation()]
  input.snapshot.commitOnce = legacyMigrationSlot()
  input.snapshot.welcomes = [
    { opID: 'op', welcome: new Uint8Array([7, 255]), recipients: ['original'] },
  ]
  const migrated = migrateLegacyControl({
    ...input,
    snapshot: input.snapshot as unknown as LegacyControlSnapshot,
    at: 100,
    outcomeID: () => 'fresh',
  })
  const changes = closeControlBuild(
    migrated,
    { kind: 'landed', position: asLogPosition('006') },
    101,
    'final',
  )
  expect(changes.putWelcomes).toBeUndefined()
  expect(migrated.welcomes).toEqual([
    { opID: 'op', welcome: new Uint8Array([7, 255]), recipients: ['original'] },
  ])
})

test('reading an unrelated group before migration cannot move the legacy snapshot to that group', async () => {
  const input = legacyMigrationFixture()
  input.snapshot.commitOnce = legacyMigrationSlot()
  input.snapshot.operations = [legacyMigrationOperation()]
  const backend = createMemoryMigrationBackend(input)
  const db = createMemoryHostDatabase({ migration: backend })
  expect(await db.loadState('other-group')).toBeNull()
  expect(
    (await db.control('other-group', { groupID: 'other-group', incarnation: 1 }).load()).commitOnce,
  ).toBeNull()
  expect(
    (await db.control(input.source.key.groupID, input.source.key).load()).commitOnce?.opID,
  ).toBe('op')
})

test('the single-incarnation memory store refuses a migration source for another incarnation', () => {
  const input = legacyMigrationFixture()
  expect(() =>
    createMemoryControlStore({ ...input.source.key, incarnation: 2 }, { legacy: input }),
  ).toThrow()
  expect(() =>
    createMemoryControlStore(
      { ...input.source.key, incarnation: 2 },
      { migration: createMemoryMigrationBackend(input) },
    ),
  ).toThrow()
})

describe('independent memory store migration', () => {
  testLegacyControlMapping({
    map: async (input) =>
      (await createMemoryControlStore(input.source.key, {
        legacy: input,
      }).load()) as unknown as MigrationResult,
  })
  testControlMigrationActivation(async (input) => {
    const backend = createMemoryMigrationBackend(input)
    let store = createMemoryControlStore(input.source.key, { migration: backend })
    return {
      ...backend,
      reopen() {
        backend.reopen()
        store = createMemoryControlStore(input.source.key, { migration: backend })
      },
      async read(path, ready) {
        if (path === 'state') {
          await store.loadState()
          ready?.()
        }
        const result = await store.load()
        ready?.()
        return result as unknown as MigrationResult
      },
    }
  })
})

describe('peer database migration', () => {
  testLegacyControlMapping({
    map: async (input) => {
      const db = createMemoryHostDatabase({ legacy: input })
      return (await db
        .control(input.source.key.groupID, input.source.key)
        .load()) as unknown as MigrationResult
    },
  })
  testControlMigrationActivation(async (input) => {
    const backend = createMemoryMigrationBackend(input)
    let db = createMemoryHostDatabase({ migration: backend })
    return {
      ...backend,
      reopen() {
        backend.reopen()
        db = createMemoryHostDatabase({ migration: backend })
      },
      async read(path, ready) {
        if (path === 'state') {
          await db.loadState(input.source.key.groupID)
          ready?.()
        }
        const result = await db.control(input.source.key.groupID, input.source.key).load()
        ready?.()
        return result as unknown as MigrationResult
      },
    }
  })
})
