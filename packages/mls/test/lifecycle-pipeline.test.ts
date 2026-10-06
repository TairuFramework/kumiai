import { audienceConfirmation } from '@kokuin/capability'
import {
  createControllerIdentity,
  createReset,
  createRevoke,
  createRotate,
} from '@kokuin/controller'
import { createIdentity, stringifyToken } from '@kokuin/token'
import {
  createProposal,
  defaultProposalTypes,
  encode,
  type LeafIndex,
  makeCustomExtension,
  mlsMessageEncoder,
  nodeTypes,
} from 'ts-mls'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { foldEnvelope } from '../src/envelope-fold.js'
import { commitWithEntries } from '../src/group-commit.js'
import { makeMLSCredential } from '../src/group-credential.js'
import { addDevice } from '../src/group-device.js'
import {
  buildCommitPolicyContext,
  CommitRejectedError,
  deriveGroup,
  type GroupHandle,
} from '../src/group-handle.js'
import { HISTORY_HORIZON, historySize } from '../src/history.js'
import { ledgerEntryDigest, signLedgerEntry, verifyLedgerEntry } from '../src/ledger.js'
import {
  isLapsed,
  prepareLifecycleGate,
  treeTime,
  validateEntry,
  validateWelcomeTree,
} from '../src/lifecycle.js'
import { DEVICE_ENTRY_TYPE } from '../src/registry.js'
import { joinBoundDevice } from './fixtures/device-harness.js'
import { controllerSeed } from './fixtures/lifecycle-ledger.js'
import {
  agent,
  controllerID,
  inception,
  lowLevelApply,
  lowLevelExternal,
  lowLevelWelcome,
  pipelineGroup,
  rawAdd,
  rawApplication,
  rawCommit,
  rawUpdate,
  timedBinding,
  welcomeBoundary,
} from './fixtures/lifecycle-pipeline.js'
import { buildManagementCapability } from './fixtures/management-capability.js'

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(100_000)
})
afterEach(() => {
  vi.restoreAllMocks()
})

test.each(['author', 'receiver'] as const)(
  '%s refuses an absent-target revoke with a renewing committer path',
  async (side) => {
    const { group, identity, tokens } = await pipelineGroup()
    const bob = agent(61)
    const { author, joined } = await lowLevelWelcome(
      group,
      bob,
      await timedBinding({ identity: bob, iat: 90, exp: 200 }),
    )
    const target = agent(81)
    const revoke = createRevoke({
      seed: controllerSeed,
      profile: 0,
      did: controllerID,
      prior: inception.event,
      target: target.id,
      keyPosition: { gen: 0, seq: 0 },
    })
    const token = await signLedgerEntry(identity, {
      type: DEVICE_ENTRY_TYPE,
      groupID: author.groupID,
      subject: target.id,
      value: { op: 'revoke', proof: [inception, revoke], revoked: [{ did: target.id }] },
    })
    const entryID = ledgerEntryDigest(token)
    tokens.set(entryID, token)
    const result = await rawCommit({
      group: author,
      binding: await timedBinding({ identity, iat: 100, exp: 201 }),
      tokens: [token],
    })
    const previous = side === 'author' ? author.state : joined.state
    if (side === 'receiver') {
      await expect(
        joined.processMessage(encode(mlsMessageEncoder, result.commit)),
      ).rejects.toMatchObject({ reason: 'invalid', cause: { reason: 'identity-change' } })
      expect(joined.state).toBe(previous)
      expect(joined.ledgerTokens).not.toContain(token)
    } else {
      const verified = await verifyLedgerEntry(token)
      if (verified == null) throw new Error('Invalid revoke fixture')
      const fold = foldEnvelope({
        baseRoster: author.roster,
        baseRegistry: author.registry,
        entries: [{ verified, entryID }],
        groupID: author.groupID,
        context: {
          controllerID,
          memberController: (did) => author.bindingOfDID(did)?.controller,
        },
      })
      if (!fold.ok) throw new Error(fold.reason)
      const context = buildCommitPolicyContext(author, {
        baseRoster: author.roster,
        candidateRoster: fold.roster,
        entryIDs: [entryID],
        enactedDeviceEntries: [{ subject: target.id, op: 'revoke' }],
      })
      const gate = await prepareLifecycleGate({
        group: author,
        entries: [verified],
        candidateRegistry: fold.registry,
        context,
      })
      gate.check({
        kind: 'commit',
        senderLeafIndex: author.state.privatePath.leafIndex as LeafIndex,
        proposals: [
          {
            senderLeafIndex: author.state.privatePath.leafIndex as LeafIndex,
            proposal: {
              proposalType: defaultProposalTypes.group_context_extensions,
              groupContextExtensions: { extensions: result.newState.groupContext.extensions },
            },
          },
        ],
      })
      await expect(gate.postApply(result.newState)).rejects.toMatchObject({
        reason: 'identity-change',
      })
      expect(author.state).toBe(previous)
      expect(author.ledgerTokens).not.toContain(token)
    }
    const preserved = await commitWithEntries({
      group: author,
      extraProposals: [],
      enacted: [token],
      requireAdmin: false,
    })
    expect(preserved.newState.groupContext.epoch).toBe(author.epoch + 1n)
    if (side === 'receiver') {
      await joined.processMessage(encode(mlsMessageEncoder, preserved.commit))
      expect(joined.ledgerTokens).toContain(token)
    }
  },
)

