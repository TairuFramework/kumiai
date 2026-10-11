import type { HubFetchTopicResult } from '@kumiai/hub-tunnel'
import { sha256 } from '@noble/hashes/sha2.js'
import { toB64U } from '@sozai/codec'
import { expect, test, vi } from 'vitest'

import { classifyCommit } from '../src/classify.js'
import { encodeCommitFrame } from '../src/commit-frame.js'
import {
  type CertifiedControlRange,
  type ControlLogFrame,
  type ControlSearchDeps,
  type ControlSearchWork,
  createControlSearch,
  isCertifiedControlLoser,
} from '../src/control/search.js'
import type { AdoptionExpected, BuiltCommit } from '../src/control/types.js'
import { asLogPosition, type LogPosition } from '../src/cursor.js'
import { encodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'

const position = (value: number) => asLogPosition(String(value).padStart(6, '0'))
const digest = (bytes: Uint8Array) => toB64U(sha256(bytes))
const payload = (value: number) =>
  encodeHandshakeFrame(
    HANDSHAKE_KIND.commit,
    encodeCommitFrame(new Uint8Array([value]), new Uint8Array()),
  )
const source: AdoptionExpected & { identity: NonNullable<AdoptionExpected['identity']> } = {
  key: { groupID: 'search', incarnation: 1 },
  stateVersion: 1,
  identity: { groupID: 'search', incarnation: 1, epoch: 65, authenticator: new Uint8Array([7]) },
}
const built: BuiltCommit = {
  epoch: 65,
  incarnation: 1,
  authenticatorBefore: new Uint8Array([7]),
  searchFrom: position(100),
  expectedHead: position(100),
  publishID: 'own',
  payload: payload(2),
  payloadDigest: digest(payload(2)),
  digest: digest(new Uint8Array([2])),
  bodies: [],
  journal: new Uint8Array([3]),
  welcome: { bytes: new Uint8Array([4]), recipients: ['invitee'] },
}

function fixture(
  rows: Array<{ id: number; value: number }>,
  overrides: Partial<ControlSearchDeps> = {},
) {
  const validateFrame = vi.fn(async (frame: { payload: Uint8Array }) => ({
    kind: 'valid' as const,
    header: {
      epoch: 65,
      committerDID: digest(frame.payload) === built.payloadDigest ? 'own' : 'competitor',
    },
    own: digest(frame.payload) === built.payloadDigest,
    advanced: true,
    removed: false,
  }))
  const fetch = vi.fn(async (after: LogPosition | null) => ({
    messages: rows
      .filter((row) => after == null || position(row.id) > after)
      .map((row) => ({
        sequenceID: position(row.id),
        payload: payload(row.value),
        senderDID: 'publisher',
        topicID: 'commits',
        receivedAt: 1,
      })),
    head: rows.length === 0 ? position(100) : position(rows.at(-1)?.id ?? 100),
    oldest: position(rows[0]?.id ?? 100),
    gap: false,
  }))
  const followWinner = vi.fn(
    async (frame: ControlLogFrame, _range: CertifiedControlRange, _work: ControlSearchWork) => ({
      kind: 'applied' as const,
      position: frame.position,
    }),
  )
  const reconcileAbsent = vi.fn(async () => true)
  const hold = vi.fn(async () => {})
  const deps: ControlSearchDeps = {
    budget: { maxPasses: 2, maxFetches: 16, maxFrames: 256 },
    fetch,
    validation: {
      restoreValidation: async () => ({
        source,
        readCommitHeader: async () => ({ epoch: 65 }),
        validateFrame,
        verifyOwn: async () => true,
      }),
    },
    readEvidence: async () => ({
      source,
      applied: [],
      cursor: { position: position(100), epoch: 65 },
      terminal: false,
    }),
    followWinner,
    reconcileAbsent,
    hold,
    ...overrides,
  }
  return {
    search: createControlSearch(deps),
    deps,
    validateFrame,
    fetch,
    followWinner,
    reconcileAbsent,
    hold,
  }
}

test('first-valid lands on a trimmed log from its checkpoint', async () => {
  const f = fixture([{ id: 101, value: 2 }])
  expect(await f.search.searchLog(built)).toEqual({
    kind: 'first-valid',
    proof: {
      source,
      from: built.searchFrom,
      position: position(101),
      payloadDigest: built.payloadDigest,
    },
  })
  expect(f.fetch).toHaveBeenCalledWith(position(100))
  expect(f.validateFrame).toHaveBeenCalledOnce()
  expect(f.followWinner).not.toHaveBeenCalled()
})

test.each([
  'suffix gap',
  'matching-page gap',
  'empty nonterminal',
  'backward head',
  'out of order',
])('match never bypasses suffix or page gaps: %s', async (fault) => {
  const f = fixture([{ id: 101, value: 2 }])
  f.deps.fetch = async (): Promise<HubFetchTopicResult> => {
    const page = await f.fetch(position(100))
    if (fault.includes('gap')) return { ...page, gap: true }
    if (fault === 'empty nonterminal') return { ...page, messages: [] }
    if (fault === 'backward head') return { ...page, head: position(99) }
    return { ...page, messages: [...page.messages, ...page.messages] }
  }
  expect(await f.search.searchLog(built)).toEqual({ kind: 'unknown' })
  expect(f.followWinner).not.toHaveBeenCalled()
  expect(f.validateFrame).not.toHaveBeenCalled()
})

test('earlier valid competitor supersedes an alternate-ID exact own replay', async () => {
  const f = fixture([
    { id: 101, value: 1 },
    { id: 102, value: 2 },
  ])
  expect(await f.search.searchLog(built, position(999))).toEqual({
    kind: 'superseded',
    winner: position(101),
  })
  expect(f.followWinner).toHaveBeenCalledOnce()
  expect(f.followWinner.mock.calls[0]?.[1]).toMatchObject({
    winner: { position: position(101), payloadDigest: digest(payload(1)) },
    losers: [{ position: position(102), payloadDigest: built.payloadDigest }],
  })
})

test.each(['resolver', 'missing-proposal', 'missing-key', 'unrecognised'] as const)(
  'unavailable validation cannot hide an earlier winner: %s',
  async (reason) => {
    const f = fixture([
      { id: 101, value: 1 },
      { id: 102, value: 2 },
    ])
    f.deps.validation = {
      restoreValidation: async () => ({
        source,
        readCommitHeader: async () => ({ epoch: 65 }),
        validateFrame: async () => ({ kind: 'unavailable', reason }),
        verifyOwn: async () => true,
      }),
    }
    expect(await f.search.searchLog(built)).toEqual({ kind: 'unknown' })
    expect(f.followWinner).not.toHaveBeenCalled()
  },
)

test('validator and live winner disagreement holds', async () => {
  const f = fixture(
    [
      { id: 101, value: 1 },
      { id: 102, value: 2 },
    ],
    { followWinner: async () => ({ kind: 'refused' }) },
  )
  expect(await f.search.searchLog(built)).toEqual({ kind: 'unknown' })
})

test('already adopted own build requires committed full payload evidence', async () => {
  const advanced = {
    ...source,
    identity: { ...source.identity, epoch: 66, authenticator: new Uint8Array([8]) },
  }
  const f = fixture([{ id: 101, value: 2 }], {
    readEvidence: async () => ({
      source: advanced,
      applied: [],
      cursor: { position: position(101), epoch: 66 },
      terminal: false,
    }),
  })
  expect(await f.search.searchLog(built)).toEqual({ kind: 'unknown' })
  f.deps.readEvidence = async () => ({
    source: advanced,
    applied: [
      {
        epoch: 65,
        digest: built.digest,
        payloadDigest: built.payloadDigest,
        sequenceID: position(101),
        opID: 'own',
        removed: false,
      },
    ],
    cursor: { position: position(101), epoch: 66 },
    terminal: false,
  })
  expect(await f.search.searchLog(built)).toMatchObject({ kind: 'first-valid' })
})

test('committed own evidence must also match the commit digest', async () => {
  const f = fixture([{ id: 101, value: 2 }], {
    readEvidence: async () => ({
      source: { ...source, identity: { ...source.identity, epoch: 66 } },
      applied: [
        {
          epoch: 65,
          digest: 'conflicting-commit',
          payloadDigest: built.payloadDigest,
          sequenceID: position(101),
          opID: 'own',
          removed: false,
        },
      ],
      cursor: { position: position(101), epoch: 66 },
      terminal: false,
    }),
  })
  expect(await f.search.searchLog(built)).toEqual({ kind: 'unknown' })
  expect(f.hold).toHaveBeenCalledWith(expect.objectContaining({ reason: 'fork-evidence' }))
})

test('conflicting committed evidence discards a budget continuation before resuming', async () => {
  const f = fixture(
    [
      { id: 101, value: 1 },
      { id: 102, value: 2 },
    ],
    { budget: { maxPasses: 2, maxFetches: 16, maxFrames: 1 } },
  )
  expect(await f.search.searchLog(built)).toEqual({ kind: 'unknown' })
  f.deps.readEvidence = async () => ({
    source: { ...source, identity: { ...source.identity, epoch: 66 } },
    applied: [
      {
        epoch: 65,
        digest: 'branch',
        payloadDigest: 'other',
        sequenceID: position(101),
        opID: null,
        removed: false,
      },
    ],
    cursor: { position: position(101), epoch: 66 },
    terminal: false,
  })
  expect(await f.search.searchLog(built)).toEqual({ kind: 'unknown' })
  expect(f.fetch).toHaveBeenCalledTimes(1)
  expect(f.hold).toHaveBeenCalledWith(expect.objectContaining({ reason: 'fork-evidence' }))
})

test.each(['gap', 'backward head'] as const)(
  'coverage is checked again on later suffix pages: %s',
  async (fault) => {
    const f = fixture([
      { id: 101, value: 1 },
      { id: 102, value: 2 },
    ])
    f.deps.validation = {
      restoreValidation: async () => ({
        source,
        readCommitHeader: async () => ({ epoch: 65 }),
        validateFrame: async () => ({ kind: 'invalid', reason: 'policy' }),
        verifyOwn: async () => true,
      }),
    }
    f.deps.fetch = async (after) => {
      const page = await f.fetch(after)
      if (after === position(100)) return { ...page, messages: page.messages.slice(0, 1) }
      return fault === 'gap' ? { ...page, gap: true } : { ...page, head: position(101) }
    }
    expect(await f.search.searchLog(built)).toEqual({ kind: 'unknown' })
    expect(f.followWinner).not.toHaveBeenCalled()
    expect(f.reconcileAbsent).not.toHaveBeenCalled()
  },
)

test('fetch exhaustion within one pass resumes at the validated page boundary', async () => {
  const f = fixture(
    [
      { id: 101, value: 0 },
      { id: 102, value: 2 },
    ],
    { budget: { maxPasses: 2, maxFetches: 1, maxFrames: 256 } },
  )
  f.deps.fetch = async (after) => {
    const page = await f.fetch(after)
    return { ...page, messages: page.messages.slice(0, 1) }
  }
  f.deps.validation = {
    restoreValidation: async () => ({
      source,
      readCommitHeader: async () => ({ epoch: 65 }),
      validateFrame: async (frame) =>
        digest(frame.payload) === built.payloadDigest
          ? { kind: 'valid', header: { epoch: 65 }, own: true, advanced: true, removed: false }
          : { kind: 'invalid', reason: 'policy' },
      verifyOwn: async () => true,
    }),
  }
  expect(await f.search.searchLog(built)).toEqual({ kind: 'unknown' })
  expect(await f.search.searchLog(built)).toMatchObject({ kind: 'first-valid' })
  expect(f.fetch.mock.calls.map(([after]) => after)).toEqual([position(100), position(101)])
})

test('older suffix replays require retained applied evidence', async () => {
  const f = fixture([
    { id: 101, value: 1 },
    { id: 102, value: 2 },
  ])
  f.deps.validation = {
    restoreValidation: async () => ({
      source,
      readCommitHeader: async (commit) => ({ epoch: commit[0] === 1 ? 64 : 65 }),
      validateFrame: f.validateFrame,
      verifyOwn: async () => true,
    }),
  }
  expect(await f.search.searchLog(built)).toEqual({ kind: 'unknown' })
  f.deps.readEvidence = async () => ({
    source,
    applied: [
      {
        epoch: 64,
        digest: digest(new Uint8Array([1])),
        payloadDigest: digest(payload(1)),
        sequenceID: position(50),
        opID: null,
        removed: false,
      },
    ],
    cursor: { position: position(100), epoch: 65 },
    terminal: false,
  })
  expect(await f.search.searchLog(built)).toMatchObject({ kind: 'first-valid' })
})

test('older suffix conflicts with a present applied row are skippable', async () => {
  const f = fixture([
    { id: 101, value: 1 },
    { id: 102, value: 2 },
  ])
  f.deps.validation = {
    restoreValidation: async () => ({
      source,
      readCommitHeader: async (commit) => ({ epoch: commit[0] === 1 ? 64 : 65 }),
      validateFrame: f.validateFrame,
      verifyOwn: async () => true,
    }),
  }
  f.deps.readEvidence = async () => ({
    source,
    applied: [
      {
        epoch: 64,
        digest: 'other',
        payloadDigest: 'other',
        sequenceID: position(50),
        opID: null,
        removed: false,
      },
    ],
    cursor: { position: position(100), epoch: 65 },
    terminal: false,
  })
  expect(await f.search.searchLog(built)).toMatchObject({
    kind: 'first-valid',
    proof: { position: position(102) },
  })
})

test('committed own occurrence beyond a captured empty head forbids absence', async () => {
  const f = fixture([], {
    readEvidence: async () => ({
      source: { ...source, identity: { ...source.identity, epoch: 66 } },
      applied: [
        {
          epoch: 65,
          digest: built.digest,
          payloadDigest: built.payloadDigest,
          sequenceID: position(101),
          opID: 'own',
          removed: false,
        },
      ],
      cursor: { position: position(101), epoch: 66 },
      terminal: false,
    }),
  })
  expect(built.epoch).toBe(65)
  expect(built.searchFrom).toBe(position(100))
  expect(await f.search.searchLog(built)).toEqual({ kind: 'unknown' })
  expect(f.hold).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'acceptance-unknown' }))
  expect(f.followWinner).not.toHaveBeenCalled()
})

