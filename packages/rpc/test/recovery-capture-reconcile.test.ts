import { expect, test, vi } from 'vitest'

import { createMemoryControlStore } from '../../rpc-conformance/src/memory-control-store.js'
import { stepRejoin } from '../src/control/rejoin.js'
import type { AdoptionWriteFactory, Outcome } from '../src/control/types.js'
import { asLogPosition, type LogPosition } from '../src/cursor.js'
import type { ConfirmationOutcome } from '../src/recovery-confirmation.js'
import { settleRecovery } from '../src/recovery-reconcile.js'
import type {
  CapturedRejoinRecord,
  ConfirmedRecoveryHandoff,
  RecoveryReconciliation,
} from '../src/recovery-types.js'
import { createCapturedMemoryRecovery } from './fixtures/memory-captured-recovery.js'

async function setup() {
  const fixture = await createCapturedMemoryRecovery()
  const port = fixture.requester.capturedRecovery
  if (port === undefined) throw new Error('Missing captured port')
  const requestID = 'saved-X'
  const { request, requestKey } = await fixture.requester.createRecoveryRequest(requestID)
  const pending = await port.applyRecovery(
    await fixture.responder.sealGroupInfo(request, null),
    requestID,
    requestKey,
  )
  if (pending === null || 'renewalRequired' in pending) throw new Error('Missing candidate')
  const record = fixture.record(pending, request, requestKey, requestID)
  record.ledgerBefore = ['owed-X', 'shared']
  const control = createMemoryControlStore<LogPosition>(record.source.key)
  await control.apply(
    { putRejoin: record, recoveryEpochFloor: record.target.groupInfoEpoch },
    'save-X',
  )
  let reconciliation: RecoveryReconciliation = { kind: 'retry' }
  let verdict: ConfirmationOutcome = { kind: 'unconfirmed', advisory: [] }
  let builds = 0
  let adopted = 0
  let id = 0
  const events: Array<Outcome> = []
  const publications: Array<{ payload: Uint8Array; id: string; head: string | null }> = []
  const deps = {
    control,
    newID: () => `transition-${++id}`,
    now: () => 1234,
    runSerial: async <T>(fn: () => Promise<T>) => fn(),
    publish: async (payload: Uint8Array, publishID: string, head: string | null) => {
      publications.push({ payload: payload.slice(), id: publishID, head })
      throw Object.assign(new Error('CAS lost'), { name: 'HeadMismatchError' })
    },
    searchLog: async () => 'gap' as const,
    confirm: async () => verdict,
    reconcileCapture: async () => {
      builds++
      return reconciliation
    },
    adopt: async (
      _record: CapturedRejoinRecord,
      _write: AdoptionWriteFactory,
    ): Promise<'adopted' | 'handoff'> => {
      adopted++
      return 'handoff'
    },
    bootstrapLedger: async () => true,
    getLedger: async () => [],
    emit: (outcome: Outcome) => {
      events.push(outcome)
    },
    discarded: () => {},
  }
  return {
    record,
    control,
    deps,
    publications,
    events,
    builds: () => builds,
    adopted: () => adopted,
    reconcile: (next: RecoveryReconciliation) => {
      reconciliation = next
    },
    verdict: (next: ConfirmationOutcome) => {
      verdict = next
    },
  }
}

test('a gap after CAS loss retains X and retries identical bytes at an authenticated regressing head', async () => {
  const s = await setup()
  s.record.expectedHead = asLogPosition('inflated-head')
  await s.control.apply({ putRejoin: s.record }, 'inflated')
  s.reconcile({ kind: 'head-only', head: null })
  const next = await stepRejoin(s.deps, s.record)
  expect(next).toEqual({ ...s.record, expectedHead: null })
  expect((await s.control.load()).rejoin).toEqual(next)
  expect(s.builds()).toBe(1)
  expect(s.publications).toEqual([
    { payload: s.record.payload, id: s.record.publishID, head: 'inflated-head' },
  ])
  expect(s.adopted()).toBe(0)
})

test.each(['retry', 'held'] as const)(
  '%s recapture preserves all saved X bytes and its floor',
  async (kind) => {
    const s = await setup()
    s.reconcile({ kind })
    await stepRejoin(s.deps, s.record)
    expect((await s.control.load()).rejoin).toEqual(s.record)
    expect((await s.control.load()).recoveryEpochFloor).toBe(s.record.target.groupInfoEpoch)
  },
)

