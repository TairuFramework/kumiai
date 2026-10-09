import { describe, expect, test } from 'vitest'

export type ConformanceAppOutboxEntry = {
  seq: number
  protocol: string
  prc: string
  data: Uint8Array
  lastAttempt: { epoch: number; floor: string | null; attempts: number } | null
}

export type ConformanceAppOutbox = {
  put(entry: ConformanceAppOutboxEntry): Promise<void>
  list(): Promise<Array<ConformanceAppOutboxEntry>>
  remove(seq: number): Promise<void>
  clear(): Promise<void>
}

export type AppOutboxConformanceParams = {
  label: string
  createOutbox(): ConformanceAppOutbox & { failNextPut(): void }
}

export function testAppOutboxConformance(params: AppOutboxConformanceParams): void {
  describe(`AppOutbox conformance — ${params.label}`, () => {
    test('put is durable on resolution, replaces by sequence and lists ascending', async () => {
      const outbox = params.createOutbox()
      const entry: ConformanceAppOutboxEntry = {
        seq: 9,
        protocol: 'chat',
        prc: 'chat/posted',
        data: new Uint8Array([1, 2]),
        lastAttempt: null,
      }
      await outbox.put(entry)
      expect(await outbox.list()).toEqual([entry])
      const earlier = { ...entry, seq: 2, lastAttempt: { epoch: 3, floor: null, attempts: 1 } }
      await outbox.put(earlier)
      const replacement = { ...entry, lastAttempt: { epoch: 4, floor: 'head', attempts: 2 } }
      await outbox.put(replacement)
      expect(await outbox.list()).toEqual([earlier, replacement])
    })

    test('remove is durable and unknown sequences are harmless; clear is durable', async () => {
      const outbox = params.createOutbox()
      await outbox.put({
        seq: 0,
        protocol: 'chat',
        prc: 'chat/posted',
        data: new Uint8Array([3]),
        lastAttempt: null,
      })
      await outbox.remove(99)
      expect(await outbox.list()).toHaveLength(1)
      await outbox.remove(0)
      expect(await outbox.list()).toEqual([])
      await outbox.put({
        seq: 1,
        protocol: 'chat',
        prc: 'chat/posted',
        data: new Uint8Array([4]),
        lastAttempt: null,
      })
      await outbox.clear()
      expect(await outbox.list()).toEqual([])
    })
    test('a rejected atomic put leaves no new row and preserves an existing row', async () => {
      const outbox = params.createOutbox()
      const entry: ConformanceAppOutboxEntry = {
        seq: 1,
        protocol: 'chat',
        prc: 'chat/posted',
        data: new Uint8Array([5]),
        lastAttempt: null,
      }
      outbox.failNextPut()
      await expect(outbox.put(entry)).rejects.toThrow()
      expect(await outbox.list()).toEqual([])
      await outbox.put(entry)
      outbox.failNextPut()
      await expect(outbox.put({ ...entry, data: new Uint8Array([6]) })).rejects.toThrow()
      expect(await outbox.list()).toEqual([entry])
    })
  })
}
