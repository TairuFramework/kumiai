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
export type ConformanceOwnOccurrence<Position extends string = string> = {
  source: ConformanceAdoptionExpected
  position: Position
  payloadDigest: string
  coverage: 'complete' | 'incomplete'
}
export type ConformanceControlSlot<Position extends string = string> =
  ConformanceBuiltCommit<Position> & { opID: string }
export type ConformanceGroupCondition = 'not-member' | 'spent-set-corrupt'
export type ConformanceNotMemberEvidence = {
  responderKeyHash: string
  epoch: number
  authHash: string
  observedAt: number
  responderDIDs: Array<string>
  responderCount: number
}
export type ConformanceGroupConditionEvent = ConformanceGroupKey & {
  id: string
  kind: ConformanceGroupCondition
  detectedAt: number
  evidence: ConformanceNotMemberEvidence | null
}
export type ConformanceSafetyHold =
  | 'fork-halted'
  | 'spent-set-corrupt'
  | 'recovery-unavailable'
  | null

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
  producer?: 'app-report' | 'internal'
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
  reason: 'unsupported-version'
  position: Position | null
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
  schemaVersion: 1
  commitOnce: ConformanceControlSlot<Position> | null
  spentSource: { epoch: number; opID?: string } | null
  controlHold: ConformanceControlHold<Position> | null
  forkHalt: ConformanceForkHalt | null
  recoveryUnavailable: ConformanceRecoveryUnavailableEvent | null
  strand: {
    reason: 'retention-gap' | 'unprocessable-gap' | 'lost-state' | 'ahead' | 'unsupported-version'
  } | null
  operations: Array<ConformanceOperation<Position>> // Unbuilt intents, ordered by sequence.
  forkRecoveryAttempt?: ConformanceForkRecoveryAttempt | null
  rejoin: ConformanceStoredRejoinRecord<Position> | null
  recoveryEpochFloor: number | null
  settledRejoins: Array<ConformanceAcceptedRejoinSettlement<Position>>
  outcomes: Array<ConformanceOutcome<Position>>
  welcomes: Array<ConformanceWelcomeObligation>
  applied: Array<ConformanceAppliedCommit> // newest 64 epochs
  responses: Array<ConformanceExternalResponse<Position>> // applied only, newest 64 epochs; legacy negatives are advisory
  cursor: ConformanceControlCommitCursor<Position> | null // {position, epoch, stranded?}
}
export type ConformanceControlChanges<Position extends string = string> = {
  commitOnce?: ConformanceControlSlot<Position> | null
  spentSource?: { epoch: number; opID?: string } | null
  controlHold?: ConformanceControlSnapshot<Position>['controlHold']
  clearAppHold?: { eventID: string; reportMutationID: string }
  forkHalt?: ConformanceForkHalt
  recoveryUnavailable?: ConformanceRecoveryUnavailableEvent
  strand?: ConformanceControlSnapshot<Position>['strand']
  putOperations?: Array<ConformanceOperation<Position>>
  deleteOperations?: Array<string>
  putRejoin?: ConformanceStoredRejoinRecord<Position>
  deleteRejoin?: true
  recoveryEpochFloor?: number | null
  putSettledRejoins?: Array<ConformanceAcceptedRejoinSettlement<Position>>
  putOutcomes?: Array<ConformanceOutcome<Position>>
  deleteOutcomes?: Array<string>
  putWelcomes?: Array<ConformanceWelcomeObligation>
  deleteWelcomes?: Array<string>
  putApplied?: Array<ConformanceAppliedCommit>
  deleteAppliedBelow?: number // drops rows at epoch < n, before puts
  /** Upsert applied responses by position; negative puts are ignored and legacy negatives dropped. */
  putResponses?: Array<ConformanceExternalResponse<Position>>
  deleteResponsesBelow?: number // by `epoch`
  cursor?: ConformanceControlCommitCursor<Position> | null
}
/** Control changes committed with an adoption's state save (D5). */
export type ConformanceAdoptionWrite<Position extends string = string> = {
  expected?: ConformanceAdoptionExpected & {
    occurrence?: ConformanceOwnOccurrence<Position>
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
export type ConformanceOperation<_Position extends string = string> =
  ConformanceOperationRequest & {
    seq: number
    enqueuedAt: number
    deadline: number
    stage: 'intent'
  }
export type ConformanceBuiltCommit<Position extends string = string> = {
  opID: string
  kind: ConformanceOperationRequest['kind']
  revokes: boolean
  enqueuedAt: number
  deadline: number
  acceptedAs?: Position
  skipped?: true
  reported?: true
  incarnation: number
  head: Position | null
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
  | {
      kind: 'unknown'
      lostCommit?:
        | { kind: 'ledger'; tokens: Array<string>; journal: Uint8Array }
        | { kind: 'invite' | 'remove'; journal: Uint8Array }
    }
  | { kind: 'reenact'; tokens: Array<string> } // ledger tokens missing after a rejoin
  | { kind: 'rejected'; reason: string } // build refused, e.g. not authorised
  | { kind: 'refused'; reason: ConformanceRecoveryRefusal } // a rejoin refused by policy (D6)
)

export type ConformanceLegacyRejoinRecord<Position extends string = string> = {
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
  /** Reserved conflict epoch; new recovery attempts leave it null. */
  conflictEpoch: number | null
  position?: Position
  verdict?: Uint8Array
  /** Set with stage `refused`. */
  refusal?: ConformanceRecoveryRefusal
}
export type ConformanceRejoinRecord<Position extends string = string> =
  ConformanceCapturedRejoinRecord<Position>
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
  refusalAuthority?: 'authenticated-commit'
  epochAfter?: number
}
export type ConformanceControlCommitCursor<Position extends string = string> = {
  position: Position | null
  epoch: number
  stranded?: true
  incomplete?: true
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
    expected: ConformanceAdoptionExpected & { occurrence: ConformanceOwnOccurrence<Position> },
    write: ConformanceAdoptionWrite<Position>,
  ): Promise<'installed' | 'noop' | 'moved'>
}