test('propagated recapture errors preserve X without negative settlement', async () => {
  const s = await setup()
  await stepRejoin(
    {
      ...s.deps,
      reconcileCapture: async () => {
        throw new Error('provider or origin drift')
      },
    },
    s.record,
  ).catch(() => {})
  expect((await s.control.load()).rejoin).toEqual(s.record)
  expect((await s.control.load()).settledRejoins).toEqual([])
})

test.each([
  { kind: 'unapplied-later', epoch: 7, leafDigest: 'saved-X-leaf' },
  { kind: 'accepted', epoch: 8, leafDigest: 'exact-wire-leaf' },
  { kind: 'head-only', head: asLogPosition('fresh-head') },
] satisfies Array<RecoveryReconciliation>)(
  'a hold installed during $kind recapture preserves X and its floor',
  async (result) => {
    const s = await setup()
    const before = await s.control.load()
    const settle = vi.fn()
    expect(
      await stepRejoin(
        {
          ...s.deps,
          settleAcceptedRecovery: settle,
          reconcileCapture: async () => {
            await s.control.apply(
              { controlHold: { reason: 'unsupported-version', position: asLogPosition('hold') } },
              'hold-during-recapture',
            )
            return result
          },
        },
        s.record,
      ),
    ).toEqual(s.record)
    const after = await s.control.load()
    expect(after.rejoin).toEqual(before.rejoin)
    expect(after.recoveryEpochFloor).toBe(before.recoveryEpochFloor)
    expect(after.settledRejoins).toEqual(before.settledRejoins)
    expect(settle).not.toHaveBeenCalled()
  },
)

test('direct recovery settlement refuses an unsupported-version hold', async () => {
  const s = await setup()
  await s.control.apply(
    { controlHold: { reason: 'unsupported-version', position: null } },
    'held-settlement',
  )
  const before = await s.control.load()
  await expect(
    settleRecovery({
      control: s.control,
      record: s.record,
      provenance: { kind: 'not-accepted', epoch: 7 },
      mutationID: 'forbidden-settlement',
    }),
  ).rejects.toThrow('Recovery settlement is held')
  expect(await s.control.load()).toEqual(before)
})

test('authenticated leaf absence atomically retains obligations, clears X and raises the floor', async () => {
  const s = await setup()
  s.reconcile({ kind: 'unapplied-later', epoch: 7, leafDigest: 'saved-X-leaf' })
  expect(await stepRejoin(s.deps, s.record)).toBeNull()
  const restarted = await s.control.load()
  expect(restarted.rejoin).toBeNull()
  expect(restarted.recoveryEpochFloor).toBe(7)
  expect(restarted.settledRejoins).toEqual([
    {
      kind: 'not-accepted',
      epoch: 7,
      id: s.record.id,
      origin: { sourceKey: s.record.source.key, target: s.record.target, searchFrom: null },
      ledgerBefore: ['owed-X', 'shared'],
    },
  ])
  expect(s.events).toEqual([])
})

test('later exact-leaf acceptance settles compact public facts without a position lookup', async () => {
  const s = await setup()
  s.reconcile({ kind: 'accepted', epoch: 8, leafDigest: 'exact-wire-leaf' })
  expect(await stepRejoin(s.deps, s.record)).toBeNull()
  const restarted = await s.control.load()
  expect(restarted.rejoin).toBeNull()
  expect(restarted.recoveryEpochFloor).toBe(8)
  expect(restarted.settledRejoins).toEqual([
    {
      kind: 'accepted-unadoptable',
      id: s.record.id,
      digest: s.record.digest,
      payloadDigest: s.record.payloadDigest,
      epochAfter: s.record.epochAfter,
      acceptedEpoch: 8,
      leafDigest: 'exact-wire-leaf',
      origin: { sourceKey: s.record.source.key, target: s.record.target, searchFrom: null },
      ledgerBefore: ['owed-X', 'shared'],
    },
  ])
  expect(s.record.requestKey.every((byte) => byte === 0)).toBe(true)
  expect(s.record.candidate.every((byte) => byte === 0)).toBe(true)
  expect(s.adopted()).toBe(0)
})

