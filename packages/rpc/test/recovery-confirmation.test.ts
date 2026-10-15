import { afterEach, describe, expect, test, vi } from 'vitest'

import { createMemoryControlStore } from '../../rpc-conformance/src/memory-control-store.js'
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
import { publishCommit, publishedCommitDigest } from './fixtures/commits.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryGroupMLS } from './fixtures/memory-group-mls.js'
import { makeMLSPeer } from './fixtures/peer.js'

describe('recovery ordering', { concurrent: false }, () => {
  afterEach(() => vi.useRealTimers())

  test.each([
    ['refused', false],
    ['refused', true],
    ['applied', false],
    ['applied', true],
  ] as const)(
    '%s copy at a reused position permits a later applicable commit (restart %s)',
    async (firstKind, restart) => {
      const hub = new FakeHub()
      const other = new FakeHub()
      const secret = new Uint8Array(32).fill(0x65)
      const wantedEpoch = firstKind === 'refused' ? 1 : 2
      const { sequenceID: position } = await publishCommit({
        hub,
        senderDID: 'bob',
        recoverySecret: secret,
        epoch: wantedEpoch,
        external: true,
      })
      await publishCommit({
        hub: other,
        senderDID: 'carol',
        recoverySecret: secret,
        epoch: 1,
        external: true,
      })
      const target = hub.published[0]
      const copy = other.published[0]
      if (target == null || copy == null) throw new Error('Missing commits')
      const digest = publishedCommitDigest(hub, position)
      let deliverGenuine = false
      const fetch = hub.fetchTopic.bind(hub)
      vi.spyOn(hub, 'fetchTopic').mockImplementation(async (params) => {
        if (params.topicID !== commitTopic(secret)) return fetch(params)
        return {
          messages: [
            { ...(deliverGenuine ? target : copy), sequenceID: position, logPosition: position },
          ],
          head: position,
          oldest: position,
          gap: false,
        }
      })
      const options = {
        members: ['alice', 'bob', 'carol'],
        acceptsCommitter: (did: string) => firstKind === 'applied' || did !== 'carol',
        recovery: { timeoutMs: 100, deadlineMs: 1000, getDelayMs: () => 50 },
      }
      let alice = makeMLSPeer(hub, 'alice', secret, options)
      try {
        await alice.peer.replay()
        const original = (await alice.control.load()).responses[0]
        expect(original).toMatchObject({ position, kind: firstKind })
        expect(alice.mls.epoch()).toBe(wantedEpoch)
        if (restart) {
          await alice.peer.dispose()
          await alice.peer.drained()
          alice = makeMLSPeer(hub, 'alice', secret, { ...options, restartOf: alice })
          await alice.peer.replay()
          expect((await alice.control.load()).responses).toContainEqual(original)
        }
        const process = vi.spyOn(alice.mls, 'processCommit')
        deliverGenuine = true
        vi.useFakeTimers()
        await hub.publish({
          topicID: commitTopic(secret),
          senderDID: 'relay',
          payload: new Uint8Array([0]),
        })
        await vi.advanceTimersByTimeAsync(0)
        await alice.peer.ack('refresh')
        expect(process).toHaveBeenCalled()
        expect(alice.mls.epoch()).toBe(wantedEpoch + 1)
        const responses = (await alice.control.load()).responses
        expect(responses).toContainEqual(original)
        expect(responses).toContainEqual({
          position,
          digest,
          epoch: wantedEpoch,
          kind: 'applied',
          epochAfter: wantedEpoch + 1,
        })
        if (firstKind === 'refused' && original != null) {
          const bob = createMemoryGroupMLS({ members: options.members, localDID: 'bob' })
          const requestID = 'preserved-copy-refusal'
          const { request, requestKey } = await bob.createRecoveryRequest(requestID)
          await hub.publish({
            topicID: rendezvousTopic(secret),
            senderDID: 'bob',
            retain: 'mailbox',
            payload: encodeHandshakeFrame(
              HANDSHAKE_KIND.recoveryConfirmRequest,
              encodeRecoveryConfirmRequest({
                requestID,
                request,
                position,
                commitDigest: original.digest,
              }),
            ),
          })
          await vi.advanceTimersByTimeAsync(50)
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
            commitDigest: original.digest,
            refusalAuthority: 'authenticated-commit',
          })
        }
      } finally {
        await alice.peer.dispose()
        await alice.peer.drained()
        vi.restoreAllMocks()
      }
    },
  )

  test('a conflicting commit copy cannot replace an authenticated refusal across responder restart', async () => {
    const hub = new FakeHub()
    const secret = new Uint8Array(32).fill(0x64)
    const { sequenceID: position } = await publishCommit({
      hub,
      senderDID: 'bob',
      recoverySecret: secret,
      epoch: 1,
      external: true,
    })
    const digest = publishedCommitDigest(hub, position)
    const copiedHub = new FakeHub()
    const copied = await publishCommit({
      hub: copiedHub,
      senderDID: 'carol',
      recoverySecret: secret,
      epoch: 1,
      external: true,
    })
    const copiedDigest = publishedCommitDigest(copiedHub, copied.sequenceID)
    const message = copiedHub.published[0]
    if (message == null) throw new Error('Missing copied commit')
    expect(copiedDigest).not.toBe(digest)
    const options = {
      members: ['alice', 'bob', 'carol'],
      acceptsCommitter: () => false,
      recovery: { timeoutMs: 100, deadlineMs: 1000, getDelayMs: () => 50 },
    }
    let alice = makeMLSPeer(hub, 'alice', secret, options)
    const bob = createMemoryGroupMLS({ members: options.members, localDID: 'bob' })
    const requestID = 'preserved-refusal'
    const { request, requestKey } = await bob.createRecoveryRequest(requestID)
    const ask = (commitDigest: string) =>
      hub.publish({
        topicID: rendezvousTopic(secret),
        senderDID: 'bob',
        retain: 'mailbox',
        payload: encodeHandshakeFrame(
          HANDSHAKE_KIND.recoveryConfirmRequest,
          encodeRecoveryConfirmRequest({ requestID, request, position, commitDigest }),
        ),
      })
    try {
      await alice.peer.replay()
      const original = (await alice.control.load()).responses[0]
      expect(original).toMatchObject({
        position,
        digest,
        kind: 'refused',
        refusalAuthority: 'authenticated-commit',
      })
      vi.useFakeTimers()
      const seal = vi.spyOn(alice.mls, 'sealRecoveryVerdict')
      await ask(digest)
      await vi.advanceTimersByTimeAsync(0)
      expect(seal).toHaveBeenCalledOnce()
      const fetch = hub.fetchTopic.bind(hub)
      let replayCopy = true
      vi.spyOn(hub, 'fetchTopic').mockImplementation(async (params) => {
        if (replayCopy && params.topicID === commitTopic(secret)) {
          replayCopy = false
          return {
            messages: [{ ...message, sequenceID: position, logPosition: position }],
            head: position,
            oldest: position,
            gap: false,
          }
        }
        return fetch(params)
      })
      await hub.publish({
        topicID: commitTopic(secret),
        senderDID: 'relay',
        payload: new Uint8Array([0]),
      })
      await vi.advanceTimersByTimeAsync(0)
      await alice.peer.ack('refresh')
      expect(replayCopy).toBe(false)
      const responses = (await alice.control.load()).responses
      expect(responses).toHaveLength(2)
      expect(responses).toContainEqual(original)
      expect(responses).toContainEqual({ ...original, digest: copiedDigest })
      await vi.advanceTimersByTimeAsync(50)
      const verdicts = () =>
        hub.published.filter(
          (row) =>
            row.topicID === rendezvousTopic(secret) &&
            decodeHandshakeFrame(row.payload).kind === HANDSHAKE_KIND.recoveryVerdict,
        )
      expect(verdicts()).toHaveLength(1)
      await alice.peer.dispose()
      await alice.peer.drained()
      alice = makeMLSPeer(hub, 'alice', secret, { ...options, restartOf: alice })
      await alice.peer.replay()
      expect((await alice.control.load()).responses).toEqual(responses)
      await ask(digest)
      await vi.advanceTimersByTimeAsync(50)
      expect(verdicts()).toHaveLength(2)
      for (const verdict of verdicts()) {
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
          commitDigest: digest,
          refusalAuthority: 'authenticated-commit',
        })
      }
      await ask(copiedDigest)
      await vi.advanceTimersByTimeAsync(100)
      expect(verdicts()).toHaveLength(3)
      const copiedVerdict = verdicts()[2]
      if (copiedVerdict == null) throw new Error('Missing copied-commit refusal')
      expect(
        (
          await bob.openRecoveryVerdict(
            decodeRecoveryVerdict(decodeHandshakeFrame(copiedVerdict.payload).payload).sealed,
            requestID,
            requestKey,
          )
        )?.verdict,
      ).toMatchObject({
        verdict: 'refused',
        commitDigest: copiedDigest,
        refusalAuthority: 'authenticated-commit',
      })
      await ask('unseen-digest')
      await vi.advanceTimersByTimeAsync(100)
      expect(verdicts()).toHaveLength(3)
    } finally {
      await alice.peer.dispose()
      await alice.peer.drained()
      vi.restoreAllMocks()
    }
  })

  test('one refused commit relayed at fresh positions retains one response across restart', async () => {
    const hub = new FakeHub()
    const origin = new FakeHub()
    const secret = new Uint8Array(32).fill(0x7a)
    await publishCommit({
      hub: origin,
      senderDID: 'carol',
      recoverySecret: secret,
      epoch: 1,
      external: true,
    })
    const genuine = origin.published[0]
    if (genuine == null) throw new Error('Missing genuine commit')
    let page: typeof origin.published = []
    const fetch = hub.fetchTopic.bind(hub)
    vi.spyOn(hub, 'fetchTopic').mockImplementation(async (params) => {
      if (params.topicID !== commitTopic(secret)) return fetch(params)
      return {
        messages: page,
        head: page.at(-1)?.sequenceID ?? null,
        oldest: page[0]?.sequenceID ?? null,
        gap: false,
      }
    })
    const options = { members: ['alice', 'bob', 'carol'], acceptsCommitter: () => false }
    let alice = makeMLSPeer(hub, 'alice', secret, options)
    try {
      await alice.peer.replay()
      vi.useFakeTimers()
      for (let batch = 0; batch < 3; batch++) {
        page = Array.from({ length: 80 }, (_, index) => {
          const position = String(batch * 80 + index + 1).padStart(12, '0')
          return { ...genuine, sequenceID: position, logPosition: position }
        })
        await hub.publish({
          topicID: commitTopic(secret),
          senderDID: 'relay',
          payload: new Uint8Array([0]),
        })
        await vi.advanceTimersByTimeAsync(0)
        await alice.peer.ack('refresh')
        expect((await alice.control.load()).responses).toEqual([
          {
            position: '000000000001',
            epoch: 1,
            digest: publishedCommitDigest(origin, genuine.sequenceID),
            kind: 'refused',
            reason: 'policy',
            refusalAuthority: 'authenticated-commit',
          },
        ])
        expect((await alice.control.load()).cursor?.position).toBe(page.at(-1)?.sequenceID)
        expect(alice.mls.epoch()).toBe(1)
      }
      await alice.peer.dispose()
      await alice.peer.drained()
      alice = makeMLSPeer(hub, 'alice', secret, { ...options, restartOf: alice })
      await alice.peer.replay()
      expect((await alice.control.load()).responses).toHaveLength(1)
      expect((await alice.control.load()).responses[0]?.position).toBe('000000000001')
    } finally {
      await alice.peer.dispose()
      await alice.peer.drained()
      vi.restoreAllMocks()
    }
  })

  test('distinct authenticated refusals fill the total budget while overflow commits still apply', async () => {
    const hub = new FakeHub()
    const secret = new Uint8Array(32).fill(0x7b)
    const carols = Array.from({ length: 280 }, (_, index) => `carol-${index}`)
    for (const senderDID of carols) {
      await publishCommit({ hub, senderDID, recoverySecret: secret, epoch: 1, external: true })
    }
    const { sequenceID: position } = await publishCommit({
      hub,
      senderDID: 'bob',
      recoverySecret: secret,
      epoch: 1,
      external: true,
    })
    const digest = publishedCommitDigest(hub, position)
    const options = {
      members: ['alice', 'bob', ...carols],
      acceptsCommitter: (did: string) => did === 'bob',
      recovery: { timeoutMs: 100, deadlineMs: 1000, getDelayMs: () => 0 },
    }
    let alice = makeMLSPeer(hub, 'alice', secret, options)
    try {
      await alice.peer.replay()
      const snapshot = await alice.control.load()
      expect(alice.mls.epoch()).toBe(2)
      expect(snapshot.applied.some((row) => row.digest === digest)).toBe(true)
      expect(snapshot.responses).toHaveLength(256)
      expect(snapshot.responses.map((row) => row.digest)).toEqual(
        hub.published.slice(0, 256).map((row) => publishedCommitDigest(hub, row.sequenceID)),
      )
      expect(
        snapshot.responses.every(
          (row) => row.kind === 'refused' && row.refusalAuthority === 'authenticated-commit',
        ),
      ).toBe(true)
      await alice.peer.dispose()
      await alice.peer.drained()
      alice = makeMLSPeer(hub, 'alice', secret, { ...options, restartOf: alice })
      await alice.peer.replay()
      expect((await alice.control.load()).responses).toEqual(snapshot.responses)
      const bob = createMemoryGroupMLS({ members: options.members, localDID: 'bob' })
      const requestID = 'overflow-total-budget'
      const { request } = await bob.createRecoveryRequest(requestID)
      vi.useFakeTimers()
      await hub.publish({
        topicID: rendezvousTopic(secret),
        senderDID: 'bob',
        retain: 'mailbox',
        payload: encodeHandshakeFrame(
          HANDSHAKE_KIND.recoveryConfirmRequest,
          encodeRecoveryConfirmRequest({ requestID, request, position, commitDigest: digest }),
        ),
      })
      await vi.advanceTimersByTimeAsync(100)
      expect(
        hub.published.filter(
          (row) =>
            row.topicID === rendezvousTopic(secret) &&
            decodeHandshakeFrame(row.payload).kind === HANDSHAKE_KIND.recoveryVerdict,
        ),
      ).toHaveLength(0)
    } finally {
      await alice.peer.dispose()
      await alice.peer.drained()
      vi.restoreAllMocks()
    }
  })

  test('response saturation preserves an outstanding refusal and permits commit intake', async () => {
    const hub = new FakeHub()
    const secret = new Uint8Array(32).fill(0x66)
    const { sequenceID: position } = await publishCommit({
      hub,
      senderDID: 'bob',
      recoverySecret: secret,
      epoch: 1,
      external: true,
    })
    const genuine = hub.published[0]
    if (genuine == null) throw new Error('Missing genuine commit')
    const fetch = hub.fetchTopic.bind(hub)
    let deliver = false
    vi.spyOn(hub, 'fetchTopic').mockImplementation(async (params) => {
      if (params.topicID !== commitTopic(secret)) return fetch(params)
      return { messages: deliver ? [genuine] : [], head: null, oldest: null, gap: false }
    })
    const alice = makeMLSPeer(hub, 'alice', secret, {
      members: ['alice', 'bob'],
      recovery: { timeoutMs: 100, deadlineMs: 1000, getDelayMs: () => 50 },
    })
    try {
      await alice.peer.replay()
      const original = {
        position: asLogPosition(position),
        epoch: 1,
        digest: 'retained-refusal',
        kind: 'refused' as const,
        reason: 'policy' as const,
        refusalAuthority: 'authenticated-commit' as const,
      }
      await alice.control.apply({ putResponses: [original] }, 'refusal')
      await alice.peer.ack('refresh')
      const bob = createMemoryGroupMLS({ members: ['alice', 'bob'], localDID: 'bob' })
      const requestID = 'saturated-response'
      const { request, requestKey } = await bob.createRecoveryRequest(requestID)
      vi.useFakeTimers()
      const seal = vi.spyOn(alice.mls, 'sealRecoveryVerdict')
      await hub.publish({
        topicID: rendezvousTopic(secret),
        senderDID: 'bob',
        retain: 'mailbox',
        payload: encodeHandshakeFrame(
          HANDSHAKE_KIND.recoveryConfirmRequest,
          encodeRecoveryConfirmRequest({
            requestID,
            request,
            position,
            commitDigest: original.digest,
          }),
        ),
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(seal).toHaveBeenCalledOnce()
      await alice.control.apply(
        {
          putResponses: Array.from({ length: 128 }, (_, index) => ({
            ...original,
            digest: `copy-${index}`,
          })),
        },
        'flood',
      )
      deliver = true
      await hub.publish({
        topicID: commitTopic(secret),
        senderDID: 'relay',
        payload: new Uint8Array([0]),
      })
      await vi.advanceTimersByTimeAsync(0)
      await alice.peer.ack('refresh')
      expect(alice.mls.epoch()).toBe(2)
      const rows = (await alice.control.load()).responses
      expect(rows).toHaveLength(64)
      expect(rows).toContainEqual(original)
      expect(rows.some((row) => row.digest === publishedCommitDigest(hub, position))).toBe(false)
      await vi.advanceTimersByTimeAsync(50)
      const verdicts = hub.published.filter(
        (row) =>
          row.topicID === rendezvousTopic(secret) &&
          decodeHandshakeFrame(row.payload).kind === HANDSHAKE_KIND.recoveryVerdict,
      )
      expect(verdicts).toHaveLength(1)
      const verdict = verdicts[0]
      if (verdict == null) throw new Error('Missing retained refusal')
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
        commitDigest: original.digest,
        refusalAuthority: 'authenticated-commit',
      })
    } finally {
      await alice.peer.dispose()
      await alice.peer.drained()
      vi.restoreAllMocks()
    }
  })

  test('a delayed cached refusal rechecks the current persisted authority before publication', async () => {
    const hub = new FakeHub()
    const secret = new Uint8Array(32).fill(0x63)
    const alice = makeMLSPeer(hub, 'alice', secret, {
      members: ['alice', 'bob'],
      recovery: { timeoutMs: 100, deadlineMs: 1000, getDelayMs: () => 50 },
    })
    try {
      await alice.peer.replay()
      const bob = createMemoryGroupMLS({ members: ['alice', 'bob'], localDID: 'bob' })
      const requestID = 'cached-authority'
      const { request, requestKey } = await bob.createRecoveryRequest(requestID)
      const row = {
        position: asLogPosition('accepted'),
        epoch: 1,
        digest: 'commit',
        kind: 'refused' as const,
        reason: 'policy' as const,
      }
      await alice.control.apply(
        { putResponses: [{ ...row, refusalAuthority: 'authenticated-commit' }] },
        'authoritative',
      )
      await alice.peer.ack('refresh')
      const seal = vi.spyOn(alice.mls, 'sealRecoveryVerdict')
      vi.useFakeTimers()
      const ask = () =>
        hub.publish({
          topicID: rendezvousTopic(secret),
          senderDID: 'bob',
          retain: 'mailbox' as const,
          payload: encodeHandshakeFrame(
            HANDSHAKE_KIND.recoveryConfirmRequest,
            encodeRecoveryConfirmRequest({
              requestID,
              request,
              position: row.position,
              commitDigest: row.digest,
            }),
          ),
        })
      await ask()
      await vi.advanceTimersByTimeAsync(0)
      expect(seal).toHaveBeenCalledOnce()
      const sealed = await seal.mock.results[0]?.value
      if (sealed == null) throw new Error('Missing sealed refusal')
      expect((await bob.openRecoveryVerdict(sealed, requestID, requestKey))?.verdict).toMatchObject(
        {
          verdict: 'refused',
          reason: 'policy',
          refusalAuthority: 'authenticated-commit',
        },
      )
      await ask()
      await vi.advanceTimersByTimeAsync(0)
      expect(seal).toHaveBeenCalledOnce()
      await alice.control.apply({ putResponses: [row] }, 'legacy-copy-failure')
      await alice.peer.ack('refresh')
      await ask()
      await vi.advanceTimersByTimeAsync(100)
      expect(
        hub.published.filter(
          (message) =>
            decodeHandshakeFrame(message.payload).kind === HANDSHAKE_KIND.recoveryVerdict,
        ),
      ).toEqual([])
    } finally {
      await alice.peer.dispose()
      await alice.peer.drained()
      vi.restoreAllMocks()
    }
  })

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
          if (row == null) throw new Error('Missing response')
          const outcome = await responseOutcome(port, {
            ...row,
            position: asLogPosition(row.position),
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

  test('authenticated refusal authority survives response replay', async () => {
    const port = createMemoryGroupMLS({ epoch: 3, localDID: 'alice' })
    const response = {
      position: asLogPosition('refused-position'),
      digest: 'refused-commit',
      epoch: 1,
      kind: 'refused' as const,
      reason: 'policy' as const,
      refusalAuthority: 'authenticated-commit' as const,
    }
    expect(await responseOutcome(port, response)).toEqual({
      kind: 'refused',
      commitDigest: 'refused-commit',
      reason: 'policy',
      refusalAuthority: 'authenticated-commit',
    })
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
