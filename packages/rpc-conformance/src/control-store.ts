import { describe, expect, test } from 'vitest'

import type { ConformanceAnchorStore } from './anchor-store.js'

export type ConformanceControlSnapshot<Position extends string = string> = {
  operations: Array<ConformanceOperation<Position>> // FIFO by `seq`
  rejoin: ConformanceRejoinRecord<Position> | null
  outcomes: Array<ConformanceOutcome<Position>>
  welcomes: Array<ConformanceWelcomeObligation>
  applied: Array<ConformanceAppliedCommit> // newest 64 epochs
  responses: Array<ConformanceExternalResponse<Position>> // responder outcomes, newest 64 epochs
  cursor: ConformanceCommitCursor<Position> | null // {position, epoch, stranded?, fork?}
}
/**
 * Durable with the strand. A detected conflict, not a proven divergence point: the framed epoch is
 * unauthenticated below the current epoch, and divergence may lie lower (D5).
 */
export type ConformanceForkEvidence<Position extends string = string> = {
  conflictEpoch: number
  sharedPosition: Position | null
  frameDigest: string
}
export type ConformanceControlChanges<Position extends string = string> = {
  putOperations?: Array<ConformanceOperation<Position>>
  deleteOperations?: Array<string>
  putRejoin?: ConformanceRejoinRecord<Position>
  deleteRejoin?: true
  putOutcomes?: Array<ConformanceOutcome<Position>>
  deleteOutcomes?: Array<string>
  putWelcomes?: Array<ConformanceWelcomeObligation>
  deleteWelcomes?: Array<string>
  putApplied?: Array<ConformanceAppliedCommit>
  deleteAppliedFrom?: number // drops rows at epoch >= n, before puts
  putResponses?: Array<ConformanceExternalResponse<Position>>
  deleteResponsesBelow?: number // by `epoch`
  cursor?: ConformanceCommitCursor<Position> | null
}
/** Control changes committed with an adoption's state save (D5). */
export type ConformanceAdoptionWrite<Position extends string = string> = {
  changes: ConformanceControlChanges<Position>
  mutationID: string
  /** The `advance` of the pending anchor rotation this adoption lands, marked in the same transaction. */
  anchorLanded?: string
}
export type ConformanceControlStore<Position extends string = string> = {
  load(): Promise<ConformanceControlSnapshot<Position>>
  /** All or nothing. On an ambiguous commit, rejects with `StorageOutcomeUnknownError`. */
  apply(changes: ConformanceControlChanges<Position>, mutationID: string): Promise<void>
  /** The `mutationID` of the last committed `apply`. */
  lastMutation(): Promise<string | null>
}

export type ConformanceOperationRequest = {
  /** Random 128-bit; the host's handle for outcomes. */
  id: string
  kind: 'invite' | 'remove' | 'ledger' | 'rotation'
  /** Holds app sends (the revoke hold, below) from enqueue until the operation settles. */
  revokes: boolean
  /** Host-opaque; everything `build` needs, such as targets, role and signed tokens. */
  body: Uint8Array
}
/** The operation deadline is `enqueuedAt + operationTimeoutMs`, so a restart keeps it. */
export type ConformanceOperation<Position extends string = string> = ConformanceOperationRequest & {
  seq: number
  enqueuedAt: number
} & (
    | { stage: 'intent' }
    | { stage: 'built'; built: ConformanceBuiltCommit<Position> }
    | { stage: 'accepted'; built: ConformanceBuiltCommit<Position>; acceptedAs: Position }
  )