test('processWelcome accepts existing lapsed leaves after admission advances tree time', async () => {
  const { group, identity } = await pipelineGroup()
  const bob = agent(61)
  const fixture = await welcomeBoundary(
    group,
    bob,
    await timedBinding({ identity: bob, iat: 201, exp: 300 }),
  )
  const { group: joined } = await fixture.process()
  expect(treeTime(joined, controllerID)).toBe(201)
  const existing = joined.state.ratchetTree[0]
  const admitted = joined.state.ratchetTree[joined.state.privatePath.leafIndex * 2]
  if (existing?.nodeType !== nodeTypes.leaf || admitted?.nodeType !== nodeTypes.leaf)
    throw new Error('Missing Welcome leaves')
  expect(joined.bindingOfDID(identity.id)?.controller).toBe(controllerID)
  expect(isLapsed(joined, existing.leaf)).toBe(true)
  expect(isLapsed(joined, admitted.leaf)).toBe(false)
})

test.each([99, 100])('processWelcome refuses an admitted leaf expiring at %s', async (exp) => {
  const { group } = await pipelineGroup()
  const bob = agent(61)
  const fixture = await welcomeBoundary(
    group,
    bob,
    await timedBinding({ identity: bob, iat: 90, exp }),
  )
  await expect(fixture.process()).rejects.toMatchObject({ reason: 'lapsed' })
})

describe('mandatory entry gates', () => {
  test('an accepting caller cannot admit a floating Add', async () => {
    const { group } = await pipelineGroup()
    const added = await rawAdd(group, agent(61))
    const previous = group.state
    await expect(group.processMessage(added.message)).rejects.toBeInstanceOf(CommitRejectedError)
    expect(group.state).toBe(previous)
  })

  test.each([100, 99])('an Add with expiry %s does not pass strict tree time', async (exp) => {
    const { group } = await pipelineGroup()
    const identity = agent(61)
    const added = await rawAdd(group, identity, await timedBinding({ identity, iat: 90, exp }))
    await expect(group.processMessage(added.message)).rejects.toBeInstanceOf(CommitRejectedError)
  })

  test('a child issuance time cannot advance controller tree time', async () => {
    const { group } = await pipelineGroup()
    const trusted = agent(71)
    const identity = agent(61)
    const signer = createControllerIdentity({ seed: controllerSeed, profile: 0, log: [inception] })
    const parent = stringifyToken(
      await signer.signToken({
        sub: controllerID,
        aud: trusted.id,
        act: 'authenticate',
        res: 'kumiai/mls-leaf',
        cnf: audienceConfirmation({ alg: 'EdDSA', publicKey: trusted.publicKey }),
        iat: 90,
        exp: 10000,
      }),
    )
    const added = await rawAdd(
      group,
      identity,
      await timedBinding({ identity, iat: 5000, exp: 6000, parent, issuer: trusted }),
    )
    const before = treeTime(group, controllerID)
    expect(before).toBe(100)
    await group.processMessage(added.message)
    expect(treeTime(group, controllerID)).toBe(before)
  })

  test.each([86400, 86401])(
    'Welcome enforces the anchored direct lifetime %s',
    async (lifetime) => {
      const { group } = await pipelineGroup()
      const identity = agent(61)
      const { joined } = await lowLevelWelcome(
        group,
        identity,
        await timedBinding({ identity, iat: 100, exp: 100 + lifetime }),
      )
      const result = validateWelcomeTree(joined)
      if (lifetime === 86400) await expect(result).resolves.toBeUndefined()
      else await expect(result).rejects.toMatchObject({ reason: 'lifetime-cap' })
    },
  )

  test('external replacement cannot float under an accepting caller', async () => {
    const { group } = await pipelineGroup()
    const identity = agent(61)
    const { author } = await lowLevelWelcome(
      group,
      identity,
      await timedBinding({ identity, iat: 90, exp: 200 }),
    )
    const message = await lowLevelExternal({ group: author, identity })
    await expect(author.processMessage(message)).rejects.toBeInstanceOf(CommitRejectedError)
  })

  test('external replacement keeps identity and cannot lower tree time', async () => {
    const { group } = await pipelineGroup()
    const identity = agent(61)
    const { author } = await lowLevelWelcome(
      group,
      identity,
      await timedBinding({ identity, iat: 110, exp: 200 }),
    )
    const message = await lowLevelExternal({
      group: author,
      identity,
      binding: await timedBinding({ identity, iat: 105, exp: 200 }),
    })
    await expect(author.processMessage(message)).rejects.toBeInstanceOf(CommitRejectedError)
  })

  test('a member Remove cannot be authorised by an accepting caller', async () => {
    const { group } = await pipelineGroup()
    const identity = agent(61)
    const { author } = await lowLevelWelcome(
      group,
      identity,
      await timedBinding({ identity, iat: 90, exp: 200 }),
    )
    const result = await rawCommit({
      group: author,
      proposals: [{ proposalType: defaultProposalTypes.remove, remove: { removed: 1 } }],
    })
    await expect(
      author.processMessage(encode(mlsMessageEncoder, result.commit)),
    ).rejects.toBeInstanceOf(CommitRejectedError)
  })

  test('standard groups still reject a bound-to-floating replacement', async () => {
    const { group } = await pipelineGroup()
    const previous = group.state.ratchetTree[0]
    if (previous?.nodeType !== nodeTypes.leaf) throw new Error('Missing leaf')
    const { group: standard } = await pipelineGroup({ standard: true })
    const floating = standard.state.ratchetTree[0]
    if (floating?.nodeType !== nodeTypes.leaf) throw new Error('Missing leaf')
    await expect(validateEntry(standard, floating.leaf, previous.leaf)).rejects.toMatchObject({
      reason: 'identity-change',
    })
  })

  test('author results must pass the same admission gate', async () => {
    const { group } = await pipelineGroup()
    const added = await rawAdd(group, agent(61))
    await expect(
      commitWithEntries({
        group,
        extraProposals: [
          {
            proposalType: defaultProposalTypes.add,
            add: { keyPackage: added.bundle.publicPackage },
          },
        ],
        enacted: [],
        requireAdmin: false,
      }),
    ).rejects.toThrow()
  })
})

