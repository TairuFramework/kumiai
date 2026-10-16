import type { ConformanceCheckpointRecord } from './checkpoint.js'
/**
 * Conformance suite for the `GroupMLS` consumer port of `@kumiai/rpc`.
 *
 * `GroupMLS` is the lifecycle half of the seam `GroupCrypto` opens: it reads a Commit's own claims
 * before the peer touches it, applies the ones this member is in a position to apply, and reports
 * the roster the apply left behind. Every clause below is a place a double answered where the real
 * port refuses — a header that named a committer the real port cannot authenticate, a commit
 * modelled as a value to adopt when ts-mls advances the handle in place — and each of those
 * shapes, carried across to a host, is silent data loss or a peer that reports itself reconciled
 * at a dead epoch.
 *
 * The port shape is re-declared STRUCTURALLY, for the reason given in `./group-crypto.js`.
 *
 * @module rpc-conformance/group-mls
 */

import { describe, expect, test } from 'vitest'

import type {
  ConformanceAdoptionExpected,
  ConformanceAdoptionWrite,
  ConformanceBuiltCommit,
  ConformanceCapturedRejoinRecord,
  ConformanceControlSnapshot,
  ConformanceForkRecoveryAuthorisation,
  ConformanceGroupKey,
  ConformanceRecoverySource,
  ConformanceRecoveryTargetCapture,
  ConformanceResyncProof,
  ConformanceStoredRejoinRecord,
} from './control-store.js'

export type ConformanceControlFrameValidation =
  | {
      kind: 'valid'
      header: ConformanceCommitHeader
      own: boolean
      advanced: boolean
      removed: boolean
    }
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

export type ConformanceControlValidation<Position extends string = string> = {
  source: ConformanceAdoptionExpected
  readCommitHeader(commit: Uint8Array): Promise<ConformanceCommitHeader | null>
  validateFrame(
    frame: { position: Position; payload: Uint8Array; senderDID: string },
    built: ConformanceBuiltCommit<Position>,
    header?: ConformanceCommitHeader | null,
  ): Promise<ConformanceControlFrameValidation>
  verifyOwn(built: ConformanceBuiltCommit<Position>): Promise<boolean>
}

export type ConformanceControlValidationPort<Position extends string = string> = {
  restoreValidation(
    built: ConformanceBuiltCommit<Position>,
  ): Promise<ConformanceControlValidation<Position> | null>
}

/** The `CommitHeader` of `@kumiai/rpc`, re-declared structurally. */
export type ConformanceCommitHeader = {
  epoch: number
  committerDID?: string
  external?: boolean
}

/** The `CommitContext` of `@kumiai/rpc`, re-declared structurally. */
export type ConformanceCommitContext = {
  /** Suite writes omit positions so host-specific position brands remain assignable. */
  adoption?: (staged: {
    incarnation: number
    epochAfter: number
    removed: boolean
    epochAuthenticator: Uint8Array
  }) => ConformanceAdoptionWrite<never>
  senderDID?: string
  resolveLedgerEntries?: (ids: Array<string>) => Promise<Array<string>>
}

/** The `PendingRecovery` of `@kumiai/rpc`, re-declared structurally. */
export type ConformanceRecoveryRefusalReason = 'binding' | 'lapse' | 'floor' | 'policy' | 'invalid'
export type ConformanceRecoveryVerdict = {
  groupID: string
  requestID: string
  position: string
  commitDigest: string
} & (
  | { verdict: 'confirmed'; epoch: number; tag: string }
  | { verdict: 'superseded' }
  | {
      verdict: 'refused'
      reason: ConformanceRecoveryRefusalReason
      refusalAuthority?: 'authenticated-commit'
    }
)
export type ConformanceOpenedRecoveryVerdict = {
  signer: string
  verdict: ConformanceRecoveryVerdict
}
export type ConformanceVerifiedRecoveryRequest = {
  groupID: string
  requestID: string
  requesterDID: string
}
export type ConformanceConfirmationKey = { epoch: number; key: Uint8Array }
export type ConformanceSendAdmission =
  | { epoch: number; admissible: true }
  | {
      epoch: number
      admissible: false
      reason:
        | 'lapsed'
        | 'rotation-required'
        | 'stranded'
        | 'fork-halted'
        | 'terminal'
        | 'backup-restored'
        | 'recovery-unavailable'
        | 'spent-set-corrupt'
    }
export type ConformanceProcessCommitResult = {
  applied: boolean
  advanced: boolean
  epochBefore: number
  epochAfter: number
  refusal?: ConformanceRecoveryRefusalReason
  validation?: 'unavailable'
}
export type ConformanceAppliedRecovery =
  | ConformancePendingRecovery
  | { renewalRequired: true }
  | null
export type ConformanceBoundRecovery = {
  requester: ConformanceGroupMLS
  responder: ConformanceGroupMLS
  ratchet: () => Promise<void>
  replaceBinding: () => Promise<void>
}
export type ConformanceLegacyPendingRecovery = {
  epoch: number
  markBindingUnusable: () => void
  confirmationKey: (position: string, commitDigest: string) => Promise<Uint8Array>
  judgeVerdict: (opened: ConformanceOpenedRecoveryVerdict) => 'authoritative' | 'advisory'
  commit: Uint8Array
  serialize: () => Uint8Array
  onAccepted(write: NonNullable<ConformanceCommitContext['adoption']>): Promise<void>
}

export type ConformancePendingRecovery = ConformanceLegacyPendingRecovery

export type ConformanceRestoredPendingRecovery = Omit<ConformancePendingRecovery, 'onAccepted'> & {
  onAccepted(write: NonNullable<ConformanceCommitContext['adoption']>): Promise<void>
}

/** The `RosterEntry` of `@kumiai/rpc`, re-declared structurally. */
export type ConformanceRosterEntry = {
  did: string
  leafIndex: number
  longForm: string
}

/**
 * The `GroupMLS` this suite exercises — ALL of it.
 *
 * An earlier version left the recovery and ledger half out, on the reasoning that it is "a
 * multi-party rendezvous whose harness would be most of a peer". That was wrong, and the omission
 * was invisible: eight of twelve port members had no contract, on the two lanes that carry a
 * group's whole authority state. The rendezvous is a lane concern; the PORT is three calls
 * passing bytes between two instances, which is all the clauses below do.
 */
export type ConformanceGroupMLS<Position extends string = string> = {
  ownCommitDigest(commit: Uint8Array): string | null
  /** Core incarnation-bound sink. Replays an existing hold synchronously and returns an unsubscribe. */
  onSafetyHold?: (
    latch: (reason: 'fork-halted' | 'spent-set-corrupt' | 'recovery-unavailable') => void,
  ) => () => void
  capturedRecovery?: ConformanceCapturedRecoveryPort<Position>
  signRecoveryConfirmation: (binding: {
    groupID: string
    requestID: string
    position: string
    commitDigest: string
  }) => Promise<Uint8Array>
  verifyRecoveryConfirmation: (
    binding: { groupID: string; requestID: string; position: string; commitDigest: string },
    signature: Uint8Array,
    requesterDID: string,
  ) => Promise<boolean>
  verifyRecoveryRequest: (request: Uint8Array) => Promise<ConformanceVerifiedRecoveryRequest | null>
  confirmationKey: (position: string, commitDigest: string) => Promise<ConformanceConfirmationKey>
  sealRecoveryVerdict: (
    request: Uint8Array,
    verdict: ConformanceRecoveryVerdict,
  ) => Promise<Uint8Array>
  openRecoveryVerdict: (
    sealed: Uint8Array,
    requestID: string,
    requestKey: Uint8Array,
  ) => Promise<ConformanceOpenedRecoveryVerdict | null>
  sendAdmission: () => ConformanceSendAdmission
  validateRecoveryCommit: (commit: Uint8Array) => Promise<{
    epoch: number
    valid?: true
    refusal?: ConformanceRecoveryRefusalReason
    refusalAuthority?: 'authenticated-commit'
  }>
  readEpoch: () => Promise<number>
  readRecoverySource: () => Promise<ConformanceAdoptionExpected>
  rosterEntries: () => Promise<Array<ConformanceRosterEntry>>
  readCommitHeader: (commit: Uint8Array) => Promise<ConformanceCommitHeader | null>
  processCommit: (
    commit: Uint8Array,
    context: ConformanceCommitContext,
  ) => Promise<ConformanceProcessCommitResult>
  exportRecoverySecret: () => Uint8Array | Promise<Uint8Array>
  prepareRecovery: () => Promise<'ready' | 'renewal-required'>
  createRecoveryRequest: (
    requestID: string,
    deadlineMs?: number,
    comparisonEpoch?: number,
  ) => Promise<{ request: Uint8Array; requestKey: Uint8Array }>
  sealGroupInfo: {
    (request: Uint8Array): Promise<Uint8Array>
    (request: Uint8Array, captureHead: Position | null): Promise<Uint8Array>
  }
  applyRecovery: (
    sealed: Uint8Array,
    requestID: string,
    requestKey: Uint8Array,
  ) => Promise<ConformanceAppliedRecovery>
  restoreRecovery: (
    candidate: Uint8Array,
    requestKey: Uint8Array,
  ) => Promise<ConformanceRestoredPendingRecovery>
  isLedgerComplete: () => Promise<boolean>
  getLedger: () => Promise<Array<string>>
  getRecoveryLedger?: () => Promise<Array<string>>
  sealLedger: (request: Uint8Array) => Promise<Uint8Array>
  openSealedLedger: (
    sealed: Uint8Array,
    requestID: string,
    requestKey: Uint8Array,
  ) => Promise<Array<string> | null>
  bootstrapLedger: (tokens: Array<string>) => Promise<void>
}

export type ConformanceMLSMember = {
  did: string
  mls: ConformanceGroupMLS
}

/** A Commit and the context the lane would deliver alongside it. */
export type ConformanceCommit = {
  commit: Uint8Array
  context: ConformanceCommitContext
}

export type ConformanceMLSGroup = {
  readEvidence(member: number): Promise<{
    source: ConformanceAdoptionExpected
    applied: ConformanceControlSnapshot['applied']
    cursor: ConformanceControlSnapshot['cursor']
    terminal: boolean
  }>
  groupID: string
  /** Restore a fresh port from this member's durable state. */
  restartMember: (member: number) => Promise<ConformanceMLSMember>
  /** A separate group containing the same local identity. */
  otherGroupMember: (member: number) => Promise<ConformanceMLSMember>
  /** Build an empty rotation without adopting it or changing membership. */
  buildRotation: (member: number) => Promise<Uint8Array>
  confirmationTag: (key: Uint8Array, requestID: string) => string
  /** Authenticated malformed payloads bypass the sender port's shape guard. */
  sealVerdictPayload: (
    member: number,
    request: Uint8Array,
    verdict: Record<string, unknown>,
  ) => Promise<Uint8Array>
  /**
   * The ports under test. The regular committer is outside this list. Rotation clauses use
   * another listed member's commit, so `processCommit` still receives another member's frame.
   */
  members: Array<ConformanceMLSMember>
  pauseNextSave: (member: number, pause: () => Promise<void>) => void
  setEpochHintOffset: (offset: number) => void
  /** The DID of the member that authors the commits, for the committer clauses. */
  committerDID: string
  /**
   * Build a Commit framed at the group's CURRENT epoch, and advance the AUTHOR past it — as a
   * real committer does when the hub accepts, and as nothing else may. `members` are untouched:
   * a member reaches the new epoch by being handed these bytes and not otherwise.
   *
   * `removes` names the index in `members` whose leaf the Commit drops. `adds`, when `true`,
   * invites one genuinely NEW identity — never one already modelled in `members` — so a caller
   * can prove a freed leaf is reused by an arrival the group has never seen, not merely
   * re-verify a DID it already knew. Both implementations already had the primitive this
   * threads through: a real committer's plain (no-`removes`) commit already invites a fresh
   * identity to advance the epoch, and the memory double's commit encoding already carries an
   * `adds` list — `adds` only asks each harness to exercise that existing path on request.
   */
  buildCommit: (options?: { removes?: number; adds?: boolean }) => Promise<ConformanceCommit>
  /** Authenticated source-epoch commit with a referenced proposal missing at the receiver. */
  buildUnavailableCommit: () => Promise<Uint8Array>
  /**
   * A genuine EXTERNAL commit — a rejoin — framed at the group's current epoch, together with a
   * forgery of it: the same frame with only the claimed author rewritten, which is what a
   * publisher holding no key can produce from a frame it observed.
   *
   * Optional: an implementation with no way to build one says so by omitting it, and the two
   * external clauses are skipped rather than faked.
   */
  buildExternalCommit?: (params: {
    /** The index in `members` that is rejoining. */
    rejoining: number
    /** The DID the forgery claims authored it. */
    forgeAs: string
  }) => Promise<{ genuine: Uint8Array; forged: Uint8Array }>
  dispose?: () => void | Promise<void>
}

