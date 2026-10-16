import { afterEach, expect, test, vi } from 'vitest'

import { retainForkEvidence } from '../src/checkpoint.js'
import { foldForkNotices } from '../src/fork-notice.js'

function required<TValue>(value: TValue | undefined): TValue {
  if (value === undefined) throw new Error('Missing fixture value')
  return value
}

afterEach(() => vi.useRealTimers())

test('lone unequal statement only notifies', () => {
  vi.useFakeTimers()
  vi.setSystemTime(100000)
  const result = foldForkNotices({
    key: { groupID: 'group', incarnation: 1 },
    records: [],
    statements: [
      {
        epoch: 4,
        authHash: 'remote',
        parentAuthHash: 'shared',
        signerDID: 'remote-did',
        keyHash: 'remote-key',
        localAuthHash: 'local',
        frameID: 'frame',
      },
    ],
    now: Date.now(),
  })
  expect(result.notices).toHaveLength(1)
  expect(result.notices[0]).toMatchObject({ splitEpoch: 4, revision: 1, closedAt: null })
  expect(result.events[0]?.kind).toBe('fork-detected')
  expect(result.records.every((row) => row.kind === 'notice' || row.kind === 'notice-event')).toBe(
    true,
  )
})

const key = { groupID: 'group', incarnation: 1 }
const statement = (patch = {}) => ({
  epoch: 4,
  authHash: 'remote',
  parentAuthHash: 'shared',
  signerDID: 'remote-did',
  keyHash: 'remote-key',
  localAuthHash: 'local',
  frameID: 'frame',
  ...patch,
})
const start = () => foldForkNotices({ key, records: [], statements: [statement()], now: 0 })

test('material updates coalesce for 30000 milliseconds', () => {
  const first = start()
  for (const row of first.records) if (row.kind === 'notice-event') row.acknowledged = true
  const second = foldForkNotices({
    key,
    records: first.records,
    statements: [statement({ keyHash: 'another-key' })],
    now: 1,
  })
  expect(second.notices[0]?.revision).toBe(2)
  expect(second.events).toEqual([])
  const third = foldForkNotices({
    key,
    records: second.records,
    statements: [statement({ authHash: 'third' })],
    now: 2,
  })
  expect(third.notices[0]?.revision).toBe(3)
  expect(third.events).toEqual([])
  const ready = foldForkNotices({ key, records: third.records, statements: [], now: 30000 })
  expect(ready.events.at(-1)?.notice.revision).toBe(3)
  const times = ready.records.flatMap((row) => (row.kind === 'notice-event' ? [row.emitAt] : []))
  expect(required(times[1]) - required(times[0])).toBeGreaterThanOrEqual(30000)
})

test('replay after ack preserves revision', () => {
  const first = start()
  const acknowledged = first.records.map((row) =>
    row.kind === 'notice-event'
      ? { ...row, acknowledged: true }
      : row.kind === 'notice'
        ? { ...row, notice: { ...row.notice, acknowledgedRevision: 1, acknowledgedAt: 10 } }
        : row,
  )
  const replay = foldForkNotices({ key, records: acknowledged, statements: [statement()], now: 11 })
  expect(replay.notices[0]?.revision).toBe(1)
  expect(replay.events).toEqual([])
  const update = foldForkNotices({
    key,
    records: replay.records,
    statements: [statement({ keyHash: 'new-key' })],
    now: 20,
  })
  expect(update.notices[0]?.acknowledgedAt).toBeNull()
  expect(update.events).toEqual([])
  expect(
    update.records.flatMap((row) =>
      row.kind === 'notice-event' && !row.acknowledged ? [row.emitAt] : [],
    ),
  ).toEqual([30000])
})

test('one active branch closes after 86400000 milliseconds', () => {
  const first = start()
  const silent = foldForkNotices({ key, records: first.records, statements: [], now: 86400000 })
  expect(silent.notices[0]?.closedAt).toBeNull()
  const continuing = foldForkNotices({
    key,
    records: first.records,
    statements: [statement()],
    now: 86400000,
  })
  expect(continuing.notices[0]?.closedAt).toBe(86400000)
})