async function threeMembers() {
  const { group, identity } = await pipelineGroup()
  const bob = agent(61)
  const first = await lowLevelWelcome(
    group,
    bob,
    await timedBinding({ identity: bob, iat: 90, exp: 99 }),
  )
  const carol = agent(71)
  const second = await lowLevelWelcome(
    first.author,
    carol,
    await timedBinding({ identity: carol, iat: 95, exp: 200 }),
  )
  await first.joined.processMessage(second.message)
  return {
    author: second.author,
    bob: first.joined,
    survivor: second.joined,
    identity,
    bobIdentity: bob,
  }
}

describe('path, clock and lapse gates', () => {
  test('lapse refusal happens before a decrypt generation or persistence is consumed', async () => {
    const setup = await threeMembers()
    const message = await rawApplication(setup.bob)
    const previous = setup.survivor.state
    const persist = vi.fn()
    await expect(setup.survivor.decrypt(message)).rejects.toMatchObject({ reason: 'lapsed' })
    await expect(setup.survivor.decryptStaged(message, {}, persist)).rejects.toMatchObject({
      reason: 'lapsed',
    })
    expect(setup.survivor.state).toBe(previous)
    expect(persist).not.toHaveBeenCalled()
    await expect(setup.bob.encrypt(new Uint8Array([1]))).rejects.toMatchObject({ reason: 'lapsed' })
  })

  test('a lapsed sender can only commit a renewal of its own leaf', async () => {
    const setup = await threeMembers()
    const stale = await rawCommit({ group: setup.bob })
    await expect(
      setup.survivor.processMessage(encode(mlsMessageEncoder, stale.commit)),
    ).rejects.toMatchObject({ reason: 'lapse' })
    const renewal = await rawCommit({
      group: setup.bob,
      binding: await timedBinding({ identity: setup.bobIdentity, iat: 100, exp: 200 }),
    })
    await expect(
      setup.survivor.processMessage(encode(mlsMessageEncoder, renewal.commit)),
    ).resolves.toBeNull()
  })

  test('a Remove keeps the committer credential and rejection leaves delayed decrypt usable', async () => {
    const setup = await threeMembers()
    const delayed = await rawApplication(setup.author)
    const result = await rawCommit({
      group: setup.author,
      proposals: [{ proposalType: defaultProposalTypes.remove, remove: { removed: 1 } }],
      binding: await timedBinding({ identity: setup.identity, iat: 100, exp: 201 }),
    })
    const previous = setup.survivor.state
    const message = encode(mlsMessageEncoder, result.commit)
    await expect(setup.survivor.processMessage(message)).rejects.toBeInstanceOf(CommitRejectedError)
    expect(setup.survivor.state).toBe(previous)
    expect(new TextDecoder().decode((await setup.survivor.decrypt(delayed)).payload)).toBe(
      'delayed',
    )
    await setup.bob.processMessage(message)
    expect(setup.bob.state.groupActiveState.kind).toBe('removedFromGroup')
  })

  test('a path cannot renew under a different controller even with an accepting caller', async () => {
    const { group, identity } = await pipelineGroup()
    const bob = agent(61)
    const { author, joined } = await lowLevelWelcome(
      group,
      bob,
      await timedBinding({ identity: bob, iat: 90, exp: 200 }),
    )
    const binding = await timedBinding({ identity, iat: 100, exp: 201 })
    const result = await rawCommit({
      group: author,
      binding: { ...binding, id: 'did:kokuin:foreign' },
    })
    const previous = joined.state
    await expect(joined.processMessage(encode(mlsMessageEncoder, result.commit))).rejects.toThrow()
    expect(joined.state).toBe(previous)
  })

  test('Update keeps identity under an accepting caller', async () => {
    const { group } = await pipelineGroup()
    const bob = agent(61)
    const { author, joined } = await lowLevelWelcome(
      group,
      bob,
      await timedBinding({ identity: bob, iat: 90, exp: 200 }),
    )
    const replacement = await createIdentity({
      didMethod: 'peer:4',
      keys: [{ purpose: 'sig', alg: 'EdDSA', privateKey: agent(61).privateKey }],
    })
    const update = await rawUpdate(
      joined,
      replacement,
      await timedBinding({ identity: replacement, iat: 100, exp: 200 }),
    )
    await expect(author.processMessage(update)).rejects.toBeInstanceOf(CommitRejectedError)
  })

  test('removing time 100 requires a clock and preserves floor through a renewal at 95', async () => {
    const { group, tokens } = await pipelineGroup()
    const bob = agent(61)
    const { author, joined } = await lowLevelWelcome(
      group,
      bob,
      await timedBinding({ identity: bob, iat: 90, exp: 200 }),
    )
    const proposal = await createProposal({
      context: author.context,
      state: author.state,
      proposal: { proposalType: defaultProposalTypes.remove, remove: { removed: 0 } },
    })
    await joined.processMessage(proposal.message)
    const withoutClock = await rawCommit({ group: joined })
    const receiver = deriveGroup(author, proposal.newState)
    await expect(
      receiver.processMessage(encode(mlsMessageEncoder, withoutClock.commit)),
    ).rejects.toBeInstanceOf(CommitRejectedError)
    const clock = await signLedgerEntry(bob, {
      type: DEVICE_ENTRY_TYPE,
      groupID: joined.groupID,
      subject: controllerID,
      value: { op: 'clock', time: 100 },
    })
    tokens.set(ledgerEntryDigest(clock), clock)
    const result = await rawCommit({ group: joined, tokens: [clock] })
    await receiver.processMessage(encode(mlsMessageEncoder, result.commit))
    expect(receiver.state.groupActiveState.kind).toBe('removedFromGroup')
    const next = deriveGroup(joined, result.newState)
    await next.applyLedgerEntries([clock])
    expect(next.registry.controllers.get(controllerID)?.timeFloor).toBe(100)
    expect(treeTime(next, controllerID)).toBe(100)
    const renewal = await rawCommit({
      group: next,
      binding: await timedBinding({ identity: bob, iat: 95, exp: 200 }),
    })
    expect(treeTime(deriveGroup(next, renewal.newState), controllerID)).toBe(100)
  })

  test('proof Removes must equal exactly the derived targets', async () => {
    const setup = await threeMembers()
    const revoke = createRevoke({
      seed: controllerSeed,
      profile: 0,
      did: controllerID,
      prior: inception.event,
      target: setup.bobIdentity.id,
      keyPosition: { gen: 0, seq: 0 },
    })
    const token = await signLedgerEntry(setup.identity, {
      type: DEVICE_ENTRY_TYPE,
      groupID: setup.author.groupID,
      subject: setup.bobIdentity.id,
      value: { op: 'revoke', proof: [inception, revoke], revoked: [{ did: setup.bobIdentity.id }] },
    })
    await expect(
      commitWithEntries({
        group: setup.author,
        extraProposals: [],
        enacted: [token],
        requireAdmin: false,
      }),
    ).rejects.toMatchObject({ reason: 'removes-mismatch' })
    const result = await commitWithEntries({
      group: setup.author,
      extraProposals: [{ proposalType: defaultProposalTypes.remove, remove: { removed: 1 } }],
      enacted: [token],
      requireAdmin: false,
    })
    expect(result.newState.ratchetTree[2]).toBeUndefined()
  })

  test('a proof cannot absorb an Add and two clocks cannot share a commit', async () => {
    const { group, identity } = await pipelineGroup()
    const revoke = createRevoke({
      seed: controllerSeed,
      profile: 0,
      did: controllerID,
      prior: inception.event,
      target: agent(81).id,
      keyPosition: { gen: 0, seq: 0 },
    })
    const token = await signLedgerEntry(identity, {
      type: DEVICE_ENTRY_TYPE,
      groupID: group.groupID,
      subject: agent(81).id,
      value: { op: 'revoke', proof: [inception, revoke], revoked: [{ did: agent(81).id }] },
    })
    const add = await rawAdd(
      group,
      agent(61),
      await timedBinding({ identity: agent(61), iat: 100, exp: 200 }),
    )
    await expect(
      commitWithEntries({
        group,
        extraProposals: [
          { proposalType: defaultProposalTypes.add, add: { keyPackage: add.bundle.publicPackage } },
        ],
        enacted: [token],
        requireAdmin: false,
      }),
    ).rejects.toMatchObject({ reason: 'effects-mismatch' })
    const clocks = await Promise.all(
      [90, 95].map((time) =>
        signLedgerEntry(identity, {
          type: DEVICE_ENTRY_TYPE,
          groupID: group.groupID,
          subject: controllerID,
          value: { op: 'clock', time },
        }),
      ),
    )
    await expect(
      commitWithEntries({ group, extraProposals: [], enacted: clocks, requireAdmin: false }),
    ).rejects.toMatchObject({ reason: 'effects-mismatch' })
  })
})