test('known-position bound confirmation co-writes the switch ID then hands off', async () => {
  const s = await setup()
  const record: CapturedRejoinRecord = {
    ...s.record,
    stage: 'published',
    position: asLogPosition('known'),
  }
  await s.control.apply({ putRejoin: record }, 'published')
  s.verdict({
    kind: 'confirmed',
    epoch: record.epochAfter,
    position: 'known',
    sealed: new Uint8Array([9]),
  })
  const confirmed = await stepRejoin(s.deps, record)
  expect(confirmed).toMatchObject({
    stage: 'confirmed',
    switchMutationID: expect.any(String),
    verdict: new Uint8Array([9]),
  })
  if (confirmed === null || 'kind' in confirmed) throw new Error('Missing confirmation')
  expect(await stepRejoin(s.deps, confirmed)).toEqual({ kind: 'handoff', record: confirmed })
  expect(s.adopted()).toBe(1)
  expect(s.builds()).toBe(0)
})

test.each([
  { stage: 'confirmed', sink: false },
  { stage: 'confirmed', sink: true },
  { stage: 'adopted', sink: false },
  { stage: 'adopted', sink: true },
] as const)(
  '$stage X settles accepted provenance after a later leaf absence (sink: $sink)',
  async ({ stage, sink }) => {
    const s = await setup()
    const record: CapturedRejoinRecord = {
      ...s.record,
      stage,
      position: asLogPosition('known'),
      verdict: new Uint8Array([9]),
      switchMutationID: 'saved-switch',
      destinationKey: stage === 'adopted' ? { ...s.record.source.key, incarnation: 2 } : null,
    }
    await s.control.apply(
      {
        putRejoin: record,
        putSettledRejoins: [
          {
            kind: 'not-accepted',
            id: 'prior-X',
            epoch: 0,
            origin: { sourceKey: record.source.key, target: record.target, searchFrom: null },
            ledgerBefore: ['prior-owed', 'shared'],
          },
        ],
      },
      'confirmed',
    )
    s.reconcile({ kind: 'unapplied-later', epoch: 9, leafDigest: 'saved-X-leaf' })
    const transitions: Array<unknown> = []
    const apply = s.control.apply.bind(s.control)
    s.control.apply = async (changes, id) => {
      transitions.push(changes)
      await apply(changes, id)
    }
    expect(
      await stepRejoin(
        {
          ...s.deps,
          reconcileConfirmedRecovery: record.id,
          ...(sink
            ? {
                settleAcceptedRecovery: async (
                  saved: CapturedRejoinRecord,
                  epoch: number,
                  leafDigest: string,
                  recoveryEpochFloor?: number,
                ) => {
                  expect(epoch).toBe(record.epochAfter)
                  expect(leafDigest).toBe('saved-X-leaf')
                  expect(recoveryEpochFloor).toBe(9)
                  await settleRecovery({
                    control: s.control,
                    record: saved,
                    provenance: { kind: 'accepted-unadoptable', epoch, leafDigest },
                    recoveryEpochFloor,
                    mutationID: 'accepted-sink',
                  })
                },
              }
            : {}),
        },
        record,
      ),
    ).toBeNull()
    expect(s.builds()).toBe(1)
    expect(s.adopted()).toBe(0)
    const snapshot = await s.control.load()
    expect(snapshot.rejoin).toBeNull()
    expect(snapshot.recoveryEpochFloor).toBe(9)
    expect(snapshot.settledRejoins).toEqual([
      {
        kind: 'accepted-unadoptable',
        id: record.id,
        digest: record.digest,
        payloadDigest: record.payloadDigest,
        epochAfter: record.epochAfter,
        acceptedEpoch: record.epochAfter,
        leafDigest: 'saved-X-leaf',
        origin: { sourceKey: record.source.key, target: record.target, searchFrom: null },
        ledgerBefore: ['prior-owed', 'shared', 'owed-X'],
      },
    ])
    expect(transitions).toHaveLength(1)
  },
)