export type GroupMLSConformanceParams = {
  /** Prefix for the describe block, so a failure names the implementation it came from. */
  label: string
  /** A fresh group of `size` ports plus an outside committer. `id` is unique per case. */
  createGroup: (size: number, id: string) => Promise<ConformanceMLSGroup>
  createBoundRecovery: () => Promise<ConformanceBoundRecovery>
  createCapturedRecovery: () => Promise<ConformanceCapturedRecoveryFixture>
}

export type ConformanceCapturedRecoveryFixture = {
  invalidateRetainedSigner(kind: 'missing' | 'wrong-controller' | 'revoked'): void
  requester: ConformanceGroupMLS
  responder: ConformanceGroupMLS
  restartResponder(): Promise<ConformanceGroupMLS>
  record(
    pending: ConformanceCapturedPendingRecovery,
    request: Uint8Array,
    requestKey: Uint8Array,
    requestID: string,
  ): ConformanceCapturedRejoinRecord
  confirmationTag(key: Uint8Array, requestID: string): string
  accepted(): number
}

/** The member at `index`, with the assertion the suite would otherwise repeat everywhere. */
function memberAt(members: Array<ConformanceMLSMember>, index: number): ConformanceMLSMember {
  const member = members[index]
  if (member == null) throw new Error(`the harness returned no member at index ${index}`)
  return member
}

const dids = (r: Array<ConformanceRosterEntry>) => r.map((e) => e.did)

const NOT_A_COMMIT: Array<Uint8Array> = [
  new Uint8Array(),
  new Uint8Array([0]),
  new Uint8Array([1, 2, 3, 4, 5]),
  new Uint8Array(64).fill(0xff),
  new TextEncoder().encode('{"not":"a commit"}'),
]

