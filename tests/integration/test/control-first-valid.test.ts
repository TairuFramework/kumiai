import { randomIdentity } from '@kokuin/token'
import {
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  encodeClientState,
  encodeControlEnvelope,
} from '@kumiai/mls'
import { createGroupMLS } from '@kumiai/mls-rpc'
import type { ControlStore, GroupForkEvidence } from '@kumiai/rpc'
import {
  asLogPosition,
  CONTROL_SEARCH_BUDGET,
  createControlSearch,
  decodeCommitFrame,
  decodeHandshakeFrame,
  deliverObligations,
  digestAppliedCommit,
  encodeCommitFrame,
  encodeHandshakeFrame,
  encodeLedgerEntries,
  HANDSHAKE_KIND,
  type OperationDeps,
  type Outcome,
  settleControlSlot,
} from '@kumiai/rpc'
import { createCommit, defaultProposalTypes, encode, mlsMessageEncoder } from 'ts-mls'
import { expect, test, vi } from 'vitest'

import {
  buildRealUnavailableCommit,
  createRealGroup,
  testHandleAccess,
} from '../../../packages/mls-rpc/test/fixtures/real-group.js'
import { stepOperation } from '../../../packages/rpc/src/control/operations.js'
import {
  createDurableHandleAccess,
  createOperationHost,
  encodeJournal,
  operationIntent,
  operationRequest,
} from './app-lane-e2e.js'

async function firstValidRunner() {
  const group = await createRealGroup(2, 'real-poison-prefix')
  let current = group.committer.handle
  const access = await createDurableHandleAccess({
    handle: () => current,
    adopt: (next) => {
      current = next
    },
  })
  const host = createOperationHost(access, group.committer.identity)
  const invitee = randomIdentity()
  const { invite } = await createInvite({
    group: current,
    identity: group.committer.identity,
    recipientDID: invitee.id,
    permission: 'member',
  })
  const bundle = await createKeyPackageBundle(invitee)
  let candidateAuthenticator: Uint8Array | undefined
  const builds = vi.fn(async () => {
    const committed = await commitInvite(current, bundle.publicPackage, invite)
    candidateAuthenticator = committed.newGroup.state.keySchedule.epochAuthenticator.slice()
    return {
      commit: committed.commitMessage,
      journal: encodeJournal(committed.newGroup),
      bodies: invite.ledgerEntries,
      welcome: { bytes: committed.welcomeMessage, recipients: [invitee.id] },
      epoch: Number(current.epoch),
      incarnation: 1,
      authenticatorBefore: current.state.keySchedule.epochAuthenticator.slice(),
      digest: digestAppliedCommit(committed.commitMessage),
    }
  })
  const op = operationIntent(operationRequest('invite', {}))
  host.builders.set(op.id, builds)
  await host.control.apply({ putOperations: [op] }, 'enqueue')
  const frames: Array<{
    topicID: string
    sequenceID: string
    senderDID: string
    payload: Uint8Array
  }> = []
  const position = () => asLogPosition(String(frames.length).padStart(20, '0'))
  const head = () => (frames.length === 0 ? null : position())
  const append = (payload: Uint8Array, senderDID: string) => {
    frames.push({
      topicID: 'control',
      sequenceID: asLogPosition(String(frames.length + 1).padStart(20, '0')),
      senderDID,
      payload,
    })
    return { sequenceID: position() }
  }
  const safety = safetyCallbacks(host.control)
  const search = createControlSearch({
    ...safety,
    budget: CONTROL_SEARCH_BUDGET,
    validation: host.validation,
    readEvidence: host.readEvidence,
    fetch: async (after) => ({
      head: head(),
      oldest: frames[0]?.sequenceID ?? null,
      gap: false,
      messages: frames.filter((frame) => after === null || frame.sequenceID > after),
    }),
    followWinner: async () => {
      throw new Error('Unexpected competitor')
    },
    reconcileAbsent: async () => {
      await host.control.apply(
        { cursor: { position: head(), epoch: Number(current.epoch) } },
        crypto.randomUUID(),
      )
      return true
    },
    hold: async (controlHold) => host.control.apply({ controlHold }, crypto.randomUUID()),
  })
  let now = op.enqueuedAt
  const emitted: Array<Outcome> = []
  const deps: OperationDeps = {
    ...safety,
    control: host.control,
    prepareBuild: host.prepareBuild,
    adopt: host.adopt,
    frame: async (built, seal) => ({
      payload: encodeHandshakeFrame(
        HANDSHAKE_KIND.commit,
        encodeCommitFrame(built.commit, (await seal(encodeLedgerEntries(built.bodies))).sealed),
      ),
      publishID: 'saved-invite',
      expectedHead: head(),
    }),
    searchLog: search.searchLog,
    readEvidence: host.readEvidence,
    readHead: async () => head(),
    publish: async (payload) => append(payload, group.committer.identity.id),
    pullToHead: async () => {},
    now: () => now,
    newID: () => crypto.randomUUID(),
    emit: (outcome) => emitted.push(outcome),
  }
  const built = await stepOperation(deps, op)
  if (built === null || built.stage !== 'built') throw new Error('Missing build')
  const slot = (await host.control.load()).commitOnce
  if (slot === null) throw new Error('Missing slot')
  const receiver = group.members[0]
  if (receiver === undefined) throw new Error('Missing receiver')
  const receiverMLS = createGroupMLS({
    identity: receiver.identity,
    entrySlot: receiver.slot,
    access: testHandleAccess({
      handle: () => receiver.handle,
      adopt: (next) => {
        receiver.handle = next
      },
      persist: async () => {},
    }),
  })
  return {
    group,
    host,
    slot,
    op,
    built,
    builds,
    deps,
    frames,
    append,
    head,
    receiver,
    receiverMLS,
    expire: () => {
      now = op.deadline
    },
    current: () => current,
    emitted,
    candidateAuthenticator: () => {
      if (candidateAuthenticator === undefined) throw new Error('Missing candidate authenticator')
      return candidateAuthenticator
    },
  }
}

