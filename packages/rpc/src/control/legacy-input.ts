import type { LogPosition } from '../cursor.js'
import type { BuiltCommit, ControlSnapshot, Operation } from './types.js'

/** Input only. Never pass a main journal to the control-journal decoder. */
export type LegacyMainJournal = {
  publishID: string
  expectedHead: string | null
  epoch: number
  holdsLogSends?: true
  acceptedAs?: string
  commit: Uint8Array
  bodies: Array<string>
  kind: 'ledger' | 'invite' | 'remove'
  journal: Uint8Array
}
export type LegacyControlSlot = Omit<
  BuiltCommit,
  'kind' | 'revokes' | 'enqueuedAt' | 'deadline' | 'head' | 'reported' | 'skipped' | 'acceptedAs'
> & { searchFrom?: LogPosition | null; uncertainty?: unknown }
export type LegacyControlOperation = Omit<Operation, 'stage'> & {
  stage: 'intent' | 'built' | 'accepted'
  built?: Pick<LegacyControlSlot, 'incarnation' | 'epoch' | 'publishID' | 'payloadDigest'>
  pendingPublish?: { expectedHead: LogPosition | null }
  hubAcceptedAt?: LogPosition
  acceptedAs?: LogPosition
  acceptance?: unknown
  unknownReported?: true
  reconciliation?: { slot: LegacyControlSlot; acceptance: unknown; uncertainty?: unknown }
}
export type LegacyControlSnapshot = Omit<
  ControlSnapshot,
  'schemaVersion' | 'commitOnce' | 'spentSource' | 'operations' | 'welcomes' | 'controlHold'
> & {
  schemaVersion?: undefined
  controlHold: {
    reason: 'acceptance-unknown' | 'unsupported-version'
    position: LogPosition | null
    cause?: 'unavailable' | 'gap' | 'ahead' | 'copy-mismatch'
  } | null
  commitOnce: LegacyControlSlot | null
  commitOnceAcceptance?: unknown
  uncertainty?: unknown
  spentSource?: { epoch: number } | null
  operations: Array<LegacyControlOperation>
  welcomes: Array<{
    opID: string
    welcome: Uint8Array
    recipients: Array<string>
    committed?: boolean
  }>
}
