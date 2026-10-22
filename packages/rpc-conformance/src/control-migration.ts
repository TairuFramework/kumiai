import { describe, expect, test, vi } from 'vitest'

export type MigrationFixture = {
  snapshot: Record<string, unknown>
  source: {
    key: { groupID: string; incarnation: number }
    epoch: number
    terminal: boolean
    retired: boolean
    deleted?: true
  }
  mainJournal?: {
    publishID: string
    expectedHead: string | null
    epoch: number
    holdsLogSends?: true
    acceptedAs?: string
    commit: Uint8Array
    bodies: Array<string>
    kind: 'ledger' | 'invite' | 'remove'
    journal: Uint8Array
  } | null
}
export type MigrationResult = Record<string, unknown> & {
  commitOnce: Record<string, unknown> | null
  operations: Array<Record<string, unknown>>
  outcomes: Array<Record<string, unknown>>
  welcomes: Array<Record<string, unknown>>
}

export function legacyMigrationFixture(): MigrationFixture {
  return {
    source: {
      key: { groupID: 'group-A', incarnation: 1 },
      epoch: 4,
      terminal: false,
      retired: false,
    },
    snapshot: {
      commitOnce: null,
      commitOnceAcceptance: null,
      controlHold: null,
      forkHalt: null,
      recoveryUnavailable: null,
      strand: null,
      operations: [],
      rejoin: null,
      recoveryEpochFloor: 2,
      settledRejoins: [],
      forkRecoveryAttempt: null,
      outcomes: [{ id: 'owed', opID: 'closed', at: 12, kind: 'lost' }],
      welcomes: [],
      applied: [],
      responses: [],
      cursor: { position: '004', epoch: 4 },
    },
  }
}

export function legacyMigrationSlot(): Record<string, unknown> {
  return {
    opID: 'op',
    incarnation: 1,
    epoch: 4,
    searchFrom: '004',
    publishID: 'publish',
    expectedHead: '005',
    authenticatorBefore: new Uint8Array([4]),
    payload: new Uint8Array([0, 255, 7]),
    payloadDigest: 'payload',
    digest: 'commit',
    bodies: ['token\u0000one'],
    journal: new Uint8Array([255, 0, 1]),
    welcome: { bytes: new Uint8Array([9]), recipients: ['did:b'] },
  }
}

export function legacyMigrationOperation(stage = 'built'): Record<string, unknown> {
  return {
    id: 'op',
    seq: 3,
    kind: 'invite',
    revokes: true,
    body: new Uint8Array([8]),
    enqueuedAt: 10,
    deadline: 40,
    stage,
    pendingPublish: { expectedHead: '005' },
    ...(stage === 'intent'
      ? {}
      : { built: { incarnation: 1, epoch: 4, publishID: 'publish', payloadDigest: 'payload' } }),
    ...(stage === 'accepted' ? { acceptedAs: '006', acceptance: { position: '006' } } : {}),
  }
}