test('retired keys never follow a successor incarnation', async () => {
  const f = fixture(
    [
      { id: 101, value: 1 },
      { id: 102, value: 2 },
    ],
    {
      readEvidence: async () => ({
        source: { ...source, key: { ...source.key, incarnation: 2 }, identity: null },
        applied: [],
        cursor: null,
        terminal: true,
      }),
    },
  )
  expect(await f.search.searchLog(built)).toEqual({ kind: 'unknown' })
  expect(f.fetch).not.toHaveBeenCalled()
  expect(f.followWinner).not.toHaveBeenCalled()
  expect(f.hold).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'acceptance-unknown' }))
})

test('budget yields preserve discovery through a prefix larger than one invocation', async () => {
  const rows = Array.from({ length: 300 }, (_, index) => ({
    id: 101 + index,
    value: index === 299 ? 2 : 0,
  }))
  const f = fixture(rows)
  f.deps.validation = {
    restoreValidation: async () => ({
      source,
      readCommitHeader: async () => ({ epoch: 65 }),
      validateFrame: async (frame) =>
        digest(frame.payload) === built.payloadDigest
          ? { kind: 'valid', header: { epoch: 65 }, own: true, advanced: true, removed: false }
          : { kind: 'invalid', reason: 'non-commit' },
      verifyOwn: async () => true,
    }),
  }
  expect(await f.search.searchLog(built)).toEqual({ kind: 'unknown' })
  expect(await f.search.searchLog(built)).toMatchObject({
    kind: 'first-valid',
    proof: { position: position(400) },
  })
  expect(f.fetch.mock.calls[1]?.[0]).toBe(position(356))
  const restart = createControlSearch(f.deps)
  expect(await restart.searchLog(built)).toEqual({ kind: 'unknown' })
  expect(f.fetch.mock.calls[2]?.[0]).toBe(position(100))
})