test('at risk coverage exposes missing history and ephemeral exclusion', () => {
  const notice = required(start().notices[0])
  expect(notice.atRisk).toEqual([])
  expect(notice.coverage.ownMessages).toEqual({ kind: 'partial', reasons: ['pre-journal-history'] })
  expect(notice.coverage.ephemeral).toEqual({ kind: 'partial', reasons: ['ephemeral-uncovered'] })
})

test('retained parent links move a split earlier without changing identity', () => {
  const first = foldForkNotices({
    key,
    records: [],
    statements: [
      statement({
        epoch: 5,
        authHash: 'remote-5',
        localAuthHash: 'local-5',
        parentAuthHash: 'remote',
      }),
    ],
    now: 0,
  })
  const second = foldForkNotices({
    key,
    records: first.records,
    statements: [statement()],
    lineage: [
      { epoch: 5, authHash: 'remote-5', parentAuthHash: 'remote' },
      { epoch: 5, authHash: 'local-5', parentAuthHash: 'local' },
    ],
    now: 1,
  })
  expect(second.notices).toHaveLength(1)
  expect(second.notices[0]?.id).toBe(first.notices[0]?.id)
  expect(second.notices[0]?.splitEpoch).toBe(4)
  expect(second.notices[0]?.closedAt).toBeNull()
  expect(second.notices[0]?.revision).toBe(2)
  const missing = foldForkNotices({
    key,
    records: first.records,
    statements: [statement()],
    now: 1,
  })
  expect(missing.notices).toHaveLength(2)
})

test('device branch changes increment revision', () => {
  const first = start()
  const next = foldForkNotices({
    key,
    records: first.records,
    statements: [statement({ authHash: 'local', localAuthHash: 'remote' })],
    now: 1,
  })
  expect(next.notices[0]).toMatchObject({ deviceAuthHash: 'remote', revision: 2, closedAt: 1 })
})

test.each([true, false])(
  'an agreeing predecessor cannot move a split or imply equivocation with retained links: %s',
  (linked) => {
    const first = foldForkNotices({
      key,
      records: [],
      statements: [
        statement({
          epoch: 10,
          authHash: 'remote-10',
          localAuthHash: 'local-10',
          parentAuthHash: 'shared-9',
        }),
      ],
      now: 0,
    })
    const result = foldForkNotices({
      key,
      records: first.records,
      statements: [
        statement({
          epoch: 9,
          authHash: 'shared-9',
          localAuthHash: 'shared-9',
          parentAuthHash: 'shared-8',
          frameID: 'agreeing-frame',
        }),
      ],
      lineage: linked
        ? [
            { epoch: 10, authHash: 'local-10', parentAuthHash: 'shared-9' },
            { epoch: 10, authHash: 'remote-10', parentAuthHash: 'shared-9' },
          ]
        : [],
      now: 1,
    })
    expect(result.notices).toHaveLength(1)
    expect(result.notices[0]).toMatchObject({ splitEpoch: 10, equivocations: [], revision: 1 })
    expect(result.notices).toEqual(first.notices)
    expect(result.records).toEqual(first.records)
    expect(result.assignments.size).toBe(0)
  },
)

test('closed evidence obeys ack and retention bounds', async () => {
  const first = start()
  const notice = required(first.notices[0])
  notice.closedAt = 1
  notice.acknowledgedAt = 10
  notice.acknowledgedRevision = 1
  const fact = {
    kind: 'fact' as const,
    id: 'installation',
    key,
    epoch: 4,
    canonical: new Uint8Array([1]),
    supersededAt: null,
  }
  const evidence = {
    kind: 'evidence' as const,
    id: 'evidence',
    key,
    noticeID: notice.id,
    first: new Uint8Array([2]),
    second: new Uint8Array([3]),
    localRosterFact: fact.canonical,
    eligibilityRosterFact: null,
  }
  const records = [...first.records, evidence]
  expect(
    retainForkEvidence(records, [fact], 604800009).some((row) => row.kind === 'evidence'),
  ).toBe(true)
  expect(retainForkEvidence(records, [fact], 604800010)).toEqual([])
  const pruned = retainForkEvidence(records, [], 11)
  expect(pruned.find((row) => row.kind === 'evidence')).toBeUndefined()
  expect(pruned.find((row) => row.kind === 'notice')).toMatchObject({
    notice: { coverage: { evidence: { kind: 'partial', reasons: ['retention-gap'] } } },
  })
  notice.acknowledgedAt = null
  expect(retainForkEvidence(records, [], 604800010).some((row) => row.kind === 'notice')).toBe(true)
})

