import { describe, expect, test } from 'vitest'

import type { ConformanceAppOutbox, ConformanceAppOutboxEntry } from './app-outbox.js'
import type { ConformanceEpochIdentity, ConformanceGroupKey } from './persistence-fixture.js'

export type ConformanceAppPublicationSnapshot = {
  identity: ConformanceEpochIdentity
  stateVersion: number
  sealVersion: number
  segment: number
  topicID: string
}
export type ConformancePreparedAppPublication = {
  entry: ConformanceAppOutboxEntry
  payload: Uint8Array
  snapshot: ConformanceAppPublicationSnapshot
}
export type ConformanceAppPublicationPort = {
  prepare(
    entry: ConformanceAppOutboxEntry,
    floor: string | null,
  ): Promise<ConformancePreparedAppPublication>
  snapshot(protocol: string): Promise<ConformanceAppPublicationSnapshot | null>
}
export type AppPublicationFixture = {
  key: ConformanceGroupKey
  publication: ConformanceAppPublicationPort
  outbox: ConformanceAppOutbox
  state(): Promise<{
    snapshot: ConformanceAppPublicationSnapshot | null
    senderHWM: number
    storedGeneration: number
    stateBytes: Uint8Array
  }>
  rows(): Promise<Array<{ namespace: string; key: string; value: Uint8Array }>>
  gateNext(stage: 'prepare' | 'before-commit' | 'after-commit' | 'proof'): {
    entered: Promise<void>
    release(): void
  }
  failNext(
    stage: 'seal' | 'attempt' | 'certification' | 'remove' | 'effect',
    outcome: 'rollback' | 'unknown-commit' | 'unknown-rollback',
  ): void
  change(kind: 'version' | 'attempt' | 'epoch' | 'incarnation' | 'anchor'): Promise<void>
  counts(): { seals: number; transactions: number; publishes: number; effects: number }
  reopenFrozen(
    hold:
      | 'fork-halted'
      | 'recovery-unavailable'
      | 'spent-set-corrupt'
      | 'legacy-control'
      | 'revoke'
      | 'rotation-required'
      | 'terminal'
      | 'retired',
  ): Promise<{
    outbox: ConformanceAppOutbox
    finalise(): Promise<void>
    rows(): Promise<Array<{ namespace: string; key: string; value: Uint8Array }>>
    counts(): { seals: number; transactions: number; publishes: number; effects: number }
    close(): Promise<void>
  }>
  reopen(): Promise<AppPublicationFixture>
  close(): Promise<void>
}
const entry = (seq = 0): ConformanceAppOutboxEntry => ({
  seq,
  protocol: 'chat',
  prc: 'posted',
  data: new TextEncoder().encode('{"v":2,"payload":{"typ":"event","prc":"posted","data":{}}}'),
  status: 'accepted',
  lastAttempt: null,
})