test('a different saved slot invalidates budget discovery', async () => {
  const f = fixture(
    [
      { id: 101, value: 1 },
      { id: 102, value: 2 },
    ],
    { budget: { maxPasses: 2, maxFetches: 16, maxFrames: 1 } },
  )
  expect(await f.search.searchLog(built)).toEqual({ kind: 'unknown' })
  expect(await f.search.searchLog({ ...built, journal: new Uint8Array([9]) })).toEqual({
    kind: 'unknown',
  })
  expect(f.fetch.mock.calls.map(([after]) => after)).toEqual([position(100), position(100)])
})

test.each(['malformed', 'authentication', 'policy'] as const)(
  'conclusive authentication or policy rejection is skippable poison: %s',
  async (reason) => {
    const f = fixture([
      { id: 101, value: 1 },
      { id: 102, value: 2 },
    ])
    f.deps.validation = {
      restoreValidation: async () => ({
        source,
        readCommitHeader: async () => ({ epoch: 65 }),
        validateFrame: async (frame) =>
          digest(frame.payload) === built.payloadDigest
            ? { kind: 'valid', header: { epoch: 65 }, own: true, advanced: true, removed: false }
            : { kind: 'invalid', reason },
        verifyOwn: async () => true,
      }),
    }
    expect(await f.search.searchLog(built)).toMatchObject({
      kind: 'first-valid',
      proof: { position: position(102) },
    })
    expect(f.followWinner).not.toHaveBeenCalled()
  },
)

