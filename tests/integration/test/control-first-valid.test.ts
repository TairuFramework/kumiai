import { randomIdentity } from '@kokuin/token'
import {
  CommitValidationUnavailableError,
  commitInvite,
  commitKeyRotation,
  createInvite,
  createKeyPackageBundle,
  encodeClientState,
  encodeControlEnvelope,
  type GroupHandle,
} from '@kumiai/mls'
import { createGroupMLS } from '@kumiai/mls-rpc'
import {
  asLogPosition,
  commitTopic,
  decodeCommitFrame,
  decodeHandshakeFrame,
  deliverObligations,
  digestAppliedCommit,
  encodeCommitFrame,
  encodeHandshakeFrame,
  encodeLedgerEntries,
  HANDSHAKE_KIND,
  type Operation,
  type OperationDeps,
  type Outcome,
} from '@kumiai/rpc'
import { stepLiveBuild } from '@kumiai/rpc/testing'
import { createCommit, defaultProposalTypes, encode, mlsMessageEncoder } from 'ts-mls'
import { afterEach, expect, test, vi } from 'vitest'

import {
  buildRealUnavailableCommit,
  createRealGroup,
  testGroupMLSDependencies,
  testHandleAccess,
} from '../../../packages/mls-rpc/test/fixtures/real-group.js'
import {
  createMemoryStateStore,
  encodeJournal,
  makeMember,
  operationIntent,
  operationRequest,
} from './app-lane-e2e.js'
import { createWireHub } from './log-hub-over-wire.js'

afterEach(() => vi.restoreAllMocks())

async function firstValidRunner(withPastPrefix = false) {
  const group = await createRealGroup(2, 'real-poison-prefix')
  let pastPrefix: Uint8Array | undefined
  if (withPastPrefix) {
    const author = group.members[1]
    if (author === undefined) throw new Error('Missing prefix author')
    const rotated = await commitKeyRotation(author.handle)
    pastPrefix = encodeHandshakeFrame(
      HANDSHAKE_KIND.commit,
      encodeCommitFrame(rotated.commitMessage, new Uint8Array()),
    )
    for (const member of [group.committer, ...group.members]) {
      if (member === author) member.handle = rotated.newGroup
      else await member.handle.processMessage(rotated.commitMessage)
    }
  }
  const wire = createWireHub()
  const connection = wire.connect(group.committer.identity)
  // Pull explicitly so push wakeups cannot race the saved-build and crash seams.
  const pullHub = {
    connect: () => ({
      ...connection,
      receive: () => ({
        async *[Symbol.asyncIterator]() {},
        return: async () => {},
        ack: async () => {},
      }),
    }),
    dispose: wire.dispose,
  }
  const emitted: Array<Outcome> = []
  const welcomes: Array<Uint8Array> = []
  const store = createMemoryStateStore({ groupID: group.committer.handle.groupID, incarnation: 1 })
  await store.save(group.committer.handle)
  const member = makeMember({
    hub: pullHub,
    identity: group.committer.identity,
    group: group.committer.handle,
    entrySlot: group.committer.slot,
    stateStore: store,
    onOutcome: (outcome) => {
      emitted.push(outcome)
    },
    deliverWelcome: async (owed) => {
      welcomes.push(owed.welcome)
    },
  })
  await member.peer.replay()
  const topicID = commitTopic(await member.mls.exportRecoverySecret())
  const head = async () => {
    const page = await connection.fetchTopic({ topicID, subscriberDID: member.identity.id })
    return page.head === null ? null : asLogPosition(page.head)
  }
  const append = (payload: Uint8Array, publishID = crypto.randomUUID()) =>
    connection.publish({
      topicID,
      senderDID: member.identity.id,
      retain: 'log',
      publishID,
      payload,
    })
  const invitee = randomIdentity()
  const { invite } = await createInvite({
    group: member.handle(),
    identity: member.identity,
    recipientDID: invitee.id,
    permission: 'member',
  })
  const bundle = await createKeyPackageBundle(invitee)
  let candidate: GroupHandle | undefined
  const builds = vi.fn(async (_op: Operation, supplied: GroupHandle) => {
    const committed = await commitInvite(supplied, bundle.publicPackage, invite)
    candidate = committed.newGroup
    return {
      commit: committed.commitMessage,
      journal: encodeJournal(committed.newGroup),
      bodies: invite.ledgerEntries,
      welcome: { bytes: committed.welcomeMessage, recipients: [invitee.id] },
      epoch: Number(supplied.epoch),
      incarnation: 1,
      authenticatorBefore: supplied.state.keySchedule.epochAuthenticator.slice(),
      digest: digestAppliedCommit(committed.commitMessage),
    }
  })
  const op = operationIntent(operationRequest('invite', {}))
  member.builders.set(op.id, builds)
  await member.control.apply({ putOperations: [op] }, 'enqueue')
  let now = op.enqueuedAt
  const deps: OperationDeps = {
    control: member.control,
    prepareBuild: member.prepareBuild,
    adopt: member.adoptControl,
    frame: async (built, seal) => ({
      payload: encodeHandshakeFrame(
        HANDSHAKE_KIND.commit,
        encodeCommitFrame(built.commit, (await seal(encodeLedgerEntries(built.bodies))).sealed),
      ),
      publishID: 'saved-invite',
      expectedHead: await head(),
    }),
    readEvidence: store.readEvidence,
    readHead: head,
    publish: (payload, publishID, expectedHead) =>
      connection.publish({
        topicID,
        senderDID: member.identity.id,
        retain: 'log',
        payload,
        publishID,
        expectedHead,
      }),
    pullToHead: async () => {
      await member.controlWalk.walkCommits()
    },
    safetyHold: member.controlWalk.safetyHold,
    haltFork: member.controlWalk.haltFork,
    now: () => now,
    newID: () => crypto.randomUUID(),
    emit: (outcome) => emitted.push(outcome),
  }
  expect(await member.prepareBuild(op, deps.frame)).toMatchObject({ kind: 'saved' })
  const slot = (await member.control.load()).commitOnce
  if (slot === null) throw new Error('Missing saved build')
  expect((await member.control.load()).operations).toEqual([])
  const receiver = group.members[0]
  if (receiver === undefined) throw new Error('Missing receiver')
  const receiverMLS = createGroupMLS({
    identity: receiver.identity,
    entrySlot: receiver.slot,
    ...testGroupMLSDependencies(
      testHandleAccess({
        handle: () => receiver.handle,
        adopt: (next) => {
          receiver.handle = next
        },
        persist: async () => {},
      }),
    ),
  })
  return {
    group,
    member,
    slot,
    op,
    builds,
    deps,
    append,
    head,
    receiver,
    receiverMLS,
    welcomes,
    pastPrefix,
    expire: () => {
      now = op.deadline
    },
    candidate: () => {
      if (candidate === undefined) throw new Error('Missing candidate')
      return candidate
    },
    close: async () => {
      await member.peer.dispose()
      await member.peer.drained()
      await wire.dispose()
    },
  }
}