/** The same literal expectations run against the sealed provider and independent doubles. */
export function testLegacyControlMapping(params: {
  map(input: MigrationFixture): Promise<MigrationResult> | MigrationResult
}) {
  describe('total legacy control mapping', () => {
    test.each(['retired', 'retired-deleted', 'terminal', 'reconciled'])(
      'closes an accepted ahead slot on a %s source before epoch refusal',
      async (mode) => {
        const input = legacyMigrationFixture()
        const slot = legacyMigrationSlot()
        input.source.epoch = 3
        input.source.retired = mode.startsWith('retired')
        input.source.terminal = mode === 'terminal'
        if (mode === 'retired-deleted') input.source.deleted = true
        input.snapshot.commitOnce = slot
        input.snapshot.operations = [
          {
            ...legacyMigrationOperation('accepted'),
            unknownReported: true,
            ...(mode === 'reconciled' ? { reconciliation: { slot } } : {}),
          },
        ]
        input.snapshot.outcomes = [{ id: 'provisional', opID: 'op', at: 20, kind: 'unknown' }]
        input.snapshot.welcomes = [
          { opID: 'op', welcome: new Uint8Array([0, 255]), recipients: ['did:b'] },
        ]
        const result = await params.map(input)
        expect(result.schemaVersion).toBe(1)
        expect(result.commitOnce).toBeNull()
        expect(result.spentSource).toBeNull()
        expect(result.operations).toEqual([])
        expect(result.outcomes).toHaveLength(1)
        expect(result.outcomes[0]).toMatchObject({ opID: 'op', kind: 'unknown' })
        expect(result.outcomes[0]?.id).not.toBe('provisional')
        expect(result.welcomes).toEqual([
          { opID: 'op', welcome: new Uint8Array([0, 255]), recipients: ['did:b'] },
        ])
      },
    )
    test.each(['built', 'accepted'])(
      'refuses a matching %s slot ahead of the source epoch',
      async (stage) => {
        const input = legacyMigrationFixture()
        input.snapshot.operations = [legacyMigrationOperation(stage)]
        input.snapshot.commitOnce = legacyMigrationSlot()
        input.source.epoch = 3
        await expect(Promise.resolve().then(() => params.map(input))).rejects.toThrow(
          'ahead of source',
        )
      },
    )
    test.each(['op', 'owed', 'duplicate'])(
      'refuses a non-fresh final outcome identity (%s)',
      async (id) => {
        const input = legacyMigrationFixture()
        input.source.terminal = true
        input.snapshot.operations = [
          legacyMigrationOperation('intent'),
          {
            ...legacyMigrationOperation('intent'),
            id: 'second',
            seq: 4,
          },
        ]
        const random = vi
          .spyOn(crypto, 'randomUUID')
          .mockReturnValue(id as ReturnType<typeof crypto.randomUUID>)
        try {
          await expect(Promise.resolve().then(() => params.map(input))).rejects.toThrow(
            'fresh outcome identity',
          )
        } finally {
          random.mockRestore()
        }
      },
    )
    test.each([true, false])(
      'closure deletes a surviving provisional outcome with reported flag=%s',
      async (reported) => {
        const input = legacyMigrationFixture()
        input.source.epoch = 5
        input.snapshot.commitOnce = legacyMigrationSlot()
        input.snapshot.operations = [
          { ...legacyMigrationOperation(), ...(reported ? { unknownReported: true } : {}) },
        ]
        input.snapshot.outcomes = [{ id: 'provisional', opID: 'op', kind: 'unknown', at: 25 }]
        const result = await params.map(input)
        expect(result.outcomes).toHaveLength(1)
        expect(result.outcomes[0]).toMatchObject({ opID: 'op', kind: 'unknown' })
        expect(result.outcomes[0]?.id).not.toBe('provisional')
      },
    )
    test.each(['intent', 'built', 'accepted'])(
      '%s without a matching slot stays an unbuilt FIFO request',
      async (stage) => {
        const input = legacyMigrationFixture()
        input.snapshot.operations = [legacyMigrationOperation(stage)]
        const result = await params.map(input)
        expect(result.operations).toEqual([
          {
            id: 'op',
            seq: 3,
            kind: 'invite',
            revokes: true,
            body: new Uint8Array([8]),
            enqueuedAt: 10,
            deadline: 40,
            stage: 'intent',
          },
        ])
        expect(result.commitOnce).toBeNull()
        expect(result.outcomes).toEqual(input.snapshot.outcomes)
      },
    )

    test.each(['built', 'accepted'])(
      '%s extracts one immutable build and preserves exact bytes',
      async (stage) => {
        const input = legacyMigrationFixture()
        input.snapshot.commitOnce = legacyMigrationSlot()
        input.snapshot.operations = [legacyMigrationOperation(stage)]
        const result = await params.map(input)
        expect(result.operations).toEqual([])
        expect(result.commitOnce).toEqual({
          opID: 'op',
          kind: 'invite',
          revokes: true,
          enqueuedAt: 10,
          deadline: 40,
          incarnation: 1,
          epoch: 4,
          head: '004',
          publishID: 'publish',
          expectedHead: '005',
          authenticatorBefore: new Uint8Array([4]),
          payload: new Uint8Array([0, 255, 7]),
          payloadDigest: 'payload',
          digest: 'commit',
          bodies: ['token\u0000one'],
          journal: new Uint8Array([255, 0, 1]),
          welcome: { bytes: new Uint8Array([9]), recipients: ['did:b'] },
          ...(stage === 'accepted' ? { acceptedAs: '006' } : {}),
        })
        expect(result).not.toHaveProperty('commitOnceAcceptance')
        expect(result.schemaVersion).toBe(1)
      },
    )

    test.each([true, false])(
      'unknownReported survives provisional acknowledgement=%s',
      async (acked) => {
        const input = legacyMigrationFixture()
        input.snapshot.commitOnce = legacyMigrationSlot()
        input.snapshot.operations = [
          { ...legacyMigrationOperation(), unknownReported: true, hubAcceptedAt: '007' },
        ]
        if (!acked)
          (input.snapshot.outcomes as Array<unknown>).push({
            id: 'op',
            opID: 'op',
            at: 40,
            kind: 'unknown',
          })
        const result = await params.map(input)
        expect(result.commitOnce).toMatchObject({ reported: true, acceptedAs: '007' })
        expect(result.outcomes).toEqual(input.snapshot.outcomes)
      },
    )

    test.each([
      { name: 'equal head', head: '004', cursor: '004', want: undefined },
      { name: 'explicit null', head: null, cursor: '004', want: true },
      { name: 'null origin', head: null, cursor: null, want: undefined },
      { name: 'missing head', head: undefined, cursor: '004', want: true },
      { name: 'advanced cursor', head: '003', cursor: '004', want: true },
      { name: 'incomplete', head: '004', cursor: '004', incomplete: true, want: true },
      { name: 'uncertainty', head: '004', cursor: '004', uncertainty: true, want: true },
      { name: 'old hold', head: '004', cursor: '004', hold: true, want: true },
    ])(
      'head and conservative skipped: $name',
      async ({ head, cursor, want, incomplete, uncertainty, hold }) => {
        const input = legacyMigrationFixture()
        const slot = legacyMigrationSlot()
        if (head === undefined) delete slot.searchFrom
        else slot.searchFrom = head
        if (uncertainty) slot.uncertainty = { cause: 'gap', at: cursor }
        input.snapshot.commitOnce = slot
        input.snapshot.cursor = {
          position: cursor,
          epoch: 4,
          ...(incomplete ? { incomplete: true } : {}),
        }
        input.snapshot.controlHold = hold
          ? { reason: 'acceptance-unknown', position: cursor }
          : null
        input.snapshot.operations = [legacyMigrationOperation()]
        const result = await params.map(input)
        expect(result.commitOnce?.head).toBe(head === undefined ? cursor : head)
        expect(result.commitOnce?.skipped).toBe(want)
        expect(result.controlHold).toBeNull()
      },
    )

    test.each(['reconciliation', 'advanced', 'terminal', 'retired'])(
      'closes %s before converting accepted rows',
      async (mode) => {
        for (const proof of [false, true]) {
          const input = legacyMigrationFixture()
          const slot = legacyMigrationSlot()
          input.snapshot.commitOnce = mode === 'reconciliation' ? null : slot
          input.snapshot.operations = [
            {
              ...legacyMigrationOperation('accepted'),
              unknownReported: true,
              ...(mode === 'reconciliation'
                ? { reconciliation: { slot, acceptance: { position: '006' } } }
                : {}),
            },
          ]
          input.snapshot.outcomes = [{ id: 'op', opID: 'op', at: 40, kind: 'unknown' }]
          if (mode === 'advanced') input.source.epoch = 5
          if (mode === 'terminal') input.source.terminal = true
          if (mode === 'retired') input.source.retired = true
          if (proof)
            input.snapshot.applied = [
              {
                epoch: 4,
                payloadDigest: 'payload',
                digest: 'commit',
                sequenceID: '008',
                opID: null,
                removed: false,
              },
            ]
          const result = await params.map(input)
          expect(result.commitOnce).toBeNull()
          expect(result.spentSource).toBeNull()
          expect(result.operations).toEqual([])
          expect(result.outcomes).toHaveLength(1)
          expect(result.outcomes[0]).toMatchObject(
            proof
              ? { opID: 'op', kind: 'landed', position: '008' }
              : { opID: 'op', kind: 'unknown' },
          )
          expect(result.outcomes[0]?.id).not.toBe('op')
        }
      },
    )

    test('terminal intents are rejected and retired intents close unknown', async () => {
      for (const terminal of [true, false]) {
        const input = legacyMigrationFixture()
        input.source.terminal = terminal
        input.source.retired = !terminal
        input.snapshot.operations = [legacyMigrationOperation('intent')]
        const result = await params.map(input)
        expect(result.operations).toEqual([])
        expect(result.outcomes[1]).toMatchObject(
          terminal ? { kind: 'rejected', reason: 'removed' } : { kind: 'unknown' },
        )
      }
    })

    test('a retired state tombstone does not turn an intent into a self-removal rejection', async () => {
      const input = legacyMigrationFixture()
      input.source.retired = true
      input.source.deleted = true
      input.snapshot.operations = [legacyMigrationOperation('intent')]
      const result = await params.map(input)
      expect(result.operations).toEqual([])
      expect(result.outcomes[1]).toMatchObject({ opID: 'op', kind: 'unknown' })
    })

    test.each(['advanced', 'terminal', 'retired'])(
      'slotless built row with applied proof closes landed on %s source',
      async (mode) => {
        const input = legacyMigrationFixture()
        input.source.epoch = mode === 'advanced' ? 5 : 4
        input.source.terminal = mode === 'terminal'
        input.source.retired = mode === 'retired'
        input.snapshot.operations = [
          { ...legacyMigrationOperation('accepted'), unknownReported: true },
        ]
        input.snapshot.applied = [
          {
            epoch: 4,
            payloadDigest: 'payload',
            digest: 'commit',
            sequenceID: '009',
            opID: null,
            removed: false,
          },
        ]
        const result = await params.map(input)
        expect(result.operations).toEqual([])
        expect(result.outcomes[1]).toMatchObject({ opID: 'op', kind: 'landed', position: '009' })
      },
    )

    test.each([true, false])(
      'closure always writes a fresh final ID after provisional acknowledgement=%s',
      async (acked) => {
        const input = legacyMigrationFixture()
        input.source.epoch = 5
        input.snapshot.commitOnce = legacyMigrationSlot()
        input.snapshot.operations = [{ ...legacyMigrationOperation(), unknownReported: true }]
        if (!acked)
          (input.snapshot.outcomes as Array<unknown>).push({
            id: 'op',
            opID: 'op',
            at: 40,
            kind: 'unknown',
          })
        const result = await params.map(input)
        expect(result.outcomes).toHaveLength(2)
        expect(result.outcomes[1]).toMatchObject({ opID: 'op', kind: 'unknown' })
        expect(result.outcomes[1]?.id).not.toBe('op')
      },
    )

    test.each(['current', 'advanced', 'retired', 'terminal'])(
      'ownerless %s slot never creates executable work or a report',
      async (mode) => {
        const input = legacyMigrationFixture()
        input.snapshot.commitOnce = legacyMigrationSlot()
        input.source.epoch = mode === 'advanced' ? 5 : 4
        input.source.retired = mode === 'retired'
        input.source.terminal = mode === 'terminal'
        const result = await params.map(input)
        expect(result.commitOnce).toBeNull()
        expect(result.spentSource).toEqual(mode === 'current' ? { epoch: 4 } : null)
        expect(result.outcomes).toEqual(input.snapshot.outcomes)
      },
    )

    test.each([undefined, true, false])(
      'promotes every Welcome before deleting speculative work (committed=%s)',
      async (committed) => {
        const input = legacyMigrationFixture()
        input.source.retired = true
        input.snapshot.commitOnce = legacyMigrationSlot()
        input.snapshot.operations = [legacyMigrationOperation('accepted')]
        input.snapshot.welcomes = [
          {
            opID: 'op',
            welcome: new Uint8Array([0, 255]),
            recipients: ['did:a', 'did:b'],
            ...(committed === undefined ? {} : { committed }),
          },
        ]
        const result = await params.map(input)
        expect(result.welcomes).toEqual([
          { opID: 'op', welcome: new Uint8Array([0, 255]), recipients: ['did:a', 'did:b'] },
        ])
        expect(result.commitOnce).toBeNull()
      },
    )

    test('preserves recovery, safety, existing outcomes and acknowledgement state', async () => {
      const input = legacyMigrationFixture()
      Object.assign(input.snapshot, {
        controlHold: { reason: 'unsupported-version', position: '003' },
        strand: { reason: 'ahead' },
        forkHalt: { evidence: 'retained' },
        recoveryUnavailable: { id: 'retained' },
        rejoin: { source: { searchFrom: null } },
        forkRecoveryAttempt: { id: 'fork' },
        settledRejoins: [{ id: 'settled' }],
      })
      const result = await params.map(input)
      for (const field of [
        'controlHold',
        'strand',
        'forkHalt',
        'recoveryUnavailable',
        'rejoin',
        'forkRecoveryAttempt',
        'settledRejoins',
        'recoveryEpochFloor',
        'outcomes',
        'cursor',
      ])
        expect(result[field]).toEqual(input.snapshot[field])
    })

    for (const kind of ['ledger', 'invite', 'remove'] as const) {
      for (const accepted of [true, false]) {
        for (const held of [true, false]) {
          test(`main journal ${kind}, accepted=${accepted}, hold=${held} yields opaque host report`, async () => {
            const input = legacyMigrationFixture()
            input.mainJournal = {
              publishID: 'main',
              expectedHead: null,
              epoch: 4,
              commit: new Uint8Array([77]),
              bodies: ['\u0000opaque.令牌.\ud83d\ude00'],
              kind,
              journal: new Uint8Array([0, 255, 128, 42]),
              ...(accepted ? { acceptedAs: '006' } : {}),
              ...(held ? { holdsLogSends: true as const } : {}),
            }
            const result = await params.map(input)
            expect(result.commitOnce).toBeNull()
            expect(result.outcomes[1]).toMatchObject({
              kind: 'unknown',
              opID: null,
              lostCommit: {
                kind,
                journal: new Uint8Array([0, 255, 128, 42]),
                ...(kind === 'ledger' ? { tokens: ['\u0000opaque.令牌.\ud83d\ude00'] } : {}),
              },
            })
            expect(result.outcomes[1]?.id).not.toBe('main')
          })
        }
      }
    }

    test('a marked second open is a byte-identical no-op with no fresh report identity', async () => {
      const input = legacyMigrationFixture()
      input.snapshot.commitOnce = legacyMigrationSlot()
      input.snapshot.operations = [legacyMigrationOperation()]
      const once = await params.map(input)
      const twice = await params.map({ ...input, snapshot: once })
      expect(twice).toEqual(once)
    })

    test.each(['current', 'advanced', 'terminal', 'retired'])(
      'unmarked R2/R3 build on %s source obeys the same closure rules',
      async (mode) => {
        const input = legacyMigrationFixture()
        input.snapshot.commitOnce = legacyMigrationSlot()
        input.snapshot.operations = [legacyMigrationOperation()]
        const modern = await params.map(input)
        delete modern.schemaVersion
        input.snapshot = modern
        input.source.epoch = mode === 'advanced' ? 5 : 4
        input.source.terminal = mode === 'terminal'
        input.source.retired = mode === 'retired'
        if (mode !== 'current')
          input.snapshot.applied = [
            {
              epoch: 4,
              payloadDigest: 'payload',
              digest: 'commit',
              sequenceID: '010',
              opID: null,
              removed: false,
            },
          ]
        const result = await params.map(input)
        if (mode === 'current') expect(result.commitOnce).toEqual(modern.commitOnce)
        else {
          expect(result.commitOnce).toBeNull()
          expect(result.outcomes[1]).toMatchObject({ opID: 'op', kind: 'landed', position: '010' })
          expect(result.welcomes).toEqual([])
        }
      },
    )
  })
}
