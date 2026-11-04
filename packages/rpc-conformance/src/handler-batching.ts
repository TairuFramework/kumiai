import { describe, expect, test } from 'vitest'

import {
  handlerCursor,
  handlerPending,
  handlerRecord,
  saveHandlerRecords,
} from './handler-completion.js'
import type {
  ConformanceGroupTransaction,
  HandlerConformanceParams,
} from './persistence-fixture.js'

export function testHandlerBatchingConformance<TTx extends ConformanceGroupTransaction>(
  params: HandlerConformanceParams<TTx>,
): void {
  describe(`${params.label} handler batching`, () => {
    test('one oversized completion call commits bounded saved prefixes', async () => {
      const key = { groupID: 'handler-burst', incarnation: 1 }
      const f = await params.createFixture(key.groupID)
      try {
        const records = Array.from({ length: 130 }, (_, i) =>
          handlerRecord(key, `burst-${String(i).padStart(3, '0')}`),
        )
        await saveHandlerRecords(f, key, records)
        const before = await handlerPending(f, key)
        let previous = (await f.inspectRows()).pending?.size ?? 0
        const sizes: Array<number> = []
        const observePrefix = async () => {
          const count = (await f.inspectRows()).pending?.size ?? 0
          if (count < previous) sizes.push(previous - count)
          previous = count
          f.onPhase('hook', observePrefix)
        }
        f.onPhase('hook', observePrefix)
        await f.ports.completion(key).complete(records.map((r) => r.frame.id))
        expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(130)
        expect(sizes.length).toBeGreaterThanOrEqual(3)
        expect(sizes.every((size) => size > 0 && size <= 64)).toBe(true)
        expect(await handlerPending(f, key)).toEqual(
          before.filter((r) => !r.frame.id.startsWith('burst-')),
        )
        expect(await handlerCursor(f, key)).toBeNull()
      } finally {
        await f.close()
      }
    })

    test('a failed completion suffix preserves committed prefixes for idempotent retry', async () => {
      const key = { groupID: 'handler-prefix-retry', incarnation: 1 }
      const f = await params.createFixture(key.groupID)
      try {
        const records = Array.from({ length: 130 }, (_, i) => handlerRecord(key, `retry-${i}`))
        await saveHandlerRecords(f, key, records)
        f.onPhase('hook', () => {
          f.failNext('before-commit')
        })
        const ids = records.map((r) => r.frame.id)
        await expect(f.ports.completion(key).complete(ids)).rejects.toThrow()
        const remaining = (await handlerPending(f, key)).filter((r) =>
          r.frame.id.startsWith('retry-'),
        )
        expect(remaining.length).toBeGreaterThan(0)
        expect(remaining.length).toBeLessThan(130)
        await f.ports.completion(key).complete(ids)
        expect(
          (await handlerPending(f, key)).filter((r) => r.frame.id.startsWith('retry-')),
        ).toEqual([])
        expect(await handlerCursor(f, key)).toBeNull()
      } finally {
        await f.close()
      }
    })

    test('an oversized atomic callback refuses before effects', async () => {
      const key = { groupID: 'handler-atomic', incarnation: 1 }
      const f = await params.createFixture(key.groupID)
      try {
        const records = Array.from({ length: 130 }, (_, i) => handlerRecord(key, `atomic-${i}`))
        await saveHandlerRecords(f, key, records)
        const before = await f.inspectRows()
        let called = false
        await expect(
          f.ports.completion(key).transact(
            records.map((r) => r.frame.id),
            async (tx) => {
              called = true
              await params.writeSideRow(tx, 'oversized-effect', new Uint8Array([1]))
            },
          ),
        ).rejects.toBeInstanceOf(RangeError)
        expect(called).toBe(false)
        expect(await f.inspectRows()).toEqual(before)
        expect(await f.inspectSideRow('oversized-effect')).toBeNull()
      } finally {
        await f.close()
      }
    })

    test('separate transactional A and B calls isolate failure and retry', async () => {
      const key = { groupID: 'handler-isolation', incarnation: 1 }
      const f = await params.createFixture(key.groupID)
      try {
        const a = handlerRecord(key, 'A', '10', 'A')
        const b = handlerRecord(key, 'B', '2', 'B')
        await saveHandlerRecords(f, key, [a, b])
        const completion = f.ports.completion(key)
        for (let attempt = 0; attempt < 2; attempt++) {
          const outcomes = await Promise.allSettled([
            completion.transact(['A'], async (tx, records) => {
              expect(records).toEqual([a])
              await params.writeSideRow(tx, 'A', a.payload)
              throw new Error('A effect refused')
            }),
            completion.transact(['B'], async (tx, records) => {
              expect(records).toEqual([b])
              await params.writeSideRow(tx, 'B', b.payload)
            }),
          ])
          expect(outcomes.map((r) => r.status)).toEqual(['rejected', 'fulfilled'])
          expect(await f.inspectSideRow('A')).toBeNull()
          expect(await f.inspectSideRow('B')).toEqual(b.payload)
          expect(
            (await handlerPending(f, key)).filter((r) => ['A', 'B'].includes(r.frame.id)),
          ).toEqual([a])
        }
        await f.reopen()
        expect(
          (await handlerPending(f, key)).filter((r) => ['A', 'B'].includes(r.frame.id)),
        ).toEqual([a])
        expect(await handlerCursor(f, key)).toBeNull()
      } finally {
        await f.close()
      }
    })
  })
}