test.each(['later-present', 'confirmed-absent'] as const)(
  'delayed %s acceptance settles X then builds and bootstraps Y with every owed token',
  async (classification) => {
    const { FakeHub } = await import('./fixtures/fake-hub.js')
    const { makeMLSPeer, buildLedgerCommit } = await import('./fixtures/peer.js')
    const secret = new Uint8Array(32).fill(91)
    const hub = new FakeHub()
    const options = {
      members: ['alice', 'bob'],
      recovery: { timeoutMs: 100, deadlineMs: 1500, getDelayMs: () => 0 },
    }
    const alice = makeMLSPeer(hub, 'alice', secret, options)
    const bob = makeMLSPeer(hub, 'bob', secret, options)
    let restarted: typeof bob | undefined
    try {
      await alice.peer.replay()
      await bob.peer.replay()
      const apply = bob.control.apply.bind(bob.control)
      bob.control.apply = async (changes, id) => {
        await apply(changes, id)
        if (
          changes.putRejoin?.stage ===
          (classification === 'confirmed-absent' ? 'confirmed' : 'published')
        )
          void bob.peer.dispose()
      }
      await expect(bob.peer.recover()).rejects.toThrow()
      await bob.peer.dispose()
      await bob.peer.drained()
      const x = (await bob.control.load()).rejoin
      if (x === null || !('format' in x)) throw new Error('Missing captured X')
      bob.control.apply = apply
      await bob.control.apply(
        { putRejoin: { ...x, ledgerBefore: ['owed-only-X'] } },
        'retain-X-obligation',
      )
      await expect.poll(() => alice.mls.epoch()).toBe(x.epochAfter)
      if (classification === 'confirmed-absent') {
        const { publishCommit } = await import('./fixtures/commits.js')
        const captured = bob.mls.capturedRecovery
        if (captured === undefined) throw new Error('Missing captured recovery')
        const otherRequest = await bob.mls.createRecoveryRequest('other-bob')
        const other = await captured.applyRecovery(
          await alice.mls.sealGroupInfo(otherRequest.request, alice.controlWalk.head()),
          'other-bob',
          otherRequest.requestKey,
        )
        if (other === null || 'renewalRequired' in other)
          throw new Error('Missing replacement candidate')
        await publishCommit({
          hub,
          senderDID: 'bob',
          recoverySecret: secret,
          epoch: alice.mls.epoch(),
          commit: other.commit,
        })
        await expect.poll(() => alice.mls.epoch()).toBe(x.epochAfter + 1)
      }
      await alice.peer.commit(buildLedgerCommit(alice, ['present-in-destination']))
      const recapturedEpoch = alice.mls.epoch()
      expect(recapturedEpoch).toBe(x.epochAfter + (classification === 'confirmed-absent' ? 2 : 1))
      if (x.position === undefined) throw new Error('Missing X occurrence')
      const { commitTopic } = await import('../src/topic.js')
      hub.trim(commitTopic(secret), x.position)
      restarted = makeMLSPeer(hub, 'bob', secret, {
        ...options,
        restartOf: bob,
        ...(classification === 'confirmed-absent' ? { reconcileConfirmedRecovery: x.id } : {}),
      })
      const settledPeer = restarted
      const applySettlement = settledPeer.control.apply.bind(settledPeer.control)
      settledPeer.control.apply = async (changes, id) => {
        await applySettlement(changes, id)
        if (changes.putSettledRejoins?.some((row) => row.id === x.id))
          void settledPeer.peer.dispose()
      }
      await expect
        .poll(async () => (await settledPeer.control.load()).settledRejoins.length, {
          timeout: 7000,
        })
        .toBe(1)
      await settledPeer.peer.dispose()
      await settledPeer.peer.drained()
      const retained = await settledPeer.control.load()
      expect(retained.rejoin).toBeNull()
      expect(retained.recoveryEpochFloor).toBe(recapturedEpoch)
      expect(Object.keys(retained.settledRejoins[0] ?? {}).sort()).toEqual([
        'acceptedEpoch',
        'digest',
        'epochAfter',
        'id',
        'kind',
        'leafDigest',
        'ledgerBefore',
        'origin',
        'payloadDigest',
      ])
      let firstY: CapturedRejoinRecord | undefined
      restarted = makeMLSPeer(hub, 'bob', secret, { ...options, restartOf: settledPeer })
      let incompleteFolds = 0
      const roster = restarted.mls.rosterEntries.bind(restarted.mls)
      const destination = restarted
      destination.mls.rosterEntries = async () => {
        if (!(await destination.mls.isLedgerComplete())) incompleteFolds++
        return await roster()
      }
      const applyY = restarted.control.apply.bind(restarted.control)
      restarted.control.apply = async (changes, id) => {
        if (
          changes.putRejoin !== undefined &&
          'format' in changes.putRejoin &&
          changes.putRejoin.stage === 'built' &&
          firstY === undefined
        ) {
          firstY = changes.putRejoin
          expect(changes.recoveryEpochFloor).toBe(recapturedEpoch)
          expect(firstY.ledgerBefore).toContain('owed-only-X')
        }
        await applyY(changes, id)
      }
      await expect.poll(() => restarted?.mls.epoch(), { timeout: 7000 }).toBe(recapturedEpoch + 1)
      await expect
        .poll(async () => (await restarted?.control.load())?.rejoin, { timeout: 7000 })
        .toBeNull()
      expect(firstY?.id).not.toBe(x.id)
      expect(firstY?.target.groupInfoEpoch).toBe(recapturedEpoch)
      const snapshot = await restarted.control.load()
      expect(snapshot.settledRejoins).toEqual([
        expect.objectContaining({
          kind: 'accepted-unadoptable',
          id: x.id,
          acceptedEpoch: classification === 'confirmed-absent' ? x.epochAfter : recapturedEpoch,
          ledgerBefore: ['owed-only-X'],
        }),
      ])
      expect(snapshot.recoveryEpochFloor).toBe(recapturedEpoch)
      expect(snapshot.outcomes).toContainEqual(
        expect.objectContaining({ kind: 'reenact', tokens: ['owed-only-X'] }),
      )
      expect(incompleteFolds).toBe(0)
      expect(await restarted.mls.isLedgerComplete()).toBe(true)
      expect(await restarted.mls.getLedger()).toEqual(['present-in-destination'])
      expect(restarted.mls.memberSlots().filter(([, did]) => did === 'bob')).toHaveLength(1)
      expect(alice.mls.epoch()).toBe(restarted.mls.epoch())
    } finally {
      await Promise.all([alice.peer.dispose(), bob.peer.dispose(), restarted?.peer.dispose()])
      await Promise.all([alice.peer.drained(), bob.peer.drained(), restarted?.peer.drained()])
    }
  },
)