export function testAppPublicationConformance(params: {
  label: string
  createFixture(): Promise<AppPublicationFixture>
}): void {
  describe(`App publication conformance — ${params.label}`, () => {
    test.each(['version', 'attempt', 'epoch', 'incarnation'] as const)(
      'acquired certification refuses moved expectations without writes (%s)',
      async (kind) => {
        const f = await params.createFixture()
        try {
          await f.outbox.put(entry())
          const frame = await f.publication.prepare(entry(), null)
          const attempt = frame.entry.lastAttempt
          if (attempt === null) throw new Error('Missing attempt')
          const expected = {
            identity: frame.snapshot.identity,
            stateVersion: frame.snapshot.stateVersion,
            attemptID: attempt.publishID,
          }
          const obligation = {
            sequenceID: 'application-ack',
            attemptID: attempt.publishID,
            topicID: attempt.topicID,
            outcome: 'published' as const,
          }
          await f.change(kind)
          if (kind === 'attempt') {
            const current = (await f.state()).snapshot
            if (current === null) throw new Error('Missing current snapshot')
            expected.stateVersion = current.stateVersion
          }
          const before = await f.rows()
          const counts = f.counts()
          expect(await f.outbox.recordSettlement(0, obligation, expected)).toEqual({
            recorded: false,
            reason:
              kind === 'version'
                ? 'state-version-changed'
                : kind === 'attempt'
                  ? 'attempt-changed'
                  : 'identity-changed',
          })
          expect(await f.rows()).toEqual(before)
          expect(f.counts().effects).toBe(counts.effects)
          expect(await f.outbox.loadSettlement(0)).toBeNull()
        } finally {
          await f.close()
        }
      },
    )
    test.each([
      'fork-halted',
      'recovery-unavailable',
      'spent-set-corrupt',
      'legacy-control',
      'revoke',
      'rotation-required',
      'terminal',
      'retired',
    ] as const)(
      'held reconstruction finalises only persisted publication obligations (%s)',
      async (hold) => {
        const f = await params.createFixture()
        let frozen: Awaited<ReturnType<AppPublicationFixture['reopenFrozen']>> | undefined
        try {
          await f.outbox.put(entry())
          await f.outbox.put(entry(1))
          const prepared = await f.publication.prepare(entry(), null)
          const attempt = prepared.entry.lastAttempt
          if (attempt === null) throw new Error('Missing original attempt')
          const occurrence = {
            incarnation: attempt.incarnation,
            segment: attempt.segment,
            topicID: attempt.topicID,
            position: 'original-position',
          }
          expect(
            await f.outbox.recordSettlement(
              0,
              {
                sequenceID: occurrence.position,
                attemptID: attempt.publishID,
                topicID: attempt.topicID,
                outcome: 'published',
              },
              {
                identity: prepared.snapshot.identity,
                stateVersion: prepared.snapshot.stateVersion,
                attemptID: attempt.publishID,
              },
            ),
          ).toEqual({ recorded: true })
          f.failNext('effect', 'rollback')
          await expect(f.outbox.remove(0, occurrence)).rejects.toThrow()
          expect(await f.outbox.loadSettlement(0)).not.toBeNull()
          frozen = await f.reopenFrozen(hold)
          const before = await frozen.rows()
          await frozen.finalise()
          await frozen.finalise()
          const after = await frozen.rows()
          expect(
            after.filter((row) => ['state', 'trust', 'anchor'].includes(row.namespace)),
          ).toEqual(before.filter((row) => ['state', 'trust', 'anchor'].includes(row.namespace)))
          const published = (await frozen.outbox.events()).filter(
            (event) => event.kind === 'published',
          )
          expect(published).toHaveLength(1)
          expect(published[0]).toMatchObject({ ...f.key, entry: prepared.entry, occurrence })
          expect(await frozen.outbox.loadSettlement(0)).toBeNull()
          if (hold !== 'retired')
            expect((await frozen.outbox.list()).map((row) => row.seq)).toEqual([1])
          expect(frozen.counts()).toMatchObject({
            seals: 0,
            publishes: 0,
            transactions: 0,
            effects: 1,
          })
        } finally {
          await (frozen ?? f).close()
        }
      },
    )
    test('duplicate settlement is idempotent and conflicting position rejects', async () => {
      const f = await params.createFixture()
      try {
        await f.outbox.put(entry())
        const frame = await f.publication.prepare(entry(), null)
        const attempt = frame.entry.lastAttempt
        if (attempt === null) throw new Error('Missing attempt')
        const expected = {
          identity: frame.snapshot.identity,
          stateVersion: frame.snapshot.stateVersion,
          attemptID: attempt.publishID,
        }
        const obligation = {
          sequenceID: 'application-ack',
          attemptID: attempt.publishID,
          topicID: attempt.topicID,
          outcome: 'published' as const,
        }
        expect(await f.outbox.recordSettlement(0, obligation, expected)).toEqual({ recorded: true })
        const before = await f.rows()
        expect(await f.outbox.recordSettlement(0, obligation, expected)).toEqual({ recorded: true })
        await expect(
          f.outbox.recordSettlement(0, { ...obligation, sequenceID: 'conflict' }, expected),
        ).rejects.toThrow()
        expect(await f.rows()).toEqual(before)
      } finally {
        await f.close()
      }
    })
    test('a committed range is reused without a per-message lease burn', async () => {
      let f = await params.createFixture()
      try {
        const before = await f.state()
        const frames = []
        for (let seq = 0; seq < 5; seq++) {
          const row = entry(seq)
          await f.outbox.put(row)
          frames.push(await f.publication.prepare(row, null))
        }
        const state = await f.state()
        expect(state.senderHWM).toBe(before.senderHWM)
        expect(state.stateBytes).toEqual(before.stateBytes)
        expect(new Set(frames.map((frame) => frame.entry.lastAttempt?.publishID)).size).toBe(5)
        expect(new Set(frames.map((frame) => JSON.stringify([...frame.payload]))).size).toBe(5)
        f = await f.reopen()
        expect((await f.outbox.list()).map((row) => row.lastAttempt?.publishID)).toEqual(
          frames.map((frame) => frame.entry.lastAttempt?.publishID),
        )
      } finally {
        await f.close()
      }
    })
    test('active reconstruction reseals unproven plaintext under a new ID', async () => {
      let f = await params.createFixture()
      try {
        const accepted = entry()
        await f.outbox.put(accepted)
        const first = await f.publication.prepare(accepted, null)
        f = await f.reopen()
        const restored = (await f.outbox.list())[0]
        if (restored === undefined) throw new Error('Missing restored entry')
        const second = await f.publication.prepare(restored, null)
        expect(second.entry.data).toEqual(first.entry.data)
        expect(second.entry.lastAttempt?.attempts).toBe(2)
        expect(second.entry.lastAttempt?.publishID).not.toBe(first.entry.lastAttempt?.publishID)
        expect(second.payload).not.toEqual(first.payload)
        expect(second.snapshot.identity).toEqual(first.snapshot.identity)
        expect(second.entry.lastAttempt?.topicID).toBe(second.snapshot.topicID)
      } finally {
        await f.close()
      }
    })
    test('retired reconstruction never reseals an old entry', async () => {
      let f = await params.createFixture()
      try {
        const accepted = entry()
        await f.outbox.put(accepted)
        const first = await f.publication.prepare(accepted, null)
        await f.change('incarnation')
        f = await f.reopen()
        const rows = await f.rows()
        await expect(f.publication.prepare(first.entry, null)).rejects.toThrow()
        expect(await f.publication.snapshot('chat')).toBeNull()
        expect(f.counts().seals).toBe(0)
        expect(f.counts().publishes).toBe(0)
        expect(await f.rows()).toEqual(rows)
      } finally {
        await f.close()
      }
    })
    test('preparation rejects an obligated entry before seal or put', async () => {
      const f = await params.createFixture()
      try {
        await f.outbox.put(entry())
        const prepared = await f.publication.prepare(entry(), null)
        const attempt = prepared.entry.lastAttempt
        if (attempt === null) throw new Error('Missing attempt')
        const obligation = {
          sequenceID: 'accepted',
          attemptID: attempt.publishID,
          topicID: attempt.topicID,
          outcome: 'published' as const,
        }
        expect(
          await f.outbox.recordSettlement(0, obligation, {
            identity: prepared.snapshot.identity,
            stateVersion: prepared.snapshot.stateVersion,
            attemptID: attempt.publishID,
          }),
        ).toEqual({ recorded: true })
        const before = f.counts()
        const rows = await f.rows()
        await expect(f.publication.prepare(prepared.entry, null)).rejects.toThrow()
        expect(f.counts().seals).toBe(before.seals)
        expect(await f.rows()).toEqual(rows)
        expect(await f.outbox.loadSettlement(0)).toEqual(obligation)
      } finally {
        await f.close()
      }
    })
    test('outbox values cannot mutate stored plaintext or an obligated attempt', async () => {
      const f = await params.createFixture()
      try {
        const accepted = entry()
        const original = { ...accepted, data: accepted.data.slice() }
        await f.outbox.put(accepted)
        accepted.data.fill(0)
        const listed = await f.outbox.list()
        listed[0]?.data.fill(1)
        expect(await f.outbox.list()).toEqual([original])
        for (const change of [
          { protocol: 'other' },
          { prc: 'other' },
          { data: new Uint8Array([1]) },
        ])
          await expect(f.outbox.put({ ...original, ...change })).rejects.toThrow()
        const prepared = await f.publication.prepare(original, null)
        const attempt = prepared.entry.lastAttempt
        if (attempt === null) throw new Error('Missing attempt')
        const obligation = {
          sequenceID: 'accepted',
          attemptID: attempt.publishID,
          topicID: attempt.topicID,
          outcome: 'published' as const,
        }
        expect(
          await f.outbox.recordSettlement(0, obligation, {
            identity: prepared.snapshot.identity,
            stateVersion: prepared.snapshot.stateVersion,
            attemptID: attempt.publishID,
          }),
        ).toEqual({ recorded: true })
        await expect(
          f.outbox.put({
            ...prepared.entry,
            lastAttempt: { ...attempt, publishID: 'replacement' },
          }),
        ).rejects.toThrow()
        await expect(f.outbox.remove(0)).rejects.toThrow()
        await expect(
          f.outbox.remove(0, {
            incarnation: attempt.incarnation,
            segment: attempt.segment,
            topicID: attempt.topicID,
            position: 'other',
          }),
        ).rejects.toThrow()
        await f.outbox.remove(0, {
          incarnation: attempt.incarnation,
          segment: attempt.segment,
          topicID: attempt.topicID,
          position: obligation.sequenceID,
        })
        const events = await f.outbox.events()
        expect(events.filter((event) => event.kind === 'published')).toHaveLength(1)
        await f.outbox.remove(0)
        await f.outbox.ackEvent('unknown')
        expect(await f.outbox.events()).toEqual(events)
      } finally {
        await f.close()
      }
    })
    test.each(['seal', 'attempt'] as const)(
      'failed %s preparation releases no payload or attempt',
      async (stage) => {
        const f = await params.createFixture()
        try {
          await f.outbox.put(entry())
          const rows = await f.rows()
          f.failNext(stage, 'rollback')
          await expect(f.publication.prepare(entry(), null)).rejects.toThrow()
          expect(await f.outbox.list()).toEqual([entry()])
          expect(await f.rows()).toEqual(rows)
        } finally {
          await f.close()
        }
      },
    )
    test.each(['version', 'epoch', 'incarnation', 'anchor'] as const)(
      'prepare refuses moved identity and anchor (%s)',
      async (kind) => {
        const f = await params.createFixture()
        let release = () => {}
        let pending: Promise<unknown> | undefined
        try {
          await f.outbox.put(entry())
          const first = await f.publication.prepare(entry(), null)
          const gate = f.gateNext('prepare')
          release = gate.release
          let releasedPayload = false
          pending = f.publication
            .prepare(first.entry, null)
            .then((frame) => {
              releasedPayload = true
              return frame
            })
            .catch((error: unknown) => error)
          await gate.entered
          await f.change(kind)
          const snapshot = await f.publication.snapshot('chat')
          if (kind === 'incarnation') expect(snapshot).toBeNull()
          else {
            expect(snapshot).not.toBeNull()
            if (snapshot === null) throw new Error('Missing active snapshot')
            if (kind === 'version')
              expect(snapshot.stateVersion).not.toBe(first.snapshot.stateVersion)
            else
              expect(JSON.stringify([snapshot.identity, snapshot.topicID])).not.toBe(
                JSON.stringify([first.snapshot.identity, first.snapshot.topicID]),
              )
          }
          const rows = await f.rows()
          const entries = await f.outbox.list()
          const counts = f.counts()
          gate.release()
          expect(await pending).toBeInstanceOf(Error)
          expect(releasedPayload).toBe(false)
          expect(f.counts().seals).toBe(counts.seals)
          expect(f.counts().publishes).toBe(counts.publishes)
          expect(f.counts().effects).toBe(counts.effects)
          expect(await f.outbox.list()).toEqual(entries)
          expect(await f.rows()).toEqual(rows)
          if (kind === 'incarnation') expect(await f.publication.snapshot('chat')).toBeNull()
        } finally {
          release()
          await pending
          await f.close()
        }
      },
    )
  })
}