test('first-valid self-removal wins without epoch advance', async () => {
  const f = fixture([
    { id: 101, value: 1 },
    { id: 102, value: 2 },
  ])
  const restore = f.deps.validation.restoreValidation
  f.deps.validation = {
    restoreValidation: async (value) => {
      const validation = await restore(value)
      if (validation === null) throw new Error('missing validator')
      return {
        ...validation,
        validateFrame: async (frame, value) => {
          const result = await validation.validateFrame(frame, value)
          return result.kind !== 'valid' || result.own
            ? result
            : { ...result, advanced: false, removed: true }
        },
      }
    },
  }
  expect(await f.search.searchLog(built)).toEqual({ kind: 'superseded', winner: position(101) })
})

test('unavailable header cannot hide an earlier winner', async () => {
  const f = fixture([
    { id: 101, value: 1 },
    { id: 102, value: 2 },
  ])
  f.deps.validation = {
    restoreValidation: async () => ({
      source,
      readCommitHeader: async () => {
        throw new Error('retained key unavailable')
      },
      validateFrame: f.validateFrame,
      verifyOwn: async () => true,
    }),
  }
  expect(await f.search.searchLog(built)).toEqual({ kind: 'unknown' })
  expect(f.followWinner).not.toHaveBeenCalled()
  expect(f.validateFrame).not.toHaveBeenCalled()
})