test('defensive confirmed startup assigns its saved switch ID before handing off', async () => {
  const s = await setup()
  const record: CapturedRejoinRecord = {
    ...s.record,
    stage: 'confirmed',
    position: asLogPosition('known'),
    verdict: new Uint8Array([9]),
  }
  await s.control.apply({ putRejoin: record }, 'confirmed-without-ID')
  let handedID: string | null = null
  const result = await stepRejoin(
    {
      ...s.deps,
      adopt: async (confirmed) => {
        handedID = confirmed.switchMutationID
        expect((await s.control.load()).rejoin).toEqual(confirmed)
        return 'handoff'
      },
    },
    record,
  )
  expect(handedID).toEqual(expect.any(String))
  expect(result).toMatchObject({ kind: 'handoff', record: { switchMutationID: handedID } })
})

test('a newly confirmed peer invokes its coordinator after source recovery completes', async () => {
  const { FakeHub } = await import('./fixtures/fake-hub.js')
  const { makeMLSPeer } = await import('./fixtures/peer.js')
  const secret = new Uint8Array(32).fill(92)
  const hub = new FakeHub()
  const options = {
    members: ['alice', 'bob'],
    recovery: { timeoutMs: 100, deadlineMs: 1000, getDelayMs: () => 0 },
  }
  const handoffs: Array<ConfirmedRecoveryHandoff> = []
  const alice = makeMLSPeer(hub, 'alice', secret, options)
  const bob = makeMLSPeer(hub, 'bob', secret, {
    ...options,
    onConfirmedRecovery: (value) => {
      handoffs.push(value)
    },
  })
  try {
    await alice.peer.replay()
    await bob.peer.replay()
    expect(await bob.peer.recover()).toEqual({ advanced: false, reenact: [] })
    expect(handoffs).toHaveLength(1)
    const handoff = handoffs[0]
    if (handoff === undefined) throw new Error('Missing coordinator handoff')
    await handoff.completion
    expect(handoff.record).toMatchObject({
      stage: 'confirmed',
      switchMutationID: expect.any(String),
    })
    expect((await bob.control.load()).rejoin).toEqual(handoff.record)
    expect(bob.mls.epoch()).toBe(1)
    expect(alice.mls.epoch()).toBe(handoff.record.epochAfter)
  } finally {
    await Promise.all([alice.peer.dispose(), bob.peer.dispose()])
    await Promise.all([alice.peer.drained(), bob.peer.drained()])
  }
})

