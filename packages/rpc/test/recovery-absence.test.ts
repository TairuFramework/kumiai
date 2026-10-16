import { createMemoryControlStore, testRosterAbsenceConformance } from '@kumiai/rpc-conformance'
import { expect, expectTypeOf, test } from 'vitest'

import { controlSafetyHeld as mirrorSafetyHeld } from '../../rpc-conformance/src/memory-control-store.js'
import { controlSafetyHeld, type GroupCondition, type SafetyHold } from '../src/control/safety.js'
import type { SendAdmission } from '../src/crypto.js'
import type { LogPosition } from '../src/cursor.js'
import { GroupNotMemberError, SpentSetCorruptError } from '../src/errors.js'
import { createRosterAbsenceMemoryFixture } from './fixtures/memory-captured-recovery.js'

test.each(['clear', 'stranded', 'fork-halted', 'recovery-unavailable'] as const)(
  'not member diagnostic adds no admission refusal with identical %s facts',
  async (fact) => {
    const key = { groupID: 'condition-admission', incarnation: 1 }
    const store = createMemoryControlStore<LogPosition>(key)
    if (fact === 'fork-halted')
      await store.apply(
        {
          forkHalt: {
            eventID: JSON.stringify(['group:fork', key.groupID, 1]),
            detectedAt: 1,
            evidence: {
              kind: 'unexplained-own-commit',
              epoch: 1,
              position: 'head',
              digest: 'conflict',
            },
          },
        },
        'hold',
      )
    if (fact === 'recovery-unavailable')
      await store.apply(
        {
          recoveryUnavailable: {
            ...key,
            id: JSON.stringify(['group:recovery-unavailable', key.groupID, 1]),
            kind: 'group:recovery-unavailable',
            reason: 'trust-unreadable',
          },
        },
        'unavailable',
      )
    if (fact === 'stranded') await store.apply({ strand: { reason: 'lost-state' } }, 'strand')
    const snapshot = await store.load()
    const ordinary: SendAdmission =
      fact === 'stranded'
        ? { epoch: 1, admissible: false, reason: 'stranded' }
        : { epoch: 1, admissible: true }
    for (const project of [controlSafetyHeld, mirrorSafetyHeld]) {
      const before = project(snapshot)
      const diagnosed = project(snapshot, 'not-member')
      expect(diagnosed).toBe(before)
      const admission =
        diagnosed === null ? ordinary : { epoch: 1, admissible: false, reason: diagnosed }
      expect(admission).toEqual(
        before === null ? ordinary : { epoch: 1, admissible: false, reason: before },
      )
      expect(project(snapshot, 'spent-set-corrupt')).toBe(
        fact === 'fork-halted' ? 'fork-halted' : 'spent-set-corrupt',
      )
    }
  },
)

testRosterAbsenceConformance({
  label: 'independent double',
  createFixture: createRosterAbsenceMemoryFixture,
})

test.each([GroupNotMemberError, SpentSetCorruptError])(
  'condition errors preserve exact group key: %s',
  (ErrorType) => {
    const key = { groupID: 'exact-group', incarnation: 7 }
    const cause = new Error('diagnostic cause')
    const error = new ErrorType({ key, cause })
    key.groupID = 'changed'
    key.incarnation = 8
    expect(error.key).toEqual({ groupID: 'exact-group', incarnation: 7 })
    error.key.incarnation = 9
    expect(error.key).toEqual({ groupID: 'exact-group', incarnation: 7 })
    expect(error.cause).toBe(cause)
    expect(error.name).toBe(ErrorType.name)
  },
)

test('not member diagnostic adds no admission refusal', async () => {
  type Refusal = Extract<SendAdmission, { admissible: false }>['reason']
  expectTypeOf<Extract<Refusal, 'not-member'>>().toEqualTypeOf<never>()
  expectTypeOf<Extract<SafetyHold, 'not-member'>>().toEqualTypeOf<never>()
  expectTypeOf<Extract<Refusal, 'spent-set-corrupt'>>().toEqualTypeOf<'spent-set-corrupt'>()
  expectTypeOf<GroupCondition>().toEqualTypeOf<'not-member' | 'spent-set-corrupt'>()
  const fixture = await createRosterAbsenceMemoryFixture()
  try {
    const before = fixture.requester.sendAdmission()
    const { request, requestKey } = await fixture.requester.createRecoveryRequest(
      'diagnostic',
      undefined,
      1,
    )
    const evidence = await fixture.responder.capturedRecovery?.sealRosterAbsence?.(request, null)
    if (evidence == null) throw new Error('Missing roster evidence')
    expect(
      await fixture.requester.capturedRecovery?.checkRosterAbsence?.(
        evidence,
        'diagnostic',
        requestKey,
      ),
    ).not.toBeNull()
    expect(fixture.requester.sendAdmission()).toEqual(before)
  } finally {
    await fixture.close()
  }
})