test('a classified past-epoch prefix refreshes CAS and retries identical saved bytes and ID', async () => {
  const f = await firstValidRunner(true)
  try {
    const publish = f.deps.publish
    let prefixPosition: string | undefined
    const attempts = vi.fn(async (...args: Parameters<typeof publish>) => {
      if (prefixPosition === undefined) {
        if (f.pastPrefix === undefined) throw new Error('Missing past-epoch prefix')
        prefixPosition = (await f.append(f.pastPrefix)).sequenceID
        throw new Error('Head changed before publication')
      }
      return publish(...args)
    })
    f.deps.publish = attempts
    await stepLiveBuild(f.deps)
    expect((await f.member.control.load()).commitOnce?.skipped).not.toBe(true)
    const proposer = f.group.members[0]
    if (proposer === undefined) throw new Error('Missing proposer')
    const proposal = await proposer.handle.proposeSelfRemoval()
    await f.member.mutate((handle) => handle.processMessage(proposal.frame))
    expect(Object.keys(f.member.handle().state.unappliedProposals)).toHaveLength(1)
    await stepLiveBuild(f.deps)
    expect(attempts.mock.calls).toEqual([
      [f.slot.payload, f.slot.publishID, null],
      [f.slot.payload, f.slot.publishID, prefixPosition],
    ])
    expect(f.builds).toHaveBeenCalledTimes(1)
    expect((await f.member.control.load()).commitOnce).toBeNull()
    expect((await f.member.control.load()).outcomes).toMatchObject([
      { opID: f.op.id, kind: 'landed' },
    ])
    expect(f.member.handle().state.keySchedule.epochAuthenticator).toEqual(
      f.candidate().state.keySchedule.epochAuthenticator,
    )
  } finally {
    await f.close()
  }
})