export type ConformanceBuiltCommit<Position extends string = string> = {
  publishID: string
  expectedHead: Position | null
  /** Identity of the state the commit was built from. */
  epoch: number
  authenticatorBefore: Uint8Array
  lineage: number
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

export type ConformanceOutcome<Position extends string = string> = {
  id: string
  opID: string | null
  at: number
} & (
  | { kind: 'landed'; position: Position }
  | { kind: 'lost' } // absent from the branch this device follows
  | { kind: 'unknown' } // absence not provable, or touched by a fork (D5)
  | { kind: 'reenact'; tokens: Array<string> } // ledger tokens missing after a rejoin
  | { kind: 'rejected'; reason: string } // build refused, e.g. not authorised
  | { kind: 'refused'; reason: ConformanceRecoveryRefusal } // a rejoin refused by policy (D6)
)

export type ConformanceRejoinRecord<Position extends string = string> = {
  /** Random per rejoin. */
  id: string
  stage: 'built' | 'published' | 'confirmed' | 'adopted' | 'refused'
  publishID: string
  expectedHead: Position | null
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
  source: { epoch: number; authenticator: Uint8Array; lineage: number; head: Position | null }
  digest: string
  epochAfter: number
  /** Ledger tokens held before the rejoin, for `reenact`. */
  ledgerBefore: Array<string>
  /** `ConformanceForkEvidence<Position>.conflictEpoch`, when the rejoin heals a detected fork (D5). */
  conflictEpoch: number | null
  position?: Position
  verdict?: Uint8Array
  /** Set with stage `refused`. */
  refusal?: ConformanceRecoveryRefusal
}
export type ConformanceRecoveryRefusal = 'binding' | 'lapse' | 'floor' | 'policy' | 'invalid'
export type ConformanceWelcomeObligation = {
  opID: string
  welcome: Uint8Array
  recipients: Array<string>
}
export type ConformanceAppliedCommit = {
  epoch: number
  digest: string
  payloadDigest: string
  sequenceID: string
  opID: string | null
  removed: boolean
}
export type ConformanceExternalResponse<Position extends string = string> = {
  position: Position
  digest: string
  kind: 'applied' | 'refused' | 'superseded'
  epoch: number
  reason?: ConformanceRecoveryRefusal
  epochAfter?: number
}
export type ConformanceCommitCursor<Position extends string = string> = {
  position: Position
  epoch: number
  stranded?: true
  fork?: ConformanceForkEvidence<Position>
}

export type ConformanceControlHost = {
  control: ConformanceControlStore
  saveState(state: Uint8Array, write?: ConformanceAdoptionWrite): Promise<void>
  loadState(): Promise<Uint8Array | null>
  anchor: ConformanceAnchorStore
}

export type ControlStoreConformanceParams = {
  open(): Promise<ConformanceControlHost>
  reopen(): Promise<ConformanceControlHost>
  injectFailure(point: 'mid-apply' | 'mid-save'): void
  commitThenReject(): void
}

function records(): ConformanceControlChanges {
  return {
    putOperations: [
      {
        id: 'operation',
        kind: 'invite',
        revokes: false,
        body: new Uint8Array([1]),
        seq: 1,
        enqueuedAt: 100,
        stage: 'accepted',
        acceptedAs: '001',
        built: {
          publishID: 'publish',
          expectedHead: null,
          epoch: 4,
          authenticatorBefore: new Uint8Array([2]),
          lineage: 0,
          payload: new Uint8Array([3]),
          payloadDigest: 'payload-digest',
          digest: 'commit-digest',
          bodies: ['token'],
          journal: new Uint8Array([4]),
          welcome: { bytes: new Uint8Array([5]), recipients: ['bob'] },
        },
      },
    ],
    putRejoin: {
      id: 'rejoin',
      stage: 'confirmed',
      publishID: 'rejoin-publish',
      expectedHead: null,
      payload: new Uint8Array([6]),
      payloadDigest: 'rejoin-payload',
      requestID: 'request',
      request: new Uint8Array([7]),
      requestKey: new Uint8Array([0, 255, 128, 1]),
      candidate: new Uint8Array([255, 0, 127, 2]),
      source: { epoch: 4, authenticator: new Uint8Array([8]), lineage: 0, head: null },
      digest: 'rejoin-digest',
      epochAfter: 5,
      ledgerBefore: ['token'],
      conflictEpoch: 4,
      position: '002',
      verdict: new Uint8Array([9]),
    },
    putOutcomes: [
      { id: 'outcome', opID: 'prior-operation', at: 200, kind: 'landed', position: '000' },
    ],
    putWelcomes: [{ opID: 'operation', welcome: new Uint8Array([5]), recipients: ['bob'] }],
    putApplied: [
      {
        epoch: 3,
        digest: 'prior-digest',
        payloadDigest: 'prior-payload',
        sequenceID: '000',
        opID: 'prior-operation',
        removed: false,
      },
    ],
    putResponses: [
      { position: '000', digest: 'prior-digest', kind: 'applied', epoch: 3, epochAfter: 4 },
    ],
    cursor: {
      position: '001',
      epoch: 4,
      stranded: true,
      fork: { conflictEpoch: 4, sharedPosition: '000', frameDigest: 'conflict' },
    },
  }
}

export function testControlStoreConformance(params: ControlStoreConformanceParams): void {
  describe('ControlStore conformance', () => {
    test('all or nothing: a failed apply leaves every record and mutation unchanged after reopen', async () => {
      const host = await params.open()
      await host.control.apply(records(), 'baseline')
      const before = await host.control.load()
      params.injectFailure('mid-apply')
      await expect(
        host.control.apply(
          {
            deleteOperations: ['operation'],
            deleteRejoin: true,
            deleteOutcomes: ['outcome'],
            deleteWelcomes: ['operation'],
            deleteAppliedFrom: 0,
            deleteResponsesBelow: 100,
            cursor: null,
          },
          'failed',
        ),
      ).rejects.toThrow()
      const reopened = await params.reopen()
      expect(await reopened.control.load()).toEqual(before)
      expect(await reopened.control.lastMutation()).toBe('baseline')
    })

    test('durable: every record kind survives reopening', async () => {
      const host = await params.open()
      const changes = records()
      await host.control.apply(changes, 'durable')
      const reopened = await params.reopen()
      expect(await reopened.control.load()).toEqual({
        operations: changes.putOperations,
        rejoin: changes.putRejoin,
        outcomes: changes.putOutcomes,
        welcomes: changes.putWelcomes,
        applied: changes.putApplied,
        responses: changes.putResponses,
        cursor: changes.cursor,
      })
      expect(await reopened.control.lastMutation()).toBe('durable')
    })

    test('ambiguous commit: commit then reject exposes the committed mutation on reopen', async () => {
      const host = await params.open()
      params.commitThenReject()
      await expect(host.control.apply(records(), 'ambiguous')).rejects.toMatchObject({
        name: 'StorageOutcomeUnknownError',
      })
      const reopened = await params.reopen()
      expect(await reopened.control.lastMutation()).toBe('ambiguous')
      expect((await reopened.control.load()).operations).toHaveLength(1)
    })

    test('co-commit with the state save: state, control and the anchor mark change atomically', async () => {
      const host = await params.open()
      await host.saveState(new Uint8Array([1]))
      await host.control.apply(records(), 'baseline')
      const slot = {
        anchor: { secret: new Uint8Array([10]), epoch: 4 },
        pending: {
          epochBefore: 4,
          epochAfter: 5,
          rosterBefore: ['alice'],
          forced: true,
          advance: 'rotation',
        },
      }
      await host.anchor.save(slot)
      const before = await host.control.load()
      const write = {
        changes: { deleteOperations: ['operation'], cursor: { position: '002', epoch: 5 } },
        mutationID: 'adoption',
        anchorLanded: 'rotation',
      }
      params.injectFailure('mid-save')
      await expect(host.saveState(new Uint8Array([2]), write)).rejects.toThrow()
      const reopened = await params.reopen()
      expect(await reopened.loadState()).toEqual(new Uint8Array([1]))
      expect(await reopened.control.load()).toEqual(before)
      expect(await reopened.control.lastMutation()).toBe('baseline')
      expect(await reopened.anchor.load()).toEqual(slot)
      await reopened.saveState(new Uint8Array([2]), write)
      const committed = await params.reopen()
      expect(await committed.loadState()).toEqual(new Uint8Array([2]))
      expect((await committed.control.load()).operations).toEqual([])
      expect((await committed.control.load()).cursor).toEqual({ position: '002', epoch: 5 })
      expect(await committed.control.load()).toEqual({
        ...before,
        operations: [],
        cursor: { position: '002', epoch: 5 },
      })
      expect(await committed.control.lastMutation()).toBe('adoption')
      expect(await committed.anchor.load()).toEqual({
        ...slot,
        pending: { ...slot.pending, landed: true },
      })
    })

    test('outcomes persist until explicitly deleted', async () => {
      const host = await params.open()
      await host.control.apply(
        { putOutcomes: [{ id: 'unacked', opID: null, at: 1, kind: 'unknown' }] },
        'outcome',
      )
      await host.control.apply(
        { cursor: { position: '005', epoch: 65 }, deleteAppliedFrom: 0, deleteResponsesBelow: 65 },
        'prune',
      )
      const reopened = await params.reopen()
      expect((await reopened.control.load()).outcomes).toEqual([
        { id: 'unacked', opID: null, at: 1, kind: 'unknown' },
      ])
      await reopened.control.apply({ deleteOutcomes: ['unacked'] }, 'ack')
      expect((await (await params.reopen()).control.load()).outcomes).toEqual([])
    })

    test('deletes precede replacements and operations remain FIFO by sequence', async () => {
      const host = await params.open()
      const initial = records()
      await host.control.apply(initial, 'initial')
      const original = initial.putOperations?.[0]
      const rejoin = initial.putRejoin
      if (original == null || rejoin == null) throw new Error('Missing conformance fixture')
      await host.control.apply(
        {
          deleteOperations: ['operation'],
          putOperations: [
            { ...original, id: 'last', seq: 3 },
            { ...original, seq: 2 },
            { ...original, id: 'first', seq: 1 },
          ],
          deleteRejoin: true,
          putRejoin: { ...rejoin, stage: 'adopted' },
          deleteOutcomes: ['outcome'],
          putOutcomes: [{ id: 'outcome', opID: null, at: 300, kind: 'unknown' }],
          deleteWelcomes: ['operation'],
          putWelcomes: [
            { opID: 'operation', welcome: new Uint8Array([42]), recipients: ['alice'] },
          ],
          deleteAppliedFrom: 3,
          putApplied: [
            {
              epoch: 3,
              digest: 'replacement',
              payloadDigest: 'replacement-payload',
              sequenceID: '003',
              opID: null,
              removed: false,
            },
          ],
          deleteResponsesBelow: 4,
          putResponses: [
            { position: '000', epoch: 4, digest: 'replacement', kind: 'refused', reason: 'policy' },
          ],
          cursor: null,
        },
        'replacement',
      )
      const snapshot = await (await params.reopen()).control.load()
      expect(snapshot.operations.map((row) => row.id)).toEqual(['first', 'operation', 'last'])
      expect(snapshot.rejoin).toEqual({ ...rejoin, stage: 'adopted' })
      expect(snapshot.outcomes).toEqual([{ id: 'outcome', opID: null, at: 300, kind: 'unknown' }])
      expect(snapshot.welcomes).toEqual([
        { opID: 'operation', welcome: new Uint8Array([42]), recipients: ['alice'] },
      ])
      expect(snapshot.applied).toEqual([
        {
          epoch: 3,
          digest: 'replacement',
          payloadDigest: 'replacement-payload',
          sequenceID: '003',
          opID: null,
          removed: false,
        },
      ])
      expect(snapshot.responses).toEqual([
        { position: '000', epoch: 4, digest: 'replacement', kind: 'refused', reason: 'policy' },
      ])
      expect(snapshot.cursor).toBeNull()
      await host.control.apply({ deleteRejoin: true }, 'clear-rejoin')
      expect((await host.control.load()).rejoin).toBeNull()
    })

    test('secrets round-trip byte-exact and callers cannot mutate stored bytes', async () => {
      const host = await params.open()
      const changes = records()
      await host.control.apply(changes, 'secrets')
      changes.putRejoin?.requestKey.fill(9)
      changes.putRejoin?.candidate.fill(9)
      const read = await host.control.load()
      expect(read.rejoin?.requestKey).toEqual(new Uint8Array([0, 255, 128, 1]))
      expect(read.rejoin?.candidate).toEqual(new Uint8Array([255, 0, 127, 2]))
      read.rejoin?.requestKey.fill(8)
      read.rejoin?.candidate.fill(8)
      const reopened = await params.reopen()
      expect((await reopened.control.load()).rejoin?.requestKey).toEqual(
        new Uint8Array([0, 255, 128, 1]),
      )
      expect((await reopened.control.load()).rejoin?.candidate).toEqual(
        new Uint8Array([255, 0, 127, 2]),
      )
    })
  })
}