test('poison prefix retries the identical commit and real receiver matches candidate', async () => {
  const f = await firstValidRunner()
  const sealedEntries = decodeCommitFrame(
    decodeHandshakeFrame(f.slot.payload).payload,
  ).sealedEntries
  const poisonAuthor = f.group.members[1]
  if (poisonAuthor === undefined) throw new Error('Missing poison author')
  const refusedBuild = await createCommit({
    context: poisonAuthor.handle.context,
    state: { ...poisonAuthor.handle.state, unappliedProposals: {} },
    extraProposals: [
      {
        proposalType: defaultProposalTypes.remove,
        remove: { removed: f.group.committer.handle.state.privatePath.leafIndex },
      },
    ],
    wireAsPublicMessage: true,
    authenticatedData: encodeControlEnvelope({ v: 1 }),
  })
  const policyRefused = encode(mlsMessageEncoder, refusedBuild.commit)
  const proposal = await poisonAuthor.handle.proposeSelfRemoval()
  const poison = [
    new Uint8Array([0xff, 0xff]),
    encodeHandshakeFrame(HANDSHAKE_KIND.commit, encodeCommitFrame(proposal.frame, sealedEntries)),
    encodeHandshakeFrame(HANDSHAKE_KIND.commit, encodeCommitFrame(policyRefused, sealedEntries)),
  ]
  const publishes: Array<{
    payload: Uint8Array
    publishID: string
    expectedHead: ReturnType<typeof f.head>
  }> = []
  f.deps.publish = async (payload, publishID, expectedHead) => {
    publishes.push({ payload: payload.slice(), publishID, expectedHead })
    if (publishes.length === 1) {
      for (const frame of poison) f.append(frame, poisonAuthor.identity.id)
      throw new Error('Head changed before publication')
    }
    return f.append(payload, f.group.committer.identity.id)
  }
  expect(await stepOperation(f.deps, f.built)).not.toBeNull()
  const poisonHead = f.head()
  expect(await stepOperation(f.deps, f.built)).toBeNull()
  const [firstPublish, secondPublish] = publishes
  if (firstPublish === undefined || secondPublish === undefined)
    throw new Error('Missing publication')
  expect(secondPublish.payload).toEqual(firstPublish.payload)
  expect(secondPublish.publishID).toBe(firstPublish.publishID)
  expect(firstPublish.payload).toEqual(f.slot.payload)
  expect(firstPublish.publishID).toBe(f.slot.publishID)
  expect(secondPublish.expectedHead).toBe(poisonHead)
  const firstHandshake = decodeCommitFrame(
    decodeHandshakeFrame(firstPublish.payload).payload,
  ).commit
  expect(decodeCommitFrame(decodeHandshakeFrame(secondPublish.payload).payload).commit).toEqual(
    firstHandshake,
  )
  for (const bytes of [new Uint8Array([0xff, 0xff]), proposal.frame, policyRefused]) {
    expect(await f.receiverMLS.processCommit(bytes, {})).toMatchObject({
      applied: false,
      advanced: false,
    })
  }
  expect(
    await f.receiverMLS.processCommit(firstHandshake, {
      resolveLedgerEntries: async () => f.slot.bodies,
    }),
  ).toMatchObject({ applied: true, advanced: true })
  expect(f.receiver.handle.state.keySchedule.epochAuthenticator).toEqual(f.candidateAuthenticator())
  expect(f.current().state.keySchedule.epochAuthenticator).toEqual(f.candidateAuthenticator())
  expect(f.builds).toHaveBeenCalledTimes(1)
})

