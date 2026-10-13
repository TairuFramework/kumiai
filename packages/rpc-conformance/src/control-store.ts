import { describe, expect, test } from 'vitest'

import type { ConformanceAnchorStore } from './anchor-store.js'

export type ConformanceGroupKey = { groupID: string; incarnation: number }
export type ConformanceEpochIdentity = ConformanceGroupKey & {
  epoch: number
  authenticator: Uint8Array
}
export type ConformanceAdoptionExpected = {
  key: ConformanceGroupKey
  stateVersion: number
  identity: ConformanceEpochIdentity | null
}
export type ConformanceControlSource = ConformanceAdoptionExpected & {
  epoch: number
  authenticator: Uint8Array
}
export type ConformanceFirstValidCommit<Position extends string = string> = {
  source: ConformanceAdoptionExpected
  from: Position | null
  position: Position
  payloadDigest: string
}
export type ConformanceCommitSearchResult<Position extends string = string> =
  | { kind: 'first-valid'; proof: ConformanceFirstValidCommit<Position> }
  | { kind: 'superseded'; winner: Position }
  | { kind: 'absent' }
  | { kind: 'unknown' }
export type ConformanceControlSearchPort<Position extends string = string> = {
  searchLog(
    built: ConformanceBuiltCommit<Position>,
    position?: Position,
  ): Promise<ConformanceCommitSearchResult<Position>>
}
export type ConformanceControlSlot<Position extends string = string> =
  ConformanceBuiltCommit<Position> & { opID: string }
export type ConformanceSafetyHold = 'fork-halted' | 'recovery-unavailable' | null

export type ConformanceGroupForkEvidence =
  | {
      kind: 'digest-divergence'
      epoch: number
      position: string
      localDigest: string
      remoteDigest: string
    }
  | { kind: 'epoch-authenticator'; epoch: number; local: Uint8Array; remote: Uint8Array }
  | { kind: 'unexplained-own-commit'; epoch: number; position: string; digest: string }

export type ConformanceForkHalt = {
  eventID: string
  evidence: ConformanceGroupForkEvidence
  detectedAt: number
}

export type ConformanceGroupSafetyEvent = ConformanceGroupKey & {
  id: string
  kind: 'group:fork'
  halt: ConformanceForkHalt
}

export type ConformanceRecoveryUnavailableEvent = ConformanceGroupKey & {
  id: string
  kind: 'group:recovery-unavailable'
  reason: 'trust-unreadable'
}

export type ConformanceControlHold<Position extends string = string> = {
  reason: 'acceptance-unknown' | 'unsupported-version' | 'fork-evidence'
  position: Position | null
  evidence?: ConformanceGroupForkEvidence
}
export type ConformanceControlBuildRef<Position extends string = string> = Pick<
  ConformanceBuiltCommit<Position>,
  'incarnation' | 'epoch' | 'publishID' | 'payloadDigest'
>
export type ConformanceHostBuilt<Position extends string = string> = Pick<
  ConformanceBuiltCommit<Position>,
  'incarnation' | 'epoch' | 'authenticatorBefore' | 'digest' | 'bodies' | 'journal' | 'welcome'
> & { commit: Uint8Array }

export type ConformanceControlSnapshot<Position extends string = string> = {
  commitOnce: ConformanceControlSlot<Position> | null
  commitOnceAcceptance: ConformanceFirstValidCommit<Position> | null
  controlHold: ConformanceControlHold<Position> | null
  forkHalt: ConformanceForkHalt | null
  recoveryUnavailable: ConformanceRecoveryUnavailableEvent | null
  strand: {
    reason: 'retention-gap' | 'unprocessable-gap' | 'lost-state' | 'ahead' | 'unsupported-version'
  } | null
  operations: Array<ConformanceOperation<Position>> // FIFO by `seq`
  rejoin: ConformanceRejoinRecord<Position> | null
  outcomes: Array<ConformanceOutcome<Position>>
  welcomes: Array<ConformanceWelcomeObligation>
  applied: Array<ConformanceAppliedCommit> // newest 64 epochs
  responses: Array<ConformanceExternalResponse<Position>> // responder outcomes, newest 64 epochs
  cursor: ConformanceControlCommitCursor<Position> | null // {position, epoch, stranded?, fork?}
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
  commitOnce?: ConformanceControlSlot<Position> | null
  commitOnceAcceptance?: ConformanceFirstValidCommit<Position> | null
  controlHold?: ConformanceControlSnapshot<Position>['controlHold']
  forkHalt?: ConformanceForkHalt
  recoveryUnavailable?: ConformanceRecoveryUnavailableEvent
  strand?: ConformanceControlSnapshot<Position>['strand']
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
  deleteAppliedBelow?: number // drops rows at epoch < n, before puts
  putResponses?: Array<ConformanceExternalResponse<Position>>
  deleteResponsesBelow?: number // by `epoch`
  cursor?: ConformanceControlCommitCursor<Position> | null
}
/** Control changes committed with an adoption's state save (D5). */
export type ConformanceAdoptionWrite<Position extends string = string> = {
  expected?: ConformanceAdoptionExpected & {
    acceptance?: ConformanceFirstValidCommit<Position>
    journal?: Uint8Array
  }
  changes: ConformanceControlChanges<Position>
  mutationID: string
  /** The `advance` of the pending anchor rotation this adoption lands, marked in the same transaction. */
  anchorLanded?: string
}
export type ConformanceControlStore<Position extends string = string> = {
  key: ConformanceGroupKey
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
  deadline: number
  pendingPublish?: { expectedHead: Position | null }
} & (
    | { stage: 'intent' }
    | { stage: 'built'; built: ConformanceControlBuildRef<Position> }
    | {
        stage: 'accepted'
        built: ConformanceControlBuildRef<Position>
        acceptedAs: Position
        acceptance: ConformanceFirstValidCommit<Position>
      }
  )