describe('lifetime and admission boundaries', () => {
  test.each([
    { leafLifetime: 86400, lifetime: 86400, accepted: true },
    { leafLifetime: 86400, lifetime: 86401, accepted: false },
    { leafLifetime: 3600, lifetime: 3600, accepted: true },
    { leafLifetime: 3600, lifetime: 3601, accepted: false },
  ])(
    'direct lifetimes at Add, Update, external and Welcome: $leafLifetime/$lifetime',
    async ({ leafLifetime, lifetime, accepted }) => {
      for (const boundary of ['add', 'update', 'external', 'welcome']) {
        const { group } = await pipelineGroup({ leafLifetime })
        const bob = agent(61)
        const binding = await timedBinding({ identity: bob, iat: 100, exp: 100 + lifetime })
        let result: Promise<unknown>
        if (boundary === 'add') {
          const added = await rawAdd(group, bob, binding)
          result = group.processMessage(added.message)
        } else if (boundary === 'welcome') {
          const fixture = await welcomeBoundary(group, bob, binding)
          result = fixture.process()
        } else {
          const { author, joined } = await lowLevelWelcome(
            group,
            bob,
            await timedBinding({ identity: bob, iat: 90, exp: 200 }),
          )
          result = author.processMessage(
            boundary === 'update'
              ? await rawUpdate(joined, bob, binding)
              : await lowLevelExternal({ group: author, identity: bob, binding }),
          )
        }
        if (accepted) await expect(result).resolves.toBeDefined()
        else await expect(result).rejects.toThrow()
      }
    },
  )

  test.each([
    { limit: 2592000, lifetime: 2592000, accepted: true },
    { limit: 2592000, lifetime: 2592001, accepted: false },
    { limit: 86400, lifetime: 86400, accepted: true },
    { limit: 86400, lifetime: 86401, accepted: false },
  ])(
    'trusted grant lifetimes at every entry: $limit/$lifetime',
    async ({ limit, lifetime, accepted }) => {
      for (const boundary of ['add', 'update', 'external', 'welcome']) {
        const { group } = await pipelineGroup({ trustedGrantLifetime: limit })
        const bob = agent(61)
        const trusted = agent(71)
        const parent = (await timedBinding({ identity: trusted, iat: 90, exp: 90 + lifetime }))
          .capability
        const binding = await timedBinding({
          identity: bob,
          iat: 100,
          exp: 200,
          parent,
          issuer: trusted,
        })
        let result: Promise<unknown>
        if (boundary === 'add') {
          const added = await rawAdd(group, bob, binding)
          result = group.processMessage(added.message)
        } else if (boundary === 'welcome') {
          const fixture = await welcomeBoundary(group, bob, binding)
          result = fixture.process()
        } else {
          const { author, joined } = await lowLevelWelcome(
            group,
            bob,
            await timedBinding({ identity: bob, iat: 90, exp: 200 }),
          )
          result = author.processMessage(
            boundary === 'update'
              ? await rawUpdate(joined, bob, binding)
              : await lowLevelExternal({ group: author, identity: bob, binding }),
          )
        }
        if (accepted) await expect(result).resolves.toBeDefined()
        else await expect(result).rejects.toThrow()
      }
    },
  )

  test('processMessage also refuses a lapsed application sender before opening', async () => {
    const setup = await threeMembers()
    const message = await rawApplication(setup.bob)
    const previous = setup.survivor.state
    await expect(setup.survivor.processMessage(message)).rejects.toMatchObject({ reason: 'lapsed' })
    expect(setup.survivor.state).toBe(previous)
  })

  test('expiry equal to tree time is live for sending but cannot enter', async () => {
    const { group } = await pipelineGroup()
    const bob = agent(61)
    const { author, joined } = await lowLevelWelcome(
      group,
      bob,
      await timedBinding({ identity: bob, iat: 90, exp: 100 }),
    )
    const message = await joined.encrypt(new Uint8Array([7]))
    expect((await author.decrypt(message)).payload).toEqual(new Uint8Array([7]))
  })

  test('a renewal preserves delayed traffic from its old epoch', async () => {
    const { group, identity } = await pipelineGroup()
    const bob = agent(61)
    const { author, joined } = await lowLevelWelcome(
      group,
      bob,
      await timedBinding({ identity: bob, iat: 90, exp: 200 }),
    )
    const delayed = await rawApplication(author)
    const renewal = await rawCommit({
      group: author,
      binding: await timedBinding({ identity, iat: 101, exp: 201 }),
    })
    await joined.processMessage(encode(mlsMessageEncoder, renewal.commit))
    const opened = await joined.decrypt(delayed)
    expect(new TextDecoder().decode(opened.payload)).toBe('delayed')
    expect(opened.senderDID).toBe(identity.id)
  })

  test('standard groups exclude lifecycle floors and allow a one-time binding', async () => {
    const { group, identity } = await pipelineGroup({ standard: true })
    const leaf = group.state.ratchetTree[0]
    if (leaf?.nodeType !== nodeTypes.leaf) throw new Error('Missing leaf')
    const bound = {
      ...leaf.leaf,
      credential: makeMLSCredential(identity, await timedBinding({ identity, iat: 90, exp: 200 })),
    }
    ;(
      group.registry.controllers as Map<
        string,
        { recordedLog: Array<never>; genFloor: number; timeFloor: number }
      >
    ).set(controllerID, { recordedLog: [], genFloor: 99, timeFloor: 1000 })
    expect(treeTime(group, controllerID)).toBe(0)
    await expect(validateEntry(group, bound, leaf.leaf)).resolves.toBeUndefined()
  })

  test('entry refuses a revoked subject even when its leaf is floating in a standard group', async () => {
    const { group } = await pipelineGroup({ standard: true })
    const identity = agent(61)
    const bundle = await rawAdd(group, identity)
    ;(group.registry.devices as Map<string, { status: 'revoked'; controller: string }>).set(
      identity.id,
      { status: 'revoked', controller: controllerID },
    )
    await expect(group.processMessage(bundle.message)).rejects.toBeInstanceOf(CommitRejectedError)
  })
})

