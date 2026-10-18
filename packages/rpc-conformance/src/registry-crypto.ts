import { describe, expect, test } from 'vitest'

import type {
  ConformanceOpenAppInput,
  ConformanceOpenAppResult,
  ConformanceStoragePendingAppFrame,
  RegistryCryptoFixture,
} from './persistence-fixture.js'

export type RegistryCryptoConformanceParams = {
  label: string
  createFixture(id: string): Promise<RegistryCryptoFixture>
}

const encode = (text: string) =>
  new TextEncoder().encode(
    JSON.stringify({ payload: { typ: 'event', prc: 'posted', data: { text } }, v: 2 }),
  )

function opened(
  results: Array<ConformanceOpenAppResult>,
): Array<ConformanceStoragePendingAppFrame> {
  return results.map((result) => {
    expect(result.kind).toBe('opened')
    if (result.kind !== 'opened') throw new Error('Expected an opened frame')
    return result.record
  })
}

export function testRegistryCryptoConformance(params: RegistryCryptoConformanceParams): void {
  const run = async (id: string, fn: (fixture: RegistryCryptoFixture) => Promise<void>) => {
    const fixture = await params.createFixture(id)
    try {
      await fn(fixture)
    } finally {
      await fixture.close()
    }
  }
  const input = async (
    fixture: RegistryCryptoFixture,
    position: string,
  ): Promise<ConformanceOpenAppInput> => {
    const ciphertext = await fixture.seal(encode(position))
    return { ciphertext, frame: fixture.frame(ciphertext, position) }
  }
  const batch = async (fixture: RegistryCryptoFixture) => {
    const inputs: Array<ConformanceOpenAppInput> = []
    for (const position of ['000000000001', '000000000002', '000000000003'])
      inputs.push(await input(fixture, position))
    return inputs
  }

  describe(`Registry crypto conformance — ${params.label}`, () => {
    test('pre-open reference carries no procedure; opened record derives it', () =>
      run('procedure', async (fixture) => {
        const frame = await input(fixture, '000000000001')
        expect(frame.frame).not.toHaveProperty('procedure')
        expect(frame.frame).not.toHaveProperty('idempotencyKey')
        const access = await fixture.access()
        const results = await access.openBatch([frame])
        const [record] = opened(results)
        expect(results[0]).toMatchObject({ handleEpoch: record?.epoch })
        expect(record).toEqual({
          frame: { ...frame.frame, procedure: 'posted' },
          payload: encode('000000000001'),
          senderDID: fixture.senderDID,
          epoch: expect.any(Number),
          idempotencyKey: JSON.stringify([
            'kumiai/frame/v1',
            fixture.key.groupID,
            fixture.key.incarnation,
            fixture.topicID,
            frame.frame.position,
            frame.frame.protocol,
            'posted',
          ]),
        })
        expect(await access.pending.list()).toEqual([record])
      }))

    test('open N, crash mid-batch commits all or none', () =>
      run('rollback', async (fixture) => {
        const inputs = await batch(fixture)
        const before = await fixture.inspectRows()
        const fault = fixture.armNextWorkFault('after-first-write')
        await expect((await fixture.access()).openBatch(inputs)).rejects.toThrow()
        await fault.mutationID
        const restarted = await fixture.reopen()
        try {
          expect(await restarted.inspectRows()).toEqual(before)
          const access = await restarted.access()
          expect(await access.pending.list()).toEqual([])
          expect(opened(await access.openBatch(inputs))).toHaveLength(3)
          expect(await access.pending.list()).toHaveLength(3)
        } finally {
          await restarted.close()
        }
      }))

    test('ambiguous commit resolves the whole batch once', () =>
      run('ambiguous', async (fixture) => {
        const inputs = await batch(fixture)
        const fault = fixture.armNextWorkFault('commit-then-reject')
        const records = opened(await (await fixture.access()).openBatch(inputs))
        expect(records).toHaveLength(3)
        const mutationID = await fault.mutationID
        const restarted = await fixture.reopen()
        try {
          expect(await restarted.resolve(mutationID)).toBe('committed')
          const before = await restarted.inspectRows()
          const access = await restarted.access()
          expect(opened(await access.openBatch(inputs))).toEqual(records)
          expect(await access.pending.list()).toEqual(records)
          expect(await restarted.inspectRows()).toEqual(before)
        } finally {
          await restarted.close()
        }
      }))

    test('replay resolves saved pending before reopening', () =>
      run('replay', async (fixture) => {
        const frame = await input(fixture, '000000000001')
        const initial = await (await fixture.access()).openBatch([frame])
        const records = opened(initial)
        const epoch = records[0]?.epoch
        if (epoch === undefined) throw new Error('Missing opened frame epoch')
        expect(initial[0]).toMatchObject({ handleEpoch: epoch })
        await fixture.advanceRegistry()
        const restarted = await fixture.reopen()
        try {
          const before = await restarted.inspectRows()
          const access = await restarted.access()
          const replay = await access.openBatch([frame])
          expect(opened(replay)).toEqual(records)
          expect(replay[0]).toMatchObject({ handleEpoch: epoch + 1, record: { epoch } })
          expect(await access.pending.list()).toEqual(records)
          expect(records[0]?.frame.incarnation).toBe(fixture.key.incarnation)
          expect(await restarted.inspectRows()).toEqual(before)
        } finally {
          await restarted.close()
        }
      }))

    test('completed frame refetch is refused without a key or row', () =>
      run('completed', async (fixture) => {
        const frame = await input(fixture, '000000000001')
        const access = await fixture.access()
        expect(opened(await access.openBatch([frame]))).toHaveLength(1)
        await access.pending.complete(frame.frame.id)
        const restarted = await fixture.reopen()
        try {
          const before = await restarted.inspectRows()
          const access = await restarted.access()
          expect(await access.openBatch([frame])).toEqual([
            {
              kind: 'refused',
              frame: frame.frame,
              reason: 'invalid-ciphertext',
              keyConsumed: false,
            },
          ])
          expect(await access.pending.list()).toEqual([])
          expect(await restarted.inspectRows()).toEqual(before)
        } finally {
          await restarted.close()
        }
      }))

    test('future and unopenable inputs leave pending empty', () =>
      run('future', async (fixture) => {
        const ciphertext = await fixture.sealAhead(encode('future'))
        const future = { ciphertext, frame: fixture.frame(ciphertext, '000000000002') }
        const junk = new Uint8Array([0xff])
        const access = await fixture.access()
        const before = await fixture.inspectRows()
        expect(
          await access.openBatch([
            { ciphertext: junk, frame: fixture.frame(junk, '000000000001') },
            future,
          ]),
        ).toMatchObject([
          { kind: 'refused', reason: 'invalid-ciphertext', keyConsumed: false },
          { kind: 'held', reason: 'future-epoch' },
        ])
        expect(await access.pending.list()).toEqual([])
        expect(await fixture.inspectRows()).toEqual(before)
        await fixture.advanceRegistry()
        const [record] = opened(await (await fixture.access()).openBatch([future]))
        expect(record).toMatchObject({ payload: encode('future'), senderDID: fixture.senderDID })
      }))

    test('frames open across an epoch transition, retained epoch included', () =>
      run('epochs', async (fixture) => {
        const old = await input(fixture, '000000000001')
        await fixture.advanceRegistry()
        const current = await input(fixture, '000000000002')
        const access = await fixture.access()
        const results = await access.openBatch([old, current])
        const records = opened(results)
        expect(records).toHaveLength(2)
        const epoch = records[0]?.epoch
        if (epoch === undefined) throw new Error('Missing retained frame epoch')
        expect(results).toMatchObject([
          { handleEpoch: epoch + 1, record: { epoch } },
          { handleEpoch: epoch + 1, record: { epoch: epoch + 1 } },
        ])
        expect(records.map((record) => record.payload)).toEqual([
          encode('000000000001'),
          encode('000000000002'),
        ])
        expect(await access.pending.list()).toEqual(records)
      }))

    test('pending order survives reopen', () =>
      run('order', async (fixture) => {
        const inputs: Array<ConformanceOpenAppInput> = []
        for (const [segment, position] of [
          [2, '000000000010'],
          [1, '000000000002'],
          [2, '000000000003'],
        ] as const) {
          const frame = await input(fixture, position)
          frame.frame.segment = segment
          inputs.push(frame)
        }
        const access = await fixture.access()
        const records = opened(await access.openBatch(inputs))
        const sorted = [records[1], records[2], records[0]]
        expect(await access.pending.list()).toEqual(sorted)
        const restarted = await fixture.reopen()
        try {
          expect(await (await restarted.access()).pending.list()).toEqual(sorted)
        } finally {
          await restarted.close()
        }
      }))

    test('duplicate and invalid positions write nothing', () =>
      run('positions', async (fixture) => {
        const valid = await input(fixture, '000000000001')
        const access = await fixture.access()
        expect(opened(await access.openBatch([valid]))).toHaveLength(1)
        const empty = await input(fixture, '')
        const long = await input(fixture, 'x'.repeat(65))
        const before = await fixture.inspectRows()
        expect(
          await access.openBatch([
            { ...valid, frame: { ...valid.frame, position: '000000000002' } },
            empty,
            long,
          ]),
        ).toMatchObject([
          { kind: 'refused', reason: 'duplicate', keyConsumed: false },
          { kind: 'refused', reason: 'invalid-position', keyConsumed: false },
          { kind: 'refused', reason: 'invalid-position', keyConsumed: false },
        ])
        expect(await fixture.inspectRows()).toEqual(before)
        expect(await access.pending.list()).toHaveLength(1)
        for (const [at, rejected] of [empty, long].entries()) {
          expect(
            opened(
              await access.openBatch([
                { ...rejected, frame: { ...rejected.frame, position: `00000000000${at + 3}` } },
              ]),
            ),
          ).toHaveLength(1)
        }
      }))
  })
}