test('captured coordinator construction requires an accepted settlement sink', async () => {
  const { FakeHub } = await import('./fixtures/fake-hub.js')
  const { makeMLSPeer } = await import('./fixtures/peer.js')
  let invalid: ReturnType<typeof makeMLSPeer> | undefined
  try {
    expect(() => {
      invalid = makeMLSPeer(new FakeHub(), 'bob', new Uint8Array(32).fill(95), {
        onConfirmedRecovery: () => {},
        settleAcceptedRecovery: undefined,
      })
    }).toThrow(TypeError)
  } finally {
    await invalid?.peer.dispose()
    await invalid?.peer.drained()
  }
})

test('a saved X with a lost acknowledgement recaptures before attempting another publication', async () => {
  const s = await setup()
  s.reconcile({ kind: 'accepted', epoch: 8, leafDigest: 'exact-wire-leaf' })
  expect(await stepRejoin({ ...s.deps, reconcileBeforePublish: true }, s.record)).toBeNull()
  expect(s.publications).toEqual([])
  expect((await s.control.load()).settledRejoins).toMatchObject([
    { id: s.record.id, acceptedEpoch: 8 },
  ])
})

test.each([
  { captured: false, delays: [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000] },
  { captured: true, delays: [1000, 2000, 4000, 8000, 15000, 15000, 15000, 15000] },
])(
  'recovery retries retain the appropriate bound (captured: $captured)',
  async ({ captured, delays }) => {
    const { FakeHub } = await import('./fixtures/fake-hub.js')
    const { makeMLSPeer } = await import('./fixtures/peer.js')
    const { createMemoryGroupMLS } = await import('./fixtures/memory-group-mls.js')
    const secret = new Uint8Array(32).fill(94)
    const mls = createMemoryGroupMLS({ localDID: 'bob', recoverySecret: secret })
    if (!captured) mls.capturedRecovery = undefined
    const bob = makeMLSPeer(new FakeHub(), 'bob', secret, {
      mls,
      recovery: { timeoutMs: 10, deadlineMs: 30, getDelayMs: () => 0 },
    })
    try {
      await bob.peer.replay()
      vi.useFakeTimers()
      let requests = 0
      mls.createRecoveryRequest = async () => {
        requests++
        throw new Error('request transport unavailable')
      }
      await expect(bob.peer.recover()).rejects.toThrow('request transport unavailable')
      expect(requests).toBe(1)
      for (const [index, delay] of delays.entries()) {
        await vi.advanceTimersByTimeAsync(delay - 1)
        expect(requests).toBe(index + 1)
        await vi.advanceTimersByTimeAsync(1)
        expect(requests).toBe(index + 2)
      }
    } finally {
      await bob.peer.dispose()
      await bob.peer.drained()
      vi.useRealTimers()
    }
  },
)