describe('consensus history and composition', () => {
  test('a lifecycle Add crossing the horizon is rejected before a removed receiver can leave', async () => {
    const { group } = await pipelineGroup()
    const rotation = createRotate({
      seed: controllerSeed,
      profile: 0,
      did: controllerID,
      prior: inception.event,
      options: { seal: 'h'.repeat(34000) },
    })
    const prefix = [inception, rotation]
    let current = group
    let removedReceiver = group
    for (let index = 0; index < 11; index++) {
      const identity = agent(80 + index)
      const fixture = await lowLevelWelcome(
        current,
        identity,
        await timedBinding({ identity, iat: 100, exp: index === 10 ? 101 : 200, prefix }),
      )
      current = fixture.author
      removedReceiver = fixture.joined
    }
    const beforeSize = historySize(current.state.ratchetTree, [])
    expect(beforeSize).toBeLessThan(HISTORY_HORIZON)
    const identity = agent(111)
    const add = await rawAdd(
      current,
      identity,
      await timedBinding({ identity, iat: 102, exp: 200, prefix }),
    )
    await expect(current.processMessage(add.message)).rejects.toMatchObject({ reason: 'binding' })
    const oversized = deriveGroup(current, add.result.newState)
    expect(historySize(oversized.state.ratchetTree, [])).toBeGreaterThan(HISTORY_HORIZON)
    const target = oversized.findMemberLeafIndex(agent(90).id)
    if (target == null) throw new Error('Missing target')
    const longerRotation = createRotate({
      seed: controllerSeed,
      profile: 0,
      did: controllerID,
      prior: inception.event,
      options: { seal: 'h'.repeat(40000) },
    })
    const extra = await rawAdd(
      oversized,
      agent(112),
      await timedBinding({
        identity: agent(112),
        iat: 102,
        exp: 200,
        prefix: [inception, longerRotation],
      }),
    )
    const malformed = await rawCommit({
      group: oversized,
      proposals: [
        { proposalType: defaultProposalTypes.remove, remove: { removed: target } },
        { proposalType: defaultProposalTypes.add, add: { keyPackage: extra.bundle.publicPackage } },
      ],
    })
    const removed = await lowLevelApply(removedReceiver, add.message)
    const previous = removed.state
    await expect(
      removed.processMessage(encode(mlsMessageEncoder, malformed.commit)),
    ).rejects.toMatchObject({ reason: 'binding' })
    expect(removed.state).toBe(previous)
    const shrink = await commitWithEntries({
      group: oversized,
      extraProposals: [{ proposalType: defaultProposalTypes.remove, remove: { removed: target } }],
      enacted: [],
      requireAdmin: false,
    })
    expect(historySize(shrink.newState.ratchetTree, [])).toBeLessThan(
      historySize(oversized.state.ratchetTree, []),
    )
    expect(malformed.commit).toBeDefined()
  }, 30000)

  test('standard groups have no history horizon', async () => {
    const { group } = await pipelineGroup({ standard: true })
    const tree = group.state.ratchetTree.slice()
    const leaf = tree[0]
    if (leaf?.nodeType !== nodeTypes.leaf) throw new Error('Missing leaf')
    const rotation = createRotate({
      seed: controllerSeed,
      profile: 0,
      did: controllerID,
      prior: inception.event,
      options: { seal: 'h'.repeat(34000) },
    })
    const identity = agent(61)
    const bundle = await rawAdd(
      group,
      identity,
      await timedBinding({ identity, iat: 100, exp: 200, prefix: [inception, rotation] }),
    )
    for (let index = 0; index < 12; index++)
      tree.push({ nodeType: nodeTypes.leaf, leaf: bundle.bundle.publicPackage.leafNode })
    const large = deriveGroup(group, { ...group.state, ratchetTree: tree })
    expect(historySize(tree, [])).toBeGreaterThan(HISTORY_HORIZON)
    const gate = await prepareLifecycleGate({
      group: large,
      entries: [],
      candidateRegistry: large.registry,
      context: policyContext(large),
    })
    expect(() =>
      gate.check({ kind: 'commit', senderLeafIndex: 0 as LeafIndex, proposals: [] }),
    ).not.toThrow()
  })

  test('the generation floor refuses both entry and an external replacement', async () => {
    const { group, identity } = await pipelineGroup()
    const reset = createReset(controllerSeed, 0, 1)
    const prefix = [inception, reset]
    const renewal = await rawCommit({
      group,
      binding: await timedBinding({ identity, iat: 100, exp: 200, prefix }),
    })
    const renewed = deriveGroup(group, renewal.newState)
    const bob = agent(61)
    const { author } = await lowLevelWelcome(
      renewed,
      bob,
      await timedBinding({ identity: bob, iat: 100, exp: 200, prefix }),
    )
    const token = await signLedgerEntry(identity, {
      type: DEVICE_ENTRY_TYPE,
      groupID: author.groupID,
      subject: controllerID,
      value: { op: 'reset', proof: prefix, revoked: [] },
    })
    const result = await commitWithEntries({
      group: author,
      extraProposals: [],
      enacted: [token],
      requireAdmin: false,
    })
    const installed = deriveGroup(author, result.newState)
    await installed.applyLedgerEntries([token])
    const message = await lowLevelExternal({
      group: installed,
      identity: bob,
      binding: await timedBinding({ identity: bob, iat: 100, exp: 200 }),
    })
    await expect(installed.processMessage(message)).rejects.toMatchObject({ reason: 'floor' })
    const stale = await rawAdd(
      installed,
      agent(71),
      await timedBinding({ identity: agent(71), iat: 100, exp: 200 }),
    )
    await expect(installed.processMessage(stale.message)).rejects.toMatchObject({ reason: 'floor' })
  })

  test('registry agreement checks an Add credential in the same standard commit', async () => {
    const { deviceGroup, deviceIdentity, deviceID, controllerID: profile } = await joinBoundDevice()
    const { capability } = await buildManagementCapability({
      managerDID: deviceID,
      managerKey: deviceIdentity.publicKey,
    })
    const target = agent(43)
    const bundle = await rawAdd(deviceGroup, target)
    await expect(
      addDevice(deviceGroup, deviceIdentity, {
        device: target.id,
        controller: profile,
        keyPackage: bundle.bundle.publicPackage,
        capability,
      }),
    ).rejects.toMatchObject({ reason: 'controller-mismatch' })
  })

  test('a lifecycle commit cannot change extensions under an accepting policy', async () => {
    const { group } = await pipelineGroup()
    const proposal = {
      proposalType: defaultProposalTypes.group_context_extensions,
      groupContextExtensions: {
        extensions: [
          ...group.state.groupContext.extensions,
          makeCustomExtension({ extensionType: 9000, extensionData: new Uint8Array() }),
        ],
      },
    }
    const result = await rawCommit({ group, proposals: [proposal] })
    await expect(
      group.processMessage(encode(mlsMessageEncoder, result.commit)),
    ).rejects.toMatchObject({ reason: 'invalid' })
  })
})

