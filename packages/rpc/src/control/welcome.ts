import { toB64U } from '@sozai/codec'

import { applyResolved } from './store.js'
import type { ControlSnapshot, ControlStore, WelcomeObligation } from './types.js'

export async function deliverObligations(
  deps: { control: ControlStore; deliverWelcome(obligation: WelcomeObligation): Promise<void> },
  snapshot: ControlSnapshot,
): Promise<void> {
  for (const obligation of snapshot.welcomes) {
    await deps.deliverWelcome(obligation)
    await applyResolved(
      deps.control,
      { deleteWelcomes: [obligation.opID] },
      toB64U(crypto.getRandomValues(new Uint8Array(16))),
    )
  }
}