export function encodeControlFixtureState(
  identity: ConformanceEpochIdentity & { terminal?: boolean; deleted?: boolean },
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ ...identity, authenticator: Array.from(identity.authenticator) }),
  )
}
export function decodeControlFixtureState(
  bytes: Uint8Array,
): (ConformanceEpochIdentity & { terminal?: boolean; deleted?: boolean }) | null {
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

export function testControlSafetyInputConformance(params: {
  open(): Promise<ConformanceControlStore>
  reopen(): Promise<ConformanceControlStore>
}): void {
  const keyFields = ['forkHalt', 'recoveryUnavailable'] as const
  const evidenceBodies: Array<ConformanceGroupForkEvidence> = [
    {
      kind: 'epoch-authenticator',
      epoch: 4,
      local: new Uint8Array([1]),
      remote: new Uint8Array([2]),
    },
    {
      kind: 'digest-divergence',
      epoch: 4,
      position: '004',
      localDigest: 'local',
      remoteDigest: 'remote',
    },
    { kind: 'unexplained-own-commit', epoch: 4, position: '004', digest: 'commit' },
  ]
  const safety = (key: ConformanceGroupKey, evidence = evidenceBodies[0]) => {
    if (evidence === undefined) throw new Error('Missing evidence')
    return {
      forkHalt: {
        eventID: JSON.stringify(['group:fork', key.groupID, key.incarnation]),
        evidence,
        detectedAt: 100,
      },
      recoveryUnavailable: {
        ...key,
        id: JSON.stringify(['group:recovery-unavailable', key.groupID, key.incarnation]),
        kind: 'group:recovery-unavailable' as const,
        reason: 'trust-unreadable' as const,
      },
    }
  }

  describe('ControlStore safety inputs', () => {
    test.each([undefined, 'app-report', 'internal'] as const)(
      'bare callers cannot clear a halt with producer %s',
      async (producer) => {
        const store = await params.open()
        const halt = {
          ...safety(store.key).forkHalt,
          ...(producer === undefined ? {} : { producer }),
        }
        await store.apply({ forkHalt: halt }, 'report')
        const before = await store.load()
        const mutation = await store.lastMutation()
        for (const request of [
          { eventID: halt.eventID, reportMutationID: 'report' },
          { eventID: 'wrong-event', reportMutationID: 'report' },
          { eventID: halt.eventID, reportMutationID: 'wrong-report' },
        ]) {
          for (const changes of [
            { clearAppHold: request },
            Object.create({ clearAppHold: request }),
          ]) {
            await expect(store.apply(changes, 'unauthorised-clear')).rejects.toThrow()
            expect(await store.load()).toEqual(before)
            expect(await store.lastMutation()).toBe(mutation)
          }
        }
        expect((await (await params.reopen()).load()).forkHalt).toEqual(halt)
      },
    )

    test.each(keyFields)('reads the supplied %s accessor once', async (field) => {
      const store = await params.open()
      const expected = safety(store.key)[field]
      let reads = 0
      const changes = Object.defineProperty({}, field, {
        enumerable: true,
        get: () => (++reads === 1 ? expected : null),
      })
      await store.apply(changes, 'accessor')
      expect(reads).toBe(1)
      const reopened = await params.reopen()
      expect((await reopened.load())[field]).toEqual(expected)
      await reopened.apply({ [field]: expected }, 'same-accessor')
      expect((await reopened.load())[field]).toEqual(expected)
    })

    for (const shape of ['inherited', 'accessor', 'extra'] as const) {
      test.each(evidenceBodies)(
        `canonicalizes ${shape} safety bodies with $kind evidence`,
        async (evidence) => {
          const store = await params.open()
          const expected = safety(store.key, evidence)
          const materialize = <TValue extends object>(body: TValue): TValue => {
            if (shape === 'inherited') return Object.create(body) as TValue
            if (shape === 'extra') return { ...body, unknown: 'discard' }
            const result = {}
            for (const [name, value] of Object.entries(body)) {
              let reads = 0
              Object.defineProperty(result, name, {
                enumerable: true,
                get: () => (++reads === 1 ? value : undefined),
              })
            }
            return result as TValue
          }
          const changes = {
            forkHalt: materialize({ ...expected.forkHalt, evidence: materialize(evidence) }),
            recoveryUnavailable: materialize(expected.recoveryUnavailable),
          }
          await store.apply(changes, 'materialized')
          const reopened = await params.reopen()
          const read = await reopened.load()
          expect(read.forkHalt).toEqual(expected.forkHalt)
          expect(read.recoveryUnavailable).toEqual(expected.recoveryUnavailable)
          await reopened.apply(expected, 'identical')
          expect(await reopened.load()).toEqual(read)
          expect(await reopened.lastMutation()).toBe('identical')
        },
      )
    }

    test.each(keyFields)('preserves inherited and non-enumerable %s writes', async (field) => {
      const store = await params.open()
      const expected = safety(store.key)[field]
      const changes: ConformanceControlChanges = Object.create({ [field]: expected })
      await store.apply(changes, 'inherited')
      const read = await store.load()
      expect(read[field]).toEqual(expected)
      await store.apply(Object.defineProperty({}, field, { value: expected }), 'non-enumerable')
      expect(await store.load()).toEqual(read)
      expect(await store.lastMutation()).toBe('non-enumerable')
    })

    for (const field of keyFields) {
      test.each([null, undefined, {}, 'invalid'])(
        `inherited ${field} value %j rejects ordinary writes atomically`,
        async (value) => {
          let store = await params.open()
          for (const held of [false, true]) {
            if (held) await store.apply(safety(store.key), 'safety')
            const before = await store.load()
            const marker = await store.lastMutation()
            const changes: ConformanceControlChanges = Object.assign(
              Object.create({ [field]: value }),
              { putOutcomes: [{ id: 'bad', opID: null, at: 1, kind: 'lost' }] },
            )
            await expect(store.apply(changes, 'invalid-inherited')).rejects.toMatchObject(
              value === null
                ? { name: 'ControlSafetyImmutableError', field }
                : { name: 'TypeError' },
            )
            const reopened = await params.reopen()
            expect(await reopened.load()).toEqual(before)
            expect(await reopened.lastMutation()).toBe(marker)
            store = reopened
          }
        },
      )
    }
  })
}

function fixtureBuilt(): ConformanceBuiltCommit {
  return {
    opID: 'operation',
    kind: 'invite',
    revokes: false,
    enqueuedAt: 100,
    deadline: 30_100,
    publishID: 'publish',
    expectedHead: null,
    epoch: 4,
    authenticatorBefore: new Uint8Array([2]),
    incarnation: 1,
    head: null,
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
        stage: 'intent',
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
    },
  }
}

async function prepareSlot(host: ConformanceControlHost) {
  const original = records().putOperations?.[0]
  if (original == null || original.stage !== 'intent') throw new Error('Missing build fixture')
  const intent: ConformanceOperation & { stage: 'intent' } = { ...original, stage: 'intent' }
  const slot: ConformanceControlSlot = { ...fixtureBuilt(), opID: original.id }
  const identity = {
    ...host.control.key,
    epoch: slot.epoch,
    authenticator: slot.authenticatorBefore.slice(),
  }
  await host.saveState(encodeControlFixtureState(identity))
  await host.control.apply(
    { putOperations: [intent], cursor: { position: slot.head, epoch: slot.epoch } },
    'intent',
  )
  const source = { key: host.control.key, identity, stateVersion: await host.loadVersion() }
  expect(await host.saveBuilt(intent, slot, source, 'saved')).toBe('saved')
  return { intent, slot, source }
}

export function controlConsumptionRecords(
  work: 'operations' | 'rejoin',
): ConformanceControlChanges {
  const rows = records()
  return work === 'operations'
    ? { putOperations: rows.putOperations }
    : { putRejoin: rows.putRejoin }
}

/** The same refusal matrix applies to sealed providers and host doubles. */
export function testControlConsumptionConformance(params: {
  retirement?: boolean
  prepare(work: 'build' | 'operations' | 'rejoin'): Promise<{
    snapshot(): Promise<unknown>
    consume(transition: 'advance' | 'retire' | 'terminal', write: boolean): Promise<void>
    close(): Promise<void>
  }>
}): void {
  const cases = [
    { transition: 'advance' as const, work: 'build' as const },
    ...(params.retirement === false
      ? []
      : [{ transition: 'retire' as const, work: 'build' as const }]),
    ...(['build', 'operations', 'rejoin'] as const).map((work) => ({
      transition: 'terminal' as const,
      work,
    })),
  ].flatMap((row) => [false, true].map((write) => ({ ...row, write })))
  test.each(cases)(
    '$transition refuses surviving $work atomically (write=$write)',
    async ({ transition, work, write }) => {
      const fixture = await params.prepare(work)
      try {
        const before = await fixture.snapshot()
        await expect(fixture.consume(transition, write)).rejects.toThrow(
          /(?:[Cc]onsumption|[Rr]etirement|[Cc]losure|[Rr]emoval)/,
        )
        expect(await fixture.snapshot()).toEqual(before)
      } finally {
        await fixture.close()
      }
    },
  )
}