test.each(['unsupported-version', 'unexplained-own'] as const)(
  'unsupported semantics and alternate own bytes retain a diagnostic hold: %s',
  async (reason) => {
    const f = fixture([
      { id: 101, value: 1 },
      { id: 102, value: 2 },
    ])
    f.deps.validation = {
      restoreValidation: async () => ({
        source,
        readCommitHeader: async () => ({ epoch: 65 }),
        validateFrame: async () => ({ kind: 'unavailable', reason }),
        verifyOwn: async () => true,
      }),
    }
    expect(await f.search.searchLog(built)).toEqual({ kind: 'unknown' })
    expect(f.hold).toHaveBeenLastCalledWith(
      expect.objectContaining({
        reason: reason === 'unsupported-version' ? 'unsupported-version' : 'fork-evidence',
        position: position(101),
        ...(reason === 'unexplained-own'
          ? {
              evidence: {
                kind: 'unexplained-own-commit',
                epoch: 65,
                position: position(101),
                digest: digest(new Uint8Array([1])),
              },
            }
          : {}),
      }),
    )
    expect(f.followWinner).not.toHaveBeenCalled()
  },
)

test('same-epoch authenticator divergence holds as fork evidence', async () => {
  const f = fixture([{ id: 101, value: 2 }], {
    readEvidence: async () => ({
      source: { ...source, identity: { ...source.identity, authenticator: new Uint8Array([9]) } },
      applied: [],
      cursor: null,
      terminal: false,
    }),
  })
  expect(await f.search.searchLog(built)).toEqual({ kind: 'unknown' })
  expect(f.hold).toHaveBeenCalledWith(
    expect.objectContaining({
      reason: 'fork-evidence',
      evidence: expect.objectContaining({ kind: 'epoch-authenticator' }),
    }),
  )
  expect(f.fetch).not.toHaveBeenCalled()
})

