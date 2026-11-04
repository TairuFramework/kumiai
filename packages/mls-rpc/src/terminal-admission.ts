import { PeerRemovedError, type SendAdmission } from '@kumiai/rpc'

/** Call after the last await, while the exact incarnation's admission is still published. */
export function assertNotTerminal(access: { admission(): SendAdmission }): void {
  const admission = access.admission()
  if (!admission.admissible && admission.reason === 'terminal') throw new PeerRemovedError()
}