export function testGroupMLSConformance(params: GroupMLSConformanceParams): void {
  const { label, createGroup } = params

  const withGroup = async (
    size: number,
    id: string,
    run: (group: ConformanceMLSGroup) => Promise<void>,
  ): Promise<void> => {
    const group = await createGroup(size, id)
    try {
      await run(group)
    } finally {
      await group.dispose?.()
    }
  }

  describe(`GroupMLS conformance — ${label}`, () => {
    test.each(['missing', 'wrong-controller', 'revoked'] as const)(
      'ineligible retained recovery signer is refused: %s',
      async (kind) => {
        const fixture = await params.createCapturedRecovery()
        const port = fixture.requester.capturedRecovery
        if (port === undefined) throw new Error('Missing captured ports')
        const requestID = `ineligible-signer-${kind}`
        const { request, requestKey } = await fixture.requester.createRecoveryRequest(requestID)
        const sealed = await fixture.responder.sealGroupInfo(request, null)
        fixture.invalidateRetainedSigner(kind)
        expect(await port.applyRecovery(sealed, requestID, requestKey)).toBeNull()
        expect(fixture.accepted()).toBe(0)
      },
    )

    test.each(['complete', 'epoch', 'stranded', 'strand', 'incomplete'] as const)(
      'captured sealing requires a complete committed cursor (%s)',
      async (fault) => {
        await withGroup(2, `capture-cursor-${fault}`, async (group) => {
          const responder = memberAt(group.members, 0).mls
          const requester = memberAt(group.members, 1).mls
          const { request } = await requester.createRecoveryRequest('capture-cursor')
          const commit = await group.buildCommit()
          expect(
            await responder.processCommit(commit.commit, {
              ...commit.context,
              adoption: (staged) => ({
                mutationID: 'capture-cursor',
                changes: {
                  cursor: {
                    epoch: staged.epochAfter + (fault === 'epoch' ? 1 : 0),
                    position: null,
                    ...(fault === 'stranded' ? { stranded: true } : {}),
                    ...(fault === 'incomplete' ? { incomplete: true } : {}),
                  },
                  ...(fault === 'strand' ? { strand: { reason: 'retention-gap' } } : {}),
                },
              }),
            }),
          ).toMatchObject({ applied: true, advanced: true })
          await expect(responder.sealGroupInfo(request, 'sampled-head')).rejects.toThrow()
          if (fault === 'complete')
            expect((await responder.sealGroupInfo(request, null)).length).toBeGreaterThan(0)
          else await expect(responder.sealGroupInfo(request, null)).rejects.toThrow()
          expect((await responder.sealGroupInfo(request)).length).toBeGreaterThan(0)
        })
      },
    )
    test('captured recapture distinguishes exact fresh leaves with the same DID and request ID', async () => {
      const s = await params.createCapturedRecovery()
      const port = s.requester.capturedRecovery
      if (port === undefined) throw new Error('Missing captured port')
      const held = await s.requester.createRecoveryRequest('captured-X')
      const sealed = await s.responder.sealGroupInfo(held.request, null)
      const first = await port.applyRecovery(sealed, 'captured-X', held.requestKey)
      const other = await port.applyRecovery(sealed, 'captured-X', held.requestKey)
      if (
        first === null ||
        other === null ||
        'renewalRequired' in first ||
        'renewalRequired' in other
      )
        throw new Error('Missing captured candidates')
      expect(first.commit).not.toEqual(other.commit)
      const record = s.record(first, held.request, held.requestKey, 'captured-X')
      expect((await s.responder.processCommit(other.commit, {})).advanced).toBe(true)
      const restarted = await s.restartResponder()
      const fresh = await s.requester.createRecoveryRequest('recapture')
      expect(
        await port.reconcileCapture(record, {
          sealed: await restarted.sealGroupInfo(fresh.request, null),
          requestID: 'recapture',
          requestKey: fresh.requestKey,
          epochFloor: null,
        }),
      ).toEqual({ kind: 'unapplied-later', epoch: first.epoch, leafDigest: expect.any(String) })
    })
    test('captured recapture refuses a genuine reply older than the saved capture epoch', async () => {
      const s = await params.createCapturedRecovery()
      const port = s.requester.capturedRecovery
      if (port === undefined) throw new Error('Missing captured port')
      const fresh = await s.requester.createRecoveryRequest('old-recapture')
      const older = await s.responder.sealGroupInfo(fresh.request, null)
      const first = await s.requester.createRecoveryRequest('prior')
      const prior = await port.applyRecovery(
        await s.responder.sealGroupInfo(first.request, null),
        'prior',
        first.requestKey,
      )
      if (prior === null || 'renewalRequired' in prior) throw new Error('Missing prior candidate')
      expect((await s.responder.processCommit(prior.commit, {})).advanced).toBe(true)
      const held = await s.requester.createRecoveryRequest('X')
      const pending = await port.applyRecovery(
        await s.responder.sealGroupInfo(held.request, null),
        'X',
        held.requestKey,
      )
      if (pending === null || 'renewalRequired' in pending) throw new Error('Missing candidate')
      const record = s.record(pending, held.request, held.requestKey, 'X')
      expect(record.target.groupInfoEpoch).toBe(prior.epoch)
      const before = record.candidate.slice()
      expect(
        await port.reconcileCapture(record, {
          sealed: older,
          requestID: 'old-recapture',
          requestKey: fresh.requestKey,
          epochFloor: null,
        }),
      ).toEqual({ kind: 'retry', reason: 'target-behind' })
      expect(record.candidate).toEqual(before)
      expect(s.accepted()).toBe(0)
    })
    test.each([
      'digest',
      'payload',
      'epoch',
      'request',
      'key',
      'candidate',
      'origin',
      'target',
      'authenticator',
      'head',
      'search',
      'expected head',
      'stage',
      'destination',
      'mutation',
      'ledger',
      'id',
    ] as const)(
      'captured recapture refuses changed saved-record association: %s',
      async (field) => {
        const s = await params.createCapturedRecovery()
        const port = s.requester.capturedRecovery
        if (port === undefined) throw new Error('Missing captured port')
        const held = await s.requester.createRecoveryRequest('captured-X')
        const pending = await port.applyRecovery(
          await s.responder.sealGroupInfo(held.request, null),
          'captured-X',
          held.requestKey,
        )
        if (pending === null || 'renewalRequired' in pending)
          throw new Error('Missing captured candidate')
        const record = s.record(pending, held.request, held.requestKey, 'captured-X')
        if (field === 'digest') record.digest = 'other'
        if (field === 'payload') record.payload = new Uint8Array([1])
        if (field === 'epoch') record.epochAfter++
        if (field === 'request') record.requestID = 'other'
        if (field === 'key') record.requestKey = new Uint8Array(32)
        if (field === 'candidate') {
          const last = record.candidate.length - 1
          record.candidate[last] = (record.candidate[last] ?? 0) ^ 1
        }
        if (field === 'origin') record.source.stateVersion++
        if (field === 'target') record.target.topicID = 'other'
        if (field === 'authenticator') record.target.groupInfoAuthenticator.fill(0)
        if (field === 'head') record.captureHead = 'other'
        if (field === 'search') record.searchFrom = 'other'
        if (field === 'expected head') record.expectedHead = ''
        if (field === 'stage') record.stage = 'adopted'
        if (field === 'destination')
          record.destinationKey = {
            ...record.source.key,
            incarnation: record.source.key.incarnation + 2,
          }
        if (field === 'mutation') record.switchMutationID = ''
        if (field === 'ledger') Reflect.set(record, 'ledgerBefore', [42])
        if (field === 'id') record.id = ''
        const fresh = await s.requester.createRecoveryRequest('recapture')
        await expect(
          port.reconcileCapture(record, {
            sealed: await s.responder.sealGroupInfo(fresh.request, null),
            requestID: 'recapture',
            requestKey: fresh.requestKey,
            epochFloor: null,
          }),
        ).rejects.toThrow()
        expect(s.accepted()).toBe(0)
        expect(await s.requester.readEpoch()).toBe(pending.epoch - 1)
      },
    )
    test('captured recovery authenticates, restores, reconciles exact leaves after restart and narrows acceptance', async () => {
      const s = await params.createCapturedRecovery()
      const captured = s.requester.capturedRecovery
      if (captured === undefined) throw new Error('Missing captured recovery port')
      const requestID = 'captured-X'
      const { request, requestKey } = await s.requester.createRecoveryRequest(requestID)
      const legacy = await s.responder.sealGroupInfo(request)
      expect(await captured.applyRecovery(legacy, requestID, requestKey)).toBeNull()
      const sealed = await s.responder.sealGroupInfo(request, null)
      expect(await captured.applyRecovery(sealed, 'wrong', requestKey)).toBeNull()
      const pending = await captured.applyRecovery(sealed, requestID, requestKey)
      if (pending === null || 'renewalRequired' in pending)
        throw new Error('Missing captured candidate')
      const source = pending.source
      const target = pending.target
      pending.source.trustDigest = 'changed'
      pending.target.groupInfoAuthenticator.fill(0)
      expect(pending.source).toEqual(source)
      expect(pending.target).toEqual(target)
      const record = s.record(pending, request, requestKey, requestID)
      const key = await pending.confirmationKey('accepted-X', record.digest)
      const restored = await captured.restoreRecovery(pending.serialize(), requestKey)
      expect(restored.commit).toEqual(pending.commit)
      expect(restored.source).toEqual(source)
      expect(restored.target).toEqual(target)
      expect(await restored.confirmationKey('accepted-X', record.digest)).toEqual(key)
      await expect(restored.confirmationKey('different', record.digest)).rejects.toThrow()
      await expect(
        captured.restoreRecovery(pending.serialize(), new Uint8Array(32)),
      ).rejects.toThrow()
      const fresh = await s.requester.createRecoveryRequest('recapture')
      const recapture = {
        sealed: await s.responder.sealGroupInfo(fresh.request, null),
        requestID: 'recapture',
        requestKey: fresh.requestKey,
        epochFloor: null,
      }
      const before = record.candidate.slice()
      expect(await captured.reconcileCapture(record, recapture)).toEqual({
        kind: 'head-only',
        head: null,
      })
      expect(
        await captured.reconcileCapture(record, { ...recapture, epochFloor: pending.epoch }),
      ).toEqual({ kind: 'retry', reason: 'target-behind' })
      for (const changed of [
        { ...record, digest: 'wrong' },
        { ...record, payloadDigest: 'wrong' },
        { ...record, epochAfter: record.epochAfter + 1 },
        { ...record, captureHead: 'wrong' },
        { ...record, searchFrom: 'wrong' },
        {
          ...record,
          target: { ...record.target, groupInfoEpoch: record.target.groupInfoEpoch + 1 },
        },
        { ...record, target: { ...record.target, groupInfoAuthenticator: new Uint8Array(32) } },
        { ...record, source: { ...record.source, stateVersion: record.source.stateVersion + 1 } },
      ])
        await expect(captured.reconcileCapture(changed, recapture)).rejects.toThrow()
      const verdict = await s.responder.sealRecoveryVerdict(request, {
        groupID: source.key.groupID,
        requestID,
        position: 'accepted-X',
        commitDigest: record.digest,
        verdict: 'confirmed',
        epoch: pending.epoch,
        tag: s.confirmationTag(key, requestID),
      })
      const proof = {
        ...target,
        position: 'accepted-X',
        payloadDigest: record.payloadDigest,
        verdict,
      }
      const write = () => ({ mutationID: 'captured-switch', changes: {} })
      await expect(restored.onAccepted({ ...source, trust: {} }, proof, write)).rejects.toThrow()
      expect(s.accepted()).toBe(0)
      await restored.onAccepted(source, proof, write)
      expect(s.accepted()).toBe(1)
      expect((await s.responder.processCommit(pending.commit, {})).advanced).toBe(true)
      const restarted = await s.restartResponder()
      const later = await restarted.sealGroupInfo(fresh.request, null)
      const accepted = await captured.reconcileCapture(record, { ...recapture, sealed: later })
      expect(accepted).toMatchObject({ kind: 'accepted', epoch: pending.epoch })
      if (accepted.kind === 'accepted') expect(accepted.leafDigest).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(record.candidate).toEqual(before)
      expect(record.requestKey).toEqual(requestKey)
    })
    test('recovery dry-run authenticates external refusals without changing state', async () => {
      await withGroup(2, 'recovery-dry-run', async (group) => {
        if (group.buildExternalCommit === undefined) return
        const receiver = memberAt(group.members, 0)
        const { genuine, forged } = await group.buildExternalCommit({
          rejoining: 1,
          forgeAs: receiver.did,
        })
        const before = await group.readEvidence(0)
        const source = await receiver.mls.readRecoverySource()
        const own = await group.buildExternalCommit({ rejoining: 0, forgeAs: receiver.did })
        expect(await receiver.mls.validateRecoveryCommit(own.genuine)).toEqual({
          epoch: sourceIdentity(source).epoch,
          refusal: 'policy',
          refusalAuthority: 'authenticated-commit',
        })
        for (const bytes of NOT_A_COMMIT)
          expect(await receiver.mls.validateRecoveryCommit(bytes)).toEqual({
            epoch: sourceIdentity(source).epoch,
          })
        expect(await receiver.mls.validateRecoveryCommit(forged)).toEqual({
          epoch: sourceIdentity(source).epoch,
        })
        expect(await receiver.mls.validateRecoveryCommit(genuine)).toEqual({
          epoch: sourceIdentity(source).epoch,
          valid: true,
        })
        expect(await group.readEvidence(0)).toEqual(before)
        expect(await receiver.mls.processCommit(genuine, {})).toMatchObject({
          applied: true,
          advanced: true,
        })
        expect(await receiver.mls.validateRecoveryCommit(genuine)).toEqual({
          epoch: sourceIdentity(source).epoch + 1,
        })
      })
    })
    test('own recognition is total, non-mutating and distinguishes complete commits', async () => {
      await withGroup(1, 'own-recognition', async (group) => {
        const member = memberAt(group.members, 0)
        const before = await member.mls.readRecoverySource()
        const first = await group.buildCommit()
        const saved = first.commit.slice()
        const digest = member.mls.ownCommitDigest(first.commit)
        expect(typeof digest).toBe('string')
        expect(digest).not.toBe('')
        expect(member.mls.ownCommitDigest(first.commit.slice())).toBe(digest)
        for (const bytes of NOT_A_COMMIT) expect(member.mls.ownCommitDigest(bytes)).toBeNull()
        const second = await group.buildCommit()
        expect(member.mls.ownCommitDigest(second.commit)).not.toBe(digest)
        expect(first.commit).toEqual(saved)
        expect(await member.mls.readRecoverySource()).toEqual(before)
      })
    })
    test('unavailable validation never applies, advances, or invokes adoption', async () => {
      await withGroup(1, 'unavailable-validation', async (group) => {
        const member = memberAt(group.members, 0)
        const before = await member.mls.readRecoverySource()
        const evidence = await group.readEvidence(0)
        const roster = await member.mls.rosterEntries()
        const ledger = await member.mls.getLedger()
        let adoptions = 0
        const result = await member.mls.processCommit(await group.buildUnavailableCommit(), {
          adoption: () => {
            adoptions++
            return { mutationID: 'unavailable', changes: {} }
          },
        })
        expect(result).toMatchObject({
          validation: 'unavailable',
          applied: false,
          advanced: false,
          epochBefore: sourceIdentity(before).epoch,
          epochAfter: sourceIdentity(before).epoch,
        })
        expect(await member.mls.readRecoverySource()).toEqual(before)
        expect(await member.mls.rosterEntries()).toEqual(roster)
        expect(await member.mls.getLedger()).toEqual(ledger)
        expect(adoptions).toBe(0)
        expect(await group.readEvidence(0)).toEqual(evidence)
      })
    })
    test('evidence agrees with the committed source identity and version after receive', async () => {
      await withGroup(1, 'committed-evidence', async (group) => {
        const member = memberAt(group.members, 0)
        const before = await group.readEvidence(0)
        if (before.source.identity === null) throw new Error('missing committed source identity')
        const commit = await group.buildCommit()
        expect(
          await member.mls.processCommit(commit.commit, {
            ...commit.context,
            adoption: () => ({ mutationID: 'committed-evidence', changes: {} }),
          }),
        ).toMatchObject({ applied: true, advanced: true })
        const source = await member.mls.readRecoverySource()
        const evidence = await group.readEvidence(0)
        expect(evidence.source).toEqual({
          key: source.key,
          stateVersion: source.stateVersion,
          identity: source.identity,
        })
        expect(evidence.source.identity?.epoch).toBe(before.source.identity.epoch + 1)
        expect(evidence.source.stateVersion).toBeGreaterThan(before.source.stateVersion)
        expect(evidence.source.identity?.authenticator).toEqual(
          sourceIdentity(source).authenticator,
        )
        expect(evidence.applied).toEqual(before.applied)
        expect(evidence.cursor).toEqual(before.cursor)
        expect(evidence.terminal).toBe(false)
      })
    })
    test('competing empty rotations retain distinct epoch identities', async () => {
      await withGroup(3, 'competing-rotations', async (group) => {
        const alice = memberAt(group.members, 0)
        const bob = memberAt(group.members, 1)
        const carol = memberAt(group.members, 2)
        const before = await bob.mls.readRecoverySource()
        expect(sourceIdentity(await alice.mls.readRecoverySource()).authenticator).toEqual(
          sourceIdentity(before).authenticator,
        )
        const roster = await bob.mls.rosterEntries()
        const ledger = await bob.mls.getLedger()
        const aliceCommit = await group.buildRotation(0)
        const bobCommit = await group.buildRotation(1)
        expect(aliceCommit).not.toEqual(bobCommit)
        const stagedAuthenticators: Array<Uint8Array> = []
        for (const [member, commit] of [
          [alice, bobCommit],
          [bob, aliceCommit],
          [carol, aliceCommit],
        ] as const) {
          expect(
            await member.mls.processCommit(commit, {
              adoption: (staged) => {
                stagedAuthenticators.push(staged.epochAuthenticator.slice())
                return { mutationID: crypto.randomUUID(), changes: {} }
              },
            }),
          ).toMatchObject({ applied: true, epochAfter: sourceIdentity(before).epoch + 1 })
          expect(await member.mls.rosterEntries()).toEqual(roster)
          expect(await member.mls.getLedger()).toEqual(ledger)
        }
        const aliceSource = await alice.mls.readRecoverySource()
        const bobSource = await bob.mls.readRecoverySource()
        expect(sourceIdentity(aliceSource).epoch).toBe(sourceIdentity(bobSource).epoch)
        expect(sourceIdentity(aliceSource).authenticator).not.toEqual(
          sourceIdentity(bobSource).authenticator,
        )
        const carolSource = await carol.mls.readRecoverySource()
        expect(carolSource).toEqual({ ...bobSource, stateVersion: carolSource.stateVersion })
        expect(stagedAuthenticators).toEqual([
          sourceIdentity(aliceSource).authenticator,
          sourceIdentity(bobSource).authenticator,
          sourceIdentity(bobSource).authenticator,
        ])
      })
    })
    test('recovery source identity is a detached snapshot of the locked epoch', async () => {
      await withGroup(1, 'recovery-source', async (group) => {
        const member = memberAt(group.members, 0)
        const source = await member.mls.readRecoverySource()
        expect(sourceIdentity(source).epoch).toBe(await member.mls.readEpoch())
        expect(sourceIdentity(source).authenticator.length).toBeGreaterThan(0)
        expect(source.key.incarnation).toBeGreaterThanOrEqual(1)
        expect(source.stateVersion).toBeGreaterThanOrEqual(0)
        expect(Object.keys(source).sort()).toEqual(['identity', 'key', 'stateVersion'])
        const original = sourceIdentity(source).authenticator.slice()
        sourceIdentity(source).authenticator.fill(0)
        expect(sourceIdentity(await member.mls.readRecoverySource()).authenticator).toEqual(
          original,
        )
        const commit = await group.buildCommit()
        await member.mls.processCommit(commit.commit, commit.context)
        const next = await member.mls.readRecoverySource()
        expect(sourceIdentity(next).epoch).toBe(sourceIdentity(source).epoch + 1)
        expect(sourceIdentity(next).authenticator).not.toEqual(original)
      })
    })
    test('adoption factories see the staged epoch and self-removal before saving', async () => {
      await withGroup(1, 'adoption-staged', async (group) => {
        const member = memberAt(group.members, 0)
        let calls = 0
        const before = await member.mls.readEpoch()
        const sourceKey = (await member.mls.readRecoverySource()).key
        const commit = await group.buildCommit()
        const adoption = (staged: {
          incarnation: number
          epochAfter: number
          removed: boolean
          epochAuthenticator: Uint8Array
        }) => {
          calls++
          expect(staged.incarnation).toBe(sourceKey.incarnation)
          expect(staged.epochAfter).toBe(before + 1)
          expect(staged.removed).toBe(false)
          expect(staged.epochAuthenticator.length).toBeGreaterThan(0)
          return { mutationID: crypto.randomUUID(), changes: {} }
        }
        await member.mls.processCommit(commit.commit, { ...commit.context, adoption })
        expect(calls).toBe(1)
        await member.mls.processCommit(commit.commit, { ...commit.context, adoption })
        expect(calls).toBe(1)
        const removal = await group.buildCommit({ removes: 0 })
        await member.mls.processCommit(removal.commit, {
          ...removal.context,
          adoption: (staged) => {
            calls++
            expect(staged.epochAfter).toBe(before + 1)
            expect(staged.removed).toBe(true)
            return { mutationID: crypto.randomUUID(), changes: {} }
          },
        })
        expect(calls).toBe(2)
      })
    })
    test('processCommit reports applied separately from epoch advancement', async () => {
      await withGroup(2, 'process-commit-applied', async (group) => {
        const member = memberAt(group.members, 0)
        const advance = await group.buildCommit()
        expect(await member.mls.processCommit(advance.commit, advance.context)).toMatchObject({
          applied: true,
          advanced: true,
        })
        expect(await member.mls.processCommit(advance.commit, advance.context)).toMatchObject({
          applied: false,
          advanced: false,
        })
        const removal = await group.buildCommit({ removes: 0 })
        const epoch = await member.mls.readEpoch()
        expect(await member.mls.processCommit(removal.commit, removal.context)).toMatchObject({
          applied: true,
          advanced: false,
          epochBefore: epoch,
          epochAfter: epoch,
        })
      })
    })
    test('send admission is synchronous and follows only accepted epoch advances', async () => {
      await withGroup(1, 'send-admission', async (group) => {
        const member = memberAt(group.members, 0)
        const epoch = await member.mls.readEpoch()
        group.setEpochHintOffset(1)
        expect(member.mls.sendAdmission()).toEqual({ epoch, admissible: true })
        const commit = await group.buildCommit()
        expect(member.mls.sendAdmission()).toEqual({ epoch, admissible: true })
        await member.mls.processCommit(commit.commit, commit.context)
        expect(member.mls.sendAdmission()).toEqual({ epoch: epoch + 1, admissible: true })
        await member.mls.processCommit(commit.commit, commit.context)
        expect(member.mls.sendAdmission()).toEqual({ epoch: epoch + 1, admissible: true })
      })
    })
    // Three passes (hint offsets 0, -1, 1) over a real MLS group: slow on CI runners.
    test('commit results and refusals ignore a lagging or leading epoch hint', async () => {
      await withGroup(3, 'lying-epoch-hint', async (group) => {
        const alice = memberAt(group.members, 0)
        const first = await group.buildCommit()
        const future = await group.buildCommit()
        const epoch = (await alice.mls.readCommitHeader(first.commit))?.epoch
        if (epoch == null) throw new Error('commit epoch unreadable')
        for (const [index, offset] of [0, -1, 1].entries()) {
          group.setEpochHintOffset(offset)
          const member = memberAt(group.members, index)
          expect(await member.mls.readEpoch()).toBe(epoch)
          expect(await member.mls.processCommit(future.commit, future.context)).toEqual({
            applied: false,
            advanced: false,
            epochBefore: epoch,
            epochAfter: epoch,
          })
          expect(await member.mls.processCommit(first.commit, first.context)).toEqual({
            applied: true,
            advanced: true,
            epochBefore: epoch,
            epochAfter: epoch + 1,
          })
          expect(await member.mls.processCommit(first.commit, first.context)).toEqual({
            applied: false,
            advanced: false,
            epochBefore: epoch + 1,
            epochAfter: epoch + 1,
          })
          expect(await member.mls.processCommit(new Uint8Array([0]), {})).toEqual({
            applied: false,
            advanced: false,
            epochBefore: epoch + 1,
            epochAfter: epoch + 1,
          })
        }
      })
    }, 30_000)

    describe('readCommitHeader', () => {
      /**
       * The two facts have different trust AND different availability, and conflating them is the
       * defect this contract exists to forbid. The epoch is cleartext and always there; the
       * committer needs the epoch's own secret and is therefore available only at the reader's own
       * epoch — in BOTH directions, since the secret for a ratcheted-past epoch is as gone as one
       * never reached.
       */
      test('returns the epoch for a commit framed at ANY epoch, and the committer only at this member own', async () => {
        await withGroup(2, 'header-availability', async (group) => {
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)

          const first = await group.buildCommit()
          const atOwnEpoch = await alice.mls.readCommitHeader(first.commit)
          expect(atOwnEpoch).not.toBeNull()
          const firstEpoch = atOwnEpoch?.epoch as number
          expect(typeof firstEpoch).toBe('number')
          // At the reader's own epoch the commit authenticates its author.
          expect(atOwnEpoch?.committerDID).toBe(group.committerDID)

          // Alice applies it and is now one epoch ON from where that commit was framed.
          expect(await alice.mls.processCommit(first.commit, first.context)).toMatchObject({
            advanced: true,
          })

          // BELOW: the same bytes, read from the epoch after. Epoch still there — that is what
          // lets a walker classify a frame it has passed — and the committer gone.
          const fromAbove = await alice.mls.readCommitHeader(first.commit)
          expect(fromAbove).not.toBeNull()
          expect(fromAbove?.epoch).toBe(firstEpoch)
          expect(fromAbove?.committerDID).toBeUndefined()

          // ABOVE: a commit framed at an epoch this reader has not reached. Bob never applied the
          // first one. This is the frame a peer that fell behind MUST be able to read: a port that
          // answered `null` here would have it file the group's whole future as poison.
          const second = await group.buildCommit()
          const fromBelow = await bob.mls.readCommitHeader(second.commit)
          expect(fromBelow).not.toBeNull()
          expect(fromBelow?.epoch).toBe(firstEpoch + 1)
          expect(fromBelow?.committerDID).toBeUndefined()
        })
      })

      /**
       * `null` means ONE thing: these bytes are not a Commit at all. The lane files `null` as
       * poison and steps over it, so a port that returned it for a commit it merely could not read
       * would make a peer that fell behind walk to the end of the log and report itself fully
       * reconciled at a dead epoch. That is the failure this clause is here to make impossible.
       */
      test('returns null ONLY for bytes that are not a commit', async () => {
        await withGroup(1, 'header-null', async (group) => {
          const alice = memberAt(group.members, 0)
          for (const bytes of NOT_A_COMMIT) {
            expect(await alice.mls.readCommitHeader(bytes)).toBeNull()
          }
        })
      })
    })

    describe('processCommit', () => {
      /**
       * **The double's shape, and why it is wrong.** ts-mls's `processMessage` replaces the
       * handle's own state, so a RECEIVED commit has nothing to adopt — the port advances in
       * place, and the peer reads the new epoch off the same object it handed the bytes to. A
       * double that modelled every commit as a value adopted separately (true only for a commit
       * this member AUTHORED) would have a host double-apply every received one.
       */
      test('advances IN PLACE for a received commit: the roster the same object reports has moved', async () => {
        await withGroup(3, 'apply-in-place', async (group) => {
          const alice = memberAt(group.members, 0)
          const carol = memberAt(group.members, 2)
          expect(dids(await alice.mls.rosterEntries())).toContain(carol.did)

          const removal = await group.buildCommit({ removes: 2 })
          expect(await alice.mls.processCommit(removal.commit, removal.context)).toMatchObject({
            advanced: true,
          })
          // Nothing was adopted, and the roster moved anyway.
          expect(dids(await alice.mls.rosterEntries())).not.toContain(carol.did)
        })
      })

      /**
       * A Commit that removes the local member is one it can never apply: the commit's path
       * excludes the leaf it drops, so the removed member is handed nothing to derive the new
       * epoch from. Its handle stops there — which is what cutting a member off MEANS — and it is
       * `{ advanced: false }` rather than a throw, because the frame is well formed and there is
       * nothing to retry.
       */
      test('a commit removing the LOCAL member does not advance it, and does not throw', async () => {
        await withGroup(3, 'apply-self-removal', async (group) => {
          const bob = memberAt(group.members, 1)
          const carol = memberAt(group.members, 2)

          const removal = await group.buildCommit({ removes: 2 })
          expect(await carol.mls.processCommit(removal.commit, removal.context)).toMatchObject({
            advanced: false,
          })

          // ITS OWN LEAF IS GONE, AND THE EPOCH DID NOT MOVE. This was the one clause the two
          // implementations disagreed about, and the double was the wrong one: it left the tree
          // alone on the reasoning that "a member that cannot apply the commit does not learn its
          // roster from it". ts-mls does learn it — `processMessage` applies the proposals to the
          // tree and returns without throwing — so the removed member reports a roster short by
          // one at an epoch that did not move.
          //
          // That combination exists nowhere else, and undiscriminated it reads as a rotation, so
          // it is a clause and not a footnote: `peer.ts` gates its roster diff on the handle
          // having actually ratcheted precisely because of it.
          expect(dids(await carol.mls.rosterEntries())).not.toContain(carol.did)

          // And the commit is perfectly applicable by everyone else, so what refused it was the
          // removal and not the bytes.
          expect(await bob.mls.processCommit(removal.commit, removal.context)).toMatchObject({
            advanced: true,
          })
        })
      })

      /**
       * A frame it cannot apply is `{ advanced: false }`, NEVER a throw: a throw leaves the lane's
       * cursor put and re-reads the frame, so a port that threw on a commit it was never in a
       * position to apply would wedge the lane on that frame forever — a late joiner would wedge
       * on its own add-commit, the first frame it reads.
       */
      test('a commit framed at another epoch is { advanced: false } and never a throw, in both directions', async () => {
        await withGroup(2, 'apply-other-epoch', async (group) => {
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)

          const first = await group.buildCommit()
          expect(await alice.mls.processCommit(first.commit, first.context)).toMatchObject({
            advanced: true,
          })
          // BELOW: alice is past it now. Re-reading the frame she has already applied.
          expect(await alice.mls.processCommit(first.commit, first.context)).toMatchObject({
            advanced: false,
          })

          // ABOVE: bob never applied the first, so the second is framed an epoch ahead of him.
          const second = await group.buildCommit()
          expect(await bob.mls.processCommit(second.commit, second.context)).toMatchObject({
            advanced: false,
          })
          // Bob is exactly where he was: a refusal advances nothing.
          expect(await bob.mls.processCommit(first.commit, first.context)).toMatchObject({
            advanced: true,
          })
        })
      })

      test('bytes that are not a commit are { advanced: false } and never a throw', async () => {
        await withGroup(1, 'apply-garbage', async (group) => {
          const alice = memberAt(group.members, 0)
          for (const bytes of NOT_A_COMMIT) {
            expect(await alice.mls.processCommit(bytes, {})).toMatchObject({ advanced: false })
          }
        })
      })
    })

    describe('rosterEntries', () => {
      /**
       * It answers for membership and for nothing else, and it must reflect an APPLIED roster
       * change and only an applied one. The lane reads it around `processCommit` to tell a commit
       * that dropped a leaf from one that did not, and rotates the app-lane anchor on the
       * difference — so a port whose roster moved on a commit it refused would rotate a peer onto
       * a topic no one else is on.
       */
      test('reflects an APPLIED roster change, and only an applied one', async () => {
        await withGroup(3, 'roster-applied', async (group) => {
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)
          const carol = memberAt(group.members, 2)

          const before = dids(await alice.mls.rosterEntries())
          expect(before).toContain(carol.did)
          expect(new Set(dids(await bob.mls.rosterEntries()))).toEqual(new Set(before))

          const removal = await group.buildCommit({ removes: 2 })
          // Merely BUILDING it changes nobody's roster: the group moves when a member applies.
          expect(new Set(dids(await alice.mls.rosterEntries()))).toEqual(new Set(before))

          await alice.mls.processCommit(removal.commit, removal.context)
          expect(dids(await alice.mls.rosterEntries())).not.toContain(carol.did)
          // Bob was handed nothing, so his roster is untouched — the lane must be able to tell
          // "this member applied a remove" from "a remove happened somewhere".
          expect(new Set(dids(await bob.mls.rosterEntries()))).toEqual(new Set(before))
        })
      })

      /**
       * PINNED VALUES, not merely "stable": a `leafIndex` that never moves but is otherwise
       * arbitrary (leaf 7, leaf 1000 — whatever an implementation likes, forever) would pass
       * every clause above and still be useless to a caller that has to name a leaf. This clause
       * closes that gap.
       *
       * The dense range is asserted against `entries.length`, NOT against `withGroup`'s `size`:
       * the group's own COMMITTER holds a leaf too — both harnesses seat it in the tree at
       * construction (the real fixture's `createGroup` call, the double's `roster =
       * [COMMITTER_DID, ...dids]` seed) — so an `n`-member conformance group's roster is `n + 1`
       * entries wide. Asserting `{0..size-1}` would be a premise about harness plumbing, not
       * about the port; `{0..entries.length-1}` is the actual dense-and-complete contract.
       */
      test('leafIndex is a dense 0..n-1 on a fresh group, unique, ascending, and stable for untouched members', async () => {
        await withGroup(3, 'roster-leaf-identity', async (group) => {
          const alice = memberAt(group.members, 0)
          const entries = await alice.mls.rosterEntries()

          // A fresh group occupies exactly slots {0..entries.length-1}: dense, no gaps.
          expect(entries.map((e) => e.leafIndex).sort((a, b) => a - b)).toEqual(
            Array.from({ length: entries.length }, (_, i) => i),
          )
          // Unique.
          expect(new Set(entries.map((e) => e.leafIndex)).size).toBe(entries.length)
          // Ascending order as returned.
          expect(entries.map((e) => e.leafIndex)).toEqual(
            [...entries.map((e) => e.leafIndex)].sort((a, b) => a - b),
          )
          // Non-empty longForm (presence only, NOT resolvability).
          for (const e of entries) expect(e.longForm.length).toBeGreaterThan(0)

          // Stability: removing an unrelated member does not move alice's own leafIndex.
          const aliceEntry = entries.find((e) => e.did === alice.did)
          // Narrowed rather than optional-chained: an optional-chained read compared against
          // another optional-chained read below would degrade to `undefined === undefined` and
          // pass vacuously if alice were ever missing from her own roster.
          if (aliceEntry == null) throw new Error('the harness reported no leaf for alice')
          const alice0 = aliceEntry.leafIndex
          const carol = memberAt(group.members, 2)
          expect(dids(entries)).toContain(carol.did)
          const removal = await group.buildCommit({ removes: 2 })
          await alice.mls.processCommit(removal.commit, removal.context)
          const after = await alice.mls.rosterEntries()
          const aliceAfter = after.find((e) => e.did === alice.did)
          if (aliceAfter == null) {
            throw new Error('alice lost her leaf after an unrelated member was removed')
          }
          expect(aliceAfter.leafIndex).toBe(alice0)
        })
      })

      /**
       * FREED-INDEX REUSE, by a genuinely NEW arrival — never a DID the group already modelled.
       * `buildCommit({ adds: true })` is the harness's own primitive for that (see its doc in
       * `ConformanceMLSGroup`), not a helper invented for this test.
       *
       * TWO holes, not one, and non-adjacent: bob's leaf and dave's leaf are freed with carol's
       * leaf left occupied between them, so "leftmost freed" and "most-recently-freed" name two
       * different indices — a single-hole version cannot tell an implementation that always fills
       * the most-recently-vacated slot from one that correctly fills the leftmost blank.
       *
       * The freed leaves are read off `rosterEntries()` BY DID, not assumed to equal the removed
       * members' positions in `group.members`: the committer occupies a leaf of its own in both
       * harnesses (see the earlier test's note), so `group.members[1]`'s leaf is NOT necessarily
       * leaf index `1` — the two are only related through the roster this port actually reports.
       *
       * The newcomer match also excludes every DID the PRE-removal roster held, not just alice and
       * the freed DIDs: an implementation that "filled" the hole by relocating an existing,
       * untouched member (carol) rather than seating the genuine newcomer there would otherwise
       * still satisfy a same-leafIndex, different-freed-DID check.
       */
      test('an add after two removals reuses the LEFTMOST freed leaf index, never a relocated existing member', async () => {
        await withGroup(4, 'roster-leaf-reuse', async (group) => {
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)
          const dave = memberAt(group.members, 3)

          const before = await alice.mls.rosterEntries()
          const beforeDIDs = dids(before)
          const bobEntry = before.find((e) => e.did === bob.did)
          // Narrowed rather than optional-chained: `expect` does not narrow.
          if (bobEntry == null) throw new Error('the harness reported no leaf for bob')
          const daveEntry = before.find((e) => e.did === dave.did)
          if (daveEntry == null) throw new Error('the harness reported no leaf for dave')
          const leftFreed = Math.min(bobEntry.leafIndex, daveEntry.leafIndex)
          const rightFreed = Math.max(bobEntry.leafIndex, daveEntry.leafIndex)

          const removeBob = await group.buildCommit({ removes: 1 })
          await alice.mls.processCommit(removeBob.commit, removeBob.context)
          const removeDave = await group.buildCommit({ removes: 3 })
          await alice.mls.processCommit(removeDave.commit, removeDave.context)
          const add = await group.buildCommit({ adds: true })
          await alice.mls.processCommit(add.commit, add.context)

          const entries = await alice.mls.rosterEntries()
          const newcomer = entries.find(
            (e) => e.leafIndex === leftFreed && !beforeDIDs.includes(e.did),
          )
          // The newcomer occupies the LEFTMOST freed leaf and is genuinely new — not an existing
          // member relocated into the hole.
          expect(newcomer).toBeDefined()
          // The rightmost (more-recently-freed) hole stays blank: nothing fills it out of order.
          expect(entries.find((e) => e.leafIndex === rightFreed)).toBeUndefined()
        })
      })
    })

    describe('exportRecoverySecret', () => {
      /**
       * EPOCH-INDEPENDENT and agreed, because it names the non-rotating rendezvous a peer stranded
       * at any epoch has to be able to reach. This is the one place the port deliberately does NOT
       * rotate, and an implementation that keyed it off the epoch would leave exactly the peers
       * that need a heal unable to name the topic they heal on.
       */
      test('is stable across an epoch change and agreed between members', async () => {
        await withGroup(3, 'recovery-secret', async (group) => {
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)
          const before = await alice.mls.exportRecoverySecret()
          expect(before.length).toBeGreaterThan(0)
          expect(await bob.mls.exportRecoverySecret()).toEqual(before)

          const removal = await group.buildCommit({ removes: 2 })
          await alice.mls.processCommit(removal.commit, removal.context)
          await bob.mls.processCommit(removal.commit, removal.context)

          expect(await alice.mls.exportRecoverySecret()).toEqual(before)
          expect(await bob.mls.exportRecoverySecret()).toEqual(before)
        })
      })
    })

    describe('external commits', () => {
      /**
       * `external` is STRUCTURAL and the committer is not. An external commit carries its author's
       * DID in its own UpdatePath leaf — which is what makes it readable without the epoch secret
       * — but that leaf's credential is a plain field, and only the commit's own signature binds
       * it to an author. A port that reported an external committer it had not checked would let
       * anything that can publish choose who a frame is from, and the app lane rotates its anchor
       * on exactly this flag.
       */
      test('report the rejoiner ONLY when the signature verifies, and the flag either way', async ({
        skip,
      }) => {
        await withGroup(2, 'external-forgery', async (group) => {
          if (group.buildExternalCommit == null) {
            skip('the harness cannot build an external commit for this implementation')
            return
          }
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)
          const { genuine, forged } = await group.buildExternalCommit({
            rejoining: 1,
            forgeAs: alice.did,
          })

          const real = await alice.mls.readCommitHeader(genuine)
          expect(real?.external).toBe(true)
          expect(real?.committerDID).toBe(bob.did)

          // The forgery names its READER as its own author — the one claim a reader acts on by
          // healing. It is still a commit and still recognizably external: both are cleartext.
          const fake = await alice.mls.readCommitHeader(forged)
          expect(fake).not.toBeNull()
          expect(fake?.external).toBe(true)
          expect(fake?.epoch).toBe(real?.epoch)
          // And the committer is what a forger does not get to choose.
          expect(fake?.committerDID).toBeUndefined()
          const receiver = memberAt(group.members, 1)
          expect(await receiver.mls.processCommit(forged, {})).toMatchObject({
            advanced: false,
            refusal: 'invalid',
          })
        })
      })
    })

    /**
     * THE RECOVERY LANE. A stranded peer asks the group for current state on a topic derived from
     * a secret the whole group shares for life, so anyone who ever held it — including a member
     * the group removed — can mint a well-formed request and put it there. What keeps that from
     * being a way back in is the RESPONDER, and only the responder.
     */
    describe('the recovery round trip', () => {
      test.each(['confirmed', 'refused', 'superseded'] as const)(
        'requester-signed %s verdicts are advisory for live and restored candidates',
        async (kind) => {
          await withGroup(2, `self-verdict-${kind}`, async (group) => {
            const alice = memberAt(group.members, 0)
            const bob = memberAt(group.members, 1)
            const requestID = `self-verdict-${kind}`
            const { request, requestKey } = await bob.mls.createRecoveryRequest(requestID)
            const pending = await bob.mls.applyRecovery(
              await alice.mls.sealGroupInfo(request),
              requestID,
              requestKey,
            )
            if (pending == null || 'renewalRequired' in pending) throw new Error('No candidate')
            const key = await pending.confirmationKey('position', 'digest')
            const tuple = {
              groupID: group.groupID,
              requestID,
              position: 'position',
              commitDigest: 'digest',
            }
            const verdict: ConformanceRecoveryVerdict =
              kind === 'confirmed'
                ? {
                    ...tuple,
                    verdict: kind,
                    epoch: pending.epoch,
                    tag: group.confirmationTag(key, requestID),
                  }
                : kind === 'refused'
                  ? {
                      ...tuple,
                      verdict: kind,
                      reason: 'policy',
                      refusalAuthority: 'authenticated-commit',
                    }
                  : { ...tuple, verdict: kind }
            const self = await bob.mls.openRecoveryVerdict(
              await bob.mls.sealRecoveryVerdict(request, verdict),
              requestID,
              requestKey,
            )
            const other = await bob.mls.openRecoveryVerdict(
              await alice.mls.sealRecoveryVerdict(request, verdict),
              requestID,
              requestKey,
            )
            if (self == null || other == null) throw new Error('No verdict')
            expect(self.signer).toBe(bob.did)
            const restored = await bob.mls.restoreRecovery(pending.serialize(), requestKey)
            for (const candidate of [pending, restored]) {
              expect(candidate.judgeVerdict(other)).toBe(
                kind === 'superseded' ? 'advisory' : 'authoritative',
              )
              expect(candidate.judgeVerdict(self)).toBe('advisory')
            }
          })
        },
      )
      test('verified requests name their signed identity, group and request without disclosing a private key', async () => {
        await withGroup(2, 'verify-recovery-request', async (group) => {
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)
          const { request } = await bob.mls.createRecoveryRequest('verified-ask')
          expect(await alice.mls.verifyRecoveryRequest(request)).toEqual({
            groupID: group.groupID,
            requestID: 'verified-ask',
            requesterDID: bob.did,
          })
          expect(await alice.mls.verifyRecoveryRequest(new Uint8Array([0]))).toBeNull()
        })
      })
      test('confirmation asks bind the tuple and the original requester identity', async () => {
        await withGroup(2, 'confirmation-ask', async (group) => {
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)
          const tuple = {
            groupID: group.groupID,
            requestID: 'ask',
            position: 'p',
            commitDigest: 'digest',
          }
          const signature = await bob.mls.signRecoveryConfirmation(tuple)
          expect(await alice.mls.verifyRecoveryConfirmation(tuple, signature, bob.did)).toBe(true)
          for (const field of ['groupID', 'requestID', 'position', 'commitDigest'] as const) {
            expect(
              await alice.mls.verifyRecoveryConfirmation(
                { ...tuple, [field]: 'changed' },
                signature,
                bob.did,
              ),
            ).toBe(false)
          }
          expect(await alice.mls.verifyRecoveryConfirmation(tuple, signature, alice.did)).toBe(
            false,
          )
          expect(
            await alice.mls.verifyRecoveryConfirmation(tuple, new Uint8Array([0]), bob.did),
          ).toBe(false)
          const other = await group.otherGroupMember(1)
          expect(await other.mls.verifyRecoveryConfirmation(tuple, signature, bob.did)).toBe(false)
        })
      })
      test('recovery replies cannot be opened by the same identity in another group', async () => {
        await withGroup(2, 'cross-group-replies', async (group) => {
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)
          const other = await group.otherGroupMember(1)
          expect(other.did).toBe(bob.did)
          const { request, requestKey } = await bob.mls.createRecoveryRequest('cross-group')
          const info = await alice.mls.sealGroupInfo(request)
          const ledger = await alice.mls.sealLedger(request)
          expect(await bob.mls.applyRecovery(info, 'cross-group', requestKey)).not.toBeNull()
          expect(await bob.mls.openSealedLedger(ledger, 'cross-group', requestKey)).toEqual(
            await alice.mls.getLedger(),
          )
          expect(await other.mls.applyRecovery(info, 'cross-group', requestKey)).toBeNull()
          expect(await other.mls.openSealedLedger(ledger, 'cross-group', requestKey)).toBeNull()
        })
      })
      test('bootstrap and restart preserve the identity of an ordinary committed epoch', async () => {
        await withGroup(1, 'bootstrap-epoch-identity', async (group) => {
          const member = memberAt(group.members, 0)
          const { commit, context } = await group.buildCommit()
          expect((await member.mls.processCommit(commit, context)).advanced).toBe(true)
          const before = await member.mls.readRecoverySource()
          const roster = await member.mls.rosterEntries()
          const ledger = await member.mls.getLedger()
          await member.mls.bootstrapLedger(ledger)
          const after = await member.mls.readRecoverySource()
          expect(after).toEqual({ ...before, stateVersion: after.stateVersion })
          expect(after.stateVersion).toBeGreaterThan(before.stateVersion)
          const restarted = await group.restartMember(0)
          expect(await restarted.mls.readRecoverySource()).toEqual(after)
          expect(await restarted.mls.rosterEntries()).toEqual(roster)
          expect(await restarted.mls.getLedger()).toEqual(ledger)
        })
      })
      test('restoration rejects altered request-key bytes even when the public key is unchanged', async () => {
        await withGroup(2, 'altered-request-key', async (group) => {
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)
          const { request, requestKey } = await bob.mls.createRecoveryRequest('altered-key')
          const pending = await bob.mls.applyRecovery(
            await alice.mls.sealGroupInfo(request),
            'altered-key',
            requestKey,
          )
          if (pending == null || 'renewalRequired' in pending) throw new Error('No candidate')
          const bytes = pending.serialize()
          const altered = requestKey.slice()
          altered[0] = (altered[0] as number) ^ 7
          altered[31] = (altered[31] as number) ^ 128
          await expect(bob.mls.restoreRecovery(bytes, altered)).rejects.toThrow()
          expect((await bob.mls.restoreRecovery(bytes, requestKey)).commit).toEqual(pending.commit)
        })
      })
      test('an epoch read waits for recovery adoption persistence and returns the installed epoch', async () => {
        await withGroup(2, 'recovery-epoch-lock', async (group) => {
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)
          const { request, requestKey } = await bob.mls.createRecoveryRequest('locked-epoch')
          const pending = await bob.mls.applyRecovery(
            await alice.mls.sealGroupInfo(request),
            'locked-epoch',
            requestKey,
          )
          if (pending == null || 'renewalRequired' in pending) throw new Error('No candidate')
          let entered!: () => void
          let release!: () => void
          const saving = new Promise<void>((resolve) => {
            entered = resolve
          })
          const gate = new Promise<void>((resolve) => {
            release = resolve
          })
          group.pauseNextSave(1, async () => {
            entered()
            await gate
          })
          const adoption = pending.onAccepted(() => ({ mutationID: 'locked-epoch', changes: {} }))
          await saving
          let settled = false
          const reading = bob.mls.readEpoch().then((epoch) => {
            settled = true
            return epoch
          })
          try {
            await new Promise<void>((resolve) => setTimeout(resolve, 0))
            expect(settled).toBe(false)
          } finally {
            release()
            await adoption
          }
          expect(await reading).toBe(pending.epoch)
        })
      })
      test('a source read waits for recovery adoption persistence and returns the installed identity', async () => {
        await withGroup(2, 'recovery-source-lock', async (group) => {
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)
          const before = await bob.mls.readRecoverySource()
          const { request, requestKey } = await bob.mls.createRecoveryRequest('locked-source')
          const pending = await bob.mls.applyRecovery(
            await alice.mls.sealGroupInfo(request),
            'locked-source',
            requestKey,
          )
          if (pending == null || 'renewalRequired' in pending) throw new Error('No candidate')
          let entered!: () => void
          let release!: () => void
          const saving = new Promise<void>((resolve) => {
            entered = resolve
          })
          const gate = new Promise<void>((resolve) => {
            release = resolve
          })
          group.pauseNextSave(1, async () => {
            entered()
            await gate
          })
          const adoption = pending.onAccepted(() => ({
            mutationID: 'locked-source',
            changes: { deleteRejoin: true },
          }))
          await saving
          let settled = false
          const reading = bob.mls.readRecoverySource().then((source) => {
            settled = true
            return source
          })
          try {
            await new Promise<void>((resolve) => setTimeout(resolve, 0))
            expect(settled).toBe(false)
          } finally {
            release()
            await adoption
          }
          const source = await reading
          expect(sourceIdentity(source).epoch).toBe(pending.epoch)
          expect(sourceIdentity(source).authenticator).not.toEqual(
            sourceIdentity(before).authenticator,
          )
          expect(source).toEqual(await bob.mls.readRecoverySource())
        })
      })
      test('a serialized candidate restores bound judgement and accepts once', async () => {
        await withGroup(2, 'restorable-recovery', async (group) => {
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)
          const { request, requestKey } = await bob.mls.createRecoveryRequest('restorable')
          const reply = await alice.mls.sealGroupInfo(request)
          const pending = await bob.mls.applyRecovery(reply, 'restorable', requestKey)
          if (pending == null || 'renewalRequired' in pending) throw new Error('No candidate')
          await pending.confirmationKey('position', 'digest')
          const verdict: ConformanceRecoveryVerdict = {
            groupID: group.groupID,
            requestID: 'restorable',
            position: 'position',
            commitDigest: 'digest',
            verdict: 'refused',
            reason: 'policy',
            refusalAuthority: 'authenticated-commit',
          }
          const sealed = await alice.mls.sealRecoveryVerdict(request, verdict)
          const opened = await bob.mls.openRecoveryVerdict(sealed, 'restorable', requestKey)
          if (opened == null) throw new Error('No verdict')
          const before = await bob.mls.readEpoch()
          const bytes = pending.serialize()
          await expect(bob.mls.restoreRecovery(bytes, new Uint8Array(32))).rejects.toThrow()
          await expect(alice.mls.restoreRecovery(bytes, requestKey)).rejects.toThrow()
          const restored = await bob.mls.restoreRecovery(bytes, requestKey)
          expect(restored.commit).toEqual(pending.commit)
          expect(restored.epoch).toBe(pending.epoch)
          expect(restored.judgeVerdict(opened)).toBe('authoritative')
          await expect(restored.confirmationKey('other', 'digest')).rejects.toThrow()
          expect(await bob.mls.readEpoch()).toBe(before)
          const write = () => ({
            mutationID: 'restored-adoption',
            changes: { deleteRejoin: true as const },
          })
          await restored.onAccepted(write)
          await restored.onAccepted(write)
          await (await bob.mls.restoreRecovery(bytes, requestKey)).onAccepted(write)
          expect(await bob.mls.readEpoch()).toBe(pending.epoch)
        })
      })
      test('restored acceptance requires an adoption factory before changing state or returning cached success', async () => {
        await withGroup(2, 'restored-requires-write', async (group) => {
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)
          const { request, requestKey } = await bob.mls.createRecoveryRequest('required-write')
          const reply = await alice.mls.sealGroupInfo(request)
          const pending = await bob.mls.applyRecovery(reply, 'required-write', requestKey)
          if (pending == null || 'renewalRequired' in pending) throw new Error('No candidate')
          const bytes = pending.serialize()
          await expect(Reflect.apply(pending.onAccepted, pending, [])).rejects.toThrow()
          const restored = await bob.mls.restoreRecovery(bytes, requestKey)
          const before = await bob.mls.readEpoch()
          await expect(Reflect.apply(restored.onAccepted, restored, [])).rejects.toThrow()
          expect(await bob.mls.readEpoch()).toBe(before)
          const write = () => ({
            mutationID: 'required-write',
            changes: { deleteRejoin: true as const },
          })
          await restored.onAccepted(write)
          expect(await bob.mls.readEpoch()).toBe(pending.epoch)
          await expect(Reflect.apply(restored.onAccepted, restored, [])).rejects.toThrow()
          const again = await bob.mls.restoreRecovery(bytes, requestKey)
          await expect(Reflect.apply(again.onAccepted, again, [])).rejects.toThrow()
          await again.onAccepted(write)
        })
      })
      test('readers need the explicit key, including after a new request with the same ID', async () => {
        await withGroup(2, 'explicit-recovery-key', async (group) => {
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)
          const { request, requestKey } = await bob.mls.createRecoveryRequest('explicit')
          const info = await alice.mls.sealGroupInfo(request)
          const ledger = await alice.mls.sealLedger(request)
          const verdict = await alice.mls.sealRecoveryVerdict(request, {
            groupID: group.groupID,
            requestID: 'explicit',
            position: 'position',
            commitDigest: 'digest',
            verdict: 'superseded',
          })
          const next = await bob.mls.createRecoveryRequest('explicit')
          expect(await bob.mls.applyRecovery(info, 'explicit', next.requestKey)).toBeNull()
          expect(await bob.mls.openSealedLedger(ledger, 'explicit', next.requestKey)).toBeNull()
          expect(await bob.mls.openRecoveryVerdict(verdict, 'explicit', next.requestKey)).toBeNull()
          expect(await bob.mls.applyRecovery(info, 'explicit', requestKey)).not.toBeNull()
          expect(await bob.mls.openSealedLedger(ledger, 'explicit', requestKey)).toEqual(
            await alice.mls.getLedger(),
          )
          expect(await bob.mls.openRecoveryVerdict(verdict, 'explicit', requestKey)).not.toBeNull()
        })
      })
      test('a marked replacement binding is not reused after a ratchet or returned again by the host', async () => {
        const { requester, responder, ratchet, replaceBinding } = await params.createBoundRecovery()
        expect(await requester.prepareRecovery()).toBe('ready')
        const { request, requestKey } = await requester.createRecoveryRequest('mark-binding')
        const pending = await requester.applyRecovery(
          await responder.sealGroupInfo(request),
          'mark-binding',
          requestKey,
        )
        if (pending == null || 'renewalRequired' in pending) throw new Error('No bound candidate')
        const before = await requester.readEpoch()
        expect(pending.markBindingUnusable()).toBeUndefined()
        expect(pending.markBindingUnusable()).toBeUndefined()
        expect(await requester.readEpoch()).toBe(before)
        expect(await requester.prepareRecovery()).toBe('renewal-required')
        await ratchet()
        expect(await requester.prepareRecovery()).toBe('renewal-required')
        await replaceBinding()
        expect(await requester.prepareRecovery()).toBe('ready')
      })
      test('pending exporter agrees with survivors without adopting, and acceptance is idempotent', async () => {
        await withGroup(2, 'confirmation-exporter', async (group) => {
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)
          const before = await bob.mls.readEpoch()
          const { request, requestKey } = await bob.mls.createRecoveryRequest('confirm')
          const pending = await bob.mls.applyRecovery(
            await alice.mls.sealGroupInfo(request),
            'confirm',
            requestKey,
          )
          if (pending == null || 'renewalRequired' in pending)
            throw new Error('No pending recovery')
          const deriving = pending.confirmationKey('position', 'digest')
          pending.markBindingUnusable()
          expect(await bob.mls.prepareRecovery()).toBe('ready')
          await expect(pending.confirmationKey('other', 'digest')).rejects.toThrow()
          const key = await deriving
          expect(key).toHaveLength(32)
          expect(await bob.mls.readEpoch()).toBe(before)
          expect(pending.epoch).toBe((await alice.mls.readEpoch()) + 1)
          const result = await alice.mls.processCommit(pending.commit, {})
          expect(result.advanced).toBe(true)
          expect(await alice.mls.confirmationKey('position', 'digest')).toEqual({
            epoch: pending.epoch,
            key,
          })
          expect((await alice.mls.confirmationKey('position', 'other')).key).not.toEqual(key)
          expect((await alice.mls.confirmationKey('other', 'digest')).key).not.toEqual(key)
          await pending.onAccepted(() => ({
            mutationID: crypto.randomUUID(),
            changes: { deleteRejoin: true },
          }))
          await pending.onAccepted(() => ({
            mutationID: crypto.randomUUID(),
            changes: { deleteRejoin: true },
          }))
          expect(await bob.mls.readEpoch()).toBe(pending.epoch)
          expect(sourceIdentity(await bob.mls.readRecoverySource()).authenticator).toEqual(
            sourceIdentity(await alice.mls.readRecoverySource()).authenticator,
          )
        })
      })
      test.each([undefined, 'authenticated-commit'] as const)(
        'sealed verdicts bind the tuple and refusal authority through restoration: %s',
        async (refusalAuthority) => {
          await withGroup(2, 'verdict-contract', async (group) => {
            const alice = memberAt(group.members, 0)
            const bob = memberAt(group.members, 1)
            const { request, requestKey } = await bob.mls.createRecoveryRequest('verdict')
            const reply = await alice.mls.sealGroupInfo(request)
            const pending = await bob.mls.applyRecovery(reply, 'verdict', requestKey)
            if (pending == null || 'renewalRequired' in pending)
              throw new Error('No pending recovery')
            await pending.confirmationKey('position', 'digest')
            const verdict: ConformanceRecoveryVerdict = {
              groupID: group.groupID,
              requestID: 'verdict',
              position: 'position',
              commitDigest: 'digest',
              verdict: 'refused',
              reason: 'policy',
              ...(refusalAuthority === undefined ? {} : { refusalAuthority }),
            }
            const sealed = await alice.mls.sealRecoveryVerdict(request, verdict)
            const opened = await bob.mls.openRecoveryVerdict(sealed, 'verdict', requestKey)
            expect(opened).toEqual({ signer: alice.did, verdict })
            expect(await bob.mls.openRecoveryVerdict(sealed, 'verdict', requestKey)).toEqual(opened)
            expect(await bob.mls.openRecoveryVerdict(sealed, 'other', requestKey)).toBeNull()
            expect(await bob.mls.openRecoveryVerdict(reply, 'verdict', requestKey)).toBeNull()
            expect(await bob.mls.openSealedLedger(sealed, 'verdict', requestKey)).toBeNull()
            if (opened == null) throw new Error('No opened verdict')
            const restored = await bob.mls.restoreRecovery(pending.serialize(), requestKey)
            for (const candidate of [pending, restored]) {
              expect(candidate.judgeVerdict(opened)).toBe(
                refusalAuthority === 'authenticated-commit' ? 'authoritative' : 'advisory',
              )
            }
            expect(pending.judgeVerdict({ ...opened, signer: 'did:peer:unknown' })).toBe('advisory')
            expect(
              pending.judgeVerdict({ ...opened, verdict: { ...verdict, position: 'other' } }),
            ).toBe('advisory')
          })
        },
      )

      test.each([
        { verdict: 'unknown' },
        { verdict: 'refused', reason: 'unknown' },
        { verdict: 'refused' },
        { verdict: 'confirmed', epoch: -1, tag: 'tag' },
        { verdict: 'confirmed', epoch: 1.5, tag: 'tag' },
        { verdict: 'confirmed', epoch: 0, tag: 42 },
        { verdict: 'superseded', position: '' },
        { verdict: 'superseded', commitDigest: 42 },
      ])('malformed sealed verdicts are refused: %j', async (change) => {
        await withGroup(2, 'malformed-verdict', async (group) => {
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)
          const { request, requestKey } = await bob.mls.createRecoveryRequest('malformed')
          const verdict = {
            groupID: group.groupID,
            requestID: 'malformed',
            position: 'position',
            commitDigest: 'digest',
            ...change,
          }
          const sealed = await group.sealVerdictPayload(0, request, verdict)
          expect(await bob.mls.openRecoveryVerdict(sealed, 'malformed', requestKey)).toBeNull()
          await expect(
            alice.mls.sealRecoveryVerdict(request, verdict as ConformanceRecoveryVerdict),
          ).rejects.toThrow()
        })
      })

      test('a member answers another member, and the reply rebuilds a rejoin', async () => {
        await withGroup(2, 'recovery-round-trip', async (group) => {
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)

          const epochBefore = await bob.mls.readEpoch()
          expect(await bob.mls.prepareRecovery()).toBe('ready')
          expect(await bob.mls.readEpoch()).toBe(epochBefore)
          const { request, requestKey } = await bob.mls.createRecoveryRequest('req-1')
          const sealed = await alice.mls.sealGroupInfo(request)
          const pending = await bob.mls.applyRecovery(sealed, 'req-1', requestKey)

          // Narrowed rather than optional-chained: `expect` does not narrow, and a chain that
          // short-circuits would TypeError on `.length` instead of failing this assertion.
          if (pending == null || 'renewalRequired' in pending)
            throw new Error('applyRecovery returned no pending commit')
          expect(pending.commit).toBeInstanceOf(Uint8Array)
          expect(pending.commit.length).toBeGreaterThan(0)
        })
      })

      /**
       * AUTHORIZATION IS ROSTER-INTRINSIC, not a check a caller can forget. A removed member keeps
       * the rendezvous secret for life — it is epoch-independent by design, so a stranded peer on
       * any epoch can always reach the group — so the request it mints is indistinguishable from
       * an honest one. The only thing standing between it and the group's current GroupInfo is
       * that no responder holding its removal will answer.
       *
       * A double that answered anyway would make eviction cosmetic, and nothing else in the stack
       * would notice: the lane's job is to deliver the request, not to judge it.
       */
      test('a responder that has applied a removal refuses the removed member', async () => {
        await withGroup(2, 'recovery-refuses-removed', async (group) => {
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)

          // Bob is removed. Alice applies it; Bob cannot, so he still holds a live handle and the
          // rendezvous secret — exactly the position an evicted member is in.
          const removal = await group.buildCommit({ removes: 1 })
          expect(await alice.mls.processCommit(removal.commit, removal.context)).toMatchObject({
            advanced: true,
          })
          expect(dids(await alice.mls.rosterEntries())).not.toContain(bob.did)

          const { request } = await bob.mls.createRecoveryRequest('req-removed')
          await expect(alice.mls.sealGroupInfo(request)).rejects.toThrow()
        })
      })

      test('a reply minted for another request does not open', async () => {
        await withGroup(2, 'recovery-wrong-request', async (group) => {
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)

          const { request, requestKey } = await bob.mls.createRecoveryRequest('req-a')
          const sealed = await alice.mls.sealGroupInfo(request)

          // The same bytes, opened against a different request's key. `null` or a throw — the lane
          // reads both the same way — but never a PendingRecovery.
          await expect(
            bob.mls.applyRecovery(sealed, 'req-b', requestKey).catch(() => null),
          ).resolves.toBeNull()
        })
      })

      /**
       * The rendezvous topic must be reachable by a peer at ANY epoch, including one that has
       * fallen far behind — that is the whole point of a lane for peers that cannot follow the
       * group. A secret that moved with the epoch would strand exactly the peers it exists for.
       */
      test('the recovery secret does not move with the epoch', async () => {
        await withGroup(2, 'recovery-secret-stable', async (group) => {
          const alice = memberAt(group.members, 0)
          const before = await alice.mls.exportRecoverySecret()
          const commit = await group.buildCommit()
          await alice.mls.processCommit(commit.commit, commit.context)
          expect(await alice.mls.exportRecoverySecret()).toEqual(before)
        })
      })
    })

    /**
     * THE LEDGER GATHER. The ledger is the group's whole authority state — who is an admin, and so
     * who may add, remove, promote and demote. It travels on the same public secretless topic, so
     * every clause here is about a responder refusing, or a requester refusing to believe.
     */
    describe('the ledger gather', () => {
      test('a member seals its whole ordered ledger to another member, who opens it', async () => {
        await withGroup(2, 'ledger-round-trip', async (group) => {
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)

          const { request, requestKey } = await bob.mls.createRecoveryRequest('gather-1')
          const sealed = await alice.mls.sealLedger(request)
          const opened = await bob.mls.openSealedLedger(sealed, 'gather-1', requestKey)

          expect(opened).toEqual(await alice.mls.getLedger())
        })
      })

      /**
       * Same roster-intrinsic authorization as `sealGroupInfo`, and it matters more here: this
       * reply is the group's entire authority state, sealed to whatever key the requester put in
       * its own request. A responder that sealed without checking would hand every role and
       * promotion to any stranger who minted one.
       */
      test('a responder that has applied a removal refuses to seal its ledger', async () => {
        await withGroup(2, 'ledger-refuses-removed', async (group) => {
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)

          const removal = await group.buildCommit({ removes: 1 })
          await alice.mls.processCommit(removal.commit, removal.context)

          const { request } = await bob.mls.createRecoveryRequest('gather-removed')
          await expect(alice.mls.sealLedger(request)).rejects.toThrow()
        })
      })

      /**
       * THE KEY IS NOT CONSUMED, and the lane depends on it: every responder answers one gather,
       * so the requester opens reply after reply until one folds to its authenticated head. A port
       * that spent the key on the first open would leave a peer able to consider exactly one
       * responder — and the first reply may be the forged one.
       */
      test('opening one reply does not prevent opening the next', async () => {
        await withGroup(3, 'ledger-two-replies', async (group) => {
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)
          const carol = memberAt(group.members, 2)

          const { request, requestKey } = await carol.mls.createRecoveryRequest('gather-many')
          const fromAlice = await alice.mls.sealLedger(request)
          const fromBob = await bob.mls.sealLedger(request)

          expect(
            await carol.mls.openSealedLedger(fromAlice, 'gather-many', requestKey),
          ).not.toBeNull()
          expect(
            await carol.mls.openSealedLedger(fromBob, 'gather-many', requestKey),
          ).not.toBeNull()
        })
      })

      test('a reply sealed for another request does not open', async () => {
        await withGroup(2, 'ledger-wrong-request', async (group) => {
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)

          const { request, requestKey } = await bob.mls.createRecoveryRequest('gather-a')
          const sealed = await alice.mls.sealLedger(request)
          await expect(
            bob.mls.openSealedLedger(sealed, 'gather-b', requestKey).catch(() => null),
          ).resolves.toBeNull()
        })
      })

      /**
       * OPENING PROVES NOTHING ABOUT WHO SEALED IT — the gather reply carries no attestation, and
       * an observer of the request can forge one that decrypts. The bound is `bootstrapLedger`'s
       * head check: a list reproducing the head this handle's OWN GroupContext attests to is the
       * group's whole ledger in order, and anything else is refused. A lying responder can
       * withhold; it can never rewrite.
       */
      test('bootstrapLedger refuses a ledger that does not fold to the head this handle attests to', async () => {
        await withGroup(2, 'ledger-head-check', async (group) => {
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)

          const honest = await alice.mls.getLedger()
          if (honest.length === 0) {
            // Nothing to doctor: this implementation's groups carry no ledger entries, so the
            // clause has no subject. Stated rather than silently passing.
            expect(await bob.mls.getLedger()).toEqual([])
            return
          }

          // Genuinely signed tokens, one dropped. No forgery is required, which is the point.
          await expect(bob.mls.bootstrapLedger(honest.slice(0, -1))).rejects.toThrow()

          // And the honest list is accepted, so what refused above was the omission.
          await expect(bob.mls.bootstrapLedger(honest)).resolves.toBeUndefined()
          expect(await bob.mls.getLedger()).toEqual(honest)
        })
      })

      /**
       * `isLedgerComplete` is how a peer knows it must gather before it can be trusted to fold a
       * roster or judge a commit. A port that answered `true` for a handle holding nothing would
       * let a rejoined peer judge commits against an empty authority state.
       */
      test('reports completeness against the head the handle carries', async () => {
        await withGroup(2, 'ledger-complete', async (group) => {
          const alice = memberAt(group.members, 0)
          expect(await alice.mls.isLedgerComplete()).toBe(true)
        })
      })
    })
  })
}

