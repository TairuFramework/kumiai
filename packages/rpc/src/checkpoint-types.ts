import type { ForkHalt, GroupConditionEvent } from './control/safety.js'
import type { GroupKey } from './control/types.js'
import type {
  ForkNotice,
  ForkNoticeEvent,
  OwnBranchMessage,
  ReportCoverage,
} from './fork-notice.js'
import type {
  AcceptedRejoinSettlement,
  CapturedRejoinRecord,
  ForkRecoveryAuthorisation,
} from './recovery-types.js'

export type BranchReportCoverage = {
  ancestry: ReportCoverage
  ownMessages: ReportCoverage
  othersSeen: ReportCoverage
  membership: ReportCoverage
  ephemeral: ReportCoverage
}
export type AbandonedEpochRange = { from: number; through: number } | 'unknown'
export type BranchAbandonedEvent = GroupKey & {
  id: string
  kind: 'branch-abandoned'
  noticeID: string | null
  epochs: AbandonedEpochRange
  ownMessages: Array<OwnBranchMessage>
  othersSeen: number
  membersAdded: Array<string>
  membersRemoved: Array<string>
  coverage: BranchReportCoverage
}

export type CheckpointComparison =
  | { kind: 'agreement'; epoch: number; signerDID: string; keyHash: string }
  | {
      kind: 'conflict'
      epoch: number
      signerDID: string
      keyHash: string
      localAuthHash: string
      remoteAuthHash: string
      parentAuthHash: string | null
    }
  | { kind: 'invalid' | 'coverage-gap' }

export type CheckpointCoverage = {
  groupID: string
  current: { key: GroupKey; epoch: number } | null
  retained: Array<{ key: GroupKey; from: number; through: number }>
  effectiveFloor: number | null
  gaps: Array<{
    key: GroupKey
    from: number
    through: number
    reason: 'pre-join' | 'skipped' | 'expired'
  }>
}

export type CheckpointPort = {
  signInstalled(factID: string): Promise<Uint8Array | null>
  compare(key: GroupKey, frame: Uint8Array): Promise<CheckpointComparison>
  exportCheckpoints(key: GroupKey, epochs?: Array<number>): Promise<Array<Uint8Array>>
  checkpointFact(key: GroupKey, epoch: number): Promise<Uint8Array | null>
  checkpointCoverage(groupID: string): Promise<CheckpointCoverage>
}

export type CheckpointService = CheckpointPort & {
  importCheckpoint(key: GroupKey, frame: Uint8Array): Promise<void>
  forkNotices(groupID: string): Promise<Array<ForkNotice>>
  ackForkNotice(groupID: string, id: string, revision: number): Promise<void>
  events(groupID: string): Promise<Array<ForkNoticeEvent>>
  readRecords(): Promise<Array<CheckpointRecord>>
  updateRecords(change: { put?: Array<CheckpointRecord>; remove?: Array<string> }): Promise<void>
}

export type PersistedManualRecovery =
  | { mode: 'resync'; targetID: string; commitTopicID: string; allowOpenFork: boolean }
  | { mode: 'successor'; successor: GroupKey }
export type ManualRecoveryRecord = {
  id: string
  source: GroupKey
  choice: PersistedManualRecovery
  stage: 'authorised' | 'completed'
  pauseReason: 'target-unresolved' | null
  destination: GroupKey | null
  attempt: CapturedRejoinRecord | null
  epochFloor: number | null
  settlements: Array<AcceptedRejoinSettlement>
  mutationID: string
  /** A fork recovery intent this authorisation abandoned; the device stays known-behind. */
  abandonedForkRecovery?: string
}
export type ManualRecoveryStatus = {
  id: string
  kind: 'pending' | 'paused' | 'completed'
  reason: 'target-unresolved' | null
}

/** Blocks readmission of a source retired in favour of an admitted successor until the app clears it. */
export type SuccessorTombstone = {
  kind: 'successor-tombstone'
  id: string
  source: GroupKey
  successor: GroupKey
  authorisationID: string
  retiredAt: number
  clearedAt: number | null
}

