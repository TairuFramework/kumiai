import type { ControlSnapshot, GroupKey } from './types.js'

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

export type SafetyHold = 'fork-halted' | 'recovery-unavailable' | null
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

export function controlSafetyHeld(snapshot: ControlSnapshot): SafetyHold {
  if (snapshot.forkHalt !== null) return 'fork-halted'
  if (snapshot.recoveryUnavailable !== null) return 'recovery-unavailable'
  return null
}
