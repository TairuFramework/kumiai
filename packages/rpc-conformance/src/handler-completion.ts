import { describe, expect, test } from 'vitest'

import type {
  ConformanceGroupKey,
  ConformanceGroupTransaction,
  ConformancePersistenceFixture,
  ConformanceStoragePendingAppFrame,
  HandlerConformanceParams,
  HandlerConformancePorts,
} from './persistence-fixture.js'

export type HandlerFixture<TTx extends ConformanceGroupTransaction> = ConformancePersistenceFixture<
  HandlerConformancePorts<TTx>
>

export function handlerRecord(
  key: ConformanceGroupKey,
  id: string,
  position = id,
  protocol = 'chat',
): ConformanceStoragePendingAppFrame {
  const frame = {
    ...key,
    id,
    position,
    protocol,
    procedure: 'posted',
    topicID: 'handler-topic',
    segment: 3,
  }
  return {
    frame,
    payload: new TextEncoder().encode(
      JSON.stringify({ payload: { typ: 'event', prc: 'posted', data: { id } } }),
    ),
    senderDID: 'did:key:conformance-sender',
    epoch: 3,
    idempotencyKey: JSON.stringify([
      'kumiai/frame/v1',
      key.groupID,
      key.incarnation,
      frame.topicID,
      position,
      protocol,
      frame.procedure,
    ]),
  }
}

export async function saveHandlerRecords<TTx extends ConformanceGroupTransaction>(
  fixture: HandlerFixture<TTx>,
  key: ConformanceGroupKey,
  records: Array<ConformanceStoragePendingAppFrame>,
): Promise<void> {
  await fixture.entry().run(
    { groupID: key.groupID, mutationID: crypto.randomUUID() },
    async (reads) => ({ expected: await reads.lifetime(), value: undefined }),
    async (stores) => {
      await stores.incarnation(key.incarnation).pending.put(records)
    },
  )
}

export function handlerPending<TTx extends ConformanceGroupTransaction>(
  fixture: HandlerFixture<TTx>,
  key: ConformanceGroupKey,
) {
  return fixture.entry().read(key.groupID, (reads) => reads.pendingFrames(key.incarnation))
}

export function handlerCursor<TTx extends ConformanceGroupTransaction>(
  fixture: HandlerFixture<TTx>,
  key: ConformanceGroupKey,
) {
  return fixture
    .entry()
    .read(key.groupID, (reads) => reads.appCursor(key.incarnation, 'handler-topic'))
}

export function testHandlerCompletionConformance<TTx extends ConformanceGroupTransaction>(
  params: HandlerConformanceParams<TTx>,
): void {
  describe(`${params.label} handler completion`, () => {
    test('completion removes only saved IDs without prefix proof', async () => {
      const key = { groupID: 'handler-completion', incarnation: 1 }
      const f = await params.createFixture(key.groupID)
      try {
        const a = handlerRecord(key, 'A', '10')
        const b = handlerRecord(key, 'B', '2')
        await saveHandlerRecords(f, key, [a, b])
        const before = await handlerPending(f, key)
        const unrelated = (await f.inspectRawBytes()).filter(
          (r) =>
            !(
              r.groupID === key.groupID &&
              (['group-owner', 'lifetime'].includes(r.namespace) ||
                (r.namespace === 'pending' && ['A', 'B'].includes(r.recordID)))
            ),
        )
        expect(await handlerCursor(f, key)).toBeNull()
        await f.ports.completion(key).complete(['B', 'B', 'missing'])
        expect(await handlerPending(f, key)).toEqual(before.filter((r) => r.frame.id !== 'B'))
        expect(await handlerCursor(f, key)).toBeNull()
        await f.ports.completion(key).complete(['A'])
        expect(await handlerPending(f, key)).toEqual(
          before.filter((r) => !['A', 'B'].includes(r.frame.id)),
        )
        expect(await handlerCursor(f, key)).toBeNull()
        expect(
          (await f.inspectRawBytes()).filter(
            (r) =>
              !(
                r.groupID === key.groupID &&
                (['group-owner', 'lifetime'].includes(r.namespace) ||
                  (r.namespace === 'pending' && ['A', 'B'].includes(r.recordID)))
              ),
          ),
        ).toEqual(unrelated)
        const reopened = await f.reopen()
        expect(await handlerPending(f, key)).toEqual(
          before.filter((r) => !['A', 'B'].includes(r.frame.id)),
        )
        expect(await handlerCursor(f, key)).toBeNull()
        const rows = await f.inspectRows()
        let hooks = 0
        f.onPhase('hook', () => {
          hooks++
        })
        await reopened.completion(key).complete(['A', 'B', 'missing'])
        let invoked = false
        await reopened.completion(key).transact(['A', 'B', 'missing'], async () => {
          invoked = true
        })
        expect(invoked).toBe(false)
        expect(hooks).toBe(0)
        expect(await f.inspectRows()).toEqual(rows)
      } finally {
        await f.close()
      }
    })

    for (const fault of ['before-commit', 'commit-then-reject'] as const) {
      test(`transactional effect and saved completion share ${fault} outcome`, async () => {
        const key = { groupID: `handler-${fault}`, incarnation: 1 }
        const f = await params.createFixture(key.groupID)
        try {
          const record = handlerRecord(key, 'effect', '10')
          await saveHandlerRecords(f, key, [record])
          const before = await handlerPending(f, key)
          let committed = 0
          let rolledBack = 0
          const effect = async (tx: TTx, records: Array<ConformanceStoragePendingAppFrame>) => {
            expect(records).toEqual([record])
            await params.writeSideRow(tx, 'handler-effect', record.payload)
            tx.onCommit(() => {
              committed++
            })
            tx.onRollback(() => {
              rolledBack++
            })
          }
          if (fault === 'before-commit') f.failNext(fault)
          else f.commitThenReject()
          const result = f.ports.completion(key).transact(['effect'], effect)
          if (fault === 'before-commit') {
            await expect(result).rejects.toThrow()
            expect(await handlerPending(f, key)).toEqual(before)
            expect(await f.inspectSideRow('handler-effect')).toBeNull()
            expect(committed).toBe(0)
            expect(rolledBack).toBe(1)
            await f.ports.completion(key).transact(['effect'], effect)
          } else await result
          expect(committed).toBe(1)
          expect(await f.inspectSideRow('handler-effect')).toEqual(record.payload)
          expect((await handlerPending(f, key)).some((r) => r.frame.id === 'effect')).toBe(false)
          expect(await handlerCursor(f, key)).toBeNull()
          const reopened = await f.reopen()
          let duplicate = false
          await reopened.completion(key).transact(['effect'], async () => {
            duplicate = true
          })
          expect(duplicate).toBe(false)
          expect(await f.inspectSideRow('handler-effect')).toEqual(record.payload)
        } finally {
          await f.close()
        }
      })
    }
  })
}
