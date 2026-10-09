import { afterEach, expect, test, vi } from 'vitest'

import { type SourceScan, sourceRecheck } from '../src/control/rejoin.js'
import type { RejoinRecord } from '../src/control/types.js'
import { asLogPosition } from '../src/cursor.js'
import { decodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import { commitTopic } from '../src/topic.js'
import { publishCommit } from './fixtures/commits.js'
import { FakeHub } from './fixtures/fake-hub.js'
import {
  buildLedgerCommit,
  buildRejoinRecord,
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
function crashAt(bob: TestPeer, stage: RejoinRecord['stage']) {
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
    if (result === 'gap') hub.trim(commitTopic(secret), '999999999999')
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
      expect(replayedIDs[0]).not.toBe(saved?.id)
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
  const again = member(hub, 'bob', { restartOf: bob })
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
    }))
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
  const record = await buildRejoinRecord(bob)
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
  expect(sourceRecheck(scan, record)).toBe(expected)
  if (frame != null) {
    // Neither an already reconciled frame nor a successor can invalidate this source.
    record.source.head = asLogPosition('000000000002')
    expect(sourceRecheck(scan, record)).toBe('pass')
    record.source.head = null
    const scanned = scan.frames[0]
    if (scanned == null) throw new Error('Missing scan frame')
    scanned.position = record.position
    expect(sourceRecheck(scan, record)).toBe('pass')
  }
})

test.each(['gap', 'epoch', 'authenticator', 'lineage'] as const)(
  'source re-check rejects changed %s',
  async (changed) => {
    const { bob } = await setup()
    const record = await buildRejoinRecord(bob)
    const scan: SourceScan = { current: structuredClone(record.source), gap: false, frames: [] }
    if (changed === 'gap') scan.gap = true
    else if (changed === 'authenticator')
      scan.current.authenticator[0] = (scan.current.authenticator[0] ?? 0) ^ 1
    else scan.current[changed] += 1
    expect(sourceRecheck(scan, record)).toBe('fail')
  },
)

test('a confirmed rejoin is invalidated if the source moves before restart', async () => {
  const { hub, bob } = await setup()
  crashAt(bob, 'confirmed')
  await expect(bob.peer.recover()).rejects.toThrow()
  await bob.peer.drained()
  const saved = (await bob.control.load()).rejoin
  expect(saved?.stage).toBe('confirmed')
  bob.mls.adopt(bob.mls.buildCommit(['new-source']))
  await bob.database.saveState('bob', bob.mls.serializeState())
  const again = member(hub, 'bob', { restartOf: bob })
  await expect.poll(async () => (await again.control.load()).rejoin).toBeNull()
  expect(again.mls.epoch()).toBe(2)
  expect(await again.mls.getLedger()).toEqual(['new-source'])
  expect((await again.control.load()).applied).toEqual([])
  await new Promise((resolve) => setTimeout(resolve, 1100))
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
    await expect.poll(async () => (await again.control.load()).rejoin).toBeNull()
    await again.peer.resync()
    expect(again.mls.epoch()).toBe(seam === 'successor' ? 3 : 2)
    expect(again.peer.anchorEpoch()).toBe(again.mls.epoch())
    expect((await again.control.load()).cursor?.position).toBe(successor ?? saved?.position)
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

test('anchor recovery still settles a saved build before writing the rejoin record', async () => {
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
  expect((await again.peer.recover()).advanced).toBe(true)
  expect(stage).toBe('accepted')
  expect((await again.control.load()).operations).toEqual([])
  expect((await again.control.load()).outcomes).toContainEqual(
    expect.objectContaining({ opID: op.id, kind: 'unknown' }),
  )
})
