import { describe, expect, test } from 'vitest'

import type { ConformanceControlSnapshot, ConformanceSafetyHold } from './control-store.js'

export type ControlSafetyFixture = {
  prepareValid(): Promise<void>
  hold(reason: NonNullable<ConformanceSafetyHold>): Promise<void>
  prepareBuild(): Promise<'refused' | 'changed'>
  saveBuilt(): Promise<'refused' | 'changed'>
  adopt(): Promise<'refused' | 'changed'>
  snapshot(): Promise<{
    control: ConformanceControlSnapshot
    state: Uint8Array | null
    version: number
  }>
  cryptoCalls(): number
}

export function runControlSafetyContract(fixture: ControlSafetyFixture): void {
  describe('direct control safety', () => {
    for (const boundary of ['prepareBuild', 'saveBuilt', 'adopt'] as const) {
      test(`valid ${boundary} changes storage before safety`, async () => {
        await fixture.prepareValid()
        const before = await fixture.snapshot()
        expect(await fixture[boundary]()).toBe('changed')
        expect(await fixture.snapshot()).not.toEqual(before)
      })
    }
    for (const reason of ['fork-halted', 'recovery-unavailable'] as const) {
      for (const boundary of ['prepareBuild', 'saveBuilt', 'adopt'] as const) {
        test(`field-only ${reason} refuses ${boundary} without storage or crypto changes`, async () => {
          await fixture.prepareValid()
          await fixture.hold(reason)
          const before = await fixture.snapshot()
          expect(before.control.strand).toBeNull()
          expect(before.control.controlHold).toBeNull()
          expect(before.control.cursor?.stranded).not.toBe(true)
          expect(
            before.control[reason === 'fork-halted' ? 'forkHalt' : 'recoveryUnavailable'],
          ).not.toBeNull()
          const cryptoCalls = fixture.cryptoCalls()
          expect(await fixture[boundary]()).toBe('refused')
          expect(await fixture.snapshot()).toEqual(before)
          expect(fixture.cryptoCalls()).toBe(cryptoCalls)
        })
      }
    }
  })
}