export function testControlStoreConformance(params: ControlStoreConformanceParams): void {
  testControlConsumptionConformance({
    prepare: async (work) => {
      const host = await params.open()
      const identity = { ...host.control.key, epoch: 4, authenticator: new Uint8Array([2]) }
      if (work === 'build') await prepareSlot(host)
      else {
        await host.saveState(encodeControlFixtureState(identity))
        await host.control.apply(controlConsumptionRecords(work), 'pending-work')
      }
      return {
        snapshot: async () => {
          const reopened = await params.reopen()
          return {
            control: await reopened.control.load(),
            state: await reopened.loadState(),
            version: await reopened.loadVersion(),
            mutation: await reopened.control.lastMutation(),
          }
        },
        consume: (transition, write) =>
          host.saveState(
            encodeControlFixtureState({
              ...identity,
              ...(transition === 'advance' ? { epoch: 5 } : {}),
              ...(transition === 'retire' ? { incarnation: 2, epoch: 0 } : {}),
              ...(transition === 'terminal' ? { terminal: true } : {}),
            }),
            write ? { mutationID: 'unclosed', changes: {} } : undefined,
          ),
        close: async () => {},
      }
    },
  })
  testControlSafetyInputConformance({
    open: async () => (await params.open()).control,
    reopen: async () => (await params.reopen()).control,
  })
  describe('ControlStore conformance', () => {
    test('fresh recovery state has a null floor and no settlements', async () => {
      const host = await params.open()
      const snapshot = await host.control.load()
      expect(snapshot.recoveryEpochFloor).toBeNull()
      expect(snapshot.forkRecoveryAttempt).toBeNull()
      expect(snapshot.settledRejoins).toEqual([])
    })
    test('recovery floor survives deletion, lower writes, null writes and reopen', async () => {
      const host = await params.open()
      const rejoin = records().putRejoin
      await host.control.apply({ putRejoin: rejoin, recoveryEpochFloor: 4 }, 'capture')
      await host.control.apply({ deleteRejoin: true, recoveryEpochFloor: 7 }, 'discard')
      await host.control.apply({ recoveryEpochFloor: 5 }, 'lower')
      await host.control.apply({ recoveryEpochFloor: null }, 'null')
      const read = await (await params.reopen()).control.load()
      expect(read.recoveryEpochFloor).toBe(7)
      expect(read.rejoin).toBeNull()
    })
    test('leaf-absent discard retains its obligation union atomically across restart and later acceptance', async () => {
      const host = await params.open()
      const saved = records()
      await host.control.apply(saved, 'before-discard')
      const before = await host.control.load()
      const row: ConformanceAcceptedRejoinSettlement = {
        kind: 'not-accepted',
        epoch: 7,
        id: 'unconfirmed-X',
        origin: {
          sourceKey: { ...host.control.key },
          target: {
            targetID: 'hub',
            topicID: 'commits',
            groupInfoEpoch: 4,
            groupInfoAuthenticator: new Uint8Array([1, 2]),
            captureHead: null,
          },
          searchFrom: null,
        },
        ledgerBefore: ['owed-only-in-X', 'shared'],
      }
      const changes: ConformanceControlChanges = {
        putSettledRejoins: [row],
        deleteRejoin: true,
        recoveryEpochFloor: 7,
      }
      params.injectFailure('mid-apply')
      await expect(host.control.apply(changes, 'discard-rollback')).rejects.toThrow()
      expect(await (await params.reopen()).control.load()).toEqual(before)
      await host.control.apply(changes, 'discard-X')
      const restarted = (await params.reopen()).control
      const snapshot = await restarted.load()
      expect(snapshot.rejoin).toBeNull()
      expect(snapshot.recoveryEpochFloor).toBe(7)
      expect(snapshot.settledRejoins).toEqual([row])
      expect(snapshot.outcomes).toEqual(before.outcomes)
      expect(snapshot.welcomes).toEqual(before.welcomes)
      const accepted: ConformanceAcceptedRejoinSettlement = {
        id: 'accepted-Y',
        origin: row.origin,
        kind: 'accepted-unadoptable',
        acceptedEpoch: 9,
        epochAfter: 8,
        digest: 'commit-Y',
        payloadDigest: 'payload-Y',
        leafDigest: 'leaf-Y',
        ledgerBefore: ['shared', 'owed-Y'],
      }
      await restarted.apply({ putSettledRejoins: [accepted], recoveryEpochFloor: 9 }, 'settle-Y')
      expect((await (await params.reopen()).control.load()).settledRejoins).toEqual([
        { ...accepted, ledgerBefore: ['owed-only-in-X', 'shared', 'owed-Y'] },
      ])
    })
    test('settlements replace public provenance and retain cumulative owed tokens defensively', async () => {
      const host = await params.open()
      await host.control.apply({ ...records(), recoveryEpochFloor: 4 }, 'before-settlement')
      const baseline = await host.control.load()
      const settlement: ConformanceAcceptedRejoinSettlement = {
        kind: 'accepted-unadoptable',
        id: 'accepted-X',
        digest: 'commit-X',
        payloadDigest: 'payload-X',
        epochAfter: 5,
        acceptedEpoch: 6,
        origin: {
          sourceKey: { ...host.control.key },
          target: {
            targetID: 'target-X',
            topicID: 'topic-X',
            groupInfoEpoch: 4,
            groupInfoAuthenticator: new Uint8Array([1, 2]),
            captureHead: 'capture-X',
          },
          searchFrom: 'search-X',
        },
        leafDigest: 'leaf-X',
        ledgerBefore: ['owed-X', 'shared', 'owed-X'],
      }
      const original = {
        ...settlement,
        origin: {
          ...settlement.origin,
          sourceKey: { ...settlement.origin.sourceKey },
          target: {
            ...settlement.origin.target,
            groupInfoAuthenticator: Uint8Array.from(
              settlement.origin.target.groupInfoAuthenticator,
            ),
          },
        },
        ledgerBefore: [...settlement.ledgerBefore],
      }
      // Extra private fields must not cross the public storage boundary.
      const changes: ConformanceControlChanges = {
        putSettledRejoins: [
          { ...settlement, requestKey: new Uint8Array([9]) } as ConformanceAcceptedRejoinSettlement,
        ],
        deleteRejoin: true,
        recoveryEpochFloor: 6,
      }
      params.injectFailure('mid-apply')
      await expect(host.control.apply(changes, 'failed-settlement')).rejects.toThrow()
      expect(await (await params.reopen()).control.load()).toEqual(baseline)
      expect(await host.control.lastMutation()).toBe('before-settlement')
      await host.control.apply(changes, 'settle-X')
      settlement.origin.sourceKey.incarnation = 99
      settlement.origin.target.groupInfoAuthenticator.fill(0)
      settlement.ledgerBefore.push('mutated-input')
      const reopened = await params.reopen()
      const read = await reopened.control.load()
      expect(read.rejoin).toBeNull()
      expect(read.recoveryEpochFloor).toBe(6)
      expect(read.outcomes).toEqual(baseline.outcomes)
      expect(read.welcomes).toEqual(baseline.welcomes)
      expect(read.settledRejoins).toEqual([{ ...original, ledgerBefore: ['owed-X', 'shared'] }])
      read.settledRejoins?.[0]?.origin.target.groupInfoAuthenticator.fill(0)
      read.settledRejoins?.[0]?.ledgerBefore.push('mutated-output')
      expect((await reopened.control.load()).settledRejoins).toEqual([
        { ...original, ledgerBefore: ['owed-X', 'shared'] },
      ])
      const next = {
        ...original,
        id: 'accepted-Y',
        digest: 'commit-Y',
        origin: {
          ...original.origin,
          target: { ...original.origin.target, targetID: 'target-Y', captureHead: 'capture-Y' },
          searchFrom: 'search-Y',
        },
        ledgerBefore: ['shared', 'owed-Y'],
      }
      await reopened.control.apply({ putSettledRejoins: [next, next] }, 'settle-Y')
      await reopened.control.apply({ putSettledRejoins: [next] }, 'repeat-Y')
      expect((await (await params.reopen()).control.load()).settledRejoins).toEqual([
        { ...next, ledgerBefore: ['owed-X', 'shared', 'owed-Y'] },
      ])
    })
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
            : []
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
      if (op == null || op.stage !== 'intent') throw new Error('missing build')
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
      'head',
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
          case 'head':
            next.head = 'other'
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
          {
            ...slot,
            opID: intent.id,
            kind: intent.kind,
            revokes: intent.revokes,
            enqueuedAt: intent.enqueuedAt,
            deadline: intent.deadline,
          },
          { ...source, stateVersion: await host.loadVersion() },
          'same',
        ),
      ).toBe('occupied')
      expect(
        await host.saveBuilt(
          intent,
          {
            ...slot,
            opID: intent.id,
            kind: intent.kind,
            revokes: intent.revokes,
            enqueuedAt: intent.enqueuedAt,
            deadline: intent.deadline,
            epoch: slot.epoch - 1,
          },
          { ...source, identity: { ...source.identity, epoch: slot.epoch - 1 } },
          'lower',
        ),
      ).toBe('moved')
      expect(await host.control.load()).toEqual(before)
      expect(await host.control.lastMutation()).toBe(marker)
    })
    test.each(['kind', 'revokes', 'enqueuedAt', 'deadline'] as const)(
      'built save refuses copied owner metadata mismatch: %s',
      async (field) => {
        const host = await params.open()
        const intent = records().putOperations?.[0]
        if (intent === undefined) throw new Error('Missing intent')
        const built = fixtureBuilt()
        const identity = {
          ...host.control.key,
          epoch: built.epoch,
          authenticator: built.authenticatorBefore,
        }
        await host.saveState(encodeControlFixtureState(identity))
        await host.control.apply({ putOperations: [intent] }, 'enqueue')
        if (field === 'kind') built.kind = 'rotation'
        if (field === 'revokes') built.revokes = true
        if (field === 'enqueuedAt') built.enqueuedAt++
        if (field === 'deadline') built.deadline++
        const before = await host.control.load()
        expect(
          await host.saveBuilt(
            intent,
            built,
            { key: host.control.key, identity, stateVersion: await host.loadVersion() },
            'mismatched-owner',
          ),
        ).toBe('moved')
        expect(await host.control.load()).toEqual(before)
      },
    )
    test('state advancement without an adoption write cannot consume a live build', async () => {
      const host = await params.open()
      const { slot, source } = await prepareSlot(host)
      const before = await host.control.load()
      const state = await host.loadState()
      await expect(
        host.saveState(encodeControlFixtureState({ ...source.identity, epoch: slot.epoch + 1 })),
      ).rejects.toThrow()
      const reopened = await params.reopen()
      expect(await reopened.control.load()).toEqual(before)
      expect(await reopened.loadState()).toEqual(state)
    })
    test.each(
      (['complete', 'incomplete'] as const).flatMap((coverage) =>
        (['landed', 'unknown'] as const).flatMap((kind) =>
          [false, true].flatMap((welcome) =>
            (['none', 'matching', 'bytes', 'recipients'] as const).map((retained) => ({
              coverage,
              kind,
              welcome,
              retained,
            })),
          ),
        ),
      ),
    )(
      'own consumption shape: $coverage / $kind / Welcome=$welcome / retained=$retained',
      async ({ coverage, kind, welcome, retained }) => {
        const host = await params.open()
        const { slot, source } = await prepareSlot(host)
        const speculative = slot.welcome
        if (speculative === null) throw new Error('Missing speculative Welcome')
        const owed = {
          opID: slot.opID,
          welcome: retained === 'bytes' ? new Uint8Array([99]) : speculative.bytes.slice(),
          recipients: retained === 'recipients' ? ['carol'] : [...speculative.recipients],
        }
        if (retained !== 'none')
          await host.control.apply({ putWelcomes: [owed] }, 'retained-welcome')
        if (coverage === 'incomplete')
          await host.control.apply(
            { cursor: { position: slot.head, epoch: slot.epoch, incomplete: true } },
            'gap',
          )
        const before = await host.control.load()
        const state = await host.loadState()
        const mutation = await host.control.lastMutation()
        const write: ConformanceAdoptionWrite = {
          mutationID: 'own-shape',
          expected: {
            ...source,
            stateVersion: await host.loadVersion(),
            journal: slot.journal,
            occurrence: { source, position: 'winner', payloadDigest: slot.payloadDigest, coverage },
          },
          changes: {
            commitOnce: null,
            cursor: { position: 'winner', epoch: slot.epoch + 1 },
            putApplied: [
              {
                epoch: slot.epoch,
                digest: slot.digest,
                payloadDigest: slot.payloadDigest,
                sequenceID: 'winner',
                opID: slot.opID,
                removed: false,
              },
            ],
            putOutcomes: [
              kind === 'landed'
                ? { id: 'final', opID: slot.opID, at: 200, kind, position: 'winner' }
                : { id: 'final', opID: slot.opID, at: 200, kind },
            ],
            ...(welcome
              ? {
                  putWelcomes: [
                    {
                      opID: slot.opID,
                      welcome: speculative.bytes,
                      recipients: speculative.recipients,
                    },
                  ],
                }
              : {}),
          },
        }
        const saving = host.saveState(
          encodeControlFixtureState({ ...source.identity, epoch: slot.epoch + 1 }),
          write,
        )
        if (
          (coverage === 'complete' &&
            kind === 'landed' &&
            (welcome || retained === 'matching') &&
            (retained === 'none' || retained === 'matching')) ||
          (coverage === 'incomplete' && kind === 'unknown' && !welcome)
        ) {
          await saving
          const closed = await (await params.reopen()).control.load()
          expect(closed.commitOnce).toBeNull()
          expect(closed.outcomes).toEqual(write.changes.putOutcomes)
          expect(closed.applied).toEqual(write.changes.putApplied)
          expect(closed.cursor).toEqual(write.changes.cursor)
          expect(closed.welcomes).toEqual(
            write.changes.putWelcomes ?? (retained === 'none' ? [] : [owed]),
          )
        } else {
          await expect(saving).rejects.toMatchObject({ name: 'ControlAdoptionMovedError' })
          const reopened = await params.reopen()
          expect(await reopened.control.load()).toEqual(before)
          expect(await reopened.loadState()).toEqual(state)
          expect(await reopened.loadVersion()).toBe(write.expected?.stateVersion)
          expect(await reopened.control.lastMutation()).toBe(mutation)
        }
      },
    )
    test('built save extracts the owning intent and cannot be replaced before consumption', async () => {
      const host = await params.open()
      const { slot, source } = await prepareSlot(host)
      expect((await host.control.load()).operations).toEqual([])
      const later = {
        ...source.identity,
        epoch: slot.epoch + 1,
        authenticator: new Uint8Array([43]),
      }
      await host.saveState(encodeControlFixtureState(later), {
        mutationID: 'consume',
        changes: {
          commitOnce: null,
          putOutcomes: [{ id: 'final', opID: slot.opID, at: 200, kind: 'lost' }],
          cursor: { position: 'winner', epoch: later.epoch },
        },
      })
      const closed = await (await params.reopen()).control.load()
      expect(closed.commitOnce).toBeNull()
      expect(closed.outcomes).toContainEqual({
        id: 'final',
        opID: slot.opID,
        at: 200,
        kind: 'lost',
      })
      expect(closed.welcomes).toEqual([])
    })
    test.each(['digest', 'key', 'coverage', 'journal', 'stranded'] as const)(
      'current own occurrence refuses stale %s without state or cursor changes',
      async (field) => {
        const host = await params.open()
        const { slot, source } = await prepareSlot(host)
        if (field === 'stranded')
          await host.control.apply(
            { cursor: { position: slot.head, epoch: slot.epoch, stranded: true } },
            'strand',
          )
        const before = await host.control.load()
        const state = await host.loadState()
        const occurrence: ConformanceOwnOccurrence = {
          source,
          position: 'winner',
          payloadDigest: slot.payloadDigest,
          coverage: 'complete',
        }
        if (field === 'digest') occurrence.payloadDigest = 'different'
        if (field === 'key')
          occurrence.source = { ...source, key: { ...source.key, incarnation: 9 } }
        if (field === 'coverage') occurrence.coverage = 'incomplete'
        await expect(
          host.saveState(encodeControlFixtureState({ ...source.identity, epoch: slot.epoch + 1 }), {
            expected: {
              ...source,
              stateVersion: await host.loadVersion(),
              occurrence,
              journal: field === 'journal' ? new Uint8Array([99]) : slot.journal,
            },
            mutationID: 'invalid-own',
            changes: { commitOnce: null },
          }),
        ).rejects.toThrow()
        expect(await host.control.load()).toEqual(before)
        expect(await host.loadState()).toEqual(state)
      },
    )
    test('same-epoch generic adoption cannot clear a build and retirement preserves owed Welcomes', async () => {
      const host = await params.open()
      const { source } = await prepareSlot(host)
      const obligation = { opID: 'previous', welcome: new Uint8Array([8]), recipients: ['bob'] }
      await host.control.apply({ putWelcomes: [obligation] }, 'obligation')
      const before = await host.control.load()
      await expect(
        host.saveState(encodeControlFixtureState(source.identity), {
          changes: { commitOnce: null },
          mutationID: 'unverified',
        }),
      ).rejects.toThrow()
      expect(await host.control.load()).toEqual(before)
      await host.saveState(
        encodeControlFixtureState({
          ...source.identity,
          incarnation: source.identity.incarnation + 1,
          epoch: 0,
        }),
        {
          changes: { commitOnce: null, spentSource: null },
          mutationID: 'retire',
        },
      )
      expect((await host.control.load()).commitOnce).toBeNull()
      expect((await host.control.load()).welcomes).toEqual([obligation])
    })
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
    test('build material survives defensive reads and rollback while ack never installs', async () => {
      const host = await params.open()
      const { slot, source } = await prepareSlot(host)
      const expected = {
        ...slot,
        authenticatorBefore: slot.authenticatorBefore.slice(),
        payload: slot.payload.slice(),
        bodies: [...slot.bodies],
        journal: slot.journal.slice(),
        welcome:
          slot.welcome === null
            ? null
            : { bytes: slot.welcome.bytes.slice(), recipients: [...slot.welcome.recipients] },
      }
      const refreshed = { ...slot, acceptedAs: 'ack' }
      await host.control.apply({ commitOnce: refreshed }, 'ack')
      expected.acceptedAs = 'ack'
      const loaded = await (await params.reopen()).control.load()
      expect(loaded.commitOnce).toEqual(expected)
      expect(loaded.applied).toEqual([])
      expect(loaded.outcomes).toEqual([])
      expect(loaded.welcomes).toEqual([])
      loaded.commitOnce?.payload.fill(0)
      loaded.commitOnce?.journal.fill(0)
      expect((await host.control.load()).commitOnce).toEqual(expected)
      params.injectFailure('mid-save')
      await expect(
        host.saveState(encodeControlFixtureState({ ...source.identity, epoch: slot.epoch + 1 }), {
          mutationID: 'consume',
          changes: { commitOnce: null, cursor: { position: 'winner', epoch: slot.epoch + 1 } },
        }),
      ).rejects.toThrow()
      expect((await (await params.reopen()).control.load()).commitOnce).toEqual(expected)
    })
    test('skipped and reported are monotone, copied owner metadata and build head remain immutable', async () => {
      const host = await params.open()
      const { slot } = await prepareSlot(host)
      await expect(
        host.control.apply({ commitOnce: { ...slot, skipped: true } }, 'unbound-skip'),
      ).rejects.toThrow()
      await host.control.apply(
        { commitOnce: { ...slot, skipped: true }, cursor: { position: 'skip', epoch: slot.epoch } },
        'skip',
      )
      const skipped = (await host.control.load()).commitOnce
      if (skipped === null) throw new Error('Missing build')
      await host.control.apply(
        {
          commitOnce: { ...skipped, reported: true },
          putOutcomes: [
            { id: 'provisional', opID: skipped.opID, at: skipped.deadline, kind: 'unknown' },
          ],
        },
        'report',
      )
      const marked = (await host.control.load()).commitOnce
      if (marked === null) throw new Error('Missing build')
      await host.control.apply({ commitOnce: { ...marked, expectedHead: 'refresh' } }, 'head')
      const saved = await host.control.load()
      expect(saved.commitOnce?.skipped).toBe(true)
      expect(saved.commitOnce?.reported).toBe(true)
      for (const mutation of [
        { ...marked, skipped: undefined },
        { ...marked, reported: undefined },
        { ...marked, deadline: 999 },
        { ...marked, kind: 'rotation' as const },
        { ...marked, revokes: true },
        { ...marked, enqueuedAt: 9 },
      ]) {
        await expect(host.control.apply({ commitOnce: mutation }, 'invalid')).rejects.toThrow()
        expect(await host.control.load()).toEqual(saved)
      }
    })
    test.each(['missing', 'owner', 'final', 'reused', 'repeat'] as const)(
      'report marking requires a fresh once-only provisional unknown: %s',
      async (mutation) => {
        const host = await params.open()
        const { slot } = await prepareSlot(host)
        const outcome = { id: 'clock', opID: slot.opID, at: 1, kind: 'unknown' as const }
        if (mutation === 'reused') await host.control.apply({ putOutcomes: [outcome] }, 'previous')
        if (mutation === 'repeat')
          await host.control.apply(
            { commitOnce: { ...slot, reported: true }, putOutcomes: [outcome] },
            'first',
          )
        const before = await host.control.load()
        await expect(
          host.control.apply(
            {
              commitOnce: { ...slot, reported: true },
              putOutcomes:
                mutation === 'missing'
                  ? []
                  : [
                      mutation === 'owner'
                        ? { ...outcome, opID: 'other' }
                        : mutation === 'final'
                          ? { ...outcome, kind: 'lost' }
                          : mutation === 'repeat'
                            ? { ...outcome, id: 'second' }
                            : outcome,
                    ],
            },
            'invalid',
          ),
        ).rejects.toThrow()
        expect(await host.control.load()).toEqual(before)
      },
    )
    test('abandonment removes a provisional report committed after its closure snapshot', async () => {
      const host = await params.open()
      const { slot } = await prepareSlot(host)
      const final = { id: 'abandon-final', opID: slot.opID, at: 2, kind: 'unknown' as const }
      const prepared = {
        commitOnce: null,
        spentSource: { epoch: slot.epoch },
        deleteOutcomes: [],
        putOutcomes: [final],
      }
      await host.control.apply(
        {
          commitOnce: { ...slot, reported: true },
          putOutcomes: [{ id: 'clock', opID: slot.opID, at: 1, kind: 'unknown' }],
        },
        'clock',
      )
      await host.control.apply(prepared, 'abandon')
      const closed = await (await params.reopen()).control.load()
      expect(closed.commitOnce).toBeNull()
      expect(closed.spentSource).toEqual({ epoch: slot.epoch })
      expect(closed.outcomes).toEqual([final])
      await host.control.apply({ deleteOutcomes: ['clock'] }, 'late-ack')
      expect((await host.control.load()).outcomes).toEqual([final])
    })
    test('clearing a build without a final report preserves its provisional outcome', async () => {
      const host = await params.open()
      const { slot, source } = await prepareSlot(host)
      await host.control.apply(
        {
          commitOnce: { ...slot, reported: true },
          putOutcomes: [{ id: 'clock', opID: slot.opID, at: 1, kind: 'unknown' }],
        },
        'clock',
      )
      await host.saveState(
        encodeControlFixtureState({ ...source.identity, epoch: slot.epoch + 1 }),
        { mutationID: 'incomplete-closure', changes: { commitOnce: null } },
      )
      expect((await (await params.reopen()).control.load()).outcomes).toEqual([
        { id: 'clock', opID: slot.opID, at: 1, kind: 'unknown' },
      ])
    })
    test('consumption removes a provisional report written after the closure was prepared', async () => {
      const host = await params.open()
      const { slot, source } = await prepareSlot(host)
      const final = { id: 'fresh-final', opID: slot.opID, at: 2, kind: 'lost' as const }
      const prepared = {
        mutationID: 'consume',
        changes: { commitOnce: null, putOutcomes: [final] },
      }
      await host.control.apply(
        {
          commitOnce: { ...slot, reported: true },
          putOutcomes: [{ id: 'clock', opID: slot.opID, at: 1, kind: 'unknown' }],
        },
        'clock',
      )
      await host.saveState(
        encodeControlFixtureState({ ...source.identity, epoch: slot.epoch + 1 }),
        prepared,
      )
      expect((await (await params.reopen()).control.load()).outcomes).toEqual([final])
    })
    test.each(['absent', 'epoch', 'operation', 'report', 'clear', 'reuse'] as const)(
      'raw control writes cannot change spent-source authority: %s',
      async (mutation) => {
        const host = await params.open()
        const { slot } = await prepareSlot(host)
        const close: ConformanceControlChanges = {
          commitOnce: null,
          spentSource: { epoch: slot.epoch },
          putOutcomes: [{ id: 'final', opID: slot.opID, at: 1, kind: 'unknown' }],
        }
        if (mutation === 'clear' || mutation === 'absent')
          await host.control.apply(close, 'abandon')
        if (mutation === 'reuse')
          await host.control.apply({ putOutcomes: close.putOutcomes }, 'prior')
        const before = await host.control.load()
        const changes =
          mutation === 'clear'
            ? { spentSource: null }
            : mutation === 'absent'
              ? { spentSource: { epoch: slot.epoch + 1 } }
              : mutation === 'epoch'
                ? { ...close, spentSource: { epoch: slot.epoch + 1 } }
                : mutation === 'operation'
                  ? { ...close, spentSource: { epoch: slot.epoch, opID: 'different-operation' } }
                  : mutation === 'report'
                    ? { ...close, putOutcomes: [] }
                    : close
        await expect(host.control.apply(changes, 'invalid')).rejects.toThrow()
        expect(await host.control.load()).toEqual(before)
      },
    )
    test.each(['missing', 'deleted'] as const)(
      'abandonment refuses when persisted state is %s',
      async (state) => {
        const host = await params.open()
        const { slot, source } = await prepareSlot(host)
        await host.saveState(
          state === 'missing'
            ? new Uint8Array()
            : encodeControlFixtureState({ ...source.identity, deleted: true }),
        )
        const before = await host.control.load()
        await expect(
          host.control.apply(
            {
              commitOnce: null,
              spentSource: { epoch: slot.epoch },
              putOutcomes: [{ id: 'final', opID: slot.opID, at: 2, kind: 'unknown' }],
            },
            'invalid-abandon',
          ),
        ).rejects.toThrow()
        expect(await host.control.load()).toEqual(before)
      },
    )
    test('abandonment closes executable work with a durable epoch-only fuse and preserves obligations', async () => {
      const host = await params.open()
      const { slot, source, intent } = await prepareSlot(host)
      const obligation = { opID: 'owed', welcome: new Uint8Array([8]), recipients: ['guest'] }
      await host.control.apply(
        {
          putWelcomes: [obligation],
          putOutcomes: [{ id: 'provisional', opID: slot.opID, at: 1, kind: 'unknown' }],
        },
        'owed',
      )
      await host.control.apply(
        {
          commitOnce: null,
          spentSource: { epoch: slot.epoch },
          deleteOutcomes: ['provisional'],
          putOutcomes: [{ id: 'final', opID: slot.opID, at: 2, kind: 'unknown' }],
        },
        'abandon',
      )
      const again = await params.reopen()
      expect((await again.control.load()).commitOnce).toBeNull()
      expect((await again.control.load()).welcomes).toEqual([obligation])
      await again.control.apply({ deleteOutcomes: ['final'], putOperations: [intent] }, 'ack')
      expect(
        await again.saveBuilt(
          intent,
          slot,
          {
            ...source,
            stateVersion: await again.loadVersion(),
          },
          'blocked',
        ),
      ).not.toBe('saved')
      expect((await again.control.load()).spentSource).toEqual({ epoch: slot.epoch })
      await again.saveState(
        encodeControlFixtureState({ ...source.identity, epoch: slot.epoch + 1 }),
        {
          mutationID: 'consume-spent',
          changes: { spentSource: null },
        },
      )
      expect((await (await params.reopen()).control.load()).spentSource).toBeNull()
    })
    test('a stale spent marker permits a later-source build and clears at its next consumption', async () => {
      const host = await params.open()
      const { slot, source, intent } = await prepareSlot(host)
      await host.control.apply(
        {
          commitOnce: null,
          spentSource: { epoch: slot.epoch },
          putOutcomes: [{ id: 'abandoned', opID: slot.opID, at: 1, kind: 'unknown' }],
        },
        'abandon',
      )
      const later = {
        ...source.identity,
        epoch: slot.epoch + 1,
        authenticator: new Uint8Array([43]),
      }
      await host.saveState(encodeControlFixtureState(later))
      const successor = { ...intent, id: 'successor' }
      await host.control.apply(
        { putOperations: [successor], cursor: { position: null, epoch: later.epoch } },
        'later-intent',
      )
      const next = {
        ...slot,
        opID: successor.id,
        epoch: later.epoch,
        authenticatorBefore: later.authenticator,
        publishID: 'later-publication',
      }
      expect(
        await host.saveBuilt(
          successor,
          next,
          {
            key: host.control.key,
            identity: later,
            stateVersion: await host.loadVersion(),
          },
          'later-build',
        ),
      ).toBe('saved')
      expect((await host.control.load()).spentSource).toEqual({ epoch: slot.epoch })
      await host.saveState(encodeControlFixtureState({ ...later, epoch: later.epoch + 1 }), {
        mutationID: 'consume-later',
        changes: {
          commitOnce: null,
          spentSource: null,
          putOutcomes: [{ id: 'later-final', opID: successor.id, at: 2, kind: 'unknown' }],
        },
      })
      expect((await (await params.reopen()).control.load()).spentSource).toBeNull()
    })
    test.each(['incomplete', 'stranded', 'spent'] as const)(
      'build refuses an %s source',
      async (condition) => {
        const host = await params.open()
        const original = records().putOperations?.[0]
        if (original === undefined) throw new Error('Missing intent')
        const slot = fixtureBuilt()
        const identity = {
          ...host.control.key,
          epoch: slot.epoch,
          authenticator: slot.authenticatorBefore,
        }
        await host.saveState(encodeControlFixtureState(identity))
        if (condition === 'spent') {
          await host.control.apply({ putOperations: [original] }, 'intent')
          expect(
            await host.saveBuilt(
              original,
              slot,
              {
                key: host.control.key,
                identity,
                stateVersion: await host.loadVersion(),
              },
              'saved',
            ),
          ).toBe('saved')
          await host.control.apply(
            {
              commitOnce: null,
              spentSource: { epoch: slot.epoch },
              putOutcomes: [{ id: 'abandoned', opID: slot.opID, at: 1, kind: 'unknown' }],
            },
            'abandon',
          )
        }
        await host.control.apply(
          {
            putOperations: [original],
            ...(condition === 'spent'
              ? { spentSource: { epoch: slot.epoch } }
              : {
                  cursor: {
                    position: null,
                    epoch: slot.epoch,
                    ...(condition === 'incomplete'
                      ? { incomplete: true as const }
                      : { stranded: true as const }),
                  },
                }),
          },
          'source',
        )
        const before = await host.control.load()
        expect(
          await host.saveBuilt(
            original,
            slot,
            { key: host.control.key, identity, stateVersion: await host.loadVersion() },
            'refused',
          ),
        ).not.toBe('saved')
        expect(await host.control.load()).toEqual(before)
      },
    )
    test('an initial strand persists without inventing a processed log position', async () => {
      const host = await params.open()
      const cursor: ConformanceControlCommitCursor = {
        position: null,
        epoch: 4,
        stranded: true,
      }
      await host.control.apply({ cursor }, 'initial-strand')
      const reopened = await params.reopen()
      expect((await reopened.control.load()).cursor).toEqual(cursor)
      expect(await reopened.control.lastMutation()).toBe('initial-strand')
    })
    test('incomplete capture coverage survives unrelated writes and reopen', async () => {
      const host = await params.open()
      const cursor = { position: '002', epoch: 4, incomplete: true as const }
      await host.control.apply({ cursor }, 'uncovered-suffix')
      await host.control.apply({ recoveryEpochFloor: 4 }, 'unrelated')
      const reopened = await params.reopen()
      expect((await reopened.control.load()).cursor).toEqual(cursor)
      const read = await reopened.control.load()
      if (read.cursor !== null) read.cursor.position = 'mutated'
      expect((await reopened.control.load()).cursor).toEqual(cursor)
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
            deleteAppliedBelow: Number.MAX_SAFE_INTEGER + 1,
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

    test.each(['built', 'published', 'confirmed', 'adopted', 'refused'] as const)(
      'durable: both rejoin formats retain exact %s records and defensive copies',
      async (stage) => {
        const makeRecord = (format: 'legacy' | 'captured'): ConformanceStoredRejoinRecord => {
          const legacy = records().putRejoin
          if (legacy == null || 'format' in legacy) throw new Error('Missing legacy fixture')
          if (format === 'legacy') return { ...legacy, stage }
          const { source, conflictEpoch: _conflict, ...common } = legacy
          return {
            ...common,
            stage,
            format: 2,
            source: {
              key: source.key,
              stateVersion: 3,
              identity: { ...source.key, epoch: source.epoch, authenticator: source.authenticator },
              lifetimeRevision: 4,
              trustDigest: 'd'.repeat(43),
              trust: {
                registry: new Map([['signer', new Uint8Array([0, 128, 255])]]),
                lifetime: 12345678901234567890n,
              },
            },
            target: {
              targetID: 'recovery-hub',
              topicID: 'commit-topic',
              groupInfoEpoch: source.epoch,
              groupInfoAuthenticator: new Uint8Array([128, 255, 0]),
              captureHead: 'captured-head',
            },
            captureHead: 'captured-head',
            searchFrom: 'captured-head',
            trigger: 'automatic',
            authorisationID: null,
            switchMutationID: 'saved-switch',
            destinationKey: { ...source.key, incarnation: source.key.incarnation + 1 },
          }
        }
        for (const format of ['legacy', 'captured'] as const) {
          const host = await params.open()
          const record = makeRecord(format)
          const expected = makeRecord(format)
          await host.control.apply({ putRejoin: record }, `save-${stage}`)
          record.payload.fill(0)
          record.request.fill(0)
          record.requestKey.fill(0)
          record.candidate.fill(0)
          record.verdict?.fill(0)
          record.ledgerBefore.push('changed-input')
          if ('format' in record) {
            record.source.identity?.authenticator.fill(0)
            record.target.groupInfoAuthenticator.fill(0)
            const trust = record.source.trust
            if (trust == null || typeof trust !== 'object' || !('registry' in trust))
              throw new Error('Missing captured trust')
            if (!(trust.registry instanceof Map)) throw new Error('Missing trust registry')
            const key = trust.registry.get('signer')
            if (!(key instanceof Uint8Array)) throw new Error('Missing signer key')
            key.fill(0)
            trust.registry.clear()
            record.source.trust = null
          } else record.source.authenticator.fill(0)
          const reopened = await params.reopen()
          const loaded = (await reopened.control.load()).rejoin
          expect(loaded).toEqual(expected)
          if (loaded == null) throw new Error('Missing saved rejoin')
          loaded.candidate.fill(0)
          loaded.requestKey.fill(0)
          loaded.ledgerBefore.push('changed-load')
          if ('format' in loaded) {
            loaded.target.groupInfoAuthenticator.fill(0)
            loaded.source.identity?.authenticator.fill(0)
            const trust = loaded.source.trust
            if (trust == null || typeof trust !== 'object' || !('registry' in trust))
              throw new Error('Missing captured trust')
            if (!(trust.registry instanceof Map)) throw new Error('Missing trust registry')
            const key = trust.registry.get('signer')
            if (!(key instanceof Uint8Array)) throw new Error('Missing signer key')
            key.fill(0)
            trust.registry.clear()
          } else loaded.source.authenticator.fill(0)
          expect((await (await params.reopen()).control.load()).rejoin).toEqual(expected)
        }
      },
    )

    test('bare changes cannot manufacture a fork intent or branch settlement', async () => {
      const host = await params.open()
      const before = await host.control.load()
      expect(before.forkRecoveryAttempt ?? null).toBeNull()
      await expect(
        host.control.apply(
          { forkRecoveryAttempt: null } as ConformanceControlChanges,
          'clear-fork',
        ),
      ).rejects.toThrow('authority')
      const settled: ConformanceAcceptedRejoinSettlement = {
        kind: 'superseded-branch',
        id: 'unproven-X',
        epoch: 10,
        origin: {
          sourceKey: host.control.key,
          target: {
            targetID: 'unproven',
            topicID: 'unproven',
            groupInfoEpoch: 12,
            groupInfoAuthenticator: new Uint8Array(32),
            captureHead: null,
          },
          searchFrom: null,
        },
        ledgerBefore: ['owed'],
      }
      await expect(
        host.control.apply({ putSettledRejoins: [settled] }, 'unverified-settlement'),
      ).rejects.toThrow('authority')
      expect(await host.control.load()).toEqual(before)
    })

    test('durable: every record kind survives reopening', async () => {
      const host = await params.open()
      const changes = records()
      await host.control.apply(changes, 'durable')
      const reopened = await params.reopen()
      expect(await reopened.control.load()).toEqual({
        schemaVersion: 1,
        commitOnce: null,
        spentSource: null,
        controlHold: null,
        forkHalt: null,
        recoveryUnavailable: null,
        strand: null,
        operations: changes.putOperations,
        rejoin: changes.putRejoin,
        recoveryEpochFloor: null,
        forkRecoveryAttempt: null,
        settledRejoins: [],
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
        departing: [{ anchor: { secret: new Uint8Array([0, 128, 255]), epoch: 2 }, departedAt: 4 }],
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
        {
          cursor: { position: '005', epoch: 65 },
          deleteAppliedBelow: Number.MAX_SAFE_INTEGER + 1,
          deleteResponsesBelow: 65,
        },
        'prune',
      )
      const reopened = await params.reopen()
      expect((await reopened.control.load()).outcomes).toEqual([
        { id: 'unacked', opID: null, at: 1, kind: 'unknown' },
      ])
      await reopened.control.apply({ deleteOutcomes: ['unacked'] }, 'ack')
      expect((await (await params.reopen()).control.load()).outcomes).toEqual([])
    })

    test.each([null, '005'])('build retry head %s survives reopen', async (expectedHead) => {
      const host = await params.open()
      const { slot } = await prepareSlot(host)
      await host.control.apply({ commitOnce: { ...slot, expectedHead } }, 'handoff')
      expect((await (await params.reopen()).control.load()).commitOnce?.expectedHead).toBe(
        expectedHead,
      )
      expect((await host.control.load()).operations).toEqual([])
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
          deleteAppliedBelow: 4,
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
            { position: '000', epoch: 4, digest: 'replacement', kind: 'applied', reason: 'policy' },
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
        { position: '000', epoch: 4, digest: 'replacement', kind: 'applied', reason: 'policy' },
      ])
      expect(snapshot.cursor).toBeNull()
      await host.control.apply({ deleteRejoin: true }, 'clear-rejoin')
      expect((await host.control.load()).rejoin).toBeNull()
    })

    test('responses store only applied outcomes by position through ordinary and adoption writes', async () => {
      const host = await params.open()
      const negative: ConformanceExternalResponse = {
        position: 'shared',
        epoch: 1,
        digest: 'refused',
        kind: 'refused',
        reason: 'policy',
        refusalAuthority: 'authenticated-commit',
      }
      const applied: ConformanceExternalResponse = {
        position: 'shared',
        epoch: 1,
        digest: 'applied',
        kind: 'applied',
        epochAfter: 2,
      }
      await host.control.apply(
        { putResponses: [negative, { ...negative, kind: 'superseded' }] },
        'negative',
      )
      expect((await (await params.reopen()).control.load()).responses).toEqual([])
      await host.control.apply({ putResponses: [applied, negative] }, 'applied')
      expect((await (await params.reopen()).control.load()).responses).toEqual([applied])
      await host.saveState(new Uint8Array([2]), {
        changes: { putResponses: [negative, { ...applied, digest: 'replacement', epochAfter: 3 }] },
        mutationID: 'replace-applied',
      })
      expect((await (await params.reopen()).control.load()).responses).toEqual([
        { ...applied, digest: 'replacement', epochAfter: 3 },
      ])
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
            { position: 'old', epoch: 0, digest: 'old', kind: 'applied' },
            { position: 'boundary', epoch: 2, digest: 'boundary', kind: 'applied' },
            { position: 'new', epoch: 3, digest: 'new', kind: 'applied' },
          ],
        },
        'baseline',
      )
      await host.control.apply(
        {
          deleteAppliedBelow: 2,
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
        { position: 'boundary', epoch: 2, digest: 'boundary', kind: 'applied' },
        { position: 'new', epoch: 3, digest: 'new', kind: 'applied' },
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
        { position: 'new', epoch: 3, digest: 'new', kind: 'applied' },
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

export type ConformanceRecoverySource<TTrust = unknown> = ConformanceAdoptionExpected & {
  trust: TTrust
  trustDigest: string
  lifetimeRevision: number
}
export type ConformanceRecoveryTargetCapture<Position extends string = string> = {
  targetID: string
  topicID: string
  groupInfoEpoch: number
  groupInfoAuthenticator: Uint8Array
  captureHead: Position | null
}
export type ConformanceResyncProof<Position extends string = string> =
  ConformanceRecoveryTargetCapture<Position> & {
    position: Position
    payloadDigest: string
    verdict: Uint8Array
  }
export type ConformanceCapturedRejoinRecord<Position extends string = string> = Omit<
  ConformanceLegacyRejoinRecord<Position>,
  'source' | 'conflictEpoch'
> & {
  format: 2
  forkRecovery?: ConformanceForkRecoveryAuthorisation
  source: ConformanceRecoverySource
  target: ConformanceRecoveryTargetCapture<Position>
  captureHead: Position | null
  searchFrom: Position | null
  trigger: 'automatic' | 'manual'
  authorisationID: string | null
  switchMutationID: string | null
  destinationKey: ConformanceGroupKey | null
}
export type ConformanceStoredRejoinRecord<Position extends string = string> =
  | ConformanceLegacyRejoinRecord<Position>
  | ConformanceCapturedRejoinRecord<Position>
export type ConformanceRecoveryOrigin<Position extends string = string> = {
  sourceKey: ConformanceGroupKey
  target: ConformanceRecoveryTargetCapture<Position>
  searchFrom: Position | null
}
export type ConformanceAcceptedRejoinSettlement<Position extends string = string> = {
  id: string
  origin: ConformanceRecoveryOrigin<Position>
  ledgerBefore: Array<string>
} & (
  | {
      kind: 'accepted-unadoptable'
      digest: string
      payloadDigest: string
      epochAfter: number
      acceptedEpoch: number
      leafDigest: string
    }
  | { kind: 'not-accepted'; epoch: number }
  | { kind: 'superseded-branch'; epoch: number }
)

export type ConformanceForkRecoveryAuthorisation = {
  attemptID: string
  noticeID: string
  splitEpoch: number
  otherAuthHash: string
  responderKeyHash: string
  source: ConformanceGroupKey
  evidence: Uint8Array
}
export type ConformanceForkRecoveryAttempt = {
  id: string
  source: ConformanceGroupKey
  forkRecovery: ConformanceForkRecoveryAuthorisation
}