test('missing referenced proposal holds sender and refuses receiver', async () => {
  const f = await firstValidRunner()
  const author = f.group.members[1]
  if (author === undefined) throw new Error('Missing author')
  const unavailable = await buildRealUnavailableCommit({ ...f.group, committer: author })
  const sealedEntries = decodeCommitFrame(
    decodeHandshakeFrame(f.slot.payload).payload,
  ).sealedEntries
  f.append(
    encodeHandshakeFrame(HANDSHAKE_KIND.commit, encodeCommitFrame(unavailable, sealedEntries)),
    author.identity.id,
  )
  f.append(f.slot.payload, f.group.committer.identity.id)
  const before = encodeClientState(f.receiver.handle.state)
  expect(await f.receiverMLS.processCommit(unavailable, {})).toMatchObject({
    applied: false,
    advanced: false,
    validation: 'unavailable',
  })
  expect(encodeClientState(f.receiver.handle.state)).toEqual(before)
  f.expire()
  expect(await stepOperation(f.deps, f.built)).toBeNull()
  expect(f.emitted).toEqual([expect.objectContaining({ kind: 'unknown', opID: f.op.id })])
  expect(f.host.welcomes).toEqual([])
  expect((await f.host.control.load()).welcomes).toEqual([])
  expect((await f.host.control.load()).commitOnce).toEqual(f.slot)
})