export type ConformanceBuiltCommit<Position extends string = string> = {
  incarnation: number
  searchFrom: Position | null
  publishID: string
  expectedHead: Position | null
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
  source: {
    key: ConformanceGroupKey
    epoch: number
    authenticator: Uint8Array
    head: Position | null
  }
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
  committed?: true
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
export type ConformanceControlCommitCursor<Position extends string = string> = {
  position: Position | null
  epoch: number
  stranded?: true
  fork?: ConformanceForkEvidence<Position>
}

export type ConformanceSaveControlBuild<Position extends string = string> = (
  intent: ConformanceOperation<Position> & { stage: 'intent' },
  built: ConformanceControlSlot<Position>,
  expected: ConformanceAdoptionExpected,
  mutationID: string,
) => Promise<'saved' | 'moved' | 'occupied'>

export type ConformanceControlAdoptionPort<Position extends string = string> = {
  adopt(
    journal: Uint8Array,
    expected: ConformanceAdoptionExpected & { acceptance: ConformanceFirstValidCommit<Position> },
    write: ConformanceAdoptionWrite<Position>,
  ): Promise<'installed' | 'noop' | 'moved'>
}

export function encodeControlFixtureState(identity: ConformanceEpochIdentity): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ ...identity, authenticator: Array.from(identity.authenticator) }),
  )
}
export function decodeControlFixtureState(bytes: Uint8Array): ConformanceEpochIdentity | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as ConformanceEpochIdentity & {
      authenticator: Array<number>
    }
    if (
      typeof value.groupID !== 'string' ||
      !Number.isSafeInteger(value.incarnation) ||
      !Number.isSafeInteger(value.epoch) ||
      !Array.isArray(value.authenticator)
    )
      return null
    return { ...value, authenticator: Uint8Array.from(value.authenticator) }
  } catch {
    return null
  }
}