test.each([false, true])(
  'a fresh recovery-only attempt retries non-delivery without private state (renewal required: %s)',
  async (renewalRequired) => {
    const { FakeHub } = await import('./fixtures/fake-hub.js')
    const { makeMLSPeer } = await import('./fixtures/peer.js')
    const { createMemoryGroupMLS } = await import('./fixtures/memory-group-mls.js')
    const { createFakeCrypto } = await import('./fixtures/fake-crypto.js')
    const { decodeHandshakeFrame, HANDSHAKE_KIND } = await import('../src/handshake.js')
    const secret = new Uint8Array(32).fill(93)
    const hub = new FakeHub()
    const options = {
      members: ['alice', 'bob'],
      epoch: 2,
      recovery: { timeoutMs: 100, deadlineMs: 1000, getDelayMs: () => 0 },
    }
    const alice = makeMLSPeer(hub, 'alice', secret, options)
    const publish = hub.publish.bind(hub)
    let dropped = false
    vi.spyOn(hub, 'publish').mockImplementation((value) => {
      if (!dropped && decodeHandshakeFrame(value.payload).kind === HANDSHAKE_KIND.recoveryRequest) {
        dropped = true
        return publish({ ...value, payload: new Uint8Array([0]) })
      }
      return publish(value)
    })
    const mls = createMemoryGroupMLS({
      storageID: 'bob',
      localDID: 'bob',
      members: options.members,
      epoch: 2,
      recoverySecret: secret,
      ledgerEntries: ['owed-only-in-source'],
    })
    let privateReads = 0
    mls.getLedger = async () => {
      privateReads++
      throw new Error('Private ledger is unavailable')
    }
    if (renewalRequired) {
      if (mls.capturedRecovery === undefined) throw new Error('Missing captured recovery port')
      vi.spyOn(mls.capturedRecovery, 'applyRecovery').mockResolvedValue({ renewalRequired: true })
    }
    const failures: Array<unknown> = []
    const handoffs: Array<ConfirmedRecoveryHandoff> = []
    const providerCrypto = createFakeCrypto({ epoch: 2, localDID: 'bob' })
    const privateEpoch = vi.spyOn(providerCrypto, 'epoch').mockImplementation(() => {
      throw new Error('Private crypto state is unavailable')
    })
    const bob = makeMLSPeer(hub, 'bob', secret, {
      ...options,
      mls,
      crypto: providerCrypto,
      recoveryOnly: true,
      onRecovery: (event) => {
        if (event.phase === 'failed') failures.push(event)
      },
      onConfirmedRecovery: (value) => {
        handoffs.push(value)
      },
    })
    try {
      await alice.peer.replay()
      await bob.peer.replay()
      if (renewalRequired) {
        await expect
          .poll(() => failures, { timeout: 3000 })
          .toContainEqual(expect.objectContaining({ reason: 'renewal-required' }))
        expect(handoffs).toEqual([])
        expect(privateEpoch).not.toHaveBeenCalled()
        expect(privateReads).toBe(0)
        return
      }
      await expect.poll(() => handoffs.length, { timeout: 3000 }).toBe(1)
      expect(dropped).toBe(true)
      expect(failures).toContainEqual(expect.objectContaining({ reason: 'no-responder' }))
      const record = (await bob.control.load()).rejoin
      expect(record).toMatchObject({ stage: 'confirmed', ledgerBefore: ['owed-only-in-source'] })
      expect(privateReads).toBe(0)
      expect(privateEpoch).not.toHaveBeenCalled()
      expect(bob.mls.epoch()).toBe(2)
      expect(alice.mls.epoch()).toBe(3)
    } finally {
      await Promise.all([alice.peer.dispose(), bob.peer.dispose()])
      await Promise.all([alice.peer.drained(), bob.peer.drained()])
    }
  },
)

test.each(['floor', 'legacy', 'legacy-refused'] as const)(
  'every floor and legacy retry exposes reason: %s',
  async (row) => {
    const { FakeHub } = await import('./fixtures/fake-hub.js')
    const { makeMLSPeer } = await import('./fixtures/peer.js')
    const hub = new FakeHub()
    const secret = new Uint8Array(32).fill(106)
    const events: Array<unknown> = []
    const options = {
      members: ['alice', 'bob'],
      recovery: { timeoutMs: 50, deadlineMs: 200, getDelayMs: () => 0 },
    }
    const alice = makeMLSPeer(hub, 'alice', secret, options)
    const bob = makeMLSPeer(hub, 'bob', secret, {
      ...options,
      onRecovery: (event) => {
        events.push(event)
      },
    })
    try {
      await alice.peer.replay()
      await bob.peer.replay()
      if (row === 'floor') {
        await bob.control.apply({ recoveryEpochFloor: 5 }, 'higher-floor')
      } else {
        const s = await setup()
        const { format: _format, ...record } = s.record
        await bob.control.apply(
          {
            putRejoin: {
              ...record,
              ...(row === 'legacy-refused'
                ? { stage: 'refused' as const, refusal: 'policy' as const }
                : {}),
              source: {
                key: record.source.key,
                epoch: bob.mls.epoch(),
                authenticator: new Uint8Array(32).fill(1),
                head: null,
              },
              conflictEpoch: null,
            },
          },
          'legacy-X',
        )
      }
      const before = await bob.control.load()
      vi.useFakeTimers()
      for (let round = 0; round < 9; round++) {
        if (round === 0) {
          const recovering = bob.peer.recover()
          await vi.advanceTimersByTimeAsync(50)
          await recovering
        } else await vi.advanceTimersByTimeAsync(Math.min(1000 * 2 ** (round - 1), 15000))
        expect(events).toContainEqual(
          expect.objectContaining({
            phase: 'failed',
            reason: row === 'floor' ? 'below-epoch-floor' : 'legacy-recovery-record',
          }),
        )
        expect((await bob.control.load()).rejoin).toEqual(before.rejoin)
        expect((await bob.control.load()).recoveryEpochFloor).toEqual(before.recoveryEpochFloor)
        expect((await bob.control.load()).forkHalt).toBeNull()
        events.length = 0
      }
    } finally {
      await Promise.all([alice.peer.dispose(), bob.peer.dispose()])
      await Promise.all([alice.peer.drained(), bob.peer.drained()])
      vi.useRealTimers()
    }
  },
)