test('equivocation is deduplicated across three branches', () => {
  const first = start()
  const second = foldForkNotices({
    key,
    records: first.records,
    statements: [statement({ authHash: 'local' })],
    now: 1,
  })
  const third = foldForkNotices({
    key,
    records: second.records,
    statements: [statement({ authHash: 'third' })],
    now: 2,
  })
  expect(third.notices[0]?.equivocations).toEqual([
    { signerDID: 'remote-did', keyHash: 'remote-key' },
  ])
})

function disconnectedNotices() {
  const later = foldForkNotices({
    key,
    records: [],
    statements: [
      statement({
        epoch: 6,
        authHash: 'remote-6',
        localAuthHash: 'local-6',
        parentAuthHash: 'remote-5',
      }),
    ],
    now: 0,
  })
  const disconnected = foldForkNotices({
    key,
    records: later.records,
    statements: [statement()],
    now: 1,
  })
  expect(disconnected.notices).toHaveLength(2)
  return { later, disconnected }
}

function connectNotices(records: ReturnType<typeof start>['records'], now = 2, switched = false) {
  return foldForkNotices({
    key,
    records,
    statements: [
      statement({
        epoch: 5,
        authHash: switched ? 'local-5' : 'remote-5',
        localAuthHash: switched ? 'remote-5' : 'local-5',
        parentAuthHash: switched ? 'local' : 'remote',
      }),
    ],
    lineage: [
      { epoch: 6, authHash: 'local-6', parentAuthHash: 'local-5' },
      { epoch: 5, authHash: 'local-5', parentAuthHash: 'local' },
      { epoch: 6, authHash: 'remote-6', parentAuthHash: 'remote-5' },
      { epoch: 5, authHash: 'remote-5', parentAuthHash: 'remote' },
    ],
    now,
  })
}

test('retained parent links unify notices for the same split', () => {
  const { later, disconnected } = disconnectedNotices()
  const connected = connectNotices(disconnected.records)
  const survivorID = required(later.notices[0]).id
  const loserID = required(disconnected.notices.find((notice) => notice.id !== survivorID)).id
  expect(connected.notices.filter((notice) => notice.closedAt === null)).toHaveLength(1)
  expect(connected.notices.find((notice) => notice.closedAt === null)).toMatchObject({
    id: survivorID,
    splitEpoch: 4,
    detectedAt: 0,
    lastEvidenceAt: 2,
    revision: 2,
    acknowledgedAt: null,
  })
  expect(connected.notices.find((notice) => notice.id === loserID)).toMatchObject({
    closedAt: 2,
    closeReason: 'merged',
    mergedInto: survivorID,
    revision: 2,
  })
  const priorEvents = disconnected.records.filter((row) => row.kind === 'notice-event')
  for (const event of priorEvents)
    expect(connected.records.find((row) => row.id === event.id)).toEqual(event)
  const update = required(
    connected.records.find((row) => row.kind === 'notice-event' && row.id === `${survivorID}:2`),
  )
  expect(update).toMatchObject({
    event: {
      kind: 'fork-updated',
      mergedFrom: [loserID],
      notice: { acknowledgedRevision: 0, acknowledgedAt: null },
    },
    acknowledged: false,
    emitAt: 30000,
  })
  const replay = foldForkNotices({
    key,
    records: [...connected.records].reverse(),
    statements: [statement()],
    now: 3,
  })
  expect(replay.notices.filter((notice) => notice.closedAt === null)).toHaveLength(1)
  expect(replay.notices.map((notice) => notice.revision)).toEqual([2, 2])
  expect(replay.assignments.get('frame')).toBe(survivorID)
  const updateAgain = foldForkNotices({
    key,
    records: connected.records,
    statements: [statement({ keyHash: 'new-key' })],
    now: 4,
  })
  for (const event of connected.records.filter((row) => row.kind === 'notice-event'))
    expect(updateAgain.records.find((row) => row.id === event.id)).toEqual(event)
  const due = foldForkNotices({ key, records: updateAgain.records, statements: [], now: 30000 })
  expect(
    due.events
      .filter((event) => event.notice.id === survivorID)
      .map((event) => event.notice.revision),
  ).toEqual([1, 3])
})

