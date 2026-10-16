import { controlSafetyHeld, isHardControlHold } from './control/safety.js'
import { applyResolved } from './control/store.js'
import type { ControlSnapshot, ControlStore } from './control/types.js'
import type { AcceptedRejoinSettlement, CapturedRejoinRecord } from './recovery-types.js'

export function recoveryHeld(snapshot: ControlSnapshot): boolean {
  return controlSafetyHeld(snapshot) !== null || isHardControlHold(snapshot.controlHold)
}

/** Persist obligations before releasing the only durable copy of X's private state. */
export async function settleRecovery(params: {
  control: ControlStore
  record: CapturedRejoinRecord
  provenance:
    | { kind: 'not-accepted'; epoch: number }
    | { kind: 'accepted-unadoptable'; epoch: number; leafDigest: string }
  mutationID: string
  recoveryEpochFloor?: number | null
  signal?: AbortSignal
}): Promise<void> {
  const { control, record, provenance } = params
  const snapshot = await control.load()
  if (recoveryHeld(snapshot)) throw new Error('Recovery settlement is held')
  if (snapshot.rejoin?.id !== record.id) return
  if (
    provenance.kind === 'not-accepted' &&
    (record.stage === 'confirmed' || record.stage === 'adopted')
  )
    throw new Error('Accepted recovery cannot be discarded')
  const common = {
    id: record.id,
    origin: { sourceKey: record.source.key, target: record.target, searchFrom: record.searchFrom },
    ledgerBefore: record.ledgerBefore,
  }
  const settlement: AcceptedRejoinSettlement =
    provenance.kind === 'not-accepted'
      ? { ...common, kind: 'not-accepted', epoch: provenance.epoch }
      : {
          ...common,
          kind: 'accepted-unadoptable',
          digest: record.digest,
          payloadDigest: record.payloadDigest,
          epochAfter: record.epochAfter,
          acceptedEpoch: provenance.epoch,
          leafDigest: provenance.leafDigest,
        }
  await applyResolved(
    control,
    {
      putSettledRejoins: [settlement],
      deleteRejoin: true,
      recoveryEpochFloor:
        params.recoveryEpochFloor === undefined ? provenance.epoch : params.recoveryEpochFloor,
    },
    params.mutationID,
    undefined,
    params.signal,
  )
  record.requestKey.fill(0)
  record.candidate.fill(0)
}