function policyContext(group: GroupHandle) {
  return buildCommitPolicyContext(group, {
    baseRoster: group.roster,
    candidateRoster: group.roster,
    entryIDs: [],
    enactedDeviceEntries: [],
  })
}

test('bound members can author consumer entries without a registry-derived admin role', async () => {
  const { group, identity } = await pipelineGroup()
  const token = await signLedgerEntry(identity, {
    type: 'consumer.note',
    groupID: group.groupID,
    subject: identity.id,
    value: 'note',
  })
  const result = await commitWithEntries({ group, extraProposals: [], enacted: [token] })
  expect(result.newState.groupContext.epoch).toBe(group.epoch + 1n)
})

test.each(['psk', 'reinit'] as const)('mandatory composition refuses %s', async (kind) => {
  const { group } = await pipelineGroup()
  const gate = await prepareLifecycleGate({
    group,
    entries: [],
    candidateRegistry: group.registry,
    context: policyContext(group),
  })
  const proposal =
    kind === 'psk'
      ? {
          proposalType: defaultProposalTypes.psk,
          psk: {
            preSharedKeyId: {
              psktype: 1 as const,
              pskId: new Uint8Array([1]),
              pskNonce: new Uint8Array(32),
            },
          },
        }
      : {
          proposalType: defaultProposalTypes.reinit,
          reinit: {
            groupId: new Uint8Array([1]),
            version: 1 as const,
            cipherSuite: 1 as const,
            extensions: [],
          },
        }
  expect(() =>
    gate.check({
      kind: 'commit',
      senderLeafIndex: 0 as LeafIndex,
      proposals: [{ proposal, senderLeafIndex: 0 as LeafIndex }],
    }),
  ).toThrow(/Unsupported lifecycle proposal/)
})