test('merged notices preserve pending events and acknowledgements and union retained evidence', () => {
  const { later, disconnected } = disconnectedNotices()
  const survivorID = required(later.notices[0]).id
  const loserID = required(disconnected.notices.find((notice) => notice.id !== survivorID)).id
  const records = disconnected.records
  for (const row of records) {
    if (row.kind === 'notice') {
      row.notice.acknowledgedRevision = 1
      row.notice.acknowledgedAt = 1
    }
    if (row.kind === 'notice-event') row.acknowledged = true
  }
  const pending = foldForkNotices({
    key,
    records,
    statements: [statement({ keyHash: 'another-key' })],
    now: 2,
  })
  pending.records.push({
    kind: 'evidence',
    id: 'saved-evidence',
    key,
    noticeID: loserID,
    first: new Uint8Array([1]),
    second: new Uint8Array([2]),
    localRosterFact: new Uint8Array([3]),
    eligibilityRosterFact: new Uint8Array([4]),
  })
  const oldEvents = pending.records.filter((row) => row.kind === 'notice-event')
  const losing = required(
    pending.records.find((row) => row.kind === 'notice' && row.id === loserID),
  )
  if (losing.kind !== 'notice') throw new Error('Missing loser')
  losing.notice.lastEvidenceAt = 4
  losing.notice.coverage.evidence = { kind: 'partial', reasons: ['retention-gap'] }
  losing.notice.atRisk = [{ id: 'own-send', epoch: 4, authHash: 'local' }]
  required(losing.notice.branches.find((branch) => branch.authHash === 'local')).signers.push({
    signerDID: 'remote-did',
    keyHash: 'remote-key',
  })
  const merged = connectNotices(pending.records, 3)
  const survivor = required(merged.notices.find((notice) => notice.id === survivorID))
  expect(survivor).toMatchObject({
    revision: 2,
    acknowledgedRevision: 1,
    acknowledgedAt: null,
    detectedAt: 0,
    lastEvidenceAt: 4,
  })
  expect(survivor.coverage.evidence).toEqual({ kind: 'partial', reasons: ['retention-gap'] })
  expect(survivor.atRisk).toEqual([{ id: 'own-send', epoch: 4, authHash: 'local' }])
  expect(survivor.equivocations).toEqual([{ signerDID: 'remote-did', keyHash: 'remote-key' }])
  expect(survivor.branches.map((branch) => branch.authHash)).toEqual(['local', 'remote'])
  expect(survivor.branches.map((branch) => branch.firstSeenAt)).toEqual([0, 0])
  expect(survivor.branches.find((branch) => branch.authHash === 'remote')?.signers).toEqual([
    { signerDID: 'remote-did', keyHash: 'remote-key' },
    { signerDID: 'remote-did', keyHash: 'another-key' },
  ])
  expect(merged.notices.find((notice) => notice.id === loserID)).toMatchObject({
    revision: 3,
    acknowledgedRevision: 1,
    acknowledgedAt: null,
    closedAt: 3,
    mergedInto: survivorID,
  })
  for (const event of oldEvents)
    expect(merged.records.find((row) => row.id === event.id)).toEqual(event)
  expect(merged.records.find((row) => row.id === `${loserID}:3`)).toMatchObject({ emitAt: 30001 })
  expect(
    merged.records.filter((row) => row.kind === 'evidence').map((row) => row.noticeID),
  ).toEqual([loserID, survivorID])
})

