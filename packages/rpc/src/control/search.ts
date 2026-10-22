import type { CommitHeader } from '../crypto.js'
import type { LogPosition } from '../cursor.js'
import type { AdoptionExpected, AppliedCommit, BuiltCommit, CommitCursor } from './types.js'

export type ControlLogFrame = { position: LogPosition; payload: Uint8Array; senderDID: string }
export type ControlFrameValidation =
  // Own means receiver-eligible recognition of the saved work, not just local authorship.
  | { kind: 'valid'; header: CommitHeader; own: boolean; advanced: boolean; removed: boolean }
  | { kind: 'invalid'; reason: 'non-commit' | 'malformed' | 'authentication' | 'policy' }
  | {
      kind: 'unavailable'
      reason:
        | 'unsupported-version'
        | 'missing-proposal'
        | 'missing-key'
        | 'resolver'
        | 'unrecognised'
        | 'unexplained-own'
    }
export type ControlValidation = {
  source: AdoptionExpected
  readCommitHeader(commit: Uint8Array): Promise<CommitHeader | null>
  validateFrame(
    frame: ControlLogFrame,
    built: BuiltCommit,
    header?: CommitHeader | null,
  ): Promise<ControlFrameValidation>
  verifyOwn(built: BuiltCommit): Promise<boolean>
}
export type ControlValidationPort = {
  restoreValidation(built: BuiltCommit): Promise<ControlValidation | null>
}
export type ControlEvidenceSnapshot = {
  source: AdoptionExpected
  applied: Array<AppliedCommit>
  cursor: CommitCursor | null
  terminal: boolean
}
export type { GroupForkEvidence } from './safety.js'
export type ControlHold = {
  reason: 'unsupported-version'
  position: LogPosition | null
}
