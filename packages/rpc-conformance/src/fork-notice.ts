import { describe, expect, onTestFinished, test, vi } from 'vitest'

import type { ConformanceCheckpointRecord, ConformanceCheckpointService } from './checkpoint.js'
import type { ConformanceGroupKey } from './persistence-fixture.js'

type Coverage =
  | { kind: 'complete' }
  | {
      kind: 'partial'
      reasons: Array<
        'pre-journal-history' | 'retention-gap' | 'unknown-ancestry' | 'ephemeral-uncovered'
      >
    }
export type ConformanceForkNotice = {
  id: string
  groupID: string
  splitEpoch: number
  branches: Array<{
    authHash: string
    signers: Array<{ signerDID: string; keyHash: string }>
    firstSeenAt: number
    lastCheckpointAt: number
  }>
  deviceAuthHash: string
  detectedAt: number
  lastEvidenceAt: number
  atRisk: Array<{ id: string; epoch: number; authHash: string }>
  revision: number
  acknowledgedRevision: number
  acknowledgedAt: number | null
  coverage: { evidence: Coverage; ownMessages: Coverage; ephemeral: Coverage }
  closedAt: number | null
  closeReason?: 'merged'
  mergedInto?: string
  equivocations: Array<{ signerDID: string; keyHash: string }>
}
export type ConformanceForkNoticeEvent = {
  id: string
  kind: 'fork-detected' | 'fork-updated'
  mergedFrom?: Array<string>
  notice: ConformanceForkNotice
}
export type ForkNoticeFixture<Position extends string = string> = {
  key: ConformanceGroupKey
  service(): ConformanceCheckpointService<Position>
  frame: Uint8Array
  agreeingPredecessorFrame: Uint8Array
  nextSignerFrame: Uint8Array
  mergeFrames(): Promise<{
    later: Uint8Array
    earlier: Uint8Array
    link: Uint8Array
    update: Uint8Array
  }>
  snapshot(): Promise<unknown>
  installedRecords(): Promise<Array<ConformanceCheckpointRecord>>
  emitted: Array<ConformanceForkNoticeEvent>
  restart(): Promise<void>
  advance(count: number): Promise<void>
  retire(): Promise<void>
  signingReads(): number
  holdProof(): { rejected: Promise<void>; finish(outcome: 'commit' | 'rollback'): Promise<void> }
  raw(): Promise<Array<{ namespace: string; incarnation: number | null; bytes: Uint8Array }>>
  close(): Promise<void>
}

function required<TValue>(value: TValue | undefined): TValue {
  if (value === undefined) throw new Error('Missing fixture value')
  return value
}