export type CheckpointRecord =
  | { kind: 'manual-recovery'; id: string; key: GroupKey; value: ManualRecoveryRecord }
  | { kind: 'successor'; id: string; key: GroupKey; value: SuccessorTombstone }
  | {
      kind: 'branch-abandonment'
      id: string
      key: GroupKey
      event: BranchAbandonedEvent
      factIDs: Array<string>
      acknowledgedAt: number | null
    }
  | {
      kind: 'own-branch-messages'
      id: string
      key: GroupKey
      epoch: number
      authHash: string
      messages: Array<OwnBranchMessage>
    }
  | {
      kind: 'others-seen'
      id: string
      key: GroupKey
      epoch: number
      authHash: string
      count: number
    }
  | {
      kind: 'branch-coverage'
      id: string
      key: GroupKey
      startedEpoch: number
      startedAuthHash: string
    }
  | {
      kind: 'app-hold'
      id: string
      key: GroupKey
      producer: 'app-report'
      eventID: string
      reportMutationID: string
      clearedAt: number | null
    }
  | { kind: 'hold-history'; id: string; key: GroupKey; halt: ForkHalt; reportMutationID: string }
  | {
      kind: 'superseded-rejoin'
      id: string
      key: GroupKey
      record: CapturedRejoinRecord
      authorisation: ForkRecoveryAuthorisation
    }
  | {
      kind: 'condition'
      id: string
      key: GroupKey
      event: GroupConditionEvent
      active: boolean
      notification?: { emitAt: number; emitted: boolean; installationID: string }
      sealedProof: Uint8Array | null
    }
  | {
      kind: 'notice-tombstone'
      id: string
      key: GroupKey
      noticeID: string
      acknowledgedRevision: number
      acknowledgedAt: number | null
      frames: Array<{ hash: string; installationID: string }>
    }
  | { kind: 'notice'; id: string; key: GroupKey; notice: ForkNotice }
  | {
      kind: 'evidence'
      id: string
      key: GroupKey
      noticeID: string
      first: Uint8Array
      second: Uint8Array
      localRosterFact: Uint8Array
      eligibilityRosterFact: Uint8Array | null
    }
  | {
      kind: 'notice-event'
      id: string
      key: GroupKey
      event: ForkNoticeEvent
      emitAt: number
      acknowledged: boolean
    }
  | {
      kind: 'fact'
      id: string
      key: GroupKey
      epoch: number
      canonical: Uint8Array
      supersededAt: number | null
    }
  | {
      kind: 'publication'
      id: string
      key: GroupKey
      factID: string
      frame: Uint8Array | null
      publishID: string | null
      accepted: boolean
      nextHeartbeatAt: number | null
      retryAt?: number
      retryDelay?: number
    }
  | {
      kind: 'cursor'
      id: string
      key: GroupKey
      topicID: string
      position: string | null
      /** Compare these bytes atomically with the cursor write, then omit them from storage. */
      intake?: Uint8Array
      schedule?: {
        clock: number
        tokens: number
        refilledAt: number
        receiveAt: number
        retryDelay: number
      }
    }
  | {
      kind: 'coverage'
      id: string
      key: GroupKey
      current: { key: GroupKey; epoch: number } | null
      effectiveFloor: number | null
      gaps: CheckpointCoverage['gaps']
      installations: Array<{ id: string; key: GroupKey; epoch: number }>
    }

export type CheckpointFactRecord = Extract<CheckpointRecord, { kind: 'fact' }>

// Records are data. Installation provenance and signing authority belong to the coordinator.
export type CheckpointStore = {
  load(id: string): Promise<CheckpointRecord | null>
  list(): Promise<Array<CheckpointRecord>>
  put(record: CheckpointRecord): Promise<void>
  remove(ids: Array<string>): Promise<void>
}