test('a chained renewal that lowers tree time requires its preserving clock', async () => {
  const { group, identity, tokens } = await pipelineGroup()
  const bob = agent(61)
  const { author, joined } = await lowLevelWelcome(
    group,
    bob,
    await timedBinding({ identity: bob, iat: 90, exp: 200 }),
  )
  const trusted = agent(71)
  const parent = (await timedBinding({ identity: trusted, iat: 90, exp: 300 })).capability
  const binding = await timedBinding({ identity, iat: 100, exp: 201, parent, issuer: trusted })
  const withoutClock = await rawCommit({ group: author, binding })
  const previous = joined.state
  await expect(
    joined.processMessage(encode(mlsMessageEncoder, withoutClock.commit)),
  ).rejects.toMatchObject({ reason: 'floor' })
  expect(joined.state).toBe(previous)
  const clock = await signLedgerEntry(identity, {
    type: DEVICE_ENTRY_TYPE,
    groupID: author.groupID,
    subject: controllerID,
    value: { op: 'clock', time: 100 },
  })
  tokens.set(ledgerEntryDigest(clock), clock)
  const withClock = await rawCommit({ group: author, binding, tokens: [clock] })
  await joined.processMessage(encode(mlsMessageEncoder, withClock.commit))
  expect(treeTime(joined, controllerID)).toBe(100)
  expect(joined.registry.controllers.get(controllerID)?.timeFloor).toBe(100)
})

test('a newer direct grant advances tree time and any member can remove a lapsed target', async () => {
  const { group } = await pipelineGroup()
  const bob = agent(61)
  const fixture = await lowLevelWelcome(
    group,
    bob,
    await timedBinding({ identity: bob, iat: 201, exp: 300 }),
  )
  expect(treeTime(fixture.author, controllerID)).toBe(201)
  await expect(fixture.author.encrypt(new Uint8Array([1]))).rejects.toMatchObject({
    reason: 'lapsed',
  })
  const result = await rawCommit({
    group: fixture.joined,
    proposals: [{ proposalType: defaultProposalTypes.remove, remove: { removed: 0 } }],
  })
  await fixture.author.processMessage(encode(mlsMessageEncoder, result.commit))
  expect(fixture.author.state.groupActiveState.kind).toBe('removedFromGroup')
})