test('poison prefix suppresses retry; later own occurrence installs and matches the real receiver', async () => {
  const f = await firstValidRunner()
  try {
    const sealedEntries = decodeCommitFrame(
      decodeHandshakeFrame(f.slot.payload).payload,
    ).sealedEntries
    const author = f.group.members[1]
    if (author === undefined) throw new Error('Missing poison author')
    const refused = await createCommit({
      context: author.handle.context,
      state: { ...author.handle.state, unappliedProposals: {} },
      extraProposals: [
        {
          proposalType: defaultProposalTypes.remove,
          remove: { removed: f.group.committer.handle.state.privatePath.leafIndex },
        },
      ],
      wireAsPublicMessage: true,
      authenticatedData: encodeControlEnvelope({ v: 1 }),
    })
    const policyRefused = encode(mlsMessageEncoder, refused.commit)
    const proposal = await author.handle.proposeSelfRemoval()
    const poison = [
      new Uint8Array([0xff, 0xff]),
      encodeHandshakeFrame(HANDSHAKE_KIND.commit, encodeCommitFrame(proposal.frame, sealedEntries)),
      encodeHandshakeFrame(HANDSHAKE_KIND.commit, encodeCommitFrame(policyRefused, sealedEntries)),
    ]
    const publish = vi.fn(async () => {
      for (const payload of poison) await f.append(payload)
      throw new Error('Head changed before publication')
    })
    f.deps.publish = publish
    await stepLiveBuild(f.deps)
    expect((await f.member.control.load()).commitOnce).toMatchObject({ skipped: true })
    await stepLiveBuild(f.deps)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(f.member.handle().epoch).toBe(BigInt(f.slot.epoch))
    const occurrence = await f.append(f.slot.payload)
    const receive = vi.spyOn(f.member.mls, 'processCommit')
    await f.member.controlWalk.walkCommits()
    expect(receive).not.toHaveBeenCalled()
    const commit = decodeCommitFrame(decodeHandshakeFrame(f.slot.payload).payload).commit
    for (const bytes of [new Uint8Array([0xff, 0xff]), proposal.frame, policyRefused]) {
      expect(await f.receiverMLS.processCommit(bytes, {})).toMatchObject({
        applied: false,
        advanced: false,
      })
    }
    expect(
      await f.receiverMLS.processCommit(commit, {
        resolveLedgerEntries: async () => f.slot.bodies,
      }),
    ).toMatchObject({ applied: true, advanced: true })
    expect(f.receiver.handle.state.keySchedule.epochAuthenticator).toEqual(
      f.candidate().state.keySchedule.epochAuthenticator,
    )
    expect(f.member.handle().state.keySchedule.epochAuthenticator).toEqual(
      f.candidate().state.keySchedule.epochAuthenticator,
    )
    const saved = await f.member.control.load()
    expect(saved.commitOnce).toBeNull()
    expect(saved.applied).toMatchObject([{ opID: f.op.id, sequenceID: occurrence.sequenceID }])
    expect(saved.outcomes).toMatchObject([{ kind: 'unknown', opID: f.op.id }])
    expect(saved.welcomes).toEqual([])
    expect(f.welcomes).toEqual([])
    expect(f.builds).toHaveBeenCalledTimes(1)
  } finally {
    await f.close()
  }
})

test('missing referenced proposal strands the sender and refuses the real receiver', async () => {
  const f = await firstValidRunner()
  try {
    const author = f.group.members[1]
    if (author === undefined) throw new Error('Missing author')
    const unavailable = await buildRealUnavailableCommit({ ...f.group, committer: author })
    const sealedEntries = decodeCommitFrame(
      decodeHandshakeFrame(f.slot.payload).payload,
    ).sealedEntries
    await f.append(
      encodeHandshakeFrame(HANDSHAKE_KIND.commit, encodeCommitFrame(unavailable, sealedEntries)),
    )
    await f.append(f.slot.payload)
    const before = encodeClientState(f.receiver.handle.state)
    expect(await f.receiverMLS.processCommit(unavailable, {})).toMatchObject({
      applied: false,
      advanced: false,
      validation: 'unavailable',
    })
    expect(encodeClientState(f.receiver.handle.state)).toEqual(before)
    await f.member.controlWalk.walkCommits()
    const saved = await f.member.control.load()
    expect(saved.strand?.reason).toBe('unprocessable-gap')
    expect(saved.commitOnce?.publishID).toBe(f.slot.publishID)
    expect(saved.applied).toEqual([])
    expect(f.member.handle().epoch).toBe(BigInt(f.slot.epoch))
    expect(saved.welcomes).toEqual([])
    expect(f.welcomes).toEqual([])
  } finally {
    await f.close()
  }
})