test('a conflicting committed branch holds as evidence', async () => {
  const f = fixture([{ id: 101, value: 2 }], {
    readEvidence: async () => ({
      source: { ...source, identity: { ...source.identity, epoch: 66 } },
      applied: [
        {
          epoch: 65,
          digest: 'branch',
          payloadDigest: 'other-full-bytes',
          sequenceID: position(101),
          opID: null,
          removed: false,
        },
      ],
      cursor: { position: position(101), epoch: 66 },
      terminal: false,
    }),
  })
  expect(await f.search.searchLog(built)).toEqual({ kind: 'unknown' })
  expect(f.hold).toHaveBeenLastCalledWith(
    expect.objectContaining({
      reason: 'fork-evidence',
      evidence: expect.objectContaining({ kind: 'digest-divergence' }),
    }),
  )
})

test('certification excludes only listed loser bytes', () => {
  const range: CertifiedControlRange = {
    key: source.key,
    source: source.identity,
    from: position(100),
    through: position(103),
    winner: { position: position(101), payloadDigest: 'winner' },
    losers: [{ position: position(102), payloadDigest: 'loser' }],
  }
  expect(isCertifiedControlLoser(range, source.key, 65, position(102), 'loser')).toBe(true)
  for (const [at, bytes] of [
    [position(102), 'different'],
    [position(103), 'loser'],
    [position(104), 'loser'],
  ] as const) {
    expect(isCertifiedControlLoser(range, source.key, 65, at, bytes)).toBe(false)
    expect(
      classifyCommit({
        header: { epoch: 65 },
        sequenceID: at,
        commitDigest: bytes,
        state: {
          localDID: 'own',
          epoch: 66,
          appliedByEpoch: new Map([
            [
              65,
              {
                epoch: 65,
                digest: 'winner',
                payloadDigest: 'winner',
                sequenceID: position(101),
                opID: null,
                removed: false,
              },
            ],
          ]),
        },
      }),
    ).toMatchObject({ row: 'fork' })
  }
  expect(
    isCertifiedControlLoser(range, { ...source.key, incarnation: 2 }, 65, position(102), 'loser'),
  ).toBe(false)
})