export type ConformanceAdoptionWriteFactory<Position extends string = string> = (staged: {
  incarnation: number
  epochAfter: number
  removed: boolean
  epochAuthenticator: Uint8Array
}) => ConformanceAdoptionWrite<Position>
export type ConformanceCapturedRecapture = {
  sealed: Uint8Array
  requestID: string
  requestKey: Uint8Array
  epochFloor: number | null
}
export type ConformanceRecoveryReconciliation<Position extends string = string> =
  | {
      kind: 'superseded-branch'
      epoch: number
      authorisation: ConformanceForkRecoveryAuthorisation
    }
  | { kind: 'accepted'; epoch: number; leafDigest: string }
  | { kind: 'head-only'; head: Position | null }
  | { kind: 'unapplied-later'; epoch: number; leafDigest: string }
  | { kind: 'retry'; reason?: 'target-behind' | 'capture-authenticator-disagreement' }
  | { kind: 'held' }
export type ConformanceCapturedPendingRecovery<Position extends string = string> = Omit<
  ConformancePendingRecovery,
  'onAccepted'
> & {
  source: ConformanceRecoverySource<unknown>
  target: ConformanceRecoveryTargetCapture<Position>
  onAccepted(
    expected: ConformanceRecoverySource<unknown>,
    proof: ConformanceResyncProof<Position>,
    write: ConformanceAdoptionWriteFactory<Position>,
  ): Promise<void>
}
export type ConformanceCapturedAppliedRecovery<Position extends string = string> =
  | ConformanceCapturedPendingRecovery<Position>
  | { renewalRequired: true }
  | null
