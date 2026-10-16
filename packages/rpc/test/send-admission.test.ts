import { assertType, expect, expectTypeOf, test } from 'vitest'

import type { SendAdmission } from '../src/crypto.js'
import { SendNotAdmissibleError } from '../src/errors.js'

const reasons = [
  'lapsed',
  'rotation-required',
  'stranded',
  'fork-halted',
  'terminal',
  'backup-restored',
  'recovery-unavailable',
  'spent-set-corrupt',
] as const

test('send admission accepts every variant', () => {
  assertType<SendAdmission>({ epoch: 7, admissible: true })
  assertType<SendAdmission>({ epoch: 7, admissible: false, reason: 'lapsed' })
  assertType<SendAdmission>({ epoch: 7, admissible: false, reason: 'rotation-required' })
  assertType<SendAdmission>({ epoch: 7, admissible: false, reason: 'stranded' })
  assertType<SendAdmission>({ epoch: 7, admissible: false, reason: 'fork-halted' })
  assertType<SendAdmission>({ epoch: 7, admissible: false, reason: 'terminal' })
  assertType<SendAdmission>({ epoch: 7, admissible: false, reason: 'backup-restored' })
  assertType<SendAdmission>({ epoch: 7, admissible: false, reason: 'recovery-unavailable' })
  assertType<SendAdmission>({ epoch: 7, admissible: false, reason: 'spent-set-corrupt' })
})

test('admission error accepts and exposes the complete reason union', () => {
  type Reason = (typeof reasons)[number]
  expectTypeOf<Extract<SendAdmission, { admissible: false }>['reason']>().toEqualTypeOf<Reason>()
  expectTypeOf<ConstructorParameters<typeof SendNotAdmissibleError>>().toEqualTypeOf<[Reason]>()
  expectTypeOf<SendNotAdmissibleError['reason']>().toEqualTypeOf<Reason>()
})

test('admission error preserves every reason', () => {
  for (const reason of reasons) {
    const error = new SendNotAdmissibleError(reason)
    expect(error.reason).toBe(reason)
  }
})