test('head advances every pass and search returns unknown within its work budget', async () => {
  let head = 100
  let frames = 0
  const rows: Array<{
    sequenceID: string
    payload: Uint8Array
    senderDID: string
    topicID: string
    receivedAt: number
  }> = []
  const f = fixture([], {
    fetch: async (after) => {
      head++
      rows.push({
        sequenceID: position(head),
        payload: payload(0),
        senderDID: 'publisher',
        topicID: 'commits',
        receivedAt: 1,
      })
      return {
        messages: rows.filter((row) => after === null || row.sequenceID > after),
        head: position(head),
        oldest: position(101),
        gap: false,
      }
    },
    validation: {
      restoreValidation: async () => ({
        source,
        readCommitHeader: async () => ({ epoch: 65 }),
        validateFrame: async () => {
          frames++
          return { kind: 'invalid', reason: 'policy' }
        },
        verifyOwn: async () => true,
      }),
    },
  })
  expect(await f.search.searchLog(built)).toEqual({ kind: 'unknown' })
  expect(head - 100).toBeLessThanOrEqual(16)
  expect(frames).toBeLessThanOrEqual(256)
  expect(f.reconcileAbsent).toHaveBeenCalledTimes(2)
  expect(f.followWinner).not.toHaveBeenCalled()
})

test.each(['fetch', 'frame'] as const)(
  'budget reserves %s units shared with live reconciliation',
  async (limit) => {
    const f = fixture(
      [
        { id: 101, value: 1 },
        { id: 102, value: 2 },
      ],
      {
        budget: {
          maxPasses: 2,
          maxFetches: limit === 'fetch' ? 1 : 16,
          maxFrames: limit === 'frame' ? 2 : 256,
        },
        followWinner: async (_frame, _range, work) => {
          if (!(limit === 'fetch' ? work.takeFetch() : work.takeFrame()))
            return { kind: 'unavailable' }
          return { kind: 'applied', position: position(101) }
        },
      },
    )
    expect(await f.search.searchLog(built)).toEqual({ kind: 'unknown' })
    expect(f.reconcileAbsent).not.toHaveBeenCalled()
  },
)

test('version-only movement preserves discovery and refreshes the proof', async () => {
  const f = fixture(
    [
      { id: 101, value: 0 },
      { id: 102, value: 2 },
    ],
    { budget: { maxPasses: 2, maxFetches: 16, maxFrames: 1 } },
  )
  f.deps.validation = {
    restoreValidation: async () => ({
      source,
      readCommitHeader: async () => ({ epoch: 65 }),
      validateFrame: async (frame) =>
        digest(frame.payload) === built.payloadDigest
          ? { kind: 'valid', header: { epoch: 65 }, own: true, advanced: true, removed: false }
          : { kind: 'invalid', reason: 'policy' },
      verifyOwn: async () => true,
    }),
  }
  expect(await f.search.searchLog(built)).toEqual({ kind: 'unknown' })
  f.deps.readEvidence = async () => ({
    source: { ...source, stateVersion: 2 },
    applied: [],
    cursor: { position: position(100), epoch: 65 },
    terminal: false,
  })
  expect(await f.search.searchLog(built)).toMatchObject({
    kind: 'first-valid',
    proof: { source: { stateVersion: 2 } },
  })
  expect(f.fetch.mock.calls[1]?.[0]).toBe(position(101))
})

test('complete absence requires reconciliation and a stable bounded head', async () => {
  const f = fixture([])
  expect(await f.search.searchLog(built)).toEqual({ kind: 'absent' })
  expect(f.reconcileAbsent).toHaveBeenCalledWith(position(100), null, expect.any(Object))
  f.deps.reconcileAbsent = async () => false
  expect(await f.search.searchLog(built)).toEqual({ kind: 'unknown' })
})