export type ConformanceAuthenticatedRosterAbsence = {
  groupID: string
  requesterDID: string
  requestID: string
  epoch: number
  captureHead: string | null
  groupInfoAuthenticator: Uint8Array
  confirmedTranscriptHash: string
  responderDID: string
  responderKeyHash: string
  lineage: Array<{ epoch: number; authHash: string }>
  evidence: Uint8Array
}
export type ConformanceCapturedRecoveryPort<Position extends string = string> = {
  authoriseForkRecovery?(
    reply: ConformanceCapturedRecapture,
    noticeID: string,
  ): Promise<ConformanceForkRecoveryAuthorisation | null>
  applyRecovery(
    sealed: Uint8Array,
    requestID: string,
    requestKey: Uint8Array,
  ): Promise<ConformanceCapturedAppliedRecovery<Position>>
  restoreRecovery(
    candidate: Uint8Array,
    requestKey: Uint8Array,
  ): Promise<ConformanceCapturedPendingRecovery<Position>>
  reconcileCapture(
    record: ConformanceCapturedRejoinRecord<Position>,
    reply: ConformanceCapturedRecapture,
  ): Promise<ConformanceRecoveryReconciliation<Position>>
  checkRosterAbsence?(
    evidence: Uint8Array,
    requestID: string,
    requestKey: Uint8Array,
  ): Promise<ConformanceAuthenticatedRosterAbsence | null>
  sealRosterAbsence?(request: Uint8Array, captureHead: Position | null): Promise<Uint8Array | null>
  sealGroupInfo(request: Uint8Array, captureHead: Position | null): Promise<Uint8Array>
}
export type ConformanceConfirmedRecoveryHandoff<Position extends string = string> = {
  record: ConformanceCapturedRejoinRecord<Position>
  completion: Promise<void>
}
export type ConformanceRecoveryContinuation<Position extends string = string> = {
  source: ConformanceGroupKey
  destination: ConformanceGroupKey
  record: ConformanceStoredRejoinRecord<Position>
}
export type ConformanceRecoveryCompletion = (params: {
  ledger: Array<string>
  mutationID: string
}) => Promise<void>
export type ConformanceRecoveryContinuationPort<Position extends string = string> = {
  loadRecoveryContinuation(
    destination: ConformanceGroupKey,
  ): Promise<ConformanceRecoveryContinuation<Position> | null>
  finishRecoveryContinuation(params: {
    continuation: ConformanceRecoveryContinuation<Position>
    ledger: Array<string>
    mutationID: string
  }): Promise<void>
}