test('a lifecycle external replacement is refused when its subject is denied', async () => {
  const { group, identity } = await pipelineGroup()
  const bob = agent(61)
  const { author } = await lowLevelWelcome(
    group,
    bob,
    await timedBinding({ identity: bob, iat: 90, exp: 200 }),
  )
  const message = await lowLevelExternal({
    group: author,
    identity: bob,
    binding: await timedBinding({ identity: bob, iat: 100, exp: 200 }),
  })
  const revoke = createRevoke({
    seed: controllerSeed,
    profile: 0,
    did: controllerID,
    prior: inception.event,
    target: bob.id,
    keyPosition: { gen: 0, seq: 0 },
  })
  const token = await signLedgerEntry(identity, {
    type: DEVICE_ENTRY_TYPE,
    groupID: author.groupID,
    subject: bob.id,
    value: { op: 'revoke', proof: [inception, revoke], revoked: [{ did: bob.id }] },
  })
  // Seed a known revocation on the offered epoch to exercise admission independently of removal.
  await author.applyLedgerEntries([token])
  await expect(author.processMessage(message)).rejects.toMatchObject({ reason: 'invalid' })
})

test('management capability expiry is judged against its controller tree time', async () => {
  const { deviceGroup, deviceIdentity, deviceID } = await joinBoundDevice()
  const { capability } = await buildManagementCapability({
    managerDID: deviceID,
    managerKey: deviceIdentity.publicKey,
    capabilityOverrides: { iat: 90, exp: 99 },
  })
  const token = await signLedgerEntry(deviceIdentity, {
    type: DEVICE_ENTRY_TYPE,
    groupID: deviceGroup.groupID,
    subject: agent(43).id,
    value: { op: 'add', controller: controllerID, capability },
  })
  await expect(
    commitWithEntries({
      group: deviceGroup,
      extraProposals: [],
      enacted: [token],
      requireAdmin: false,
    }),
  ).rejects.toThrow()
})

test('proposal-level mandatory refusal precedes the caller policy', async () => {
  const { group } = await pipelineGroup()
  const added = await rawAdd(group, agent(61))
  const caller = vi.fn(() => 'accept' as const)
  await expect(group.processMessage(added.message, { commitPolicy: caller })).rejects.toMatchObject(
    { reason: 'binding' },
  )
  expect(caller).not.toHaveBeenCalled()
})

test.each([
  { limit: 86400, lifetime: 86400, accepted: true },
  { limit: 86400, lifetime: 86401, accepted: false },
  { limit: 3600, lifetime: 3600, accepted: true },
  { limit: 3600, lifetime: 3601, accepted: false },
])(
  'chained child lifetime at every entry: $limit/$lifetime',
  async ({ limit, lifetime, accepted }) => {
    for (const boundary of ['add', 'update', 'external', 'welcome']) {
      const { group } = await pipelineGroup({ leafLifetime: limit })
      const bob = agent(61)
      const trusted = agent(71)
      const parent = (await timedBinding({ identity: trusted, iat: 100, exp: 2592100 })).capability
      const binding = await timedBinding({
        identity: bob,
        iat: 100,
        exp: 100 + lifetime,
        parent,
        issuer: trusted,
      })
      let result: Promise<unknown>
      if (boundary === 'add') {
        const fixture = await rawAdd(group, bob, binding)
        result = group.processMessage(fixture.message)
      } else if (boundary === 'welcome') {
        result = (await welcomeBoundary(group, bob, binding)).process()
      } else {
        const fixture = await lowLevelWelcome(
          group,
          bob,
          await timedBinding({ identity: bob, iat: 90, exp: 200 }),
        )
        result = fixture.author.processMessage(
          boundary === 'update'
            ? await rawUpdate(fixture.joined, bob, binding)
            : await lowLevelExternal({ group: fixture.author, identity: bob, binding }),
        )
      }
      if (accepted) await expect(result).resolves.toBeDefined()
      else await expect(result).rejects.toThrow()
    }
  },
)

test('two revoke proofs cannot share a commit', async () => {
  const { group, identity } = await pipelineGroup()
  const first = agent(61)
  const second = agent(71)
  const revoke = createRevoke({
    seed: controllerSeed,
    profile: 0,
    did: controllerID,
    prior: inception.event,
    target: first.id,
    keyPosition: { gen: 0, seq: 0 },
  })
  const next = createRevoke({
    seed: controllerSeed,
    profile: 0,
    did: controllerID,
    prior: revoke.event,
    target: second.id,
    keyPosition: { gen: 0, seq: 0 },
  })
  const tokens = await Promise.all([
    signLedgerEntry(identity, {
      type: DEVICE_ENTRY_TYPE,
      groupID: group.groupID,
      subject: first.id,
      value: { op: 'revoke', proof: [inception, revoke], revoked: [{ did: first.id }] },
    }),
    signLedgerEntry(identity, {
      type: DEVICE_ENTRY_TYPE,
      groupID: group.groupID,
      subject: second.id,
      value: { op: 'revoke', proof: [next], revoked: [{ did: second.id }] },
    }),
  ])
  await expect(
    commitWithEntries({ group, extraProposals: [], enacted: tokens, requireAdmin: false }),
  ).rejects.toMatchObject({ reason: 'effects-mismatch' })
})