test.each(['unknown', 'lost', 'abandon'] as const)(
  'real first-valid adoption of an orphaned %s invite co-commits and delivers its saved Welcome',
  async (prior) => {
    const identity = randomIdentity()
    const invitee = randomIdentity()
    let current = (await createGroup(identity, `first-valid-${prior}`)).group
    const access = await createDurableHandleAccess({
      handle: () => current,
      adopt: (next) => {
        current = next
      },
    })
    const host = createOperationHost(access, identity)
    const { invite } = await createInvite({
      group: current,
      identity,
      recipientDID: invitee.id,
      permission: 'member',
    })
    const bundle = await createKeyPackageBundle(invitee)
    const committed = await commitInvite(current, bundle.publicPackage, invite)
    const op = operationIntent(operationRequest('invite', {}))
    const builds = vi.fn(async () => ({
      commit: committed.commitMessage,
      journal: encodeJournal(committed.newGroup),
      bodies: invite.ledgerEntries,
      welcome: { bytes: committed.welcomeMessage, recipients: [invitee.id] },
      epoch: Number(current.epoch),
      incarnation: 1,
      authenticatorBefore: current.state.keySchedule.epochAuthenticator.slice(),
      digest: digestAppliedCommit(committed.commitMessage),
    }))
    host.builders.set(op.id, builds)
    await host.control.apply({ putOperations: [op] }, 'enqueue')
    expect(
      (
        await host.prepareBuild(op, async (built, seal) => ({
          payload: encodeHandshakeFrame(
            HANDSHAKE_KIND.commit,
            encodeCommitFrame(built.commit, (await seal(encodeLedgerEntries(built.bodies))).sealed),
          ),
          publishID: 'retained-invite',
          expectedHead: null,
        }))
      ).kind,
    ).toBe('saved')
    const slot = (await host.control.load()).commitOnce
    if (slot === null) throw new Error('Missing slot')
    await host.control.apply(
      {
        deleteOperations: [op.id],
        putOutcomes: [
          {
            id: op.id,
            opID: op.id,
            at: op.deadline,
            kind: prior === 'abandon' ? 'unknown' : prior,
          },
        ],
      },
      'settle',
    )
    await host.control.apply({ deleteOutcomes: [op.id] }, 'ack')
    let missing = true
    const restore = host.validation.restoreValidation.bind(host.validation)
    const position = asLogPosition('00000000000000000001')
    const safety = safetyCallbacks(host.control)
    const search = createControlSearch({
      ...safety,
      budget: CONTROL_SEARCH_BUDGET,
      validation: {
        restoreValidation: (built) => (missing ? Promise.resolve(null) : restore(built)),
      },
      readEvidence: host.readEvidence,
      fetch: async (after) => ({
        head: position,
        oldest: position,
        gap: false,
        messages:
          after === position
            ? []
            : [
                {
                  topicID: 'control',
                  sequenceID: position,
                  senderDID: identity.id,
                  payload: slot.payload,
                },
              ],
      }),
      followWinner: async () => {
        throw new Error('Unexpected competitor')
      },
      reconcileAbsent: async () => true,
      hold: async (controlHold) => {
        await host.control.apply({ controlHold }, crypto.randomUUID())
      },
    })
    const emitted: Array<Outcome> = []
    const deps = {
      ...safety,
      control: host.control,
      search,
      adoption: { adopt: host.adopt },
      readEvidence: host.readEvidence,
      now: () => op.deadline + 1,
      newID: () => crypto.randomUUID(),
      emit: (outcome: Outcome) => emitted.push(outcome),
    }
    expect(await settleControlSlot(deps)).toBe('unknown')
    expect((await host.control.load()).controlHold?.reason).toBe('acceptance-unknown')
    expect(current.epoch).toBe(BigInt(slot.epoch))
    const version = (await host.readEvidence()).source.stateVersion
    await access.mutate(async (handle) => {
      await handle.proposeSelfRemoval()
    })
    expect(Object.keys(current.state.unappliedProposals)).toHaveLength(1)
    expect((await host.readEvidence()).source.stateVersion).toBeGreaterThan(version)
    expect((await host.control.load()).commitOnce).toEqual(slot)
    missing = false
    expect(await settleControlSlot(deps)).toBe('landed')
    const saved = await host.control.load()
    expect(saved.operations).toEqual([])
    expect(saved.commitOnce).toBeNull()
    expect(saved.controlHold).toBeNull()
    expect(current.state.keySchedule.epochAuthenticator).toEqual(
      committed.newGroup.state.keySchedule.epochAuthenticator,
    )
    expect(saved.applied).toEqual([
      expect.objectContaining({ payloadDigest: slot.payloadDigest, sequenceID: position }),
    ])
    expect(saved.cursor).toEqual({ position, epoch: slot.epoch + 1 })
    expect(saved.outcomes).toEqual([
      expect.objectContaining({
        id: JSON.stringify(['control:landed', op.id, slot.publishID, position]),
        opID: op.id,
        kind: 'landed',
        position,
      }),
    ])
    expect(saved.welcomes).toEqual([
      { opID: op.id, welcome: committed.welcomeMessage, recipients: [invitee.id], committed: true },
    ])
    await deliverObligations(
      {
        control: host.control,
        canDeliver: async (owed) => owed.committed === true,
        deliverWelcome: host.deliverWelcome,
      },
      saved,
    )
    expect(host.welcomes).toEqual(saved.welcomes)
    await host.control.apply(
      { deleteOutcomes: saved.outcomes.map((outcome) => outcome.id) },
      'ack-landed',
    )
    expect(await settleControlSlot(deps)).toBe('empty')
    expect((await host.control.load()).outcomes).toEqual([])
    expect((await host.control.load()).welcomes).toEqual([])
    expect(builds).toHaveBeenCalledTimes(1)
    expect(emitted).toHaveLength(1)
  },
)

function safetyCallbacks(control: ControlStore) {
  let held = false
  return {
    safetyHold: () => (held ? ('fork-halted' as const) : null),
    haltFork: async (evidence: GroupForkEvidence) => {
      held = true
      await control.apply(
        {
          forkHalt: {
            eventID: JSON.stringify(['group:fork', control.key.groupID, control.key.incarnation]),
            evidence,
            detectedAt: Date.now(),
          },
        },
        crypto.randomUUID(),
      )
    },
  }
}