test.each([false, true])(
  'acked provisional invite installs after expiry with incomplete coverage=%s',
  async (incomplete) => {
    const f = await firstValidRunner()
    try {
      if (incomplete) {
        await f.append(new Uint8Array([255]))
        await f.member.controlWalk.walkCommits()
      }
      f.expire()
      await stepLiveBuild(f.deps)
      const provisional = (await f.member.control.load()).outcomes[0]
      if (provisional === undefined) throw new Error('Missing provisional report')
      expect(provisional.kind).toBe('unknown')
      await f.member.control.apply({ deleteOutcomes: [provisional.id] }, 'ack')
      const author = f.group.members[0]
      if (author === undefined) throw new Error('Missing proposer')
      const proposal = await author.handle.proposeSelfRemoval()
      const version = (await f.member.stateStore.readEvidence()).source.stateVersion
      await f.member.mutate((handle) => handle.processMessage(proposal.frame))
      expect(Object.keys(f.member.handle().state.unappliedProposals)).toHaveLength(1)
      expect((await f.member.stateStore.readEvidence()).source.stateVersion).toBeGreaterThan(
        version,
      )
      expect((await f.member.control.load()).commitOnce?.payload).toEqual(f.slot.payload)
      const occurrence = await f.append(f.slot.payload)
      const receive = vi.spyOn(f.member.mls, 'processCommit')
      await f.member.controlWalk.walkCommits()
      expect(receive).not.toHaveBeenCalled()
      const saved = await f.member.control.load()
      expect(saved.operations).toEqual([])
      expect(saved.commitOnce).toBeNull()
      expect(saved.controlHold).toBeNull()
      expect(Object.keys(f.member.handle().state.unappliedProposals)).toEqual([])
      expect(saved.outcomes).toMatchObject([
        { opID: f.op.id, kind: incomplete ? 'unknown' : 'landed' },
      ])
      expect(saved.outcomes[0]?.id).not.toBe(provisional.id)
      expect(saved.applied).toMatchObject([{ opID: f.op.id, sequenceID: occurrence.sequenceID }])
      expect(saved.cursor).toMatchObject({
        position: occurrence.sequenceID,
        epoch: f.slot.epoch + 1,
      })
      expect(f.member.handle().state.keySchedule.epochAuthenticator).toEqual(
        f.candidate().state.keySchedule.epochAuthenticator,
      )
      expect(saved.welcomes).toEqual(
        incomplete
          ? []
          : [
              {
                opID: f.op.id,
                welcome: f.slot.welcome?.bytes,
                recipients: f.slot.welcome?.recipients,
              },
            ],
      )
      const deliverWelcome = vi.fn(async () => {})
      await deliverObligations(
        {
          control: f.member.control,
          canDeliver: async () => true,
          deliverWelcome,
        },
        saved,
      )
      expect(deliverWelcome).toHaveBeenCalledTimes(incomplete ? 0 : 1)
      await f.member.controlWalk.walkCommits()
      expect((await f.member.control.load()).outcomes).toEqual(saved.outcomes)
      expect((await f.member.control.load()).welcomes).toEqual([])
      expect(f.builds).toHaveBeenCalledTimes(1)
    } finally {
      await f.close()
    }
  },
)

test('a lost invite never reopens or owes a Welcome when its own copy arrives later', async () => {
  const f = await firstValidRunner()
  try {
    const author = f.group.members[0]
    if (author === undefined) throw new Error('Missing competitor')
    const competitor = await commitKeyRotation(author.handle)
    const sealedEntries = decodeCommitFrame(
      decodeHandshakeFrame(f.slot.payload).payload,
    ).sealedEntries
    await f.append(
      encodeHandshakeFrame(
        HANDSHAKE_KIND.commit,
        encodeCommitFrame(competitor.commitMessage, sealedEntries),
      ),
    )
    await f.member.controlWalk.walkCommits()
    const saved = await f.member.control.load()
    expect(saved.outcomes).toMatchObject([{ kind: 'lost', opID: f.op.id }])
    expect(saved.commitOnce).toBeNull()
    await f.append(f.slot.payload)
    await f.member.controlWalk.walkCommits()
    expect((await f.member.control.load()).outcomes).toEqual(saved.outcomes)
    expect((await f.member.control.load()).welcomes).toEqual([])
    expect(f.welcomes).toEqual([])
    expect(f.member.handle().state.keySchedule.epochAuthenticator).toEqual(
      competitor.newGroup.state.keySchedule.epochAuthenticator,
    )
  } finally {
    await f.close()
  }
})

