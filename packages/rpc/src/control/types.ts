import type { RecoveryRefusalReason } from '../crypto.js'
import type { LogPosition } from '../cursor.js'
import type { ForkHalt, RecoveryUnavailableEvent } from './safety.js'
import type { ControlHold } from './search.js'

export type GroupKey = { groupID: string; incarnation: number }
export type EpochIdentity = GroupKey & { epoch: number; authenticator: Uint8Array }
export type AdoptionExpected = {
  key: GroupKey
  stateVersion: number
  identity: EpochIdentity | null
}
export type ControlSource = AdoptionExpected & { epoch: number; authenticator: Uint8Array }
export type FirstValidCommit = {
  source: AdoptionExpected
  from: LogPosition | null
  position: LogPosition
  payloadDigest: string
}
export type CommitSearchResult =
  | { kind: 'first-valid'; proof: FirstValidCommit }
  | { kind: 'superseded'; winner: LogPosition }
  | { kind: 'absent' }
  | { kind: 'unknown' }
export type ControlSearchPort = {
  searchLog(built: BuiltCommit, position?: LogPosition): Promise<CommitSearchResult>
}
export type ControlSlot = BuiltCommit & { opID: string }
export type ControlBuildRef = Pick<
  BuiltCommit,
  'incarnation' | 'epoch' | 'publishID' | 'payloadDigest'
>
export type HostBuilt = Pick<
  BuiltCommit,
  'incarnation' | 'epoch' | 'authenticatorBefore' | 'digest' | 'bodies' | 'journal' | 'welcome'
> & { commit: Uint8Array }

export type ControlSnapshot = {
  commitOnce: ControlSlot | null
  commitOnceAcceptance: FirstValidCommit | null
  controlHold: ControlHold | null
  forkHalt: ForkHalt | null
  recoveryUnavailable: RecoveryUnavailableEvent | null
  strand: {
    reason: 'retention-gap' | 'unprocessable-gap' | 'lost-state' | 'ahead' | 'unsupported-version'
  } | null
  operations: Array<Operation> // FIFO by `seq`
  rejoin: RejoinRecord | null
  outcomes: Array<Outcome>
  welcomes: Array<WelcomeObligation>
  applied: Array<AppliedCommit> // newest 64 epochs
  responses: Array<ExternalResponse> // responder outcomes, newest 64 epochs
  cursor: CommitCursor | null // {position, epoch, stranded?}
}
export type ControlChanges = {
  commitOnce?: ControlSlot | null
  commitOnceAcceptance?: FirstValidCommit | null
  controlHold?: ControlHold | null
  forkHalt?: ForkHalt
  recoveryUnavailable?: RecoveryUnavailableEvent
  strand?: ControlSnapshot['strand']
  putOperations?: Array<Operation>
  deleteOperations?: Array<string>
  putRejoin?: RejoinRecord
  deleteRejoin?: true
  putOutcomes?: Array<Outcome>
  deleteOutcomes?: Array<string>
  putWelcomes?: Array<WelcomeObligation>
  deleteWelcomes?: Array<string>
  putApplied?: Array<AppliedCommit>
  deleteAppliedBelow?: number // drops rows at epoch < n, before puts
  putResponses?: Array<ExternalResponse>
  deleteResponsesBelow?: number // by `epoch`
  cursor?: CommitCursor | null
}
/** Control changes committed with an adoption's state save (D5). */
export type AdoptionWrite = {
  expected?: AdoptionExpected & { acceptance?: FirstValidCommit; journal?: Uint8Array }
  changes: ControlChanges
  mutationID: string
  /** The `advance` of the pending anchor rotation this adoption lands, marked in the same transaction. */
  anchorLanded?: string
}
export type ControlAdoptionPort = {
  adopt(
    journal: Uint8Array,
    expected: AdoptionExpected & { acceptance: FirstValidCommit },
    write: AdoptionWrite,
  ): Promise<'installed' | 'noop' | 'moved'>
}
export type ControlStore = {
  key: GroupKey
  load(): Promise<ControlSnapshot>
  /** All or nothing. On an ambiguous commit, rejects with `StorageOutcomeUnknownError`. */
  apply(changes: ControlChanges, mutationID: string): Promise<void>
  /** The `mutationID` of the last committed `apply`. */
  lastMutation(): Promise<string | null>
}

