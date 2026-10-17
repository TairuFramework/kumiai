import { describe, expect, test } from 'vitest'

import type {
  ConformanceEpochIdentity,
  ConformanceGroupCondition,
  ConformanceGroupConditionEvent,
  ConformanceGroupForkEvidence,
  ConformanceGroupKey,
  ConformanceGroupSafetyEvent,
  ConformanceNotMemberEvidence,
  ConformanceRecoveryUnavailableEvent,
  ConformanceSafetyHold,
} from './control-store.js'
import type { ConformanceGroupMLS } from './group-mls.js'
import type { ConformanceBranchAbandonedEvent } from './persistence-fixture.js'
import type { ConformanceRegistryFixture, ConformanceRegistryHandle } from './registry-fixture.js'

export type RosterAbsenceScenario = 'absent' | 'present' | 'wrong-key' | 'expired' | 'imported'
export type RosterAbsenceFixture = {
  requester: ConformanceGroupMLS
  responder: ConformanceGroupMLS
  epoch: number
  requesterDID: string
  responderDID: string
  comparisonEpoch(request: Uint8Array): Promise<number | undefined>
  invalidateSigner(): void
  refuseResponder(
    reason: 'fork-halted' | 'stranded' | 'incomplete' | 'epoch-mismatch',
  ): Promise<void>
  snapshot(): Promise<{ attempt: unknown; state: unknown }>
  close(): Promise<void>
}