test('abandoned invite cannot install or deliver on later own replay', async () => {
  const f = await firstValidRunner()
  try {
    const before = encodeClientState(f.member.handle().state)
    await f.member.peer.abandon()
    const abandoned = await f.member.control.load()
    expect(abandoned.commitOnce).toBeNull()
    expect(abandoned.spentSource).toEqual({ epoch: f.slot.epoch })
    expect(abandoned.outcomes).toMatchObject([{ opID: f.op.id, kind: 'unknown' }])
    expect(abandoned.welcomes).toEqual([])
    const outcome = abandoned.outcomes[0]
    if (outcome === undefined) throw new Error('Missing abandonment outcome')
    await f.member.peer.ack(outcome.id)
    const occurrence = await f.append(f.slot.payload)
    await f.member.controlWalk.walkCommits()
    const replayed = await f.member.control.load()
    expect(replayed.commitOnce).toBeNull()
    expect(replayed.spentSource).toEqual({ epoch: f.slot.epoch })
    expect(replayed.cursor?.position).toBe(occurrence.sequenceID)
    expect(replayed.applied).toEqual([])
    expect(replayed.outcomes).toEqual([])
    expect(replayed.welcomes).toEqual([])
    expect(encodeClientState(f.member.handle().state)).toEqual(before)
    expect(f.welcomes).toEqual([])
    await f.member.peer.abandon()
    expect(await f.member.control.load()).toEqual(replayed)
    expect(f.builds).toHaveBeenCalledTimes(1)
  } finally {
    await f.close()
  }
})

test.each(['transient', 'persistent'] as const)(
  'own local validation failure holds its occurrence before %s retry completion',
  async (failure) => {
    const f = await firstValidRunner()
    try {
      let now = Date.now()
      vi.spyOn(Date, 'now').mockImplementation(() => now)
      const unavailable = new CommitValidationUnavailableError('Local source read unavailable', {
        reason: 'missing-key',
      })
      const read = vi.spyOn(f.member.mls, 'readCommitHeader')
      if (failure === 'persistent') read.mockRejectedValue(unavailable)
      else read.mockRejectedValueOnce(unavailable)
      const receive = vi.spyOn(f.member.mls, 'processCommit')
      const before = await f.member.control.load()
      const occurrence = await f.append(f.slot.payload)
      await f.member.controlWalk.walkCommits()
      const held = await f.member.control.load()
      expect(held.commitOnce).toEqual(before.commitOnce)
      expect(held.cursor).toEqual(before.cursor)
      expect(held.strand).toBeNull()
      expect(held.applied).toEqual([])
      expect(held.outcomes).toEqual([])
      expect(held.welcomes).toEqual([])
      expect(f.member.handle().epoch).toBe(BigInt(f.slot.epoch))
      await f.member.controlWalk.walkCommits()
      expect(await f.member.control.load()).toEqual(held)
      now += 100
      await f.member.controlWalk.walkCommits()
      if (failure === 'persistent') {
        expect((await f.member.control.load()).strand).toBeNull()
        now += 200
        await f.member.controlWalk.walkCommits()
        expect((await f.member.control.load()).strand).toBeNull()
        now += 400
        await f.member.controlWalk.walkCommits()
        const exhausted = await f.member.control.load()
        expect(exhausted.strand?.reason).toBe('unprocessable-gap')
        expect(exhausted.cursor?.position).toBe(before.cursor?.position ?? null)
        expect(exhausted.commitOnce).toEqual(before.commitOnce)
        expect(exhausted.outcomes).toEqual([])
        expect(exhausted.welcomes).toEqual([])
        expect(f.member.handle().epoch).toBe(BigInt(f.slot.epoch))
      } else {
        const installed = await f.member.control.load()
        expect(installed.commitOnce).toBeNull()
        expect(installed.strand).toBeNull()
        expect(installed.cursor?.position).toBe(occurrence.sequenceID)
        expect(installed.applied).toMatchObject([
          { opID: f.op.id, sequenceID: occurrence.sequenceID },
        ])
        expect(installed.outcomes).toMatchObject([{ opID: f.op.id, kind: 'landed' }])
        expect(installed.welcomes).toEqual([
          {
            opID: f.op.id,
            welcome: f.slot.welcome?.bytes,
            recipients: f.slot.welcome?.recipients,
          },
        ])
        expect(f.member.handle().state.keySchedule.epochAuthenticator).toEqual(
          f.candidate().state.keySchedule.epochAuthenticator,
        )
      }
      expect(receive).not.toHaveBeenCalled()
      expect(f.builds).toHaveBeenCalledTimes(1)
      expect(f.welcomes).toEqual([])
    } finally {
      await f.close()
    }
  },
)