export type OperationRequest = {
  /** Random 128-bit; the host's handle for outcomes. */
  id: string
  kind: 'invite' | 'remove' | 'ledger' | 'rotation'
  /** Holds app sends (the revoke hold, below) from enqueue until the operation settles. */
  revokes: boolean
  /** Host-opaque; everything `build` needs, such as targets, role and signed tokens. */
  body: Uint8Array
}
/** The operation deadline is `enqueuedAt + operationTimeoutMs`, so a restart keeps it. */
export type Operation = OperationRequest & {
  seq: number
  enqueuedAt: number
  deadline: number
  /** Persisted before handoff. Absence at this head cannot exclude a delayed CAS. */
  pendingPublish?: { expectedHead: LogPosition | null }
} & (
    | { stage: 'intent' }
    | { stage: 'built'; built: ControlBuildRef }
    | {
        stage: 'accepted'
        built: ControlBuildRef
        acceptedAs: LogPosition
        acceptance: FirstValidCommit
      }
  )
export type BuiltCommit = {
  incarnation: number
  searchFrom: LogPosition | null
  publishID: string
  expectedHead: LogPosition | null
  /** Identity of the state the commit was built from. */
  epoch: number
  authenticatorBefore: Uint8Array
  /** The exact framed hub payload, with bodies sealed once. Replay publishes these bytes. */
  payload: Uint8Array
  /** SHA-256 of `payload`: acceptance discovery matches this. */
  payloadDigest: string
  /** Digest of the MLS commit alone (`digestAppliedCommit`): fork classification only. */
  digest: string
  bodies: Array<string>
  /** Host blob: the post-commit candidate state and anything needed to adopt it. */
  journal: Uint8Array
  /** The complete host-encoded invitation artifact (D4), or null. */
  welcome: { bytes: Uint8Array; recipients: Array<string> } | null
}

export type Outcome = { id: string; opID: string | null; at: number } & (
  | { kind: 'landed'; position: LogPosition }
  | { kind: 'lost' } // absent from the branch this device follows
  | { kind: 'unknown' } // absence not provable, or touched by a fork (D5)
  | { kind: 'reenact'; tokens: Array<string> } // ledger tokens missing after a rejoin
  | { kind: 'rejected'; reason: string } // build refused, e.g. not authorised
  | { kind: 'refused'; reason: RecoveryRefusal } // a rejoin refused by policy (D6)
)

export type RejoinRecord = {
  /** Random per rejoin. */
  id: string
  stage: 'built' | 'published' | 'confirmed' | 'adopted' | 'refused'
  publishID: string
  expectedHead: LogPosition | null
  /** The exact framed external-commit payload. Framing seals with a random nonce, so it cannot be
   *  re-derived (`rpc/src/peer.ts:1781`, `mls-rpc/src/crypto.ts:64`). */
  payload: Uint8Array
  payloadDigest: string
  requestID: string
  request: Uint8Array
  /** Secret. Today it lives in a 120 s memory map (`mls-rpc/src/mls.ts:135-173`). */
  requestKey: Uint8Array
  /**
   * `PendingRecovery.serialize()`: the candidate state plus everything verdict judgment reads, the
   * source tree, the known registry and the confirmation tuple (`mls-rpc/src/recovery.ts:206-207`),
   * and the binding's `holderGrant`, which is part of the binding identity
   * (`mls-rpc/src/recovery.ts:99-108`). Secret.
   */
  candidate: Uint8Array
  /** Identity of the state the rejoin replaces; re-checked before adoption. */
  source: { key: GroupKey; epoch: number; authenticator: Uint8Array; head: LogPosition | null }
  digest: string
  epochAfter: number
  /** Ledger tokens held before the rejoin, for `reenact`. */
  ledgerBefore: Array<string>
  /** Reserved conflict epoch; new recovery attempts leave it null. */
  conflictEpoch: number | null
  position?: LogPosition
  verdict?: Uint8Array
  /** Set with stage `refused`. */
  refusal?: RecoveryRefusal
}
export type RecoveryRefusal = RecoveryRefusalReason
export type WelcomeObligation = {
  opID: string
  welcome: Uint8Array
  recipients: Array<string>
  committed?: true
}
export type AppliedCommit = {
  epoch: number
  digest: string
  payloadDigest: string
  sequenceID: string
  opID: string | null
  removed: boolean
}
export type ExternalResponse = {
  position: LogPosition
  digest: string
  kind: 'applied' | 'refused' | 'superseded'
  epoch: number
  reason?: RecoveryRefusal
  epochAfter?: number
}
export type CommitCursor = {
  position: LogPosition | null
  epoch: number
  stranded?: true
}

export type StagedAdoption = {
  incarnation: number
  epochAfter: number
  removed: boolean
  epochAuthenticator: Uint8Array
}
export type AdoptionWriteFactory = (staged: StagedAdoption) => AdoptionWrite