function sourceIdentity(source: ConformanceAdoptionExpected) {
  if (source.identity === null) throw new Error('Missing fixture source identity')
  return source.identity
}

export type ForkRecoveryFixture = {
  key: ConformanceGroupKey
  noticeID: string
  requester(): ConformanceGroupMLS
  snapshot(): Promise<ConformanceControlSnapshot>
  service(): { readRecords(): Promise<Array<ConformanceCheckpointRecord>> }
  builds(): number
  ordinaryWrite(kind: 'delete' | 'unrelated' | 'wrong-source'): Promise<void>
  reply(
    epoch?: number,
    branch?: 'own' | 'other',
    legacy?: boolean,
  ): Promise<ConformanceCapturedRecapture & { request: Uint8Array }>
  saveX(
    stage?: 'built' | 'published' | 'confirmed' | 'adopted',
  ): Promise<ConformanceCapturedRejoinRecord>
  build(
    authority: ConformanceForkRecoveryAuthorisation,
    reply: ConformanceCapturedRecapture & { request: Uint8Array },
  ): Promise<{ record: ConformanceCapturedRejoinRecord } | null>
  restart(): Promise<void>
  close(): Promise<void>
}

export function testForkRecoveryConformance(params: {
  label: string
  createFixture(): Promise<ForkRecoveryFixture>
}): void {
  describe(`bound fork recovery / ${params.label}`, () => {
    async function run(fn: (fixture: ForkRecoveryFixture) => Promise<void>) {
      const fixture = await params.createFixture()
      try {
        await fn(fixture)
      } finally {
        await fixture.close()
      }
    }
    test.each(['built', 'published', 'confirmed', 'adopted'] as const)(
      'every saved X stage settles superseded branch before fresh Y: %s',
      (stage) =>
        run(async (f) => {
          const exactX = await f.saveX(stage)
          const before = await f.snapshot()
          const capture = await f.reply()
          const port = f.requester().capturedRecovery
          expect(typeof port?.authoriseForkRecovery).toBe('function')
          const authority = await port?.authoriseForkRecovery?.(capture, f.noticeID)
          if (authority == null) throw new Error('Missing branch authority')
          const after = await f.snapshot()
          expect(after.recoveryEpochFloor).toBe(before.recoveryEpochFloor)
          expect(after.rejoin).toBeNull()
          expect(after.forkRecoveryAttempt).toMatchObject({
            id: authority.attemptID,
            source: f.key,
            forkRecovery: authority,
          })
          expect(after.settledRejoins).toContainEqual(
            expect.objectContaining({
              kind: 'superseded-branch',
              epoch: 10,
              ledgerBefore: exactX.ledgerBefore,
            }),
          )
          const history = (await f.service().readRecords()).find(
            (row) => row.kind === 'superseded-rejoin',
          )
          if (history?.kind !== 'superseded-rejoin') throw new Error('Missing exact saved history')
          expect(history.record).toEqual(exactX)
          exactX.requestKey.fill(0)
          exactX.candidate.fill(0)
          await f.restart()
          expect((await f.snapshot()).forkRecoveryAttempt).toEqual(after.forkRecoveryAttempt)
          const reopened = (await f.service().readRecords()).find(
            (row) => row.kind === 'superseded-rejoin',
          )
          expect(reopened).toEqual(history)
          const y = await f.build(authority, await f.reply())
          expect(y?.record.id).toBe(authority.attemptID)
          expect((await f.snapshot()).recoveryEpochFloor).toBe(20)
        }),
    )
    test('ahead device without X requires bound branch reply', () =>
      run(async (f) => {
        const before = await f.snapshot()
        const port = f.requester().capturedRecovery
        expect(await port?.authoriseForkRecovery?.(await f.reply(12, 'own'), f.noticeID)).toBeNull()
        expect(await f.snapshot()).toEqual(before)
        expect(await port?.authoriseForkRecovery?.(await f.reply(), f.noticeID)).toMatchObject({
          splitEpoch: 10,
        })
        expect((await f.snapshot()).settledRejoins).toEqual([])
        expect((await f.snapshot()).recoveryEpochFloor).toBe(before.recoveryEpochFloor)
      }))
    test.each([false, true])(
      'retry after settlement cannot accept own lineage capture above E after restart before Y: %s',
      (restart) =>
        run(async (f) => {
          await f.saveX()
          const authority = await f
            .requester()
            .capturedRecovery?.authoriseForkRecovery?.(await f.reply(), f.noticeID)
          if (authority == null) throw new Error('Missing branch authority')
          const before = await f.snapshot()
          if (restart) await f.restart()
          expect(await f.build(authority, await f.reply(13, 'own'))).toBeNull()
          expect(await f.snapshot()).toEqual(before)
          expect(f.builds()).toBe(0)
        }),
    )
    test('v2 or missing real authority preserves X and ordinary floor', () =>
      run(async (f) => {
        await f.saveX()
        const before = await f.snapshot()
        expect(
          await f
            .requester()
            .capturedRecovery?.authoriseForkRecovery?.(
              await f.reply(12, 'other', true),
              f.noticeID,
            ),
        ).toBeNull()
        expect(await f.snapshot()).toEqual(before)
      }))
    test('own-lineage stale capture refused by transcript hash', () =>
      run(async (f) => {
        await f.saveX()
        const before = await f.snapshot()
        expect(
          await f
            .requester()
            .capturedRecovery?.authoriseForkRecovery?.(await f.reply(12, 'own'), f.noticeID),
        ).toBeNull()
        expect(await f.snapshot()).toEqual(before)
        expect(f.builds()).toBe(0)
      }))
    test('saved v2 X restores after lineage reply activation', () =>
      run(async (f) => {
        const record = await f.saveX()
        const before = await f.snapshot()
        const restored = await f
          .requester()
          .capturedRecovery?.restoreRecovery(record.candidate, record.requestKey)
        expect(restored?.target).toEqual(record.target)
        expect(restored?.source).toEqual(record.source)
        expect(await f.snapshot()).toEqual(before)
      }))
    test('two member fork recovery needs no distinct witness DID', () =>
      run(async (f) => {
        expect(
          await f
            .requester()
            .capturedRecovery?.authoriseForkRecovery?.(await f.reply(), f.noticeID),
        ).toMatchObject({ splitEpoch: 10 })
      }))
    test('offered head above newest retained fact needs valid E lineage', () =>
      run(async (f) => {
        await f.saveX()
        expect(
          await f
            .requester()
            .capturedRecovery?.authoriseForkRecovery?.(await f.reply(21), f.noticeID),
        ).toMatchObject({ splitEpoch: 10 })
      }))
    test('equal-number different authenticator capture gets a fresh bound Y', () =>
      run(async (f) => {
        const record = await f.saveX()
        const capture = await f.reply(20)
        const authority = await f
          .requester()
          .capturedRecovery?.authoriseForkRecovery?.(capture, f.noticeID)
        if (authority == null) throw new Error('Missing equal-epoch branch authority')
        const y = await f.build(authority, capture)
        expect(y?.record.id).not.toBe(record.id)
        expect(y?.record.target.groupInfoEpoch).toBe(20)
        expect(y?.record.target.groupInfoAuthenticator).not.toEqual(
          record.target.groupInfoAuthenticator,
        )
      }))
    test('retry after settlement cannot accept own lineage capture above E with Y built', () =>
      run(async (f) => {
        await f.saveX()
        const authority = await f
          .requester()
          .capturedRecovery?.authoriseForkRecovery?.(await f.reply(), f.noticeID)
        if (authority == null) throw new Error('Missing authority')
        const y = await f.build(authority, await f.reply())
        if (y === null) throw new Error('Missing Y')
        const before = await f.snapshot()
        expect(
          await f
            .requester()
            .capturedRecovery?.reconcileCapture(y.record, await f.reply(13, 'own')),
        ).toEqual({ kind: 'retry', reason: 'target-behind' })
        expect(await f.snapshot()).toEqual(before)
      }))
    test('capture below split stays target behind', () =>
      run(async (f) => {
        await f.saveX()
        const before = await f.snapshot()
        expect(
          await f
            .requester()
            .capturedRecovery?.authoriseForkRecovery?.(await f.reply(9), f.noticeID),
        ).toBeNull()
        expect(await f.snapshot()).toEqual(before)
      }))
    test('Y recapture settlement preserves ordinary floor and removes its exception', () =>
      run(async (f) => {
        await f.saveX()
        const authority = await f
          .requester()
          .capturedRecovery?.authoriseForkRecovery?.(await f.reply(), f.noticeID)
        if (authority == null) throw new Error('Missing authority')
        const y = await f.build(authority, await f.reply())
        if (y === null) throw new Error('Missing bound Y')
        const result = await f
          .requester()
          .capturedRecovery?.reconcileCapture(y.record, await f.reply(13))
        expect(result).toMatchObject({ kind: 'unapplied-later', epoch: 13 })
        const after = await f.snapshot()
        expect(after.recoveryEpochFloor).toBe(20)
        expect(after.forkRecoveryAttempt).toBeNull()
        expect(after.rejoin).toBeNull()
        expect(after.settledRejoins[0]?.ledgerBefore).toEqual(['owed-X', 'shared'])
      }))
    test.each(['delete', 'unrelated', 'wrong-source'] as const)(
      'ordinary writes cannot detach a bound Y: %s',
      (kind) =>
        run(async (f) => {
          await f.saveX()
          const capture = await f.reply()
          const authority = await f
            .requester()
            .capturedRecovery?.authoriseForkRecovery?.(capture, f.noticeID)
          if (authority == null) throw new Error('Missing authority')
          expect(await f.build(authority, capture)).not.toBeNull()
          const before = await f.snapshot()
          await expect(f.ordinaryWrite(kind)).rejects.toThrow()
          expect(await f.snapshot()).toEqual(before)
        }),
    )
    test('existing Y intent makes authorisation idempotent', () =>
      run(async (f) => {
        await f.saveX()
        const port = f.requester().capturedRecovery
        const first = await port?.authoriseForkRecovery?.(await f.reply(), f.noticeID)
        expect(first).not.toBeNull()
        const before = await f.snapshot()
        expect(await port?.authoriseForkRecovery?.(await f.reply(), f.noticeID)).toEqual(first)
        expect(await f.snapshot()).toEqual(before)
      }))
  })
}
