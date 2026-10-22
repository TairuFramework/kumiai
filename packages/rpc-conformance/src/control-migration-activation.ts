import { describe, expect, test } from 'vitest'

import {
  legacyMigrationFixture,
  legacyMigrationOperation,
  legacyMigrationSlot,
  type MigrationFixture,
  type MigrationResult,
} from './control-migration.js'

export type MigrationPending = {
  rejected: Promise<void>
  barrierWaiting: Promise<void>
  finish(outcome: 'commit' | 'rollback'): Promise<void>
}
export type MigrationActivationHost = {
  read(path?: 'cold' | 'start' | 'retired' | 'state', ready?: () => void): Promise<MigrationResult>
  bytes(): unknown
  reopen(): void
  beforeCommit(point?: 'after-first-write'): void
  afterCommit(): void
  ambiguous(): MigrationPending
  pause(): { started: Promise<void>; release(): void }
  journal(): Promise<unknown>
}

export function testControlMigrationActivation(
  open: (input: MigrationFixture) => Promise<MigrationActivationHost>,
) {
  describe('pre-worker migration activation contract', () => {
    test.each(['retired', 'retired-deleted', 'terminal', 'reconciled'])(
      '%s ahead work closes before state access and owed delivery',
      async (mode) => {
        const input = legacyMigrationFixture()
        const slot = legacyMigrationSlot()
        input.source.epoch = 3
        input.source.retired = mode.startsWith('retired')
        input.source.terminal = mode === 'terminal'
        if (mode === 'retired-deleted') input.source.deleted = true
        input.snapshot.commitOnce = slot
        input.snapshot.operations = [
          {
            ...legacyMigrationOperation('accepted'),
            ...(mode === 'reconciled' ? { reconciliation: { slot } } : {}),
          },
        ]
        input.snapshot.welcomes = [
          { opID: 'op', welcome: new Uint8Array([255]), recipients: ['did:b'], committed: false },
        ]
        const host = await open(input)
        let ran = false
        const result = await host.read('state', () => {
          ran = true
        })
        expect(ran).toBe(true)
        expect(result.schemaVersion).toBe(1)
        expect(result.commitOnce).toBeNull()
        expect(result.spentSource).toBeNull()
        expect(result.operations).toEqual([])
        expect(result.outcomes[1]).toMatchObject({ opID: 'op', kind: 'unknown' })
        expect(result.welcomes).toEqual([
          { opID: 'op', welcome: new Uint8Array([255]), recipients: ['did:b'] },
        ])
        const once = host.bytes()
        host.reopen()
        expect(await host.read('state')).toEqual(result)
        expect(host.bytes()).toEqual(once)
      },
    )
    test('live ahead work refuses activation before workers and leaves storage unchanged', async () => {
      const input = legacyMigrationFixture()
      input.source.epoch = 3
      input.snapshot.commitOnce = legacyMigrationSlot()
      input.snapshot.operations = [legacyMigrationOperation('accepted')]
      const host = await open(input)
      const before = host.bytes()
      let ran = false
      const ready = () => {
        ran = true
      }
      await expect(host.read('state', ready)).rejects.toThrow('ahead of source')
      expect(ran).toBe(false)
      expect(host.bytes()).toEqual(before)
      host.reopen()
      await expect(host.read('cold', ready)).rejects.toThrow('ahead of source')
      expect(ran).toBe(false)
      expect(host.bytes()).toEqual(before)
    })
    test.each(['built', 'accepted'])(
      'an active deleted source refuses migration of %s work without writing a marker',
      async (stage) => {
        const input = legacyMigrationFixture()
        input.source.deleted = true
        input.snapshot.operations = [legacyMigrationOperation(stage)]
        input.snapshot.commitOnce = legacyMigrationSlot()
        const host = await open(input)
        const before = host.bytes()
        await expect(host.read()).rejects.toThrow('source state')
        expect(host.bytes()).toEqual(before)
        host.reopen()
        await expect(host.read('state')).rejects.toThrow('source state')
        expect(host.bytes()).toEqual(before)
      },
    )
    test.each([undefined, 'after-first-write'] as const)(
      'fault %s rolls back every logical write and reopen migrates once',
      async (point) => {
        const input = legacyMigrationFixture()
        input.snapshot.commitOnce = legacyMigrationSlot()
        input.snapshot.operations = [legacyMigrationOperation()]
        input.mainJournal = {
          publishID: 'main',
          epoch: 4,
          expectedHead: null,
          holdsLogSends: true,
          kind: 'remove',
          bodies: [],
          journal: new Uint8Array([1, 255]),
          commit: new Uint8Array([8]),
        }
        const host = await open(input)
        const before = host.bytes()
        host.beforeCommit(point)
        await expect(host.read()).rejects.toThrow()
        expect(host.bytes()).toEqual(before)
        host.reopen()
        const result = await host.read()
        expect(result.schemaVersion).toBe(1)
        expect(await host.journal()).toBeNull()
        const once = host.bytes()
        host.reopen()
        expect(await host.read()).toEqual(result)
        expect(host.bytes()).toEqual(once)
      },
    )

    test('after-commit rejection resolves before worker activation and preserves the host report once', async () => {
      const input = legacyMigrationFixture()
      input.mainJournal = {
        publishID: 'main',
        epoch: 4,
        expectedHead: null,
        holdsLogSends: true,
        acceptedAs: '006',
        kind: 'ledger',
        bodies: ['\u0000token.令牌'],
        journal: new Uint8Array([0, 255, 42]),
        commit: new Uint8Array([8]),
      }
      const host = await open(input)
      host.afterCommit()
      const result = await host.read()
      expect(result.outcomes[1]).toMatchObject({
        kind: 'unknown',
        lostCommit: {
          kind: 'ledger',
          tokens: ['\u0000token.令牌'],
          journal: new Uint8Array([0, 255, 42]),
        },
      })
      expect(await host.journal()).toBeNull()
      const once = host.bytes()
      host.reopen()
      expect(await host.read()).toEqual(result)
      expect(host.bytes()).toEqual(once)
    })

    test.each(['commit', 'rollback'] as const)(
      'reconstructed factory waits for unfinished backend %s before workers',
      async (outcome) => {
        const input = legacyMigrationFixture()
        input.snapshot.operations = [legacyMigrationOperation()]
        input.snapshot.commitOnce = legacyMigrationSlot()
        const host = await open(input)
        const before = host.bytes()
        const fault = host.ambiguous()
        const original = host.read()
        await fault.rejected
        host.reopen()
        let ran = false
        const restarted = host.read('cold', () => {
          ran = true
        })
        try {
          await fault.barrierWaiting
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 10)
          })
          expect(ran).toBe(false)
          expect(host.bytes()).toEqual(before)
        } finally {
          await fault.finish(outcome)
        }
        const [first, second] = await Promise.all([original, restarted])
        expect(second).toEqual(first)
        const once = host.bytes()
        host.reopen()
        await host.read()
        expect(host.bytes()).toEqual(once)
      },
    )

    for (const path of ['cold', 'start', 'retired', 'state'] as const) {
      test(`${path} callback cannot run before the migration transaction completes`, async () => {
        const input = legacyMigrationFixture()
        input.source.retired = path === 'retired'
        input.snapshot.welcomes = [
          { opID: 'owed', welcome: new Uint8Array([255]), recipients: ['did:a'], committed: false },
        ]
        const host = await open(input)
        const pause = host.pause()
        let ran = false
        const worker = host.read(path, () => {
          ran = true
        })
        try {
          const first = await Promise.race([
            pause.started.then(() => 'migration'),
            worker.then(() => 'worker'),
          ])
          expect(first).toBe('migration')
          expect(ran).toBe(false)
        } finally {
          pause.release()
        }
        const result = await worker
        expect(result.schemaVersion).toBe(1)
        expect(result.welcomes).toEqual([
          { opID: 'owed', welcome: new Uint8Array([255]), recipients: ['did:a'] },
        ])
      })

      test.each(['commit', 'rollback'] as const)(
        `${path} ambiguous %s reopens before workers`,
        async (outcome) => {
          const input = legacyMigrationFixture()
          input.source.retired = path === 'retired'
          input.snapshot.commitOnce = legacyMigrationSlot()
          input.snapshot.operations = [legacyMigrationOperation()]
          const host = await open(input)
          const before = host.bytes()
          const fault = host.ambiguous()
          let ran = false
          const worker = host.read(path, () => {
            ran = true
          })
          await fault.rejected
          try {
            await fault.barrierWaiting
            expect(ran).toBe(false)
            expect(host.bytes()).toEqual(before)
          } finally {
            await fault.finish(outcome)
          }
          expect((await worker).schemaVersion).toBe(1)
          const once = host.bytes()
          host.reopen()
          expect((await host.read(path)).schemaVersion).toBe(1)
          expect(host.bytes()).toEqual(once)
        },
      )
    }
  })
}
