import { afterEach, describe, expect, test, vi } from 'vitest'

import { createMemoryControlStore } from '../../rpc-conformance/src/memory-control-store.js'
import { digestAppliedCommit } from '../src/classify.js'
import { encodeCommitFrame } from '../src/commit-frame.js'
import type { RecoveryVerdict } from '../src/crypto.js'
import { asLogPosition } from '../src/cursor.js'
import { decodeHandshakeFrame, encodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import { decodeRecoveryVerdict, encodeRecoveryConfirmRequest } from '../src/recovery.js'
import {
  confirmationTag,
  createRecoveryCache,
  responseOutcome,
  waitForRecoveryConfirmation,
} from '../src/recovery-confirmation.js'
import { commitTopic, rendezvousTopic } from '../src/topic.js'
import { publishCommit } from './fixtures/commits.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryGroupMLS, encodeMemoryCommit } from './fixtures/memory-group-mls.js'
import { makeMLSPeer } from './fixtures/peer.js'

describe('recovery ordering', { concurrent: false }, () => {
  afterEach(() => vi.useRealTimers())

  test.each([
    ['refused', false],
    ['refused', true],
    ['applied', false],
    ['applied', true],
  ] as const)(
    '%s copy at a reused position permits applicable bytes, restart %s',
    async (kind, restart) => {
      const hub = new FakeHub()
      const secret = new Uint8Array(32).fill(0x68)
      const position = 'shared'
      let genuine = false
      const first = encodeMemoryCommit(1, 'carol', [], { external: true })
      const next = encodeMemoryCommit(kind === 'applied' ? 2 : 1, 'bob', [], { external: true })
      const fetch = hub.fetchTopic.bind(hub)
      vi.spyOn(hub, 'fetchTopic').mockImplementation(async (params) =>
        params.topicID === commitTopic(secret)
          ? {
              messages: [
                {
                  sequenceID: position,
                  topicID: params.topicID,
                  senderDID: 'relay',
                  payload: encodeHandshakeFrame(
                    HANDSHAKE_KIND.commit,
                    encodeCommitFrame(genuine ? next : first, new Uint8Array()),
                  ),
                },
              ],
              head: position,
              oldest: position,
              gap: false,
            }
          : fetch(params),
      )
      const options = {
        members: ['alice', 'bob', 'carol'],
        acceptsCommitter: (did: string) => kind === 'applied' || did !== 'carol',
      }
      let alice = makeMLSPeer(hub, 'alice', secret, options)
      try {
        await alice.peer.replay()
        expect((await alice.control.load()).responses).toHaveLength(kind === 'applied' ? 1 : 0)
        if (restart) {
          await alice.peer.dispose()
          await alice.peer.drained()
          alice = makeMLSPeer(hub, 'alice', secret, { ...options, restartOf: alice })
          await alice.peer.replay()
        }
        genuine = true
        vi.useFakeTimers()
        await hub.publish({
          topicID: commitTopic(secret),
          senderDID: 'relay',
          payload: new Uint8Array([0]),
        })
        await vi.advanceTimersByTimeAsync(0)
        await alice.peer.ack('refresh')
        expect(alice.mls.epoch()).toBe(kind === 'applied' ? 3 : 2)
        expect((await alice.control.load()).responses).toEqual([
          expect.objectContaining({ position, digest: digestAppliedCommit(next), kind: 'applied' }),
        ])
      } finally {
        await alice.peer.dispose()
        await alice.peer.drained()
        vi.restoreAllMocks()
      }
    },
  )

  test.each([false, true])(
    'refusals are computed from request bytes across restart %s',
    async (restart) => {
      const hub = new FakeHub()
      const secret = new Uint8Array(32).fill(0x64)
      const commit = encodeMemoryCommit(1, 'bob', [], { external: true })
      await publishCommit({ hub, senderDID: 'bob', recoverySecret: secret, epoch: 1, commit })
      const options = {
        members: ['alice', 'bob', 'carol'],
        acceptsCommitter: (did: string) => did !== 'bob',
        recovery: { timeoutMs: 100, deadlineMs: 1000, getDelayMs: () => 0 },
      }
      let alice = makeMLSPeer(hub, 'alice', secret, options)
      try {
        await alice.peer.replay()
        expect((await alice.control.load()).responses).toEqual([])
        if (restart) {
          await alice.peer.dispose()
          await alice.peer.drained()
          alice = makeMLSPeer(hub, 'alice', secret, { ...options, restartOf: alice })
          await alice.peer.replay()
        }
        const bob = createMemoryGroupMLS({ members: options.members, localDID: 'bob' })
        const requestID = 'request-derived-refusal'
        const { request, requestKey } = await bob.createRecoveryRequest(requestID)
        vi.useFakeTimers()
        await hub.publish({
          topicID: rendezvousTopic(secret),
          senderDID: 'bob',
          retain: 'mailbox',
          payload: encodeHandshakeFrame(
            HANDSHAKE_KIND.recoveryConfirmRequest,
            encodeRecoveryConfirmRequest({
              requestID,
              request,
              position: 'substituted',
              commitDigest: digestAppliedCommit(commit),
              commit,
            }),
          ),
        })
        await vi.advanceTimersByTimeAsync(10)
        const verdicts = hub.published.filter(
          (row) =>
            row.topicID === rendezvousTopic(secret) &&
            decodeHandshakeFrame(row.payload).kind === HANDSHAKE_KIND.recoveryVerdict,
        )
        expect(verdicts).toHaveLength(1)
        const verdict = verdicts[0]
        if (verdict == null) throw new Error('Missing refusal')
        expect(
          (
            await bob.openRecoveryVerdict(
              decodeRecoveryVerdict(decodeHandshakeFrame(verdict.payload).payload).sealed,
              requestID,
              requestKey,
            )
          )?.verdict,
        ).toMatchObject({
          verdict: 'refused',
          refusalAuthority: 'authenticated-commit',
          position: 'substituted',
        })
        expect((await alice.control.load()).responses).toEqual([])
        expect(alice.mls.epoch()).toBe(1)
      } finally {
        await alice.peer.dispose()
        await alice.peer.drained()
        vi.restoreAllMocks()
      }
    },
  )

  test.each(['relays', 'distinct', 'long-position'] as const)(
    'refused %s leave no response rows and permit MLS progress',
    async (mode) => {
      const hub = new FakeHub()
      const secret = new Uint8Array(32).fill(0x65)
      const original = encodeMemoryCommit(1, 'bob', [], { external: true })
      await publishCommit({
        hub,
        senderDID: 'bob',
        recoverySecret: secret,
        epoch: 1,
        commit: original,
      })
      const frame = hub.published[0]
      if (frame == null) throw new Error('Missing commit')
      const fetch = hub.fetchTopic.bind(hub)
      let genuine = false
      vi.spyOn(hub, 'fetchTopic').mockImplementation(async (params) => {
        if (params.topicID !== commitTopic(secret)) return fetch(params)
        const messages = genuine
          ? [
              {
                ...frame,
                sequenceID: 'z',
                logPosition: 'z',
                payload: encodeHandshakeFrame(
                  HANDSHAKE_KIND.commit,
                  encodeCommitFrame(
                    encodeMemoryCommit(1, 'carol', [], { external: true }),
                    new Uint8Array(),
                  ),
                ),
              },
            ]
          : Array.from({ length: mode === 'long-position' ? 1 : 257 }, (_, index) => {
              const position =
                mode === 'long-position'
                  ? 'p'.repeat(1024 * 1024)
                  : `p${String(index).padStart(5, '0')}`
              const commit =
                mode === 'distinct'
                  ? encodeMemoryCommit(1, 'bob', [], { external: true, branch: String(index) })
                  : original
              return {
                ...frame,
                sequenceID: position,
                logPosition: position,
                payload: encodeHandshakeFrame(
                  HANDSHAKE_KIND.commit,
                  encodeCommitFrame(commit, new Uint8Array()),
                ),
              }
            })
        // Respect fetch pagination while allowing the reused-position reveal.
        const remaining = genuine
          ? messages
          : messages.filter((row) => params.after == null || row.sequenceID > params.after)
        return {
          messages: remaining.slice(0, params.limit),
          head: messages.at(-1)?.sequenceID ?? null,
          oldest: messages[0]?.sequenceID ?? null,
          gap: false,
        }
      })
      const options = {
        members: ['alice', 'bob', 'carol'],
        acceptsCommitter: (did: string) => did !== 'bob',
        recovery: { getDelayMs: () => 0 },
      }
      let alice = makeMLSPeer(hub, 'alice', secret, options)
      try {
        await alice.peer.replay()
        const bob = createMemoryGroupMLS({ localDID: 'bob', members: options.members })
        const requestID = 'flood-refusal'
        const { request, requestKey } = await bob.createRecoveryRequest(requestID)
        const refusedCommit =
          mode === 'distinct'
            ? encodeMemoryCommit(1, 'bob', [], { external: true, branch: '256' })
            : original
        vi.useFakeTimers()
        const ask = async () => {
          const before = hub.published.length
          await hub.publish({
            topicID: rendezvousTopic(secret),
            senderDID: 'bob',
            payload: encodeHandshakeFrame(
              HANDSHAKE_KIND.recoveryConfirmRequest,
              encodeRecoveryConfirmRequest({
                requestID,
                request,
                position: 'requested-alias',
                commitDigest: digestAppliedCommit(refusedCommit),
                commit: refusedCommit,
              }),
            ),
          })
          await vi.advanceTimersByTimeAsync(500)
          const verdicts = hub.published
            .slice(before)
            .filter(
              (row) =>
                row.topicID === rendezvousTopic(secret) &&
                decodeHandshakeFrame(row.payload).kind === HANDSHAKE_KIND.recoveryVerdict,
            )
          expect(verdicts).toHaveLength(1)
          const verdict = verdicts[0]
          if (verdict == null) throw new Error('Missing refusal')
          expect(
            (
              await bob.openRecoveryVerdict(
                decodeRecoveryVerdict(decodeHandshakeFrame(verdict.payload).payload).sealed,
                requestID,
                requestKey,
              )
            )?.verdict,
          ).toMatchObject({ verdict: 'refused', refusalAuthority: 'authenticated-commit' })
        }
        await ask()
        expect((await alice.control.load()).responses).toEqual([])
        expect(alice.mls.epoch()).toBe(1)
        await alice.peer.dispose()
        await alice.peer.drained()
        alice = makeMLSPeer(hub, 'alice', secret, { ...options, restartOf: alice })
        await alice.peer.replay()
        await ask()
        genuine = true
        await hub.publish({
          topicID: commitTopic(secret),
          senderDID: 'relay',
          payload: new Uint8Array([0]),
        })
        await vi.advanceTimersByTimeAsync(0)
        await alice.peer.ack('refresh')
        expect(alice.mls.epoch()).toBe(2)
        expect((await alice.control.load()).responses).toEqual([
          expect.objectContaining({ kind: 'applied' }),
        ])
      } finally {
        await alice.peer.dispose()
        await alice.peer.drained()
        vi.restoreAllMocks()
      }
    },
  )

  test('digest checks, dry-run memo bounds and epoch changes gate signed refusals', async () => {
    const hub = new FakeHub()
    const secret = new Uint8Array(32).fill(0x66)
    const members = ['alice', 'bob', 'carol']
    const alice = makeMLSPeer(hub, 'alice', secret, {
      members,
      acceptsCommitter: (did) => did !== 'bob',
      recovery: { timeoutMs: 100, deadlineMs: 1000, getDelayMs: () => 0 },
    })
    try {
      await alice.peer.replay()
      const bob = createMemoryGroupMLS({ members, localDID: 'bob' })
      const requestID = 'memo-authority'
      const { request } = await bob.createRecoveryRequest(requestID)
      const validate = vi.spyOn(alice.mls, 'validateRecoveryCommit')
      const verify = vi.spyOn(alice.mls, 'verifyRecoveryRequest')
      const commit = (index: number) =>
        encodeMemoryCommit(1, 'bob', [], { external: true, branch: String(index) })
      const verdicts = () =>
        hub.published.filter(
          (row) =>
            row.topicID === rendezvousTopic(secret) &&
            decodeHandshakeFrame(row.payload).kind === HANDSHAKE_KIND.recoveryVerdict,
        )
      vi.useFakeTimers()
      const ask = async (
        bytes: Uint8Array,
        digest = digestAppliedCommit(bytes),
        position = 'position',
      ) => {
        await hub.publish({
          topicID: rendezvousTopic(secret),
          senderDID: 'bob',
          payload: encodeHandshakeFrame(
            HANDSHAKE_KIND.recoveryConfirmRequest,
            encodeRecoveryConfirmRequest({
              requestID,
              request,
              position,
              commitDigest: digest,
              commit: bytes,
            }),
          ),
        })
        await vi.advanceTimersByTimeAsync(1)
      }
      await ask(commit(0), digestAppliedCommit(commit(1)))
      expect(verdicts()).toHaveLength(0)
      expect(verify).not.toHaveBeenCalled()
      expect(validate).not.toHaveBeenCalled()
      await ask(commit(0))
      await ask(commit(0), undefined, 'alias')
      expect(validate).toHaveBeenCalledTimes(1)
      expect(verdicts()).toHaveLength(2)
      for (let index = 1; index <= 64; index++) await ask(commit(index))
      expect(validate).toHaveBeenCalledTimes(65)
      await ask(commit(64))
      expect(validate).toHaveBeenCalledTimes(65)
      // The oldest of 65 distinct evaluations no longer occupies the 64-entry memo.
      await ask(commit(0))
      expect(validate).toHaveBeenCalledTimes(66)
      const count = verdicts().length
      await alice.mls.processCommit(encodeMemoryCommit(1, 'carol', [], { external: true }), {})
      await ask(commit(0))
      expect(verdicts()).toHaveLength(count)
      expect((await alice.control.load()).responses).toEqual([])
    } finally {
      await alice.peer.dispose()
      await alice.peer.drained()
      vi.restoreAllMocks()
    }
  })

  test.each(['valid', 'fault', 'unavailable', 'malformed', 'forged'] as const)(
    'request validation %s supplies no refusal',
    async (kind) => {
      const hub = new FakeHub()
      const secret = new Uint8Array(32).fill(0x67)
      const members = ['alice', 'bob']
      const alice = makeMLSPeer(hub, 'alice', secret, {
        members,
        recovery: { timeoutMs: 100, deadlineMs: 1000, getDelayMs: () => 0 },
      })
      try {
        await alice.peer.replay()
        const bob = createMemoryGroupMLS({ members, localDID: 'bob' })
        const requestID = 'unproven-validation'
        const { request } = await bob.createRecoveryRequest(requestID)
        const commit =
          kind === 'malformed'
            ? new Uint8Array([0])
            : encodeMemoryCommit(1, 'bob', [], {
                external: true,
                ...(kind === 'forged' ? { signerDID: 'mallory' } : {}),
              })
        if (kind === 'fault')
          vi.spyOn(alice.mls, 'validateRecoveryCommit').mockRejectedValue(new Error('local fault'))
        if (kind === 'unavailable')
          vi.spyOn(alice.mls, 'validateRecoveryCommit').mockResolvedValue({ epoch: 1 })
        vi.useFakeTimers()
        await hub.publish({
          topicID: rendezvousTopic(secret),
          senderDID: 'bob',
          payload: encodeHandshakeFrame(
            HANDSHAKE_KIND.recoveryConfirmRequest,
            encodeRecoveryConfirmRequest({
              requestID,
              request,
              position: 'arbitrary',
              commitDigest: digestAppliedCommit(commit),
              commit,
            }),
          ),
        })
        await vi.advanceTimersByTimeAsync(10)
        expect(
          hub.published.filter(
            (row) =>
              row.topicID === rendezvousTopic(secret) &&
              decodeHandshakeFrame(row.payload).kind === HANDSHAKE_KIND.recoveryVerdict,
          ),
        ).toHaveLength(0)
        expect(alice.mls.epoch()).toBe(1)
        expect((await alice.control.load()).responses).toEqual([])
      } finally {
        await alice.peer.dispose()
        await alice.peer.drained()
        vi.restoreAllMocks()
      }
    },
  )

  test.each(['refused', 'superseded'] as const)(
    'legacy %s responses stay advisory through persistence replay and outcome cache',
    async (kind) => {
      const port = createMemoryGroupMLS({ epoch: 3, localDID: 'alice' })
      const store = createMemoryControlStore({ groupID: 'advisory', incarnation: 1 })
      await store.apply(
        {
          putResponses: [
            {
              position: asLogPosition('accepted-position'),
              digest: 'accepted-commit',
              epoch: 1,
              kind,
              ...(kind === 'refused' ? { reason: 'invalid' as const } : {}),
            },
          ],
        },
        'saved-copy-failure',
      )
      const cache = createRecoveryCache<Awaited<ReturnType<typeof responseOutcome>>>()
      try {
        for (let restart = 0; restart < 2; restart++) {
          const row = (await store.load()).responses[0]
          const legacy = row ?? {
            position: 'accepted-position',
            digest: 'accepted-commit',
            epoch: 1,
            kind,
          }
          const outcome = await responseOutcome(port, {
            ...legacy,
            position: asLogPosition(legacy.position),
          })
          expect(outcome).toBeUndefined()
          cache.set('attempt', outcome, Date.now() + 1000)
          expect(cache.get('attempt')?.value).toBeUndefined()
        }
      } finally {
        cache.clear()
      }
    },
  )

  test('legacy authenticated refusal rows never replay terminally', async () => {
    const port = createMemoryGroupMLS({ epoch: 3, localDID: 'alice' })
    const response = {
      position: asLogPosition('refused-position'),
      digest: 'refused-commit',
      epoch: 1,
      kind: 'refused' as const,
      reason: 'policy' as const,
      refusalAuthority: 'authenticated-commit' as const,
    }
    expect(await responseOutcome(port, response)).toBeUndefined()
  })

  test.each(['refused', 'superseded'] as const)(
    'a signed unproven %s cannot settle an accepted recovery after requester restart',
    async (kind) => {
      const options = { members: ['alice', 'bob', 'carol'], groupID: 'accepted-unknown', epoch: 1 }
      const alice = createMemoryGroupMLS({ ...options, localDID: 'alice' })
      const bob = createMemoryGroupMLS({ ...options, localDID: 'bob' })
      const carol = createMemoryGroupMLS({ ...options, localDID: 'carol' })
      const requestID = 'accepted-request'
      const { request, requestKey } = await bob.createRecoveryRequest(requestID)
      const pending = await bob.applyRecovery(
        await alice.sealGroupInfo(request),
        requestID,
        requestKey,
      )
      if (pending == null || 'renewalRequired' in pending) throw new Error('Missing recovery')
      expect(await carol.processCommit(pending.commit, {})).toMatchObject({
        applied: true,
        epochAfter: pending.epoch,
      })
      await pending.confirmationKey('accepted-position', 'accepted-digest')
      const saved = pending.serialize()
      const verdict: RecoveryVerdict = {
        groupID: options.groupID,
        requestID,
        position: 'accepted-position',
        commitDigest: 'accepted-digest',
        ...(kind === 'refused'
          ? { verdict: 'refused', reason: 'invalid' }
          : { verdict: 'superseded' }),
      }
      const sealed = await alice.sealRecoveryVerdict(request, verdict)
      vi.useFakeTimers()
      for (const candidate of [
        pending,
        await bob.restoreRecovery(saved, requestKey),
        { ...pending, judgeVerdict: () => 'authoritative' as const },
      ]) {
        const key = await candidate.confirmationKey('accepted-position', 'accepted-digest')
        const waiters = new Map<
          string,
          { receive: (sealed: Uint8Array) => void; dispose: () => void }
        >()
        const result = waitForRecoveryConfirmation({
          port: bob,
          pending: candidate,
          groupID: options.groupID,
          requestID,
          requestKey,
          position: 'accepted-position',
          commitDigest: 'accepted-digest',
          key,
          deadline: Date.now() + 100,
          timeoutMs: 20,
          send: async () => {},
          waiters,
        })
        waiters.get(requestID)?.receive(sealed)
        waiters.get(requestID)?.receive(sealed)
        await vi.advanceTimersByTimeAsync(100)
        expect(await result).toMatchObject({
          kind: 'unconfirmed',
          advisory: [{ signer: 'alice', verdict }],
        })
        const reopened = await bob.restoreRecovery(candidate.serialize(), requestKey)
        expect(reopened.commit).toEqual(pending.commit)
        expect(await reopened.confirmationKey('accepted-position', 'accepted-digest')).toEqual(
          await pending.confirmationKey('accepted-position', 'accepted-digest'),
        )
        expect(bob.epoch()).toBe(1)
      }
    },
  )

  test('outcome caches evict oldest records at the cap and release secrets on expiry', async () => {
    vi.useFakeTimers()
    const release = vi.fn((value: Uint8Array) => value.fill(0))
    const cache = createRecoveryCache(release)
    const first = new Uint8Array([1])
    cache.set('0', first, Date.now() + 100)
    for (let index = 1; index <= 1024; index++)
      cache.set(String(index), new Uint8Array([1]), Date.now() + 100)
    expect(cache.get('0')).toBeUndefined()
    expect(first).toEqual(new Uint8Array([0]))
    expect(cache.get('1024')).toBeDefined()
    await vi.advanceTimersByTimeAsync(100)
    expect(cache.get('1024')).toBeUndefined()
    expect(release).toHaveBeenCalledTimes(1025)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('response keys are derived only at the adopted epoch', async () => {
    const port = createMemoryGroupMLS({ epoch: 3, localDID: 'alice' })
    const derive = vi.spyOn(port, 'confirmationKey')
    expect(
      await responseOutcome(port, {
        position: asLogPosition('accepted'),
        digest: 'commit',
        epoch: 1,
        epochAfter: 2,
        kind: 'applied',
      }),
    ).toBeUndefined()
    expect(derive).not.toHaveBeenCalled()
  })

  test.each([false, true])(
    'authenticated refusal settles while unproven superseded is advisory and confirmation wins: %s',
    async (confirm) => {
      const options = { members: ['alice', 'bob'], groupID: 'precedence' }
      const alice = createMemoryGroupMLS({ ...options, localDID: 'alice' })
      const bob = createMemoryGroupMLS({ ...options, localDID: 'bob' })
      const requestID = 'precedence-ask'
      const { request, requestKey } = await bob.createRecoveryRequest(requestID)
      const pending = await bob.applyRecovery(
        await alice.sealGroupInfo(request),
        requestID,
        requestKey,
      )
      if (pending == null || 'renewalRequired' in pending) throw new Error('No pending recovery')
      const position = 'position'
      const commitDigest = 'digest'
      const key = await pending.confirmationKey(position, commitDigest)
      const tag = confirmationTag(key, requestID)
      vi.useFakeTimers()
      const waiters = new Map<
        string,
        { receive: (sealed: Uint8Array) => void; dispose: () => void }
      >()
      const send = vi.fn(async () => {})
      const outcome = waitForRecoveryConfirmation({
        port: bob,
        pending,
        groupID: 'precedence',
        requestID,
        requestKey,
        position,
        commitDigest,
        key,
        deadline: Date.now() + 1000,
        timeoutMs: 100,
        send,
        waiters,
      })
      const receive = async (value: RecoveryVerdict) => {
        const sealed = await alice.sealRecoveryVerdict(request, value)
        waiters.get(requestID)?.receive(sealed)
        await vi.advanceTimersByTimeAsync(0)
      }
      const binding = { groupID: 'precedence', requestID, position, commitDigest }
      await receive({
        ...binding,
        verdict: 'refused',
        reason: 'floor',
        ...{ refusalAuthority: 'authenticated-commit' as const },
      })
      await vi.advanceTimersByTimeAsync(20)
      await receive({ ...binding, verdict: 'superseded' })
      if (confirm) {
        await receive({ ...binding, verdict: 'confirmed', epoch: pending.epoch, tag })
        expect(await outcome).toMatchObject({ kind: 'confirmed', position, epoch: pending.epoch })
        expect(vi.getTimerCount()).toBe(0)
      } else {
        await vi.advanceTimersByTimeAsync(80)
        expect(await outcome).toEqual({ kind: 'refused', refusal: 'floor', responder: 'alice' })
      }
      expect(waiters.size).toBe(0)
      expect(send).toHaveBeenCalledTimes(2)
      expect(key).toEqual(new Uint8Array(32))
    },
  )
})
