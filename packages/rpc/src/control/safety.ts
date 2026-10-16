import type { ControlHold } from './search.js'
import type { ControlSnapshot, GroupKey } from './types.js'

export function isHardControlHold(hold: ControlHold | null): boolean {
  return hold !== null && hold.reason !== 'acceptance-unknown'
}

export type GroupForkEvidence =
  | {
      kind: 'digest-divergence'
      epoch: number
      position: string
      localDigest: string
      remoteDigest: string
    }
  | { kind: 'epoch-authenticator'; epoch: number; local: Uint8Array; remote: Uint8Array }
  | { kind: 'unexplained-own-commit'; epoch: number; position: string; digest: string }

export type GroupCondition = 'not-member' | 'spent-set-corrupt'
export type NotMemberEvidence = {
  responderKeyHash: string
  epoch: number
  authHash: string
  observedAt: number
  responderDIDs: Array<string>
  responderCount: number
}
export type GroupConditionEvent = GroupKey & {
  id: string
  kind: GroupCondition
  detectedAt: number
  evidence: NotMemberEvidence | null
}
export type SafetyHold = 'fork-halted' | 'spent-set-corrupt' | 'recovery-unavailable' | null
export type ForkHalt = { eventID: string; evidence: GroupForkEvidence; detectedAt: number }
export type GroupSafetyEvent = GroupKey & { id: string; kind: 'group:fork'; halt: ForkHalt }
export type RecoveryUnavailableEvent = GroupKey & {
  id: string
  kind: 'group:recovery-unavailable'
  reason: 'trust-unreadable'
}

export function forkEventID(key: GroupKey): string {
  return JSON.stringify(['group:fork', key.groupID, key.incarnation])
}

export function recoveryUnavailableEventID(key: GroupKey): string {
  return JSON.stringify(['group:recovery-unavailable', key.groupID, key.incarnation])
}

export function controlSafetyHeld(
  snapshot: ControlSnapshot,
  condition?: GroupCondition | null,
): SafetyHold {
  if (snapshot.forkHalt !== null) return 'fork-halted'
  if (condition === 'spent-set-corrupt') return 'spent-set-corrupt'
  if (snapshot.recoveryUnavailable !== null) return 'recovery-unavailable'
  return null
}