test('equal detection times select the lexicographically smaller notice identity', () => {
  const { disconnected } = disconnectedNotices()
  const records = disconnected.records
  const ids = records.flatMap((row) => (row.kind === 'notice' ? [row.id] : []))
  const names = new Map([
    [ids[0], 'fork:z'],
    [ids[1], 'fork:a'],
  ])
  for (const row of records) {
    if (row.kind === 'notice') {
      row.id = required(names.get(row.id))
      row.notice.id = row.id
      row.notice.detectedAt = 0
    } else if (row.kind === 'notice-event') {
      row.event.notice.id = required(names.get(row.event.notice.id))
      row.event.notice.detectedAt = 0
      row.id = `${row.event.notice.id}:1`
      row.event.id = row.id
    }
  }
  const merged = connectNotices(records)
  expect(merged.notices.filter((notice) => notice.closedAt === null)).toMatchObject([
    { id: 'fork:a', splitEpoch: 4 },
  ])
  expect(merged.notices.find((notice) => notice.id === 'fork:z')).toMatchObject({
    closeReason: 'merged',
    mergedInto: 'fork:a',
  })
})

test('a shared local branch without retained remote ancestry cannot merge notices', () => {
  const { disconnected } = disconnectedNotices()
  const partial = foldForkNotices({
    key,
    records: disconnected.records,
    statements: [],
    now: 2,
    lineage: [
      { epoch: 6, authHash: 'local-6', parentAuthHash: 'local-5' },
      { epoch: 5, authHash: 'local-5', parentAuthHash: 'local' },
    ],
  })
  expect(partial.notices.filter((notice) => notice.closedAt === null)).toHaveLength(2)
  expect(partial.records.filter((row) => row.kind === 'notice-event')).toEqual(
    disconnected.records.filter((row) => row.kind === 'notice-event'),
  )
})

test('retained ancestry merges an additional branch into the same split', () => {
  const { disconnected } = disconnectedNotices()
  const distinct = foldForkNotices({
    key,
    records: disconnected.records,
    statements: [],
    now: 2,
    lineage: [
      { epoch: 6, authHash: 'local-6', parentAuthHash: 'local-5' },
      { epoch: 5, authHash: 'local-5', parentAuthHash: 'local' },
      { epoch: 6, authHash: 'remote-6', parentAuthHash: 'remote-5' },
      { epoch: 5, authHash: 'remote-5', parentAuthHash: 'other-split' },
    ],
  })
  expect(distinct.notices.filter((notice) => notice.closedAt === null)).toHaveLength(1)
  expect(
    required(distinct.notices.find((notice) => notice.closedAt === null)).branches.map(
      (branch) => branch.authHash,
    ),
  ).toEqual(['local', 'other-split', 'remote'])
})

test('notice folding copies nested records and evidence bytes', () => {
  const input = start().records
  input.push({
    kind: 'evidence',
    id: 'evidence',
    key,
    noticeID: required(input.find((row) => row.kind === 'notice')).id,
    first: new Uint8Array([1]),
    second: new Uint8Array([2]),
    localRosterFact: new Uint8Array([3]),
    eligibilityRosterFact: null,
  })
  const before = structuredClone(input)
  const changed = foldForkNotices({
    key,
    records: input,
    statements: [statement({ keyHash: 'new-key' })],
    now: 1,
  })
  expect(input).toEqual(before)
  const evidence = required(changed.records.find((row) => row.kind === 'evidence'))
  if (evidence.kind !== 'evidence') throw new Error('Missing evidence')
  evidence.first.fill(0)
  expect(input).toEqual(before)
})

test('merging notices does not hide a device branch switch', () => {
  const { later, disconnected } = disconnectedNotices()
  const connected = connectNotices(disconnected.records, 2, true)
  expect(
    connected.notices.find((notice) => notice.id === required(later.notices[0]).id),
  ).toMatchObject({
    deviceAuthHash: 'remote',
    closedAt: 2,
    revision: 2,
  })
})

