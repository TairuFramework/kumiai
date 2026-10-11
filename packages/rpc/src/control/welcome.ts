import { toB64U } from '@sozai/codec'

import { applyResolved } from './store.js'
import type { ControlSnapshot, ControlStore, WelcomeObligation } from './types.js'

export async function deliverObligations(
  deps: {
    signal?: AbortSignal
    control: ControlStore
    canDeliver(obligation: WelcomeObligation): Promise<boolean>
    deliverWelcome(obligation: WelcomeObligation): Promise<void>
  },
  snapshot: ControlSnapshot,
): Promise<void> {
  const failures: Array<unknown> = []
  for (const obligation of snapshot.welcomes) {
    try {
      if (!(await deps.canDeliver(obligation))) continue
      await deps.deliverWelcome(obligation)
      await applyResolved(
        deps.control,
        { deleteWelcomes: [obligation.opID] },
        toB64U(crypto.getRandomValues(new Uint8Array(16))),
        undefined,
        deps.signal,
      )
    } catch (error) {
      failures.push(error)
    }
  }
  // Schedule retries only after every recipient has had a delivery attempt.
  if (failures.length !== 0)
    throw new AggregateError(failures, 'Welcome obligations remain pending')
}
