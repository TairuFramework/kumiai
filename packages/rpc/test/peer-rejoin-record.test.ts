import { afterEach, expect, test, vi } from 'vitest'

import { decodeCommitFrame } from '../src/commit-frame.js'
import {
  type LegacyRejoinDeps as RejoinDeps,
  type SourceScan,
  sourceRecheck,
  stepLegacyRejoin as stepRejoin,
} from '../src/control/rejoin.js'
import type { LegacyRejoinRecord } from '../src/control/types.js'
import { asLogPosition } from '../src/cursor.js'
import { decodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import type { RecoveryEvent } from '../src/peer-types.js'
import type { CapturedRejoinRecord } from '../src/recovery-types.js'
import { commitTopic, rendezvousTopic } from '../src/topic.js'
import { publishCommit } from './fixtures/commits.js'
import { assertCommitPoison } from './fixtures/control-hold.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryGroupMLS, decodeMemoryCommit } from './fixtures/memory-group-mls.js'
import {
  buildLedgerCommit,
  buildLegacyRejoinRecord,
  makeMLSPeer,
  seedBuiltOperation,
  type TestPeer,
} from './fixtures/peer.js'

const secret = new Uint8Array(32).fill(0x63)
const peers: Array<TestPeer> = []
function member(hub: FakeHub, did: string, options: Parameters<typeof makeMLSPeer>[3] = {}) {
  const peer = makeMLSPeer(hub, did, secret, {
    members: ['alice', 'bob'],
    recovery: { timeoutMs: 30, deadlineMs: 300, getDelayMs: () => 0 },
    ...options,
  })
  peers.push(peer)
  return peer
}
afterEach(async () => {
  await Promise.all(peers.map(({ peer }) => peer.dispose()))
  await Promise.all(peers.splice(0).map(({ peer }) => peer.drained()))
  vi.restoreAllMocks()
})
async function setup() {
  const hub = new FakeHub()
  const alice = member(hub, 'alice')
  const bob = member(hub, 'bob')
  await alice.peer.replay()
  await bob.peer.replay()
  return { hub, alice, bob }
}
function commits(hub: FakeHub) {
  return hub.published.filter((row) => row.topicID === commitTopic(secret))
}
function crashAt(bob: TestPeer, stage: LegacyRejoinRecord['stage']) {
  const apply = bob.control.apply.bind(bob.control)
  vi.spyOn(bob.control, 'apply').mockImplementation(async (changes, id) => {
    await apply(changes, id)
    if (changes.putRejoin?.stage === stage) void bob.peer.dispose()
  })
  if (stage === 'adopted')
    bob.database.seam('after-save', () => {
      void bob.peer.dispose()
    })
}

async function capturedRecord(bob: TestPeer): Promise<CapturedRejoinRecord> {
  const { source, conflictEpoch: _conflict, ...common } = await buildLegacyRejoinRecord(bob)
  return {
    ...common,
    format: 2,
    source: {
      key: source.key,
      identity: { ...source.key, epoch: source.epoch, authenticator: source.authenticator },
      stateVersion: 1,
      lifetimeRevision: 1,
      trust: { retained: new Uint8Array([1, 2, 3]) },
      trustDigest: 'd'.repeat(43),
    },
    target: {
      targetID: 'recovery-hub',
      topicID: commitTopic(secret),
      groupInfoEpoch: source.epoch,
      groupInfoAuthenticator: source.authenticator.slice(),
      captureHead: null,
    },
    captureHead: null,
    searchFrom: null,
    trigger: 'automatic',
    authorisationID: null,
    switchMutationID: null,
    destinationKey: null,
  }
}

test.each(['built', 'published', 'confirmed', 'adopted', 'refused'] as const)(
  'saved legacy %s records survive captured peer replay and recovery',
  async (stage) => {
    const { hub, bob } = await setup()
    await bob.peer.dispose()
    await bob.peer.drained()
    const record: LegacyRejoinRecord = {
      ...(await buildLegacyRejoinRecord(bob)),
      stage,
      position: asLogPosition('legacy-position'),
      verdict: new Uint8Array([128, 255]),
      conflictEpoch: 7,
      ...(stage === 'refused' ? { refusal: 'policy' } : {}),
    }
    await bob.control.apply({ putRejoin: record }, 'captured-save')
    const before = await bob.control.load()
    const again = member(hub, 'bob', { restartOf: bob })
    const restore = vi.spyOn(again.mls, 'restoreRecovery')
    await again.peer.replay()
    expect(await again.peer.recover()).toEqual({ advanced: false, reenact: [] })
    expect((await again.control.load()).rejoin).toEqual(before.rejoin)
    expect((await again.control.load()).outcomes).toEqual(before.outcomes)
    expect(again.mls.epoch()).toBe(1)
    expect(commits(hub)).toEqual([])
    expect(restore).not.toHaveBeenCalled()
  },
)

test('legacy confirmation preserves a captured replacement from the stored reread', async () => {
  const { bob } = await setup()
  const legacy = {
    ...(await buildLegacyRejoinRecord(bob)),
    stage: 'published' as const,
    position: asLogPosition('legacy-position'),
  }
  const replacement: CapturedRejoinRecord = {
    ...(await capturedRecord(bob)),
    id: legacy.id,
    stage: 'published',
    position: legacy.position,
  }
  await bob.control.apply({ putRejoin: legacy }, 'legacy-save')
  const unreachable = async (): Promise<never> => {
    throw new Error('Unexpected legacy step')
  }
  const deps: RejoinDeps = {
    control: bob.control,
    publish: unreachable,
    searchLog: unreachable,
    confirm: async () => {
      await bob.control.apply({ putRejoin: replacement }, 'replace-during-confirm')
      return {
        kind: 'confirmed',
        position: 'legacy-position',
        epoch: 2,
        sealed: new Uint8Array([9]),
      }
    },
    runSerial: (fn) => fn(),
    scan: unreachable,
    adopt: unreachable,
    bootstrapLedger: unreachable,
    getLedger: unreachable,
    newID: () => 'legacy-transition',
    now: () => 1234,
    emit: () => {},
    discarded: () => {},
  }
  expect(await stepRejoin(deps, legacy)).toEqual(replacement)
  expect((await bob.control.load()).rejoin).toEqual(replacement)
})

test('adopted legacy completion retains incomplete capture evidence', async () => {
  const { bob } = await setup()
  await bob.peer.dispose()
  await bob.peer.drained()
  const record = { ...(await buildLegacyRejoinRecord(bob)), stage: 'adopted' as const }
  const cursor = {
    position: asLogPosition('incomplete-prefix'),
    epoch: 1,
    incomplete: true as const,
  }
  await bob.control.apply({ putRejoin: record, cursor }, 'incomplete-adoption')
  const unreachable = async (): Promise<never> => {
    throw new Error('Unexpected legacy work')
  }
  const deps: RejoinDeps = {
    control: bob.control,
    publish: unreachable,
    searchLog: unreachable,
    confirm: unreachable,
    runSerial: (fn) => fn(),
    scan: unreachable,
    adopt: unreachable,
    bootstrapLedger: async () => true,
    getLedger: async () => record.ledgerBefore,
    newID: () => 'complete-incomplete',
    now: () => 1234,
    emit: () => {},
    discarded: () => {},
  }
  expect(await stepRejoin(deps, record)).toBeNull()
  expect((await bob.control.load()).cursor).toEqual(cursor)
})

test('a hold committed while loading a saved rejoin prevents external handoff', async () => {
  const { hub, bob } = await setup()
  const record = await buildLegacyRejoinRecord(bob)
  await bob.control.apply({ putRejoin: record }, 'saved-external')
  await bob.peer.ack('absent')
  const load = bob.control.load.bind(bob.control)
  let held = false
  vi.spyOn(bob.control, 'load').mockImplementation(async () => {
    const snapshot = await load()
    if (!held) {
      held = true
      await bob.control.apply(
        {
          controlHold: { reason: 'unsupported-version', position: asLogPosition('001') },
          strand: { reason: 'unsupported-version' },
        },
        'hold-during-recheck',
      )
    }
    return snapshot
  })
  await bob.peer.recover().catch(() => {})
  expect(held).toBe(true)
  expect(commits(hub)).toEqual([])
  expect((await bob.control.load()).controlHold?.reason).toBe('unsupported-version')
})

test.each(['built', 'published', 'confirmed', 'adopted'] as const)(
  'restart resumes a %s rejoin without another external commit',
  async (stage) => {
    const { hub, alice, bob } = await setup()
    crashAt(bob, stage)
    await expect(bob.peer.recover()).rejects.toThrow()
    await bob.peer.dispose()
    await bob.peer.drained()
    const saved = (await bob.control.load()).rejoin
    expect(saved?.stage).toBe(stage)
    if (saved !== null && 'format' in saved)
      expect((await bob.control.load()).recoveryEpochFloor).toBe(saved.target.groupInfoEpoch)
    const again = member(hub, 'bob', { restartOf: bob })
    await expect.poll(async () => (await again.control.load()).rejoin).toBeNull()
    expect(again.mls.epoch()).toBe(alice.mls.epoch())
    expect(commits(hub)).toHaveLength(1)
    expect(commits(hub)[0]?.payload).toEqual(saved?.payload)
    expect((await again.control.load()).applied).toEqual([
      expect.objectContaining({ digest: saved?.digest, sequenceID: commits(hub)[0]?.sequenceID }),
    ])
  },
)

test('publish accepted before the published write is found before the startup walk', async () => {
  const { hub, alice, bob } = await setup()
  const publish = hub.publish.bind(hub)
  vi.spyOn(hub, 'publish').mockImplementation(async (params) => {
    const result = await publish(params)
    if (params.senderDID === 'bob' && params.topicID === commitTopic(secret))
      void bob.peer.dispose()
    return result
  })
  await expect(bob.peer.recover()).rejects.toThrow()
  await bob.peer.dispose()
  await bob.peer.drained()
  expect((await bob.control.load()).rejoin?.stage).toBe('built')
  vi.restoreAllMocks()
  const again = member(hub, 'bob', { restartOf: bob })
  await expect.poll(async () => (await again.control.load()).rejoin).toBeNull()
  expect(again.mls.epoch()).toBe(alice.mls.epoch())
  expect(commits(hub)).toHaveLength(1)
})

test.each(['found', 'absent', 'gap'] as const)(
  'built restart resolves a head mismatch by payload search: %s',
  async (result) => {
    const { hub, bob } = await setup()
    if (result === 'found') {
      const publish = hub.publish.bind(hub)
      vi.spyOn(hub, 'publish').mockImplementation(async (params) => {
        const accepted = await publish(params)
        if (params.senderDID === 'bob' && params.topicID === commitTopic(secret))
          void bob.peer.dispose()
        return accepted
      })
    } else crashAt(bob, 'built')
    await expect(bob.peer.recover()).rejects.toThrow()
    await bob.peer.drained()
    const saved = (await bob.control.load()).rejoin
    expect(saved?.stage).toBe('built')
    vi.restoreAllMocks()
    hub.forgetPublishRecords()
    await hub.publish({
      senderDID: 'other',
      topicID: commitTopic(secret),
      payload: new Uint8Array([0]),
      retain: 'log',
    })
    if (result === 'gap') {
      const fetch = hub.fetchTopic.bind(hub)
      let missing = true
      vi.spyOn(hub, 'fetchTopic').mockImplementation(async (params) => {
        const page = await fetch(params)
        if (missing && params.subscriberDID === 'bob' && params.topicID === commitTopic(secret)) {
          missing = false
          return { ...page, messages: [], gap: true }
        }
        return page
      })
    }
    const replayedIDs: Array<string> = []
    const apply = bob.control.apply.bind(bob.control)
    vi.spyOn(bob.control, 'apply').mockImplementation(async (changes, id) => {
      if (changes.putRejoin?.stage === 'built') replayedIDs.push(changes.putRejoin.id)
      return apply(changes, id)
    })
    const again = member(hub, 'bob', { restartOf: bob, control: bob.control })
    await expect.poll(async () => again.mls.epoch()).toBe(2)
    await expect.poll(async () => (await again.control.load()).rejoin).toBeNull()
    const external = commits(hub).filter((row) => row.senderDID === 'bob')
    expect(external).toHaveLength(1)
    if (result === 'found') {
      expect(external[0]?.payload).toEqual(saved?.payload)
      expect(replayedIDs).toEqual([])
    } else {
      expect(replayedIDs).toHaveLength(1)
      expect(replayedIDs[0]).toBe(saved?.id)
    }
  },
)

test('published restart cannot adopt when every confirmation is withheld', async () => {
  const { hub, bob } = await setup()
  crashAt(bob, 'published')
  await expect(bob.peer.recover()).rejects.toThrow()
  await bob.peer.drained()
  const saved = (await bob.control.load()).rejoin
  expect(saved?.stage).toBe('published')
  const publish = hub.publish.bind(hub)
  vi.spyOn(hub, 'publish').mockImplementation((params) => {
    if (decodeHandshakeFrame(params.payload).kind === HANDSHAKE_KIND.recoveryVerdict)
      return publish({ ...params, payload: new Uint8Array([0]) })
    return publish(params)
  })
  const events: Array<RecoveryEvent> = []
  const again = member(hub, 'bob', {
    restartOf: bob,
    onRecovery: (event) => {
      events.push(event)
    },
  })
  await expect
    .poll(() =>
      hub.published.some((row) => {
        try {
          return (
            row.senderDID === 'bob' &&
            decodeHandshakeFrame(row.payload).kind === HANDSHAKE_KIND.recoveryConfirmRequest
          )
        } catch {
          return false
        }
      }),
    )
    .toBe(true)
  expect(again.mls.epoch()).toBe(1)
  expect((await again.control.load()).applied).toEqual([])
  await expect.poll(() => events.some((event) => event.phase === 'failed')).toBe(true)
  expect(events).toContainEqual(expect.objectContaining({ phase: 'failed', reason: 'unconfirmed' }))
})

test('abandon while a confirmation opens cannot resurrect or adopt the rejoin', async () => {
  const hub = new FakeHub()
  const alice = member(hub, 'alice')
  const bob = member(hub, 'bob', {
    recovery: { timeoutMs: 300, deadlineMs: 1000, getDelayMs: () => 0 },
  })
  await alice.peer.replay()
  await bob.peer.replay()
  let opened!: () => void
  let release!: () => void
  const arrived = new Promise<void>((resolve) => {
    opened = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const open = bob.mls.openRecoveryVerdict.bind(bob.mls)
  vi.spyOn(bob.mls, 'openRecoveryVerdict').mockImplementation(async (...args) => {
    const verdict = await open(...args)
    opened()
    await gate
    return verdict
  })
  const recovering = bob.peer.recover()
  await arrived
  const record = (await bob.control.load()).rejoin
  expect(record?.stage).toBe('published')
  await bob.peer.abandon()
  release()
  expect((await recovering).advanced).toBe(false)
  expect((await bob.control.load()).rejoin).toBeNull()
  expect((await bob.control.load()).applied).toEqual([])
  expect(bob.mls.epoch()).toBe(1)
  expect(await bob.peer.outcomes()).toContainEqual(
    expect.objectContaining({ id: record?.id, kind: 'unknown' }),
  )
  expect(commits(hub)).toHaveLength(1)
})

test.each(['policy', 'invalid'] as const)(
  'a %s refusal survives restart and outcome acknowledgement until recover',
  async (reason) => {
    const { hub, alice, bob } = await setup()
    const process = alice.mls.processCommit.bind(alice.mls)
    vi.spyOn(alice.mls, 'processCommit').mockImplementation(async () => ({
      applied: false,
      advanced: false,
      epochBefore: 1,
      epochAfter: 1,
      refusal: reason,
      refusalAuthority: 'authenticated-commit',
    }))
    const validation = vi
      .spyOn(alice.mls, 'validateRecoveryCommit')
      .mockResolvedValue({ epoch: 1, refusal: reason, refusalAuthority: 'authenticated-commit' })
    expect((await bob.peer.recover()).advanced).toBe(false)
    const saved = (await bob.control.load()).rejoin
    expect(saved).toMatchObject({ stage: 'refused', refusal: reason })
    expect(await bob.peer.outcomes()).toContainEqual(
      expect.objectContaining({ id: saved?.id, kind: 'refused', reason }),
    )
    await bob.peer.dispose()
    await bob.peer.drained()
    const count = commits(hub).length
    const again = member(hub, 'bob', { restartOf: bob })
    await again.peer.replay()
    if (saved == null) throw new Error('Missing refusal')
    await again.peer.ack(saved.id)
    await again.peer.resync()
    expect((await again.control.load()).rejoin).toEqual(saved)
    expect(commits(hub)).toHaveLength(count)
    vi.spyOn(alice.mls, 'processCommit').mockImplementation(process)
    validation.mockRestore()
    await publishCommit({ hub, senderDID: 'bob', recoverySecret: secret, epoch: 1 })
    await alice.peer.resync()
    expect(alice.mls.epoch()).toBe(2)
    expect((await again.peer.recover()).advanced).toBe(true)
    expect((await again.control.load()).rejoin).toBeNull()
  },
)

test.each([
  { name: 'unchanged source and empty interval', expected: 'pass', frame: null },
  {
    name: 'unparseable frame',
    expected: 'pass',
    frame: { epoch: null, external: false, responded: false },
  },
  {
    name: 'frame above the source epoch',
    expected: 'pass',
    frame: { epoch: 2, external: false, responded: false },
  },
  {
    name: 'recorded external response',
    expected: 'pass',
    frame: { epoch: 1, external: true, responded: true },
  },
  {
    name: 'own external commit',
    expected: 'pass',
    frame: { epoch: 1, external: true, responded: false },
  },
  {
    name: 'parseable source commit',
    expected: 'fail',
    frame: { epoch: 1, external: false, responded: false },
  },
  {
    name: 'foreign external commit at the source epoch',
    expected: 'fail',
    frame: { epoch: 1, external: true, responded: false },
    digest: 'foreign',
  },
])('source re-check: $name', async ({ expected, frame, digest }) => {
  const { bob } = await setup()
  const record = await buildLegacyRejoinRecord(bob)
  record.position = asLogPosition('000000000003')
  const scan: SourceScan = {
    current: record.source,
    gap: false,
    frames:
      frame == null
        ? []
        : [
            {
              position: asLogPosition('000000000002'),
              header: frame.epoch == null ? null : { epoch: frame.epoch, external: frame.external },
              digest: digest ?? record.digest,
              responded: frame.responded,
            },
          ],
  }
  expect(sourceRecheck(scan, record)).toEqual(
    expected === 'pass' ? { kind: 'pass' } : { kind: 'fail', blockingPosition: '000000000002' },
  )
  if (frame != null) {
    // Neither an already reconciled frame nor a successor can invalidate this source.
    record.source.head = asLogPosition('000000000002')
    expect(sourceRecheck(scan, record)).toEqual({ kind: 'pass' })
    record.source.head = null
    const scanned = scan.frames[0]
    if (scanned == null) throw new Error('Missing scan frame')
    scanned.position = record.position
    expect(sourceRecheck(scan, record)).toEqual({ kind: 'pass' })
  }
})

test.each(['gap', 'epoch', 'authenticator', 'incarnation', 'groupID'] as const)(
  'source re-check rejects changed %s',
  async (changed) => {
    const { bob } = await setup()
    const record = await buildLegacyRejoinRecord(bob)
    const scan: SourceScan = { current: structuredClone(record.source), gap: false, frames: [] }
    if (changed === 'gap') scan.gap = true
    else if (changed === 'authenticator')
      scan.current.authenticator[0] = (scan.current.authenticator[0] ?? 0) ^ 1
    else if (changed === 'incarnation') scan.current.key.incarnation += 1
    else if (changed === 'groupID') scan.current.key.groupID = 'other-group'
    else scan.current.epoch += 1
    expect(sourceRecheck(scan, record)).toEqual({ kind: 'fail', blockingPosition: null })
  },
)

test('a confirmed rejoin preserves accepted facts if the source moves before restart', async () => {
  const { hub, bob } = await setup()
  crashAt(bob, 'confirmed')
  await expect(bob.peer.recover()).rejects.toThrow()
  await bob.peer.drained()
  const saved = (await bob.control.load()).rejoin
  expect(saved?.stage).toBe('confirmed')
  bob.mls.adopt(bob.mls.buildCommit(['new-source']))
  await bob.database.saveState('bob', bob.mls.serializeState())
  const events: Array<RecoveryEvent> = []
  const again = member(hub, 'bob', {
    restartOf: bob,
    onRecovery: (event) => {
      events.push(event)
    },
  })
  await again.peer.recover().catch(() => {})
  expect((await again.control.load()).rejoin).toEqual(saved)
  expect(again.mls.epoch()).toBe(2)
  expect(await again.mls.getLedger()).toEqual(['new-source'])
  expect((await again.control.load()).applied).toEqual([])
  expect(events).toContainEqual(expect.objectContaining({ phase: 'failed', reason: 'error' }))
  expect(commits(hub)).toHaveLength(1)
})

test.each(['landed', 'failed-save', 'successor'] as const)(
  'same-number rejoin restart: %s',
  async (seam) => {
    const hub = new FakeHub()
    const alice = member(hub, 'alice')
    const bob = member(hub, 'bob', { epoch: 2 })
    await alice.peer.replay()
    await bob.peer.replay()
    if (seam === 'landed') crashAt(bob, 'adopted')
    else if (seam === 'successor') crashAt(bob, 'confirmed')
    else bob.database.failNext('mid-save')
    await expect(bob.peer.recover()).rejects.toThrow()
    await bob.peer.dispose()
    await bob.peer.drained()
    const saved = (await bob.control.load()).rejoin
    expect(saved?.stage).toBe(seam === 'landed' ? 'adopted' : 'confirmed')
    if (seam === 'landed') expect((await bob.anchorStore.load())?.pending?.landed).toBe(true)
    else expect((await bob.anchorStore.load())?.pending?.landed).not.toBe(true)
    let successor: string | undefined
    if (seam === 'successor') {
      await alice.peer.dispose()
      await alice.peer.drained()
      successor = (
        await publishCommit({
          hub,
          senderDID: 'alice',
          recoverySecret: secret,
          epoch: 2,
          external: true,
        })
      ).sequenceID
    }
    const again = member(hub, 'bob', { restartOf: bob })
    await expect.poll(async () => (await again.control.load()).rejoin, { timeout: 5000 }).toBeNull()
    await again.peer.resync()
    await expect
      .poll(
        async () => ({
          epoch: again.mls.epoch(),
          anchorEpoch: again.peer.anchorEpoch(),
          position: (await again.control.load()).cursor?.position,
        }),
        { timeout: 5000 },
      )
      .toEqual({
        epoch: seam === 'successor' ? 3 : 2,
        anchorEpoch: seam === 'successor' ? 3 : 2,
        position: successor ?? saved?.position,
      })
    expect(commits(hub)).toHaveLength(seam === 'successor' ? 2 : 1)
  },
)

test('ledger bootstrap before the final apply survives restart and emits reenact once', async () => {
  const hub = new FakeHub()
  const alice = member(hub, 'alice', { epoch: 2 })
  const bob = member(hub, 'bob')
  await alice.peer.replay()
  await bob.peer.replay()
  bob.mls.adopt(bob.mls.buildCommit(['discarded-branch']))
  await bob.database.saveState('bob', bob.mls.serializeState())
  const apply = bob.control.apply.bind(bob.control)
  vi.spyOn(bob.control, 'apply').mockImplementation(async (changes, id) => {
    if (changes.deleteRejoin && (await bob.control.load()).rejoin?.stage === 'adopted') {
      void bob.peer.dispose()
      throw new Error('Crash before final rejoin apply')
    }
    return apply(changes, id)
  })
  await expect(bob.peer.recover()).rejects.toThrow()
  await bob.peer.drained()
  expect((await bob.control.load()).rejoin).toMatchObject({
    stage: 'adopted',
    ledgerBefore: ['discarded-branch'],
  })
  const again = member(hub, 'bob', { restartOf: bob })
  await expect.poll(async () => (await again.control.load()).rejoin).toBeNull()
  const reenact = (await again.control.load()).outcomes.filter(
    (outcome) => outcome.kind === 'reenact',
  )
  expect(reenact).toEqual([expect.objectContaining({ opID: null, tokens: ['discarded-branch'] })])
  await again.peer.replay()
  expect(
    (await again.control.load()).outcomes.filter((outcome) => outcome.kind === 'reenact'),
  ).toEqual(reenact)
})

test('concurrent replay of a confirmed rejoin durably settles reenact exactly once', async () => {
  const hub = new FakeHub()
  const alice = member(hub, 'alice', { epoch: 2 })
  const bob = member(hub, 'bob', {
    recovery: { timeoutMs: 200, deadlineMs: 2000, getDelayMs: () => 60_000 },
  })
  await alice.peer.replay()
  await bob.peer.replay()
  bob.mls.adopt(bob.mls.buildCommit(['discarded-branch']))
  await bob.database.saveState('bob', bob.mls.serializeState())
  const apply = bob.control.apply.bind(bob.control)
  const writes: Array<LegacyRejoinRecord['stage'] | 'settled'> = []
  vi.spyOn(bob.control, 'apply').mockImplementation(async (changes, id) => {
    await apply(changes, id)
    if (changes.putRejoin?.stage === 'confirmed') bob.database.failNext('mid-save')
    if (changes.putRejoin != null) writes.push(changes.putRejoin.stage)
    if (changes.deleteRejoin) writes.push('settled')
  })
  await expect(bob.peer.recover()).rejects.toThrow('Injected transaction failure')
  const record = (await bob.control.load()).rejoin
  expect(record).toMatchObject({ stage: 'confirmed', ledgerBefore: ['discarded-branch'] })
  expect(record?.verdict).toBeInstanceOf(Uint8Array)
  const results = await Promise.all([bob.peer.replay(), bob.peer.replay()])
  expect(results.flatMap((result) => result.reenact ?? [])).toEqual(['discarded-branch'])
  const snapshot = await bob.control.load()
  expect(snapshot.rejoin).toBeNull()
  expect(snapshot.cursor?.stranded).toBeUndefined()
  expect(snapshot.outcomes).toEqual([
    expect.objectContaining({ id: record?.id, kind: 'reenact', tokens: ['discarded-branch'] }),
  ])
  expect(writes.filter((stage) => stage === 'settled')).toHaveLength(1)
  await bob.peer.replay()
  expect((await bob.control.load()).outcomes).toEqual(snapshot.outcomes)
  await bob.peer.dispose()
  await bob.peer.drained()
  const again = member(hub, 'bob', { restartOf: bob })
  await again.peer.replay()
  expect((await again.control.load()).outcomes).toEqual(snapshot.outcomes)
  expect((await again.control.load()).cursor?.stranded).toBeUndefined()
})

test('an ambiguous recovery state save is read back without a second adoption', async () => {
  const { bob, alice, hub } = await setup()
  bob.database.commitThenRejectNext('save')
  expect((await bob.peer.recover()).advanced).toBe(true)
  expect(bob.mls.epoch()).toBe(alice.mls.epoch())
  expect((await bob.control.load()).rejoin).toBeNull()
  expect((await bob.control.load()).applied).toHaveLength(1)
  expect(commits(hub)).toHaveLength(1)
})

test('a built operation settles before the rejoin built record is saved', async () => {
  const { bob } = await setup()
  const op = await seedBuiltOperation(bob, buildLedgerCommit(bob, ['settled-first']))
  let settled = false
  const apply = bob.control.apply.bind(bob.control)
  vi.spyOn(bob.control, 'apply').mockImplementation(async (changes, id) => {
    if (changes.putRejoin?.stage === 'built') {
      const snapshot = await bob.control.load()
      expect(snapshot.operations).toEqual([])
      expect(snapshot.outcomes).toContainEqual(
        expect.objectContaining({ opID: op.id, kind: 'landed' }),
      )
      settled = true
    }
    return apply(changes, id)
  })
  expect((await bob.peer.recover()).advanced).toBe(true)
  expect(settled).toBe(true)
})

test('anchor recovery holds missing acceptance evidence before writing a rejoin record', async () => {
  const hub = new FakeHub()
  const alice = member(hub, 'alice', { epoch: 2 })
  const bob = member(hub, 'bob')
  await alice.peer.replay()
  await bob.peer.replay()
  const op = await seedBuiltOperation(bob, buildLedgerCommit(bob, ['saved-build']))
  await bob.peer.dispose()
  await bob.peer.drained()
  bob.mls.adopt(bob.mls.buildCommit([]))
  await bob.database.saveState('bob', bob.mls.serializeState())
  const slot = await bob.anchorStore.load()
  if (slot == null) throw new Error('Missing anchor')
  await bob.anchorStore.save({
    anchor: slot.anchor,
    pending: {
      epochBefore: 1,
      epochAfter: 3,
      rosterBefore: ['alice', 'bob'],
      forced: true,
      advance: 'unresolved-rotation',
      landed: true,
    },
  })
  const apply = bob.control.apply.bind(bob.control)
  let stage: string | undefined
  vi.spyOn(bob.control, 'apply').mockImplementation(async (changes, id) => {
    if (changes.putRejoin?.stage === 'built')
      stage = (await bob.control.load()).operations[0]?.stage
    return apply(changes, id)
  })
  const again = member(hub, 'bob', { restartOf: bob, control: bob.control })
  await again.peer.replay()
  const held = await again.control.load()
  expect(held.controlHold).toMatchObject({ reason: 'acceptance-unknown' })
  expect(held.commitOnce?.opID).toBe(op.id)
  expect(held.operations[0]?.id).toBe(op.id)
  expect(held.outcomes).toEqual([])
  expect(held.rejoin).toBeNull()
  expect(stage).toBeUndefined()
  expect(
    hub.published.filter(
      (message) => message.topicID === rendezvousTopic(secret) && message.senderDID === 'bob',
    ),
  ).toEqual([])
  await again.peer.dispose()
  await again.peer.drained()
  const restarted = member(hub, 'bob', { restartOf: again })
  await restarted.peer.replay()
  expect((await restarted.control.load()).controlHold).toEqual(held.controlHold)
  expect((await restarted.control.load()).commitOnce).toEqual(held.commitOnce)
})

test('anchor-gated recovery adopts the authenticated capture despite an unwalked source commit', async () => {
  const { hub, alice, bob } = await setup()
  const topicID = commitTopic(secret)
  const p0 = (
    await hub.publish({ senderDID: 'other', topicID, payload: new Uint8Array([0]), retain: 'log' })
  ).sequenceID
  await alice.peer.resync()
  await bob.peer.resync()
  await bob.peer.dispose()
  await bob.peer.drained()
  const slot = await bob.anchorStore.load()
  if (slot == null) throw new Error('Missing anchor')
  await bob.anchorStore.save({
    anchor: slot.anchor,
    pending: {
      epochBefore: 1,
      epochAfter: 3,
      rosterBefore: ['alice', 'bob'],
      forced: true,
      advance: 'unresolved-rotation',
      landed: true,
    },
  })
  const p1 = (await publishCommit({ hub, senderDID: 'carol', recoverySecret: secret, epoch: 1 }))
    .sequenceID
  await alice.peer.resync()
  expect(alice.mls.epoch()).toBe(2)
  const built: Array<CapturedRejoinRecord> = []
  const failures: Array<RecoveryEvent> = []
  const confirmed: Array<CapturedRejoinRecord> = []
  const apply = bob.control.apply.bind(bob.control)
  vi.spyOn(bob.control, 'apply').mockImplementation(async (changes, id) => {
    if (
      changes.putRejoin != null &&
      'format' in changes.putRejoin &&
      changes.putRejoin.stage === 'built'
    )
      built.push(changes.putRejoin)
    if (
      changes.putRejoin != null &&
      'format' in changes.putRejoin &&
      changes.putRejoin.stage === 'confirmed'
    )
      confirmed.push(changes.putRejoin)
    return apply(changes, id)
  })
  const again = member(hub, 'bob', {
    restartOf: bob,
    control: bob.control,
    onRecovery: (event) => {
      if (event.phase === 'failed') failures.push(event)
    },
  })
  await expect.poll(() => again.mls.epoch(), { timeout: 5000 }).toBe(3)
  await expect.poll(async () => (await again.control.load()).rejoin).toBeNull()
  expect(built).toHaveLength(1)
  expect(confirmed).toHaveLength(1)
  expect(built[0]?.expectedHead).toBe(p1)
  expect(built[0]?.target.captureHead).toBe(p1)
  expect(built[0]?.source.identity?.epoch).toBe(1)
  expect(p0).not.toBe(p1)
  expect(failures).not.toContainEqual(expect.objectContaining({ reason: 'invalidated' }))
})

test('an own-unmerged copy advances without creating a recovery attempt', async () => {
  const { hub, alice, bob } = await setup()
  await bob.peer.dispose()
  await bob.peer.drained()
  const examined = (
    await publishCommit({ hub, senderDID: 'bob', recoverySecret: secret, epoch: 1 })
  ).sequenceID
  const tip = (await publishCommit({ hub, senderDID: 'dave', recoverySecret: secret, epoch: 1 }))
    .sequenceID
  await alice.peer.resync()
  const built: Array<CapturedRejoinRecord> = []
  const apply = bob.control.apply.bind(bob.control)
  vi.spyOn(bob.control, 'apply').mockImplementation(async (changes, id) => {
    if (
      changes.putRejoin != null &&
      'format' in changes.putRejoin &&
      changes.putRejoin.stage === 'built'
    )
      built.push(changes.putRejoin)
    return apply(changes, id)
  })
  const again = member(hub, 'bob', { restartOf: bob, control: bob.control })
  await assertCommitPoison(again, hub, secret, 'bob', examined)
  expect(again.mls.epoch()).toBe(2)
  expect(built).toEqual([])
  expect(examined < tip).toBe(true)
})

test.each([false, true])(
  'a retention gap permits recovery with retained suffix: %s',
  async (suffix) => {
    const { hub, alice, bob } = await setup()
    const topicID = commitTopic(secret)
    await hub.publish({ senderDID: 'other', topicID, payload: new Uint8Array([0]), retain: 'log' })
    await alice.peer.resync()
    await bob.peer.resync()
    await bob.peer.dispose()
    await bob.peer.drained()
    const removed = (
      await publishCommit({ hub, senderDID: 'carol', recoverySecret: secret, epoch: 1 })
    ).sequenceID
    await alice.peer.resync()
    const original = hub.published.find((row) => row.sequenceID === removed)
    if (original === undefined) throw new Error('Missing retained commit')
    hub.trim(topicID, '999999999999')
    const retained = suffix
      ? (
          await hub.publish({
            senderDID: 'dave',
            topicID,
            payload: original.payload,
            retain: 'log',
          })
        ).sequenceID
      : null
    const built: Array<CapturedRejoinRecord> = []
    const apply = bob.control.apply.bind(bob.control)
    vi.spyOn(bob.control, 'apply').mockImplementation(async (changes, id) => {
      if (
        changes.putRejoin != null &&
        'format' in changes.putRejoin &&
        changes.putRejoin.stage === 'built'
      )
        built.push(changes.putRejoin)
      return apply(changes, id)
    })
    const again = member(hub, 'bob', { restartOf: bob, control: bob.control })
    await expect.poll(() => again.mls.epoch()).toBe(3)
    await expect.poll(async () => (await again.control.load()).rejoin).toBeNull()
    expect(built).toHaveLength(1)
    expect(built[0]?.target.captureHead).toBe(retained ?? removed)
    expect(built[0]?.target.groupInfoEpoch).toBe(2)
    expect(built[0]?.source.identity?.epoch).toBe(suffix ? 2 : 1)
  },
)

test.each(['binding', 'lapse', 'floor'] as const)(
  'a %s refusal refreshes the binding and retries without another recover call',
  async (reason) => {
    const hub = new FakeHub()
    const alice = member(hub, 'alice')
    const crypto = createFakeCrypto({ epoch: 1, localDID: 'bob' })
    const binding = { id: 'controller', prefix: [], capability: 'original' }
    let renewals = 0
    const mls = createMemoryGroupMLS({
      recoverySecret: secret,
      localDID: 'bob',
      members: ['alice', 'bob'],
      binding,
      recoveryBinding: async () => {
        renewals += 1
        return { ...binding, capability: 'renewed' }
      },
      onAdvance: (epoch) => crypto.setEpoch(epoch),
    })
    const bob = member(hub, 'bob', { mls, crypto })
    await alice.peer.replay()
    await bob.peer.replay()
    const process = alice.mls.processCommit.bind(alice.mls)
    vi.spyOn(alice.mls, 'processCommit')
      .mockImplementationOnce(async () => ({
        applied: false,
        advanced: false,
        epochBefore: 1,
        epochAfter: 1,
        refusal: reason,
        refusalAuthority: 'authenticated-commit',
      }))
      .mockImplementation(process)
    const validate = alice.mls.validateRecoveryCommit.bind(alice.mls)
    vi.spyOn(alice.mls, 'validateRecoveryCommit')
      .mockResolvedValueOnce({
        epoch: 1,
        refusal: reason,
        refusalAuthority: 'authenticated-commit',
      })
      .mockImplementation(validate)
    // A short attempt can expire under load; its automatic retry must finish without another call.
    await bob.peer.recover()
    await publishCommit({ hub, senderDID: 'bob', recoverySecret: secret, epoch: 1 })
    await alice.peer.resync()
    expect(alice.mls.epoch()).toBe(2)
    await expect
      .poll(
        async () => ({
          renewals,
          epoch: bob.mls.epoch(),
          responderEpoch: alice.mls.epoch(),
          rejoin: (await bob.control.load()).rejoin,
        }),
        { timeout: 5000 },
      )
      .toEqual({ renewals: 1, epoch: 3, responderEpoch: 3, rejoin: null })
    expect(
      commits(hub).filter(
        (row) =>
          row.senderDID === 'bob' &&
          decodeMemoryCommit(decodeCommitFrame(decodeHandshakeFrame(row.payload).payload).commit)
            ?.external === true,
      ),
    ).toHaveLength(2)
  },
)

test('confirmed rejoin replay retains its record under a freshly persisted strong hold', async () => {
  const { bob } = await setup()
  const built = await buildLegacyRejoinRecord(bob)
  const record: LegacyRejoinRecord = {
    ...built,
    stage: 'confirmed',
    position: asLogPosition('001'),
    verdict: new Uint8Array([1]),
  }
  await bob.control.apply(
    {
      putRejoin: record,
      controlHold: { reason: 'unsupported-version', position: asLogPosition('002') },
    },
    'confirmed-held',
  )
  await bob.peer.ack('refresh')
  await bob.peer.replay()
  expect(bob.mls.epoch()).toBe(1)
  expect((await bob.control.load()).rejoin).toEqual(record)
})

test.each(['acceptance-unknown', 'unsupported-version', 'fork-halted'] as const)(
  'an ordinary ahead gap heals only through a weak control hold: %s',
  async (reason) => {
    const hub = new FakeHub()
    const alice = member(hub, 'alice', { epoch: 3 })
    const bob = member(hub, 'bob')
    await alice.peer.replay()
    await bob.peer.replay()
    await bob.control.apply(
      reason === 'fork-halted'
        ? {
            forkHalt: {
              eventID: JSON.stringify([
                'group:fork',
                bob.control.key.groupID,
                bob.control.key.incarnation,
              ]),
              detectedAt: 1,
              evidence: {
                kind: 'unexplained-own-commit',
                epoch: 1,
                position: '1',
                digest: 'foreign',
              },
            },
          }
        : { controlHold: { reason, position: null } },
      'hold',
    )
    await bob.peer.ack('refresh')
    await publishCommit({ hub, senderDID: 'carol', recoverySecret: secret, epoch: 2 })
    if (reason === 'acceptance-unknown') {
      await vi.waitFor(() => expect(bob.mls.epoch()).toBeGreaterThan(1))
      await vi.waitFor(async () => expect((await bob.control.load()).strand).toBeNull())
      expect((await bob.control.load()).cursor?.stranded).toBeUndefined()
      expect((await bob.control.load()).controlHold).toBeNull()
    } else {
      if (reason === 'fork-halted')
        await expect(bob.peer.resync()).rejects.toMatchObject({
          name: 'GroupSafetyHeldError',
          reason,
        })
      else await bob.peer.resync()
      expect(bob.mls.epoch()).toBe(1)
      if (reason === 'fork-halted') expect((await bob.control.load()).forkHalt).not.toBeNull()
      else expect((await bob.control.load()).controlHold?.reason).toBe(reason)
    }
  },
)

test.each(['acceptance-unknown', 'unsupported-version'] as const)(
  'an ordinary gap retry resumes under %s without a new delivery',
  async (reason) => {
    vi.useFakeTimers()
    const hub = new FakeHub()
    const events: Array<RecoveryEvent> = []
    const bob = member(hub, 'bob', {
      onRecovery: (event) => {
        events.push(event)
      },
    })
    try {
      await bob.peer.replay()
      await bob.control.apply(
        { controlHold: { reason: 'acceptance-unknown', position: null } },
        'weak-hold',
      )
      await bob.peer.ack('refresh')
      await publishCommit({ hub, senderDID: 'carol', recoverySecret: secret, epoch: 2 })
      await vi.waitFor(() => expect(events.some((event) => event.phase === 'failed')).toBe(true))
      expect(bob.mls.epoch()).toBe(1)
      if (reason === 'unsupported-version') {
        await bob.control.apply(
          { controlHold: { reason, position: asLogPosition('held') } },
          'hard-hold',
        )
        await bob.peer.ack('refresh-hard-hold')
      }
      const alice = member(hub, 'alice', { epoch: 3 })
      await alice.peer.replay()
      await vi.advanceTimersByTimeAsync(1_000)
      if (reason === 'acceptance-unknown') {
        await vi.waitFor(() => expect(bob.mls.epoch()).toBeGreaterThan(1))
        await vi.waitFor(async () => expect((await bob.control.load()).strand).toBeNull())
      } else {
        expect(bob.mls.epoch()).toBe(1)
        expect((await bob.control.load()).controlHold?.reason).toBe(reason)
      }
    } finally {
      await Promise.all(peers.map(({ peer }) => peer.dispose()))
      await Promise.all(peers.map(({ peer }) => peer.drained()))
      vi.useRealTimers()
    }
  },
)

test('a hold committed while rereading confirmed capture preserves its bytes', async () => {
  const { hub, bob } = await setup()
  crashAt(bob, 'confirmed')
  await expect(bob.peer.recover()).rejects.toThrow()
  await bob.peer.dispose()
  await bob.peer.drained()
  const record = (await bob.control.load()).rejoin
  const load = bob.control.load.bind(bob.control)
  let held = false
  vi.spyOn(bob.control, 'load').mockImplementation(async () => {
    if (!held) {
      held = true
      await bob.control.apply(
        { controlHold: { reason: 'unsupported-version', position: asLogPosition('held') } },
        'hold-during-reread',
      )
    }
    return await load()
  })
  const again = member(hub, 'bob', { restartOf: bob, control: bob.control })
  await again.peer.replay()
  expect(held).toBe(true)
  expect(again.mls.epoch()).toBe(1)
  expect((await again.control.load()).rejoin).toEqual(record)
})