export type ConformanceControlHost = {
  control: ConformanceControlStore
  saveBuilt: ConformanceSaveControlBuild
  loadVersion(): Promise<number>
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

function fixtureBuilt(): ConformanceBuiltCommit {
  return {
    publishID: 'publish',
    expectedHead: null,
    epoch: 4,
    authenticatorBefore: new Uint8Array([2]),
    incarnation: 1,
    searchFrom: null,
    payload: new Uint8Array([3]),
    payloadDigest: 'payload-digest',
    digest: 'commit-digest',
    bodies: ['token'],
    journal: new Uint8Array([4]),
    welcome: { bytes: new Uint8Array([5]), recipients: ['bob'] },
  }
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
        deadline: 30_100,
        stage: 'accepted',
        acceptedAs: '001',
        acceptance: {
          source: {
            key: { groupID: 'group-A', incarnation: 1 },
            stateVersion: 1,
            identity: {
              groupID: 'group-A',
              incarnation: 1,
              epoch: 4,
              authenticator: new Uint8Array([2]),
            },
          },
          from: null,
          position: '001',
          payloadDigest: 'payload-digest',
        },
        built: { incarnation: 1, epoch: 4, publishID: 'publish', payloadDigest: 'payload-digest' },
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
      source: {
        epoch: 4,
        authenticator: new Uint8Array([8]),
        key: { groupID: 'group-A', incarnation: 1 },
        head: null,
      },
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

async function prepareSlot(host: ConformanceControlHost) {
  const original = records().putOperations?.[0]
  if (original == null || original.stage !== 'accepted') throw new Error('Missing build fixture')
  const intent: ConformanceOperation & { stage: 'intent' } = { ...original, stage: 'intent' }
  const slot: ConformanceControlSlot = { ...fixtureBuilt(), opID: original.id }
  const identity = {
    ...host.control.key,
    epoch: slot.epoch,
    authenticator: slot.authenticatorBefore.slice(),
  }
  await host.saveState(encodeControlFixtureState(identity))
  await host.control.apply(
    { putOperations: [intent], cursor: { position: slot.searchFrom, epoch: slot.epoch } },
    'intent',
  )
  const source = { key: host.control.key, identity, stateVersion: await host.loadVersion() }
  expect(await host.saveBuilt(intent, slot, source, 'saved')).toBe('saved')
  return { intent, slot, source }
}

export function testControlStoreConformance(params: ControlStoreConformanceParams): void {
  describe('ControlStore conformance', () => {
    const safety = (key: ConformanceGroupKey) => ({
      forkHalt: {
        eventID: JSON.stringify(['group:fork', key.groupID, key.incarnation]),
        evidence: {
          kind: 'epoch-authenticator' as const,
          epoch: 4,
          local: new Uint8Array([1, 2]),
          remote: new Uint8Array([3, 4]),
        },
        detectedAt: 100,
      },
      recoveryUnavailable: {
        ...key,
        id: JSON.stringify(['group:recovery-unavailable', key.groupID, key.incarnation]),
        kind: 'group:recovery-unavailable' as const,
        reason: 'trust-unreadable' as const,
      },
    })

    test('safety fields start null and persist without a strand or ControlHold', async () => {
      const host = await params.open()
      const initial = await host.control.load()
      expect(initial.forkHalt).toBeNull()
      expect(initial.recoveryUnavailable).toBeNull()
      const changes = safety(host.control.key)
      await host.control.apply(changes, 'safety')
      const read = await (await params.reopen()).control.load()
      expect(read.forkHalt).toEqual(changes.forkHalt)
      expect(read.recoveryUnavailable).toEqual(changes.recoveryUnavailable)
      expect(read.strand).toBeNull()
      expect(read.controlHold).toBeNull()
      await host.control.apply(safety(host.control.key), 'same-safety')
      expect(await host.control.load()).toEqual(read)
      expect(await host.control.lastMutation()).toBe('same-safety')
    })

    test.each(['forkHalt', 'recoveryUnavailable'] as const)(
      'safety writes are immutable and atomic when %s conflicts',
      async (field) => {
        const host = await params.open()
        const values = safety(host.control.key)
        await host.control.apply({ [field]: values[field] }, 'safety')
        const before = await host.control.load()
        const marker = await host.control.lastMutation()
        const replacements =
          field === 'forkHalt'
            ? [
                { ...values.forkHalt, detectedAt: 101 },
                { ...values.forkHalt, evidence: { ...values.forkHalt.evidence, epoch: 5 } },
                {
                  ...values.forkHalt,
                  evidence: { ...values.forkHalt.evidence, remote: new Uint8Array([8, 9]) },
                },
              ]
            : [{ ...values.recoveryUnavailable, detail: 'replacement' }]
        for (const replacement of [null, ...replacements]) {
          const changes = {
            ...safety(host.control.key),
            [field]: replacement,
            putOperations: records().putOperations,
          } as unknown as ConformanceControlChanges
          await expect(host.control.apply(changes, 'conflict')).rejects.toMatchObject({
            name: 'ControlSafetyImmutableError',
            field,
          })
          const reopened = await params.reopen()
          expect(await reopened.control.load()).toEqual(before)
          expect(await reopened.control.lastMutation()).toBe(marker)
        }
      },
    )

    test.each(['forkHalt', 'recoveryUnavailable'] as const)(
      'an untyped null %s cannot clear an unset field',
      async (field) => {
        const host = await params.open()
        const before = await host.control.load()
        const changes = { [field]: null } as unknown as ConformanceControlChanges
        await expect(host.control.apply(changes, 'clear')).rejects.toMatchObject({
          name: 'ControlSafetyImmutableError',
          field,
        })
        expect(await host.control.load()).toEqual(before)
        expect(await host.control.lastMutation()).toBeNull()
      },
    )

    test.each([
      'fork-ID',
      'recovery-ID',
      'recovery-kind',
      'recovery-groupID',
      'recovery-incarnation',
      'recovery-reason',
      'partial-fork',
      'partial-evidence',
      'partial-recovery',
    ])('safety identity and complete values reject %s before any mutation', async (invalid) => {
      const host = await params.open()
      const values = safety(host.control.key)
      const cases: Record<string, unknown> = {
        'fork-ID': { forkHalt: { ...values.forkHalt, eventID: 'wrong' } },
        'recovery-ID': { recoveryUnavailable: { ...values.recoveryUnavailable, id: 'wrong' } },
        'recovery-kind': {
          recoveryUnavailable: { ...values.recoveryUnavailable, kind: 'accepted' },
        },
        'recovery-groupID': {
          recoveryUnavailable: { ...values.recoveryUnavailable, groupID: 'foreign' },
        },
        'recovery-incarnation': {
          recoveryUnavailable: {
            ...values.recoveryUnavailable,
            incarnation: host.control.key.incarnation + 1,
          },
        },
        'recovery-reason': {
          recoveryUnavailable: { ...values.recoveryUnavailable, reason: 'other' },
        },
        'partial-fork': { forkHalt: { eventID: values.forkHalt.eventID } },
        'partial-evidence': {
          forkHalt: { ...values.forkHalt, evidence: { kind: 'epoch-authenticator', epoch: 4 } },
        },
        'partial-recovery': { recoveryUnavailable: { id: values.recoveryUnavailable.id } },
      }
      const changes = {
        ...values,
        ...(cases[invalid] as object),
        putOperations: records().putOperations,
      } as ConformanceControlChanges
      const before = await host.control.load()
      await expect(host.control.apply(changes, 'invalid')).rejects.toMatchObject({
        name: 'TypeError',
      })
      expect(await host.control.load()).toEqual(before)
      expect(await host.control.lastMutation()).toBeNull()
      await host.control.apply(safety(host.control.key), 'valid')
      const held = await host.control.load()
      await expect(host.control.apply(changes, 'invalid-reapply')).rejects.toMatchObject({
        name: 'TypeError',
      })
      expect(await host.control.load()).toEqual(held)
      expect(await host.control.lastMutation()).toBe('valid')
    })

    test('safety values are defensive across inputs, reads and reopen', async () => {
      const host = await params.open()
      const input = safety(host.control.key)
      const expected = safety(host.control.key)
      await host.control.apply(input, 'safety')
      input.forkHalt.evidence.local.fill(9)
      input.forkHalt.evidence.remote.fill(9)
      input.forkHalt.detectedAt = 200
      input.recoveryUnavailable.groupID = 'changed'
      const read = await host.control.load()
      expect(read.forkHalt).toEqual(expected.forkHalt)
      expect(read.recoveryUnavailable).toEqual(expected.recoveryUnavailable)
      if (read.forkHalt?.evidence.kind !== 'epoch-authenticator')
        throw new Error('Missing evidence')
      read.forkHalt.evidence.local.fill(8)
      read.forkHalt.evidence.remote.fill(8)
      if (read.recoveryUnavailable === null) throw new Error('Missing recovery event')
      read.recoveryUnavailable.groupID = 'changed'
      const reread = await (await params.reopen()).control.load()
      expect(reread.forkHalt).toEqual(expected.forkHalt)
      expect(reread.recoveryUnavailable).toEqual(expected.recoveryUnavailable)
    })

    test('slot changes require provider-verified context: arbitrary apply cannot create a slot', async () => {
      const host = await params.open()
      const op = records().putOperations?.[0]
      if (op == null || op.stage !== 'accepted') throw new Error('missing build')
      const before = await host.control.load()
      const marker = await host.control.lastMutation()
      await expect(
        host.control.apply({ commitOnce: { ...fixtureBuilt(), opID: op.id } }, 'unverified'),
      ).rejects.toThrow()
      expect(await host.control.load()).toEqual(before)
      expect(await host.control.lastMutation()).toBe(marker)
    })
    test.each([
      'owner',
      'epoch',
      'authenticator',
      'incarnation',
      'payload',
      'payloadDigest',
      'digest',
      'publishID',
      'searchFrom',
      'bodies',
      'journal',
      'welcome',
      'null',
    ] as const)(
      'slot changes require provider-verified context: %s is immutable',
      async (field) => {
        const host = await params.open()
        const { slot } = await prepareSlot(host)
        const next = { ...slot }
        switch (field) {
          case 'owner':
            next.opID = 'other'
            break
          case 'epoch':
            next.epoch++
            break
          case 'authenticator':
            next.authenticatorBefore = new Uint8Array([99])
            break
          case 'incarnation':
            next.incarnation++
            break
          case 'payload':
            next.payload = new Uint8Array([99])
            break
          case 'payloadDigest':
            next.payloadDigest = 'other'
            break
          case 'digest':
            next.digest = 'other'
            break
          case 'publishID':
            next.publishID = 'other'
            break
          case 'searchFrom':
            next.searchFrom = 'other'
            break
          case 'bodies':
            next.bodies = ['other']
            break
          case 'journal':
            next.journal = new Uint8Array([99])
            break
          case 'welcome':
            next.welcome = { bytes: new Uint8Array([99]), recipients: ['other'] }
            break
        }
        const before = await host.control.load()
        const marker = await host.control.lastMutation()
        await expect(
          host.control.apply(
            { commitOnce: field === 'null' ? null : next, deleteOperations: [slot.opID] },
            'unverified',
          ),
        ).rejects.toThrow()
        expect(await (await params.reopen()).control.load()).toEqual(before)
        expect(await host.control.lastMutation()).toBe(marker)
      },
    )
    test('slot changes require provider-verified context: head refresh and unchanged slot preserve bytes', async () => {
      const host = await params.open()
      const { slot } = await prepareSlot(host)
      await host.control.apply({ commitOnce: { ...slot, expectedHead: 'new-head' } }, 'head')
      const refreshed = (await host.control.load()).commitOnce
      expect(refreshed).toEqual({ ...slot, expectedHead: 'new-head' })
      await host.control.apply({ commitOnce: refreshed }, 'unchanged')
      expect((await host.control.load()).commitOnce).toEqual(refreshed)
    })
    test('slot changes require provider-verified context: same-epoch save and lower source cannot replace current slot', async () => {
      const host = await params.open()
      const { slot, source } = await prepareSlot(host)
      const intent: ConformanceOperation & { stage: 'intent' } = {
        id: 'next',
        kind: 'rotation',
        revokes: false,
        body: new Uint8Array(),
        seq: 2,
        enqueuedAt: 10,
        deadline: 30_010,
        stage: 'intent',
      }
      await host.control.apply({ deleteOperations: [slot.opID], putOperations: [intent] }, 'queue')
      const before = await host.control.load()
      const marker = await host.control.lastMutation()
      expect(
        await host.saveBuilt(
          intent,
          { ...slot, opID: intent.id },
          { ...source, stateVersion: await host.loadVersion() },
          'same',
        ),
      ).toBe('occupied')
      expect(
        await host.saveBuilt(
          intent,
          { ...slot, opID: intent.id, epoch: slot.epoch - 1 },
          { ...source, identity: { ...source.identity, epoch: slot.epoch - 1 } },
          'lower',
        ),
      ).toBe('moved')
      expect(await host.control.load()).toEqual(before)
      expect(await host.control.lastMutation()).toBe(marker)
    })
    test('slot changes require provider-verified context: later epoch build replaces retained slot', async () => {
      const host = await params.open()
      const { slot, source } = await prepareSlot(host)
      await host.control.apply(
        {
          commitOnceAcceptance: {
            source,
            from: slot.searchFrom,
            position: 'accepted',
            payloadDigest: slot.payloadDigest,
          },
        },
        'accepted',
      )
      const identity = {
        ...source.identity,
        epoch: slot.epoch + 1,
        authenticator: new Uint8Array([43]),
      }
      await host.saveState(encodeControlFixtureState(identity))
      const intent: ConformanceOperation & { stage: 'intent' } = {
        id: 'next',
        kind: 'rotation',
        revokes: false,
        body: new Uint8Array(),
        seq: 2,
        enqueuedAt: 10,
        deadline: 30_010,
        stage: 'intent',
      }
      await host.control.apply(
        {
          deleteOperations: [slot.opID],
          putOperations: [intent],
          cursor: { position: 'new', epoch: identity.epoch },
        },
        'queue',
      )
      const next = {
        ...slot,
        opID: intent.id,
        epoch: identity.epoch,
        authenticatorBefore: identity.authenticator,
        searchFrom: 'new',
        expectedHead: 'new',
      }
      expect(
        await host.saveBuilt(
          intent,
          next,
          { ...source, identity, stateVersion: await host.loadVersion() },
          'new-build',
        ),
      ).toBe('saved')
      expect((await host.control.load()).commitOnce).toEqual(next)
      expect((await host.control.load()).commitOnceAcceptance).toBeNull()
    })
    test.each(['digest', 'key', 'checkpoint'] as const)(
      'slot changes require provider-verified context: acceptance must bind the occupied slot: %s',
      async (field) => {
        const host = await params.open()
        const { slot, source } = await prepareSlot(host)
        const before = await host.control.load()
        const marker = await host.control.lastMutation()
        const proof = {
          source,
          from: slot.searchFrom,
          position: 'accepted',
          payloadDigest: slot.payloadDigest,
        }
        if (field === 'digest') proof.payloadDigest = 'wrong'
        if (field === 'checkpoint') proof.from = 'wrong'
        if (field === 'key')
          proof.source = {
            ...source,
            key: { ...source.key, groupID: 'wrong' },
            identity: { ...source.identity, groupID: 'wrong' },
          }
        await expect(host.control.apply({ commitOnceAcceptance: proof }, 'proof')).rejects.toThrow()
        expect(await host.control.load()).toEqual(before)
        expect(await host.control.lastMutation()).toBe(marker)
      },
    )
    test('slot changes require provider-verified context: advancing adoption clears acceptance and retirement releases the slot', async () => {
      const host = await params.open()
      const { slot, source } = await prepareSlot(host)
      await host.control.apply(
        {
          commitOnceAcceptance: {
            source,
            from: slot.searchFrom,
            position: 'accepted',
            payloadDigest: slot.payloadDigest,
          },
        },
        'accepted',
      )
      const before = await host.control.load()
      const marker = await host.control.lastMutation()
      await expect(
        host.saveState(encodeControlFixtureState(source.identity), {
          changes: { commitOnce: null, commitOnceAcceptance: null },
          mutationID: 'same-epoch',
        }),
      ).rejects.toThrow()
      expect(await host.control.load()).toEqual(before)
      expect(await host.control.lastMutation()).toBe(marker)
      await host.saveState(
        encodeControlFixtureState({
          ...source.identity,
          incarnation: 2,
          epoch: 0,
          authenticator: new Uint8Array([45]),
        }),
        {
          expected: source,
          changes: { commitOnce: null, commitOnceAcceptance: null },
          mutationID: 'retired',
        },
      )
      expect((await host.control.load()).commitOnce).toBeNull()
      expect((await host.control.load()).commitOnceAcceptance).toBeNull()
    })
    test('retirement releases an older slot while adoption requires the exact source', async () => {
      const host = await params.open()
      const { slot, source } = await prepareSlot(host)
      await host.control.apply(
        {
          commitOnceAcceptance: {
            source,
            from: slot.searchFrom,
            position: 'accepted',
            payloadDigest: slot.payloadDigest,
          },
        },
        'accepted',
      )
      const advanced = {
        ...source.identity,
        epoch: slot.epoch + 1,
        authenticator: new Uint8Array([47]),
      }
      await host.saveState(encodeControlFixtureState(advanced))
      const before = await host.control.load()
      const marker = await host.control.lastMutation()
      await expect(
        host.saveState(encodeControlFixtureState({ ...advanced, epoch: advanced.epoch + 1 }), {
          changes: { commitOnce: null },
          mutationID: 'wrong-source',
        }),
      ).rejects.toThrow()
      expect(await host.control.load()).toEqual(before)
      expect(await host.loadState()).toEqual(encodeControlFixtureState(advanced))
      expect(await host.control.lastMutation()).toBe(marker)
      await host.saveState(
        encodeControlFixtureState({
          ...advanced,
          incarnation: advanced.incarnation + 1,
          epoch: 0,
          authenticator: new Uint8Array([48]),
        }),
        { changes: { commitOnce: null }, mutationID: 'retire-older-slot' },
      )
      const reopened = await params.reopen()
      const cleared = await reopened.control.load()
      expect(cleared.commitOnce).toBeNull()
      expect(cleared.commitOnceAcceptance).toBeNull()
      expect(await reopened.control.lastMutation()).toBe('retire-older-slot')
    })
    test.each(['omitted', 'unchanged'] as const)(
      'authorised slot clear validates resulting acceptance: %s',
      async (mode) => {
        const host = await params.open()
        const { slot, source } = await prepareSlot(host)
        const acceptance = {
          source,
          from: slot.searchFrom,
          position: 'accepted',
          payloadDigest: slot.payloadDigest,
        }
        await host.control.apply({ commitOnceAcceptance: acceptance }, 'acceptance')
        const before = await host.control.load()
        const state = await host.loadState()
        const marker = await host.control.lastMutation()
        const advancing = encodeControlFixtureState({
          ...source.identity,
          epoch: slot.epoch + 1,
          authenticator: new Uint8Array([44]),
        })
        const write: ConformanceAdoptionWrite = {
          changes:
            mode === 'omitted'
              ? { commitOnce: null }
              : { commitOnce: null, commitOnceAcceptance: acceptance },
          mutationID: 'clear',
        }
        if (mode === 'unchanged') {
          await expect(host.saveState(advancing, write)).rejects.toThrow()
          expect(await (await params.reopen()).control.load()).toEqual(before)
          expect(await host.loadState()).toEqual(state)
          expect(await host.control.lastMutation()).toBe(marker)
        } else {
          await host.saveState(advancing, write)
          const cleared = await (await params.reopen()).control.load()
          expect(cleared.commitOnce).toBeNull()
          expect(cleared.commitOnceAcceptance).toBeNull()
        }
      },
    )
    test.each([false, true])(
      'absent build cursor requires retained initial identity: later=%s',
      async (later) => {
        const host = await params.open()
        const { intent, slot, source } = await prepareSlot(host)
        const identity = {
          ...source.identity,
          epoch: slot.epoch + (later ? 1 : 0),
          authenticator: later ? new Uint8Array([46]) : slot.authenticatorBefore,
        }
        if (later) {
          await host.saveState(encodeControlFixtureState(identity), {
            changes: { commitOnce: null },
            mutationID: 'advance',
          })
          await host.control.apply({ putOperations: [intent], cursor: null }, 'intent-null')
          const built = {
            ...slot,
            epoch: identity.epoch,
            authenticatorBefore: identity.authenticator,
          }
          const before = await host.control.load()
          const marker = await host.control.lastMutation()
          expect(
            await host.saveBuilt(
              intent,
              built,
              { ...source, identity, stateVersion: await host.loadVersion() },
              'null-build',
            ),
          ).toBe('moved')
          expect(await (await params.reopen()).control.load()).toEqual(before)
          expect(await host.control.lastMutation()).toBe(marker)
        } else {
          // A fresh host has no slot and no cursor, but has an independently retained installation.
          const fresh = await params.open()
          await fresh.saveState(encodeControlFixtureState(identity))
          await fresh.control.apply({ putOperations: [intent] }, 'initial-intent')
          expect(
            await fresh.saveBuilt(
              intent,
              slot,
              {
                key: fresh.control.key,
                identity: { ...identity, ...fresh.control.key },
                stateVersion: await fresh.loadVersion(),
              },
              'initial-null',
            ),
          ).toBe('saved')
          expect((await fresh.control.load()).cursor).toBeNull()
        }
      },
    )
    test('retained slot and acceptance round-trip defensively and survive rollback', async () => {
      const host = await params.open()
      const original = records().putOperations?.[0]
      if (original == null || original.stage !== 'accepted') throw new Error('missing build')
      const slot: ConformanceControlSlot = { ...fixtureBuilt(), opID: original.id }
      const acceptance: ConformanceFirstValidCommit = {
        source: {
          key: host.control.key,
          stateVersion: 1,
          identity: {
            ...host.control.key,
            epoch: slot.epoch,
            authenticator: slot.authenticatorBefore.slice(),
          },
        },
        from: slot.searchFrom,
        position: '001',
        payloadDigest: slot.payloadDigest,
      }
      const expectedSlot: ConformanceControlSlot = {
        ...slot,
        authenticatorBefore: slot.authenticatorBefore.slice(),
        payload: slot.payload.slice(),
        bodies: [...slot.bodies],
        journal: slot.journal.slice(),
        welcome:
          slot.welcome == null
            ? null
            : { bytes: slot.welcome.bytes.slice(), recipients: [...slot.welcome.recipients] },
      }
      const expectedAcceptance: ConformanceFirstValidCommit = {
        ...acceptance,
        source: {
          ...acceptance.source,
          key: { ...acceptance.source.key },
          identity:
            acceptance.source.identity == null
              ? null
              : {
                  ...acceptance.source.identity,
                  authenticator: acceptance.source.identity.authenticator.slice(),
                },
        },
      }
      if (acceptance.source.identity === null || expectedAcceptance.source.identity === null)
        throw new Error('Missing acceptance identity')
      const expectedIdentity = expectedAcceptance.source.identity
      await host.saveState(encodeControlFixtureState(acceptance.source.identity))
      await host.control.apply(
        {
          putOperations: [{ ...original, stage: 'intent' }],
          cursor: { position: slot.searchFrom, epoch: slot.epoch },
        },
        'intent',
      )
      acceptance.source.stateVersion = await host.loadVersion()
      expectedAcceptance.source.stateVersion = acceptance.source.stateVersion
      expect(
        await host.saveBuilt({ ...original, stage: 'intent' }, slot, acceptance.source, 'slot'),
      ).toBe('saved')
      await host.control.apply({ commitOnceAcceptance: acceptance }, 'acceptance')
      slot.journal.fill(0)
      acceptance.source.identity?.authenticator.fill(0)
      await host.control.apply(
        { deleteOperations: [slot.opID], deleteOutcomes: ['outcome'] },
        'ack',
      )
      const reopened = await params.reopen()
      const loaded = await reopened.control.load()
      expect(loaded.commitOnce).toEqual(expectedSlot)
      expect(loaded.commitOnceAcceptance).toEqual(expectedAcceptance)
      loaded.commitOnce?.welcome?.bytes.fill(0)
      if (loaded.commitOnceAcceptance != null) loaded.commitOnceAcceptance.source.key.incarnation++
      expect((await reopened.control.load()).commitOnce).toEqual(expectedSlot)
      expect((await reopened.control.load()).commitOnceAcceptance).toEqual(expectedAcceptance)
      params.injectFailure('mid-save')
      const write: ConformanceAdoptionWrite = {
        expected: expectedAcceptance.source,
        changes: {
          commitOnce: null,
          commitOnceAcceptance: null,
          cursor: { position: '001', epoch: slot.epoch + 1 },
        },
        mutationID: 'advance',
      }
      await expect(
        reopened.saveState(
          encodeControlFixtureState({
            ...expectedIdentity,
            epoch: slot.epoch + 1,
            authenticator: new Uint8Array([42]),
          }),
          write,
        ),
      ).rejects.toThrow()
      expect((await (await params.reopen()).control.load()).commitOnce).toEqual(expectedSlot)
      await reopened.saveState(
        encodeControlFixtureState({
          ...expectedIdentity,
          epoch: slot.epoch + 1,
          authenticator: new Uint8Array([42]),
        }),
        write,
      )
      const cleared = await (await params.reopen()).control.load()
      expect(cleared.commitOnce).toBeNull()
      expect(cleared.commitOnceAcceptance).toBeNull()
    })
    test('an initial strand persists without inventing a processed log position', async () => {
      const host = await params.open()
      const cursor: ConformanceControlCommitCursor = {
        position: null,
        epoch: 4,
        stranded: true,
        fork: { conflictEpoch: 3, sharedPosition: null, frameDigest: 'competing-frame' },
      }
      await host.control.apply({ cursor }, 'initial-strand')
      const reopened = await params.reopen()
      expect((await reopened.control.load()).cursor).toEqual(cursor)
      expect(await reopened.control.lastMutation()).toBe('initial-strand')
    })
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
        commitOnce: null,
        commitOnceAcceptance: null,
        controlHold: null,
        forkHalt: null,
        recoveryUnavailable: null,
        strand: null,
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

    test.each([null, '005'])(
      'pending publication at head %s survives reopen and replacement',
      async (expectedHead) => {
        const host = await params.open()
        const original = records().putOperations?.[0]
        if (original === undefined) throw new Error('Missing conformance operation')
        const operation = { ...original, pendingPublish: { expectedHead } }
        await host.control.apply({ putOperations: [operation] }, 'handoff')
        const reopened = await params.reopen()
        expect((await reopened.control.load()).operations).toEqual([operation])
        await reopened.control.apply({ putOperations: [original] }, 'refused')
        expect((await (await params.reopen()).control.load()).operations).toEqual([original])
      },
    )

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

    test('epoch range deletions precede puts in apply and adoption saves', async () => {
      const host = await params.open()
      const applied = (epoch: number): ConformanceAppliedCommit => ({
        epoch,
        digest: `commit-${epoch}`,
        payloadDigest: `payload-${epoch}`,
        sequenceID: String(epoch),
        opID: null,
        removed: false,
      })
      await host.control.apply(
        {
          putApplied: [applied(0), applied(1), applied(2), applied(3), applied(4)],
          putResponses: [
            { position: 'old', epoch: 0, digest: 'old', kind: 'refused' },
            { position: 'boundary', epoch: 2, digest: 'boundary', kind: 'refused' },
            { position: 'new', epoch: 3, digest: 'new', kind: 'refused' },
          ],
        },
        'baseline',
      )
      await host.control.apply(
        {
          deleteAppliedBelow: 2,
          deleteAppliedFrom: 4,
          putApplied: [
            { ...applied(0), digest: 'reinserted' },
            { ...applied(3), digest: 'replacement' },
            applied(4),
            { ...applied(4), digest: 'last-put' },
          ],
          deleteResponsesBelow: 2,
          putResponses: [{ position: 'old', epoch: 0, digest: 'reinserted', kind: 'applied' }],
        },
        'prune-and-put',
      )
      const reopened = await params.reopen()
      const snapshot = await reopened.control.load()
      expect(snapshot.applied).toEqual([
        { ...applied(0), digest: 'reinserted' },
        applied(2),
        { ...applied(3), digest: 'replacement' },
        { ...applied(4), digest: 'last-put' },
      ])
      expect(snapshot.responses).toEqual([
        { position: 'boundary', epoch: 2, digest: 'boundary', kind: 'refused' },
        { position: 'new', epoch: 3, digest: 'new', kind: 'refused' },
        { position: 'old', epoch: 0, digest: 'reinserted', kind: 'applied' },
      ])
      await reopened.saveState(new Uint8Array([2]), {
        changes: { deleteAppliedBelow: 3, deleteResponsesBelow: 3, putApplied: [applied(1)] },
        mutationID: 'adoption-prune',
      })
      const committed = await params.reopen()
      expect((await committed.control.load()).applied).toEqual([
        applied(1),
        { ...applied(3), digest: 'replacement' },
        { ...applied(4), digest: 'last-put' },
      ])
      expect((await committed.control.load()).responses).toEqual([
        { position: 'new', epoch: 3, digest: 'new', kind: 'refused' },
      ])
      expect(await committed.loadState()).toEqual(new Uint8Array([2]))
      expect(await committed.control.lastMutation()).toBe('adoption-prune')
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