test('a later split descending from one earlier branch remains distinct', () => {
  const { disconnected } = disconnectedNotices()
  const result = foldForkNotices({
    key,
    records: disconnected.records,
    statements: [],
    now: 2,
    lineage: [
      { epoch: 6, authHash: 'local-6', parentAuthHash: 'local-5' },
      { epoch: 5, authHash: 'local-5', parentAuthHash: 'local' },
      { epoch: 6, authHash: 'remote-6', parentAuthHash: 'remote-5' },
      { epoch: 5, authHash: 'remote-5', parentAuthHash: 'local' },
    ],
  })
  expect(result.notices.filter((notice) => notice.closedAt === null)).toHaveLength(2)
})

test('disconnected branch families retain separate notices', () => {
  const { disconnected } = disconnectedNotices()
  const result = foldForkNotices({
    key,
    records: disconnected.records,
    statements: [],
    now: 2,
    lineage: [
      { epoch: 6, authHash: 'local-6', parentAuthHash: 'local-5' },
      { epoch: 5, authHash: 'local-5', parentAuthHash: 'foreign-a' },
      { epoch: 6, authHash: 'remote-6', parentAuthHash: 'remote-5' },
      { epoch: 5, authHash: 'remote-5', parentAuthHash: 'foreign-b' },
    ],
  })
  expect(result.notices.filter((notice) => notice.closedAt === null)).toHaveLength(2)
})

test('intake keeps a later conflict distinct when both roots descend from one earlier branch', () => {
  const first = start()
  const later = statement({
    epoch: 6,
    authHash: 'remote-6',
    localAuthHash: 'local-6',
    parentAuthHash: 'remote-5',
    frameID: 'later-frame',
  })
  const lineage = [
    { epoch: 6, authHash: 'local-6', parentAuthHash: 'local-5' },
    { epoch: 5, authHash: 'local-5', parentAuthHash: 'local' },
    { epoch: 5, authHash: 'remote-5', parentAuthHash: 'local' },
  ]
  const intake = foldForkNotices({
    key,
    records: first.records,
    statements: [later],
    lineage,
    now: 1,
  })
  expect(intake.notices.filter((notice) => notice.closedAt === null)).toHaveLength(2)
  expect(intake.notices.find((notice) => notice.id === first.notices[0]?.id)).toEqual(
    first.notices[0],
  )
  const notice = required(intake.notices.find((notice) => notice.splitEpoch === 6))
  expect(intake.assignments.get('later-frame')).toBe(notice.id)
  expect(notice.branches.map((branch) => branch.authHash)).toEqual(['local-6', 'remote-6'])
  const replay = foldForkNotices({
    key,
    records: intake.records,
    statements: [later],
    lineage,
    now: 2,
  })
  expect(replay.notices).toHaveLength(2)
  expect(replay.assignments.get('later-frame')).toBe(notice.id)
  expect(replay.notices.find((row) => row.id === notice.id)?.revision).toBe(1)
})

test('replay hashes expire with their supporting installations', () => {
  const fact = {
    kind: 'fact' as const,
    id: 'current',
    key,
    epoch: 4,
    canonical: new Uint8Array([1]),
    supersededAt: null,
  }
  const marker = {
    kind: 'notice-tombstone' as const,
    id: 'notice-tombstone:closed',
    key,
    noticeID: 'closed',
    acknowledgedRevision: 2,
    acknowledgedAt: 10,
    frames: [
      { hash: 'expired-frame', installationID: 'expired' },
      { hash: 'retained-frame', installationID: 'current' },
    ],
  }
  expect(retainForkEvidence([marker], [fact], 604800011)).toEqual([
    { ...marker, frames: [{ hash: 'retained-frame', installationID: 'current' }] },
  ])
  expect(retainForkEvidence([marker], [], 604800011)).toEqual([])
  expect(marker.frames).toHaveLength(2)
})