test.each(['lower', 'equal-different', 'no-reply', 'ineligible-reply'] as const)(
  'same epoch disagreement diagnoses without halt and preserves X: %s',
  async (row) => {
    const { FakeHub } = await import('./fixtures/fake-hub.js')
    const { makeMLSPeer } = await import('./fixtures/peer.js')
    const { createMemoryGroupMLS } = await import('./fixtures/memory-group-mls.js')
    const { memoryCapturedRecord } = await import('./fixtures/memory-captured-recovery.js')
    const hub = new FakeHub()
    const secret = new Uint8Array(32).fill(108)
    const events: Array<{ phase: string; reason?: string }> = []
    const options = {
      epoch: 1,
      members: ['alice', 'bob'],
      recovery: { timeoutMs: 50, deadlineMs: 200, getDelayMs: () => 0 },
    }
    const alice = makeMLSPeer(hub, 'alice', secret, options)
    const bob = makeMLSPeer(hub, 'bob', secret, {
      ...options,
      onRecovery: (event) => {
        events.push(event)
      },
    })
    try {
      await alice.peer.replay()
      await bob.peer.replay()
      const captured = bob.mls.capturedRecovery
      if (captured === undefined) throw new Error('Missing captured port')
      const held = await bob.mls.createRecoveryRequest('saved-X')
      const pending = await captured.applyRecovery(
        await alice.mls.sealGroupInfo(held.request, null),
        'saved-X',
        held.requestKey,
      )
      if (pending === null || 'renewalRequired' in pending) throw new Error('Missing X')
      const record = memoryCapturedRecord(pending, held.request, held.requestKey, 'saved-X')
      await bob.control.apply({ putRejoin: record, recoveryEpochFloor: 1 }, 'save-X')
      const before = await bob.control.load()
      const responder = createMemoryGroupMLS({
        groupID: record.source.key.groupID,
        localDID: 'alice',
        members: options.members,
        recoverySecret: secret,
        epoch: 0,
      })
      if (row === 'equal-different')
        await responder.adopt(responder.buildCommit(['different-branch']))
      alice.mls.sealGroupInfo = async (request: Uint8Array, head: LogPosition | null = null) => {
        if (row === 'no-reply') throw new Error('withheld reply')
        if (row === 'ineligible-reply') return new Uint8Array([0])
        return await responder.sealGroupInfo(request, head)
      }
      vi.useFakeTimers()
      const recovering = bob.peer.recover()
      await vi.advanceTimersByTimeAsync(100)
      await recovering
      await vi.advanceTimersByTimeAsync(500_000)
      const failures = events.filter((event) => event.phase === 'failed')
      expect(failures.length).toBeGreaterThan(20)
      expect(
        failures.every(
          (event) =>
            event.reason ===
            (row === 'lower'
              ? 'target-behind'
              : row === 'equal-different'
                ? 'capture-authenticator-disagreement'
                : 'unconfirmed'),
        ),
      ).toBe(true)
      const after = await bob.control.load()
      expect(after.rejoin).toEqual(before.rejoin)
      expect(after.recoveryEpochFloor).toBe(1)
      expect(after.settledRejoins).toEqual([])
      expect(after.forkHalt).toBeNull()
      expect(bob.mls.epoch()).toBe(1)
    } finally {
      await Promise.all([alice.peer.dispose(), bob.peer.dispose()])
      await Promise.all([alice.peer.drained(), bob.peer.drained()])
      vi.useRealTimers()
    }
  },
)