export function testForkNoticeConformance(params: {
  label: string
  createFixture(): Promise<ForkNoticeFixture>
}): void {
  describe(`Fork notice: ${params.label}`, () => {
    test('an agreeing predecessor preserves an open split without equivocation across restart', async () => {
      const fixture = await params.createFixture()
      try {
        let service = fixture.service()
        await service.importCheckpoint(fixture.key, fixture.agreeingPredecessorFrame)
        expect(await service.forkNotices(fixture.key.groupID)).toEqual([])
        await service.importCheckpoint(fixture.key, fixture.frame)
        const opened = required((await service.forkNotices(fixture.key.groupID))[0])
        expect(opened).toMatchObject({ equivocations: [], revision: 1, closedAt: null })
        await service.ackForkNotice(fixture.key.groupID, opened.id, opened.revision)
        const notices = await service.forkNotices(fixture.key.groupID)
        expect(notices).toHaveLength(1)
        const records = await service.readRecords()
        const emitted = fixture.emitted.length
        const snapshot = await fixture.snapshot()
        const signingReads = fixture.signingReads()
        await service.importCheckpoint(fixture.key, fixture.agreeingPredecessorFrame)
        expect(await service.forkNotices(fixture.key.groupID)).toEqual(notices)
        expect(await service.readRecords()).toEqual(records)
        expect(fixture.emitted).toHaveLength(emitted)
        expect(await fixture.snapshot()).toEqual(snapshot)
        expect(fixture.signingReads()).toBe(signingReads)
        await fixture.restart()
        service = fixture.service()
        await service.importCheckpoint(fixture.key, fixture.agreeingPredecessorFrame)
        expect(await service.forkNotices(fixture.key.groupID)).toEqual(notices)
        expect(await service.readRecords()).toEqual(records)
        expect(fixture.emitted).toHaveLength(emitted)
      } finally {
        await fixture.close()
      }
    })
    test('lone unequal statement only notifies', async () => {
      const fixture = await params.createFixture()
      try {
        const before = await fixture.snapshot()
        const signingReads = fixture.signingReads()
        const service = fixture.service()
        await service.importCheckpoint(fixture.key, fixture.frame)
        expect(await fixture.snapshot()).toEqual(before)
        expect(fixture.signingReads()).toBe(signingReads)
        const notices = await service.forkNotices(fixture.key.groupID)
        expect(notices).toHaveLength(1)
        expect(notices[0]).toMatchObject({ revision: 1, closedAt: null })
        expect(fixture.emitted).toHaveLength(1)
        for (const row of (await fixture.raw()).filter((row) => row.namespace === 'checkpoints')) {
          expect(row.incarnation).toBeNull()
          expect(row.bytes).not.toEqual(fixture.frame)
        }
        const imported = fixture.frame.slice()
        await service.importCheckpoint(fixture.key, imported)
        imported.fill(0)
        expect((await service.readRecords()).filter((row) => row.kind === 'evidence')).toHaveLength(
          1,
        )
        const evidence = (await service.readRecords()).find((row) => row.kind === 'evidence')
        expect(evidence).toMatchObject({
          first: fixture.frame,
          localRosterFact: expect.any(Uint8Array),
        })
      } finally {
        await fixture.close()
      }
    })
    test.each(['commit', 'rollback'] as const)(
      'notice callbacks wait for proof: %s',
      async (outcome) => {
        const fixture = await params.createFixture()
        const fault = fixture.holdProof()
        let settled = false
        try {
          let released = false
          const pending = fixture
            .service()
            .importCheckpoint(fixture.key, fixture.frame)
            .then(
              () => {
                released = true
                return null
              },
              (error: unknown) => {
                released = true
                return error
              },
            )
          await fault.rejected
          expect(released).toBe(false)
          expect(fixture.emitted).toEqual([])
          await fault.finish(outcome)
          settled = true
          const result = await pending
          if (outcome === 'rollback') {
            expect(result).toBeInstanceOf(Error)
            expect(await fixture.service().forkNotices(fixture.key.groupID)).toEqual([])
            expect(fixture.emitted).toEqual([])
          } else {
            expect(result).toBeNull()
            expect(fixture.emitted).toHaveLength(1)
          }
        } finally {
          if (!settled) await fault.finish('rollback')
          await fixture.close()
        }
      },
    )
    test('replay after ack preserves revision across restart and coalesces material updates', async () => {
      const fixture = await params.createFixture()
      const clock = vi.spyOn(Date, 'now').mockReturnValue(100000)
      try {
        let service = fixture.service()
        await service.importCheckpoint(fixture.key, fixture.frame)
        const notice = required((await service.forkNotices(fixture.key.groupID))[0])
        await service.ackForkNotice(fixture.key.groupID, notice.id, notice.revision)
        await fixture.restart()
        service = fixture.service()
        clock.mockReturnValue(100001)
        await service.importCheckpoint(fixture.key, fixture.frame)
        expect(await service.events(fixture.key.groupID)).toEqual([])
        expect((await service.forkNotices(fixture.key.groupID))[0]?.revision).toBe(1)
        await service.importCheckpoint(fixture.key, fixture.nextSignerFrame)
        expect(await service.events(fixture.key.groupID)).toEqual([])
        const next = required((await service.forkNotices(fixture.key.groupID))[0])
        expect(next).toMatchObject({ revision: 2, acknowledgedAt: null })
        const marker = required(
          (await service.readRecords()).find((row) => row.kind === 'notice-tombstone'),
        )
        if (marker.kind !== 'notice-tombstone') throw new Error('Missing notice replay marker')
        expect(marker).toMatchObject({ acknowledgedRevision: 1, acknowledgedAt: null })
        expect(marker.frames).toHaveLength(2)
        expect(marker.frames.map((frame) => frame.hash)).toEqual(
          marker.frames.map((frame) => frame.hash).sort(),
        )
        await expect(service.updateRecords({ put: [marker] })).rejects.toThrow()
        await expect(service.updateRecords({ remove: [marker.id] })).rejects.toThrow()

        await service.ackForkNotice(fixture.key.groupID, next.id, 1)
        clock.mockReturnValue(130000)
        expect(
          (await service.events(fixture.key.groupID)).map((event) => event.notice.revision),
        ).toEqual([2])
        const exported = await service.exportCheckpoints(fixture.key)
        const copy = exported.map((frame) => frame.slice())
        for (const frame of exported) frame.fill(0)
        expect(await service.exportCheckpoints(fixture.key)).toEqual(copy)
      } finally {
        clock.mockRestore()
        await fixture.close()
      }
    })
    test('retained parent links merge persisted notices without rewriting events', async () => {
      const fixture = await params.createFixture()
      const clock = vi.spyOn(Date, 'now').mockReturnValue(100000)
      try {
        const frames = await fixture.mergeFrames()
        let service = fixture.service()
        await service.importCheckpoint(fixture.key, frames.later)
        const survivor = required((await service.forkNotices(fixture.key.groupID))[0])
        await service.ackForkNotice(fixture.key.groupID, survivor.id, survivor.revision)
        clock.mockReturnValue(100001)
        await service.importCheckpoint(fixture.key, frames.earlier)
        const loser = required(
          (await service.forkNotices(fixture.key.groupID)).find(
            (notice) => notice.id !== survivor.id,
          ),
        )
        const prior = (await service.readRecords()).filter((row) => row.kind === 'notice-event')
        clock.mockReturnValue(100002)
        await service.importCheckpoint(fixture.key, frames.link)
        const notices = await service.forkNotices(fixture.key.groupID)
        expect(notices.filter((notice) => notice.closedAt === null)).toMatchObject([
          {
            id: survivor.id,
            splitEpoch: 4,
            revision: 2,
            acknowledgedRevision: 1,
            acknowledgedAt: null,
          },
        ])
        expect(notices.find((notice) => notice.id === loser.id)).toMatchObject({
          closeReason: 'merged',
          mergedInto: survivor.id,
          closedAt: 100002,
          revision: 2,
        })
        const records = await service.readRecords()
        for (const event of prior) expect(records.find((row) => row.id === event.id)).toEqual(event)
        expect(records.find((row) => row.id === `${survivor.id}:2`)).toMatchObject({
          emitAt: 130000,
          acknowledged: false,
          event: { kind: 'fork-updated', mergedFrom: [loser.id] },
        })
        clock.mockReturnValue(100003)
        await service.importCheckpoint(fixture.key, frames.update)
        for (const event of records.filter((row) => row.kind === 'notice-event'))
          expect((await service.readRecords()).find((row) => row.id === event.id)).toEqual(event)
        await fixture.restart()
        service = fixture.service()
        clock.mockReturnValue(130001)
        const events = await service.events(fixture.key.groupID)
        expect(events.map((event) => event.id)).toContain(`${survivor.id}:2`)
        expect(events.map((event) => event.id)).toContain(`${survivor.id}:3`)
        expect(
          fixture.emitted
            .filter((event) => event.notice.id === survivor.id && event.notice.revision > 1)
            .map((event) => event.notice.revision),
        ).toEqual([3])
        expect(events.map((event) => event.id)).toContain(`${loser.id}:1`)
        expect(events.map((event) => event.id)).not.toContain(`${survivor.id}:1`)
        await service.ackForkNotice(fixture.key.groupID, loser.id, 2)
        expect((await service.events(fixture.key.groupID)).map((event) => event.id)).toEqual([
          `${survivor.id}:2`,
          `${survivor.id}:3`,
        ])
      } finally {
        clock.mockRestore()
        await fixture.close()
      }
    })
    test('import cannot supply roster provenance or mutate installation authority', async () => {
      const fixture = await params.createFixture()
      try {
        const service = fixture.service()
        const before = await fixture.installedRecords()
        const coverage = required(before.find((row) => row.kind === 'coverage'))
        const fact = required(before.find((row) => row.kind === 'fact'))
        const debt = required(before.find((row) => row.kind === 'publication'))
        for (const row of [
          coverage,
          fact,
          { ...fact, id: 'injected' },
          { ...debt, id: 'injected-debt' },
        ])
          await expect(service.updateRecords({ put: [row] })).rejects.toThrow()
        for (const row of [coverage, fact, debt])
          await expect(service.updateRecords({ remove: [row.id] })).rejects.toThrow()
        await service.importCheckpoint(
          fixture.key,
          new TextEncoder().encode(
            JSON.stringify({ frame: [...fixture.frame], localRosterFact: [1, 2] }),
          ),
        )
        const damaged = fixture.frame.slice()
        damaged[damaged.length - 1] = required(damaged[damaged.length - 1]) ^ 1
        await service.importCheckpoint(fixture.key, damaged)
        expect(await service.forkNotices(fixture.key.groupID)).toEqual([])
        expect(await fixture.installedRecords()).toEqual(before)
        await expect(
          service.importCheckpoint({ ...fixture.key, groupID: 'wrong-group' }, fixture.frame),
        ).rejects.toThrow()
      } finally {
        await fixture.close()
      }
    })
    test('cursor intake is bounded and retains only authenticated evidence', async () => {
      const fixture = await params.createFixture()
      try {
        const service = fixture.service()
        const cursor = {
          kind: 'cursor' as const,
          id: 'bounded-intake',
          key: fixture.key,
          topicID: 'checkpoint-topic',
          position: '0001',
          intake: fixture.frame.slice(),
        }
        for (const put of [
          [{ ...cursor, intake: new Uint8Array(4097) }],
          [{ ...cursor, position: null }],
          [cursor, { ...cursor, id: 'second-intake' }],
        ]) {
          await expect(service.updateRecords({ put })).rejects.toThrow()
          expect(await service.forkNotices(fixture.key.groupID)).toEqual([])
          expect((await service.readRecords()).some((row) => row.kind === 'cursor')).toBe(false)
        }
        await service.updateRecords({ put: [cursor] })
        cursor.intake.fill(0)
        const records = await service.readRecords()
        const saved = required(records.find((row) => row.kind === 'cursor'))
        expect(saved).toMatchObject({ position: '0001' })
        expect(saved).not.toHaveProperty('intake')
        expect(records.filter((row) => row.kind === 'evidence')).toMatchObject([
          { first: fixture.frame },
        ])
        expect(await service.forkNotices(fixture.key.groupID)).toHaveLength(1)
        expect(fixture.emitted).toHaveLength(1)
      } finally {
        await fixture.close()
      }
    })
    test('material updates emit at the saved deadline under fake timers', async () => {
      const fixture = await params.createFixture()
      vi.useFakeTimers()
      vi.setSystemTime(100000)
      try {
        const service = fixture.service()
        await service.importCheckpoint(fixture.key, fixture.frame)
        const notice = required((await service.forkNotices(fixture.key.groupID))[0])
        await service.ackForkNotice(fixture.key.groupID, notice.id, notice.revision)
        await service.importCheckpoint(fixture.key, fixture.nextSignerFrame)
        await vi.advanceTimersByTimeAsync(29999)
        expect(fixture.emitted).toHaveLength(1)
        await vi.advanceTimersByTimeAsync(1)
        await vi.waitFor(() => expect(fixture.emitted).toHaveLength(2), { interval: 0 })
        expect(fixture.emitted[1]?.notice.revision).toBe(2)
      } finally {
        vi.useRealTimers()
        await fixture.close()
      }
    })
    test('a clock rewind chunks distant event deadlines without early emission', async () => {
      const fixture = await params.createFixture()
      vi.useFakeTimers()
      vi.setSystemTime(3000000000)
      const timeout = vi.spyOn(globalThis, 'setTimeout')
      try {
        const service = fixture.service()
        await service.importCheckpoint(fixture.key, fixture.frame)
        await service.importCheckpoint(fixture.key, fixture.nextSignerFrame)
        expect(fixture.emitted).toHaveLength(1)
        vi.setSystemTime(100000)
        timeout.mockClear()
        await service.readRecords()
        const delays = timeout.mock.calls.map(([, delay]) => delay)
        expect(delays.length).toBeGreaterThan(0)
        expect(delays.every((delay) => delay !== undefined && delay <= 2147483647)).toBe(true)
        await vi.advanceTimersByTimeAsync(2147483647)
        await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1), { interval: 0 })
        expect(fixture.emitted).toHaveLength(1)
        await vi.advanceTimersByTimeAsync(852446352)
        expect(fixture.emitted).toHaveLength(1)
        await vi.advanceTimersByTimeAsync(1)
        await vi.waitFor(() => expect(fixture.emitted).toHaveLength(2), { interval: 0 })
        expect(fixture.emitted[1]?.notice.revision).toBe(2)
      } finally {
        timeout.mockRestore()
        vi.useRealTimers()
        await fixture.close()
      }
    })
    test('one active branch closes after 86400000 milliseconds and retains evidence', async () => {
      const fixture = await params.createFixture()
      const clock = vi.spyOn(Date, 'now').mockReturnValue(100000)
      try {
        const service = fixture.service()
        await service.importCheckpoint(fixture.key, fixture.frame)
        clock.mockReturnValue(86500000)
        expect((await service.forkNotices(fixture.key.groupID))[0]?.closedAt).toBeNull()
        await service.importCheckpoint(fixture.key, fixture.frame)
        expect((await service.forkNotices(fixture.key.groupID))[0]?.closedAt).toBe(86500000)
        expect((await service.readRecords()).some((row) => row.kind === 'evidence')).toBe(true)
      } finally {
        clock.mockRestore()
        await fixture.close()
      }
    })
    test('acknowledgement expiry cannot resurrect an identical current-installation frame after restart', async () => {
      const fixture = await params.createFixture()
      const clock = vi.spyOn(Date, 'now').mockReturnValue(100000)
      try {
        let service = fixture.service()
        await service.importCheckpoint(fixture.key, fixture.frame)
        const notice = required((await service.forkNotices(fixture.key.groupID))[0])
        clock.mockReturnValue(86500000)
        await service.importCheckpoint(fixture.key, fixture.frame)
        expect((await service.forkNotices(fixture.key.groupID))[0]?.closedAt).toBe(86500000)
        await service.ackForkNotice(fixture.key.groupID, notice.id, notice.revision)
        clock.mockReturnValue(86500000 + 604800001)
        expect(await service.checkpointFact(fixture.key, notice.splitEpoch)).not.toBeNull()
        expect(await service.forkNotices(fixture.key.groupID)).toEqual([])
        expect((await service.readRecords()).filter((row) => row.kind === 'evidence')).toEqual([])
        const tombstones = (await service.readRecords()).filter(
          (row) => row.kind === 'notice-tombstone',
        )
        expect(tombstones).toHaveLength(1)
        expect(tombstones[0]).toMatchObject({
          noticeID: notice.id,
          acknowledgedRevision: notice.revision,
          acknowledgedAt: 86500000,
          frames: [{ hash: expect.any(String), installationID: expect.any(String) }],
        })
        await fixture.restart()
        service = fixture.service()
        const emitted = fixture.emitted.length
        await service.importCheckpoint(fixture.key, fixture.frame)
        expect(await service.forkNotices(fixture.key.groupID)).toEqual([])
        expect(await service.events(fixture.key.groupID)).toEqual([])
        expect(fixture.emitted).toHaveLength(emitted)
        expect((await service.readRecords()).filter((row) => row.kind === 'evidence')).toEqual([])
      } finally {
        clock.mockRestore()
        await fixture.close()
      }
    })
    test('a failed deadline flush retries without another API call', async () => {
      const fixture = await params.createFixture()
      vi.useFakeTimers()
      vi.setSystemTime(100000)
      let fault: ReturnType<ForkNoticeFixture['holdProof']> | undefined
      try {
        const service = fixture.service()
        await service.importCheckpoint(fixture.key, fixture.frame)
        const notice = required((await service.forkNotices(fixture.key.groupID))[0])
        await service.ackForkNotice(fixture.key.groupID, notice.id, notice.revision)
        await service.importCheckpoint(fixture.key, fixture.nextSignerFrame)
        fault = fixture.holdProof()
        await vi.advanceTimersByTimeAsync(30000)
        await fault.rejected
        expect(fixture.emitted).toHaveLength(1)
        await fault.finish('rollback')
        fault = undefined
        await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1), { interval: 0 })
        await vi.advanceTimersByTimeAsync(29999)
        expect(fixture.emitted).toHaveLength(1)
        await vi.advanceTimersByTimeAsync(1)
        await vi.waitFor(() => expect(fixture.emitted).toHaveLength(2), { interval: 0 })
        expect(fixture.emitted[1]?.notice.revision).toBe(2)
      } finally {
        if (fault !== undefined) await fault.finish('rollback')
        vi.useRealTimers()
        await fixture.close()
      }
    })
    test('repeated flush failures double the retry delay up to 600000 milliseconds', async () => {
      const fixture = await params.createFixture()
      vi.useFakeTimers()
      vi.setSystemTime(100000)
      let fault: ReturnType<ForkNoticeFixture['holdProof']> | undefined
      try {
        const service = fixture.service()
        await service.importCheckpoint(fixture.key, fixture.frame)
        const notice = required((await service.forkNotices(fixture.key.groupID))[0])
        await service.ackForkNotice(fixture.key.groupID, notice.id, notice.revision)
        await service.importCheckpoint(fixture.key, fixture.nextSignerFrame)
        for (const delay of [30000, 30000, 60000, 120000, 240000, 480000, 600000]) {
          fault = fixture.holdProof()
          let rejected = false
          void fault.rejected.then(() => {
            rejected = true
          })
          await vi.advanceTimersByTimeAsync(delay - 1)
          expect(rejected).toBe(false)
          expect(vi.getTimerCount()).toBe(1)
          await vi.advanceTimersByTimeAsync(1)
          expect(vi.getTimerCount()).toBe(0)
          await fault.rejected
          expect(fixture.emitted).toHaveLength(1)
          await fault.finish('rollback')
          fault = undefined
          await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1), { interval: 0 })
        }
        await vi.advanceTimersByTimeAsync(599999)
        expect(fixture.emitted).toHaveLength(1)
        await vi.advanceTimersByTimeAsync(1)
        await vi.waitFor(() => expect(fixture.emitted).toHaveLength(2), { interval: 0 })
      } finally {
        if (fault !== undefined) {
          if (vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync()
          await fault.finish('rollback')
        }
        vi.useRealTimers()
        await fixture.close()
      }
    })
    test('a disposed owner remains observable and stops timer retries', async () => {
      const fixture = await params.createFixture()
      vi.useFakeTimers()
      vi.setSystemTime(100000)
      try {
        const service = fixture.service()
        await service.importCheckpoint(fixture.key, fixture.frame)
        const notice = required((await service.forkNotices(fixture.key.groupID))[0])
        await service.ackForkNotice(fixture.key.groupID, notice.id, notice.revision)
        await service.importCheckpoint(fixture.key, fixture.nextSignerFrame)
        await fixture.close()
        await vi.advanceTimersByTimeAsync(30000)
        expect(vi.getTimerCount()).toBe(0)
        expect(fixture.emitted).toHaveLength(1)
        await expect(service.readRecords()).rejects.toThrow()
      } finally {
        vi.useRealTimers()
        await fixture.close()
      }
    })
    test('coverage query excludes summary only epochs across retired incarnations', async () => {
      const fixture = await params.createFixture()
      const start = Date.now()
      const clock = vi.spyOn(Date, 'now').mockReturnValue(start)
      try {
        await fixture.service().importCheckpoint(fixture.key, fixture.frame)
        const notice = required((await fixture.service().forkNotices(fixture.key.groupID))[0])
        clock.mockReturnValue(start + 1000)
        await fixture.restart()
        await fixture.retire()
        await fixture.restart()
        clock.mockReturnValue(start + 604801000)
        const service = fixture.service()
        const coverage = await service.checkpointCoverage(fixture.key.groupID)
        expect(coverage.current?.key.incarnation).toBe(2)
        expect(coverage.effectiveFloor).toBeGreaterThan(notice.splitEpoch)
        expect(await service.checkpointFact(fixture.key, notice.splitEpoch)).toBeNull()
        expect((await service.readRecords()).some((row) => row.kind === 'evidence')).toBe(false)
        expect((await service.forkNotices(fixture.key.groupID))[0]?.coverage.evidence).toEqual({
          kind: 'partial',
          reasons: ['retention-gap'],
        })
      } finally {
        clock.mockRestore()
        await fixture.close()
      }
    })
    test.for(['count', 'age'] as const)(
      'closed evidence obeys ack and retention bounds: %s',
      { timeout: 120_000 },
      async (bound, { signal }) => {
        const fixture = await params.createFixture()
        const start = Date.now()
        const clock = vi.spyOn(Date, 'now').mockReturnValue(start)
        // Runs on timeout too; the abandoned body keeps running and must not leak the mocked clock.
        onTestFinished(() => {
          clock.mockRestore()
        })
        try {
          const service = fixture.service()
          await service.importCheckpoint(fixture.key, fixture.frame)
          const initial = required((await service.forkNotices(fixture.key.groupID))[0])
          if (bound === 'count')
            for (let installed = 0; installed < 256; installed++) {
              if (signal.aborted) throw signal.reason
              await fixture.advance(1)
            }
          else {
            await fixture.advance(1)
            clock.mockReturnValue(start + 604800000)
          }
          expect(
            (await service.readRecords()).find((row) => row.kind === 'evidence'),
          ).toBeUndefined()
          expect((await service.readRecords()).some((row) => row.kind === 'notice-tombstone')).toBe(
            false,
          )
          const summary = required((await service.forkNotices(fixture.key.groupID))[0])
          expect(summary.coverage.evidence).toEqual({ kind: 'partial', reasons: ['retention-gap'] })
          expect((await service.events(fixture.key.groupID))[0]?.notice.coverage.evidence).toEqual({
            kind: 'partial',
            reasons: ['retention-gap'],
          })
          await fixture.restart()
          const restarted = fixture.service()
          await restarted.importCheckpoint(fixture.key, fixture.frame)
          await restarted.ackForkNotice(fixture.key.groupID, initial.id, initial.revision)
          expect(
            (await restarted.readRecords()).find((row) => row.kind === 'evidence'),
          ).toBeUndefined()
          expect(await restarted.checkpointFact(fixture.key, initial.splitEpoch)).toBeNull()
          expect(
            (await restarted.checkpointCoverage(fixture.key.groupID)).effectiveFloor,
          ).toBeGreaterThan(initial.splitEpoch)
        } finally {
          await fixture.close()
        }
      },
    )
  })
}