export function testRosterAbsenceConformance(params: {
  label: string
  createFixture(scenario?: RosterAbsenceScenario): Promise<RosterAbsenceFixture>
}): void {
  describe(`roster absence: ${params.label}`, () => {
    async function run(
      fn: (fixture: RosterAbsenceFixture) => Promise<void>,
      scenario?: RosterAbsenceScenario,
    ) {
      const fixture = await params.createFixture(scenario)
      try {
        await fn(fixture)
      } finally {
        await fixture.close()
      }
    }
    async function proof(fixture: RosterAbsenceFixture, comparisonEpoch = 1) {
      const requestID = 'roster-absence'
      const held = await fixture.requester.createRecoveryRequest(
        requestID,
        undefined,
        comparisonEpoch,
      )
      const sealed = await fixture.responder.capturedRecovery?.sealRosterAbsence?.(
        held.request,
        null,
      )
      if (sealed == null) throw new Error('Missing roster absence capability or evidence')
      const check = fixture.requester.capturedRecovery?.checkRosterAbsence
      if (check === undefined) throw new Error('Missing roster absence verifier')
      return { ...held, requestID, sealed, check }
    }
    test('request comparison span reaches real and double roster sealers', () =>
      run(async (fixture) => {
        const held = await proof(fixture)
        expect(await fixture.comparisonEpoch(held.request)).toBe(1)
        const result = await held.check(held.sealed, held.requestID, held.requestKey)
        expect(result).toMatchObject({
          requesterDID: fixture.requesterDID,
          responderDID: fixture.responderDID,
          epoch: fixture.epoch,
          captureHead: null,
          lineage: [{ epoch: 1 }, { epoch: fixture.epoch }],
        })
        const narrow = await proof(fixture, fixture.epoch)
        expect(await fixture.comparisonEpoch(narrow.request)).toBe(fixture.epoch)
        expect(
          (await narrow.check(narrow.sealed, narrow.requestID, narrow.requestKey))?.lineage,
        ).toEqual([{ epoch: fixture.epoch, authHash: expect.any(String) }])
        await expect(fixture.responder.sealGroupInfo(held.request, null)).rejects.toThrow()
      }))
    test('ineligible signer cannot assert absence', () =>
      run(async (fixture) => {
        const held = await proof(fixture)
        fixture.invalidateSigner()
        expect(await held.check(held.sealed, held.requestID, held.requestKey)).toBeNull()
      }))
    test('wrong request cannot assert absence', () =>
      run(async (fixture) => {
        const held = await proof(fixture)
        expect(await held.check(held.sealed, 'another-request', held.requestKey)).toBeNull()
        const another = await fixture.requester.createRecoveryRequest(held.requestID, undefined, 1)
        expect(await held.check(held.sealed, held.requestID, another.requestKey)).toBeNull()
      }))
    test('changed leaf for present DID never means removed', () =>
      run(async (fixture) => {
        const held = await fixture.requester.createRecoveryRequest('changed-leaf', undefined, 1)
        const seal = fixture.responder.capturedRecovery?.sealRosterAbsence
        if (seal === undefined) throw new Error('Missing roster absence sealer')
        expect(await seal(held.request, null)).toBeNull()
      }, 'present'))
    test('roster disclosure requires the complete captured head', () =>
      run(async (fixture) => {
        const held = await fixture.requester.createRecoveryRequest('wrong-head', undefined, 1)
        const seal = fixture.responder.capturedRecovery?.sealRosterAbsence
        if (seal === undefined) throw new Error('Missing roster absence sealer')
        expect(await seal(held.request, 'different-head')).toBeNull()
      }))
    test.each(['fork-halted', 'stranded', 'incomplete', 'epoch-mismatch'] as const)(
      'roster disclosure refuses an unsafe responder: %s',
      (reason) =>
        run(async (fixture) => {
          const held = await fixture.requester.createRecoveryRequest('unsafe-roster', undefined, 1)
          await fixture.refuseResponder(reason)
          const seal = fixture.responder.capturedRecovery?.sealRosterAbsence
          if (seal === undefined) throw new Error('Missing roster absence sealer')
          expect(await seal(held.request, null)).toBeNull()
        }),
    )
    test('legacy requests grant no roster disclosure', () =>
      run(async (fixture) => {
        const held = await fixture.requester.createRecoveryRequest('legacy-roster')
        const seal = fixture.responder.capturedRecovery?.sealRosterAbsence
        if (seal === undefined) throw new Error('Missing roster absence sealer')
        expect(await seal(held.request, null)).toBeNull()
      }))
    test('absence verification cannot mutate recovery attempt', () =>
      run(async (fixture) => {
        const held = await proof(fixture)
        const before = await fixture.snapshot()
        expect(before.attempt).not.toBeNull()
        expect(await held.check(held.sealed, held.requestID, held.requestKey)).not.toBeNull()
        expect(await held.check(new Uint8Array([0]), held.requestID, held.requestKey)).toBeNull()
        expect(await fixture.snapshot()).toEqual(before)
      }))
    test.each(['wrong-key', 'expired', 'imported'] as const)(
      'former member disclosure requires responder local DID and key history: %s',
      (scenario) =>
        run(async (fixture) => {
          const held = await fixture.requester.createRecoveryRequest('no-history', undefined, 1)
          const seal = fixture.responder.capturedRecovery?.sealRosterAbsence
          if (seal === undefined) throw new Error('Missing roster absence sealer')
          expect(await seal(held.request, null)).toBeNull()
        }, scenario),
    )
  })
}

export type ConformanceManualRecovery =
  | { mode: 'resync'; targetID: string }
  | { mode: 'successor'; successor: ConformanceGroupKey }

export type ConformanceGroupSafety = {
  status(key: ConformanceGroupKey): Promise<{
    hold: ConformanceSafetyHold
    condition: ConformanceGroupCondition | null
    evidence: ConformanceNotMemberEvidence | null
  }>
  epochAuthenticator(key: ConformanceGroupKey): Promise<ConformanceEpochIdentity | null>
  reportFork(key: ConformanceGroupKey, evidence: ConformanceGroupForkEvidence): Promise<void>
  recover(key: ConformanceGroupKey, choice: ConformanceManualRecovery): Promise<ConformanceGroupKey>
  events(
    key: ConformanceGroupKey,
  ): Promise<
    Array<
      | ConformanceBranchAbandonedEvent
      | ConformanceGroupSafetyEvent
      | ConformanceRecoveryUnavailableEvent
      | ConformanceGroupConditionEvent
    >
  >
  ackEvent(key: ConformanceGroupKey, id: string): Promise<void>
}

function signal() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

const forkID = (key: ConformanceGroupKey) =>
  JSON.stringify(['group:fork', key.groupID, key.incarnation])
const recoveryEvent = (key: ConformanceGroupKey): ConformanceRecoveryUnavailableEvent => ({
  ...key,
  id: JSON.stringify(['group:recovery-unavailable', key.groupID, key.incarnation]),
  kind: 'group:recovery-unavailable',
  reason: 'trust-unreadable',
})

export function runGroupSafetyContract<THandle extends ConformanceRegistryHandle>(
  fixture: ConformanceRegistryFixture<THandle>,
): void {
  async function activeKey() {
    const [lifetime] = await fixture.device.groups.list()
    if (lifetime?.activeIncarnation == null) throw new Error('Missing active fixture lifetime')
    return { groupID: lifetime.groupID, incarnation: lifetime.activeIncarnation }
  }
  async function evidence(key: ConformanceGroupKey) {
    const identity = await fixture.safety().epochAuthenticator(key)
    if (identity === null) throw new Error('Missing committed identity')
    const remote = identity.authenticator.slice()
    remote[0] = (remote[0] ?? 0) ^ 1
    return {
      kind: 'epoch-authenticator' as const,
      epoch: identity.epoch,
      local: identity.authenticator,
      remote,
    }
  }
  async function hold(key: ConformanceGroupKey, reason: 'fork-halted' | 'recovery-unavailable') {
    if (reason === 'fork-halted') await fixture.safety().reportFork(key, await evidence(key))
    else await fixture.installRows({ key, control: { recoveryUnavailable: recoveryEvent(key) } })
  }

  describe('GroupSafety contract', () => {
    test('diagnostic status separates active conditions from hard holds', async () => {
      const key = await activeKey()
      expect(await fixture.safety().status(key)).toEqual({
        hold: null,
        condition: null,
        evidence: null,
      })
      await hold(key, 'fork-halted')
      expect(await fixture.safety().status(key)).toEqual({
        hold: 'fork-halted',
        condition: null,
        evidence: null,
      })
    })
    test('host mismatch co-writes field/event/admission', async () => {
      const key = await activeKey()
      const access = await fixture.registry.access(key.groupID)
      const before = await fixture.device.groups.load(key.groupID)
      const control = await fixture.device.groups.ports(key).control.load()
      const reported = await evidence(key)
      await fixture.safety().reportFork(key, reported)
      const after = await fixture.device.groups.ports(key).control.load()
      expect(after).toEqual({
        ...control,
        forkHalt: { eventID: forkID(key), evidence: reported, detectedAt: expect.any(Number) },
      })
      expect(await fixture.safety().events(key)).toEqual([
        { ...key, id: forkID(key), kind: 'group:fork', halt: after.forkHalt },
      ])
      expect((await fixture.device.groups.load(key.groupID))?.revision).toBe(
        (before?.revision ?? 0) + 1,
      )
      expect(access.admission()).toEqual({
        epoch: reported.epoch,
        admissible: false,
        reason: 'fork-halted',
      })
    })

    test.each(['key', 'epoch', 'local', 'remote'] as const)(
      'invalid %s report writes and latches nothing',
      async (invalid) => {
        const key = await activeKey()
        const access = await fixture.registry.access(key.groupID)
        const reported = await evidence(key)
        if (invalid === 'epoch') reported.epoch++
        if (invalid === 'local') reported.local[0] = (reported.local[0] ?? 0) ^ 1
        if (invalid === 'remote') reported.remote = reported.local.slice()
        const before = await fixture.inspectRows()
        await expect(
          fixture
            .safety()
            .reportFork(
              invalid === 'key' ? { ...key, incarnation: key.incarnation + 1 } : key,
              reported,
            ),
        ).rejects.toMatchObject({
          name: 'ForkReportRefusedError',
          reason: invalid === 'key' || invalid === 'epoch' ? invalid : 'authenticator',
        })
        expect(await fixture.inspectRows()).toEqual(before)
        expect(await fixture.safety().events(key)).toEqual([])
        expect(access.admission().admissible).toBe(true)
      },
    )

    test.each(['authenticator', 'key', 'digest-divergence', 'unexplained-own-commit'] as const)(
      'queued %s report validates the committed identity after a move',
      async (kind) => {
        const key = await activeKey()
        const api = fixture.safety()
        const access = await fixture.registry.access(key.groupID)
        const original = await evidence(key)
        const next = await access.read((handle) => fixture.advance(handle))
        const started = signal()
        const released = signal()
        fixture.onPhase('work', async () => {
          started.release()
          await released.promise
        })
        const moving =
          kind === 'key'
            ? fixture.registry.seed(next, {
                replace: true,
                packageUse: { sourceID: 'source', ref: 'fresh', kind: 'ordinary' },
              })
            : access.mutate(async (_handle, persist) => persist(next))
        await started.promise
        const reported: ConformanceGroupForkEvidence =
          kind === 'digest-divergence'
            ? {
                kind,
                epoch: original.epoch,
                position: '1',
                localDigest: 'local',
                remoteDigest: 'remote',
              }
            : kind === 'unexplained-own-commit'
              ? { kind, epoch: original.epoch, position: '1', digest: 'unexpected' }
              : original
        const report = api.reportFork(key, reported).then(
          () => null,
          (error: unknown) => error,
        )
        try {
          released.release()
          await moving
          if (kind === 'authenticator' || kind === 'key') {
            const before = await fixture.inspectRows()
            expect(await report).toMatchObject({
              name: 'ForkReportRefusedError',
              reason: kind === 'key' ? 'key' : 'epoch',
            })
            expect(await fixture.inspectRows()).toEqual(before)
            expect(await api.events(key)).toEqual([])
            expect((await fixture.registry.access(key.groupID)).admission().admissible).toBe(true)
          } else {
            expect(await report).toBeNull()
            expect(
              (await fixture.device.groups.ports(key).control.load()).forkHalt?.evidence,
            ).toEqual(reported)
          }
        } finally {
          released.release()
        }
      },
    )

    test('defensive committed identity/events', async () => {
      const key = await activeKey()
      const api = fixture.safety()
      const identity = await api.epochAuthenticator(key)
      const reported = await evidence(key)
      await fixture.corruptState(key)
      expect(await api.epochAuthenticator(key)).toEqual(identity)
      const copy = await api.epochAuthenticator(key)
      copy?.authenticator.fill(0)
      expect(await api.epochAuthenticator(key)).toEqual(identity)
      await api.reportFork(key, reported)
      const expected = await api.events(key)
      const [event] = await api.events(key)
      if (event?.kind !== 'group:fork' || event.halt.evidence.kind !== 'epoch-authenticator')
        throw new Error('Missing authenticator event')
      event.halt.evidence.local.fill(0)
      event.halt.evidence.remote.fill(0)
      event.halt.detectedAt++
      expect(await api.events(key)).toEqual(expected)
      expect((await fixture.device.groups.ports(key).control.load()).forkHalt).toEqual(
        expected[0]?.kind === 'group:fork' ? expected[0].halt : null,
      )
    })

    test('Read has no revision/marker effects', async () => {
      const key = await activeKey()
      const api = fixture.safety()
      // The provider may initialise a marker-neutral owner row at its first barrier.
      await api.epochAuthenticator({ ...key, groupID: 'absent' })
      const before = await fixture.inspectRows()
      await api.epochAuthenticator(key)
      await api.events(key)
      for (const wrong of [
        { ...key, incarnation: 0 },
        { ...key, incarnation: key.incarnation + 1 },
        { ...key, groupID: 'absent' },
      ])
        expect(await api.epochAuthenticator(wrong)).toBeNull()
      expect(await fixture.inspectRows()).toEqual(before)
      await fixture.corruptTrust(key.groupID)
      const damaged = await fixture.inspectRows()
      expect(await api.epochAuthenticator(key)).toBeNull()
      expect(await api.events(key)).toEqual([])
      expect(await fixture.inspectRows()).toEqual(damaged)
    })

    test.each(['fork-halted', 'recovery-unavailable'] as const)(
      'ack retains %s across reopen/tombstone',
      async (reason) => {
        const key = await activeKey()
        await fixture.registry.access(key.groupID)
        await hold(key, reason)
        const control = await fixture.device.groups.ports(key).control.load()
        const [event] = await fixture.safety().events(key)
        if (event === undefined) throw new Error('Missing safety event')
        await expect(
          fixture.device.groups.ports(key).outbox.ackEvent(event.id),
        ).rejects.toMatchObject({ name: 'TypeError' })
        let cold = await fixture.reopen()
        try {
          expect(await cold.safety().events(key)).toEqual([event])
          expect((await cold.registry.access(key.groupID)).admission()).toMatchObject({ reason })
          await cold.registry.delete(key)
          cold = await cold.reopen()
          expect(await cold.safety().epochAuthenticator(key)).toBeNull()
          expect(await cold.safety().events(key)).toEqual([event])
          await cold.safety().ackEvent(key, event.id)
          cold = await cold.reopen()
          expect(await cold.safety().events(key)).toEqual([])
          expect(await cold.device.groups.ports(key).control.load()).toEqual(control)
          const before = await cold.inspectRows()
          await cold.safety().ackEvent(key, event.id)
          await cold.device.groups.ports(key).outbox.ackEvent(event.id)
          expect(await cold.inspectRows()).toEqual(before)
        } finally {
          await cold.close()
        }
      },
    )

    test('retired ack leaves active incarnation unchanged', async () => {
      const key = await activeKey()
      await hold(key, 'recovery-unavailable')
      const fresh = await fixture.makeHandle(2, key.groupID)
      const next = await fixture.registry.seed(fresh, {
        replace: true,
        packageUse: { sourceID: 'source', ref: 'fresh', kind: 'ordinary' },
      })
      const access = await fixture.registry.access(key.groupID)
      const snapshot = access.runtime.snapshot()
      const state = await fixture.device.groups.loadState(next)
      const control = await fixture.device.groups.ports(next).control.load()
      const [event] = await fixture.safety().events(key)
      if (event === undefined) throw new Error('Missing retired event')
      await fixture.safety().ackEvent(key, event.id)
      expect(await fixture.safety().events(key)).toEqual([])
      expect(await fixture.device.groups.loadState(next)).toEqual(state)
      expect(await fixture.device.groups.ports(next).control.load()).toEqual(control)
      expect(access.runtime.snapshot()).toEqual(snapshot)
      expect(access.admission().admissible).toBe(true)
      expect(await fixture.safety().epochAuthenticator(key)).toBeNull()
      expect((await fixture.device.groups.ports(key).control.load()).recoveryUnavailable).toEqual(
        event,
      )
    })

    test('existing-halt reports are storage-neutral', async () => {
      const key = await activeKey()
      const reported = await evidence(key)
      await fixture.safety().reportFork(key, reported)
      const cold = await fixture.reopen()
      try {
        const access = await cold.registry.access(key.groupID)
        const original = await cold.safety().events(key)
        let before = await cold.inspectRows()
        const different: ConformanceGroupForkEvidence = {
          kind: 'unexplained-own-commit',
          epoch: 999,
          position: 'different',
          digest: 'different',
        }
        await cold.safety().reportFork(key, different)
        expect(await cold.safety().events(key)).toEqual(original)
        expect(await cold.inspectRows()).toEqual(before)
        await cold.safety().ackEvent(key, forkID(key))
        before = await cold.inspectRows()
        await cold.safety().reportFork(key, different)
        expect(await cold.safety().events(key)).toEqual([])
        expect(await cold.inspectRows()).toEqual(before)
        expect(access.admission()).toMatchObject({ reason: 'fork-halted' })
      } finally {
        await cold.close()
      }
    })

    for (const path of ['source', 'cold', 'held'] as const) {
      test.each(['missing', 'corrupt', 'empty-spent'] as const)(
        `trust loss via ${path} access persists once (%s)`,
        async (damage) => {
          const key = await activeKey()
          const access = path === 'held' ? await fixture.registry.access(key.groupID) : null
          if (damage === 'missing') await fixture.removeTrust(key.groupID)
          if (damage === 'corrupt') await fixture.corruptTrust(key.groupID)
          if (damage === 'empty-spent') await fixture.corruptTrust(key.groupID, 'empty-spent')
          const revision = (await fixture.device.groups.load(key.groupID))?.revision
          let invoked = false
          const work =
            path === 'source'
              ? fixture.registry.recoverySource(key.groupID)
              : access === null
                ? fixture.registry.access(key.groupID)
                : access.read(() => {
                    invoked = true
                  })
          await expect(work).rejects.toMatchObject({
            name: 'GroupUnavailableError',
            reason: 'recovery-unavailable',
          })
          expect(invoked).toBe(false)
          expect(
            (await fixture.device.groups.ports(key).control.load()).recoveryUnavailable,
          ).toEqual(recoveryEvent(key))
          expect(await fixture.safety().events(key)).toEqual([recoveryEvent(key)])
          expect((await fixture.device.groups.load(key.groupID))?.revision).toBe(
            (revision ?? 0) + 1,
          )
          const before = await fixture.inspectRows()
          await expect(fixture.registry.recoverySource(key.groupID)).rejects.toMatchObject({
            reason: 'recovery-unavailable',
          })
          expect(await fixture.inspectRows()).toEqual(before)
          await fixture.safety().ackEvent(key, recoveryEvent(key).id)
          const cold = await fixture.reopen()
          try {
            const acknowledged = await cold.inspectRows()
            await expect(cold.registry.recoverySource(key.groupID)).rejects.toMatchObject({
              reason: 'recovery-unavailable',
            })
            expect(await cold.safety().events(key)).toEqual([])
            expect(await cold.inspectRows()).toEqual(acknowledged)
          } finally {
            await cold.close()
          }
        },
      )
    }

    test.each(['source', 'cold', 'held', 'authenticator', 'report'] as const)(
      'transient error at %s does not diagnose loss',
      async (path) => {
        const key = await activeKey()
        const api = fixture.safety()
        const reported = await evidence(key)
        const access = path === 'held' ? await fixture.registry.access(key.groupID) : null
        const error = new Error('Transient retained trust I/O')
        const before = await fixture.inspectRows()
        fixture.failTrustReads(error)
        const work =
          path === 'source'
            ? fixture.registry.recoverySource(key.groupID)
            : path === 'authenticator'
              ? api.epochAuthenticator(key)
              : path === 'report'
                ? api.reportFork(key, reported)
                : access === null
                  ? fixture.registry.access(key.groupID)
                  : access.read(() => {})
        await expect(work).rejects.toBe(error)
        fixture.failTrustReads(null)
        expect(await fixture.inspectRows()).toEqual(before)
        expect(await api.events(key)).toEqual([])
        expect((await fixture.registry.access(key.groupID)).admission().admissible).toBe(true)
      },
    )

    test.each(['missing', 'corrupt', 'empty-spent'] as const)(
      'lost %s spent trust refuses fresh Welcome unchanged',
      async (damage) => {
        const key = await activeKey()
        const fresh = await fixture.makeHandle(2, key.groupID)
        if (damage === 'missing') await fixture.removeTrust(key.groupID)
        if (damage === 'corrupt') await fixture.corruptTrust(key.groupID)
        if (damage === 'empty-spent') await fixture.corruptTrust(key.groupID, 'empty-spent')
        const before = await fixture.inspectRows()
        await expect(
          fixture.registry.seed(fresh, {
            replace: true,
            packageUse: { sourceID: 'source', ref: 'fresh', kind: 'ordinary' },
          }),
        ).rejects.toMatchObject({ name: 'SeedAdmissionRefusedError', reason: 'unavailable' })
        expect(await fixture.inspectRows()).toEqual(before)
      },
    )

    test.each(['active', 'tombstone'] as const)(
      'field-only recovery hold with valid %s trust readmits n+1',
      async (source) => {
        const key = await activeKey()
        await hold(key, 'recovery-unavailable')
        if (source === 'tombstone') await fixture.registry.delete(key)
        const fresh = await fixture.makeHandle(2, key.groupID)
        expect(
          await fixture.registry.seed(fresh, {
            replace: true,
            packageUse: { sourceID: 'source', ref: 'fresh', kind: 'ordinary' },
          }),
        ).toEqual({ ...key, incarnation: key.incarnation + 1 })
        expect((await fixture.registry.access(key.groupID)).admission().admissible).toBe(true)
        expect(await fixture.safety().events(key)).toEqual([recoveryEvent(key)])
        expect((await fixture.device.groups.ports(key).control.load()).recoveryUnavailable).toEqual(
          recoveryEvent(key),
        )
      },
    )

    test('fork tombstone refuses ordinary Welcome', async () => {
      const key = await activeKey()
      await hold(key, 'fork-halted')
      await fixture.registry.delete(key)
      const cold = await fixture.reopen()
      try {
        const fresh = await cold.makeHandle(2, key.groupID)
        const before = await cold.inspectRows()
        await expect(
          cold.registry.seed(fresh, {
            replace: true,
            packageUse: { sourceID: 'source', ref: 'fresh', kind: 'ordinary' },
          }),
        ).rejects.toMatchObject({ name: 'SeedAdmissionRefusedError', reason: 'fork-halted' })
        expect(await cold.inspectRows()).toEqual(before)
      } finally {
        await cold.close()
      }
    })

    test.each(['fork-halted', 'recovery-unavailable'] as const)(
      'switch refuses %s after ack',
      async (reason) => {
        const key = await activeKey()
        const recovery = await fixture.confirmedRecovery(key, { confirm: true })
        const access = await fixture.registry.access(key.groupID)
        let drained = false
        access.onRetire(async () => {
          drained = true
        })
        await hold(key, reason)
        const [event] = await fixture.safety().events(key)
        if (event === undefined) throw new Error('Missing safety event')
        await fixture.safety().ackEvent(key, event.id)
        const before = await fixture.inspectRows()
        await expect(
          fixture.registry.switchIncarnation(recovery.candidate, {
            source: recovery.source,
            rejoinID: recovery.record.id,
            proof: recovery.proof,
            write: {
              mutationID:
                'format' in recovery.record
                  ? (recovery.record.switchMutationID ?? crypto.randomUUID())
                  : crypto.randomUUID(),
              source: { rejoinID: recovery.record.id },
              destination: {
                control: {
                  cursor: {
                    position: recovery.proof.position,
                    epoch: Number(recovery.candidate.epoch),
                  },
                },
              },
            },
          }),
        ).rejects.toMatchObject({ name: 'RegistryResyncRefusedError', reason })
        expect(drained).toBe(false)
        expect(await fixture.inspectRows()).toEqual(before)
      },
    )

    test.each(['resync', 'successor'] as const)(
      'manual %s recovery remains unavailable',
      async (mode) => {
        const key = await activeKey()
        const before = await fixture.inspectRows()
        await expect(
          fixture
            .safety()
            .recover(
              key,
              mode === 'resync'
                ? { mode, targetID: 'hub' }
                : { mode, successor: { groupID: 'successor', incarnation: 1 } },
            ),
        ).rejects.toMatchObject({ name: 'ManualRecoveryUnavailableError' })
        expect(await fixture.inspectRows()).toEqual(before)
      },
    )
  })
}
