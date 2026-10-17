import { createRevoke } from '@kokuin/controller'
import { randomIdentity } from '@kokuin/token'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import * as envelopeFold from '../src/envelope-fold.js'
import { deriveGroup } from '../src/group-handle.js'
import {
  addDevice,
  announceControllerBeacon,
  authorPrivateCommit,
  CommitAuthoringRefusedError,
  type CommitReceipt,
  commitInvite,
  commitKeyRotation,
  commitLedgerEntries,
  commitSelfRemovals,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  decodeClientState,
  encodeClientState,
  type GroupHandle,
  labelDevice,
  processWelcome,
  proposeSelfRemoval,
  registerDevice,
  removeLapsedLeaves,
  removeMember,
  renewLeaf,
  restoreGroup,
  restrictCommitAuthoring,
  revokeDevice,
  revokeWithProof,
  signLedgerEntry,
  withCommitPermit,
} from '../src/index.js'
import * as lifecycle from '../src/lifecycle.js'
import { buildBoundLeaf } from './fixtures/bound-leaf.js'
import { buildBoundKeyPackageBundle, twoDeviceProfileGroup } from './fixtures/device-harness.js'
import { controllerID, controllerSeed } from './fixtures/lifecycle-ledger.js'
import {
  agent,
  inception,
  lowLevelWelcome,
  pipelineGroup,
  timedBinding,
} from './fixtures/lifecycle-pipeline.js'

beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(150_000))
afterEach(() => vi.restoreAllMocks())

async function pair() {
  const identity = randomIdentity()
  const peer = randomIdentity()
  const { group } = await createGroup(identity, 'authoring-permit')
  const { invite } = await createInvite({
    group,
    identity,
    recipientDID: peer.id,
    permission: 'member',
  })
  const bundle = await createKeyPackageBundle(peer)
  const added = await commitInvite(group, bundle.publicPackage, invite)
  const { group: joined } = await processWelcome({
    identity: peer,
    invite,
    welcome: added.welcomeMessage,
    keyPackageBundle: bundle,
  })
  return { group: added.newGroup, identity, peer, joined }
}

function restoreFromBytes(group: GroupHandle): () => Promise<GroupHandle> {
  const bytes = encodeClientState(group.state)
  return async () => {
    const state = decodeClientState(bytes)
    if (state == null) throw new Error('Invalid fixture state')
    return restoreGroup({ state, credential: group.credential, ledgerEntries: group.ledgerTokens })
  }
}

async function lifecyclePair(peerExp = 190) {
  const { group, identity } = await pipelineGroup()
  const peer = agent(51)
  const fixture = await lowLevelWelcome(
    group,
    peer,
    await timedBinding({ identity: peer, iat: 90, exp: peerExp }),
  )
  return { ...fixture, identity, peer }
}

type BuilderFixture = {
  group: GroupHandle
  build: (group: GroupHandle) => Promise<unknown>
}

const builders: Array<{ name: string; prepare: () => Promise<BuilderFixture> }> = [
  {
    name: 'commitKeyRotation',
    prepare: async () => {
      const { group } = await pair()
      return { group, build: commitKeyRotation }
    },
  },
  {
    name: 'commitLedgerEntries',
    prepare: async () => {
      const { group, identity, peer } = await pair()
      const token = await signLedgerEntry(identity, {
        type: 'kumiai.role',
        groupID: group.groupID,
        subject: peer.id,
        value: 'member',
      })
      return { group, build: (group) => commitLedgerEntries(group, [token]) }
    },
  },
  {
    name: 'commitInvite',
    prepare: async () => {
      const { group, identity } = await pair()
      const peer = randomIdentity()
      const { invite } = await createInvite({
        group,
        identity,
        recipientDID: peer.id,
        permission: 'member',
      })
      const bundle = await createKeyPackageBundle(peer)
      return { group, build: (group) => commitInvite(group, bundle.publicPackage, invite) }
    },
  },
  {
    name: 'removeMember',
    prepare: async () => {
      const { group, joined } = await pair()
      return { group, build: (group) => removeMember(group, joined.state.privatePath.leafIndex) }
    },
  },
  {
    name: 'registerDevice',
    prepare: async () => {
      const { managerGroup: group, managerIdentity, controllerID } = await twoDeviceProfileGroup()
      return {
        group,
        build: (group) =>
          registerDevice(group, managerIdentity, {
            device: managerIdentity.id,
            controller: controllerID,
          }),
      }
    },
  },
  {
    name: 'labelDevice',
    prepare: async () => {
      const {
        managerGroup: group,
        managerIdentity,
        targetDeviceID,
        capability,
      } = await twoDeviceProfileGroup()
      return {
        group,
        build: (group) =>
          labelDevice(group, managerIdentity, {
            device: targetDeviceID,
            label: 'Laptop',
            capability,
          }),
      }
    },
  },
  {
    name: 'addDevice',
    prepare: async () => {
      const {
        managerGroup: group,
        managerIdentity,
        controllerID,
        capability,
      } = await twoDeviceProfileGroup()
      const seed = new Uint8Array(32).fill(71)
      const leaf = await buildBoundLeaf({ deviceSeed: seed })
      const bundle = await buildBoundKeyPackageBundle(leaf, seed)
      return {
        group,
        build: (group) =>
          addDevice(group, managerIdentity, {
            keyPackage: bundle.publicPackage,
            device: leaf.deviceID,
            controller: controllerID,
            capability,
          }),
      }
    },
  },
  {
    name: 'revokeDevice',
    prepare: async () => {
      const {
        managerGroup: group,
        managerIdentity,
        targetDeviceID,
        capability,
      } = await twoDeviceProfileGroup()
      return {
        group,
        build: (group) =>
          revokeDevice(group, managerIdentity, {
            device: targetDeviceID,
            capability,
          }),
      }
    },
  },
  {
    name: 'announceControllerBeacon',
    prepare: async () => {
      const { managerGroup: group, managerIdentity, controllerID } = await twoDeviceProfileGroup()
      return {
        group,
        build: (group) =>
          announceControllerBeacon(group, managerIdentity, {
            controller: controllerID,
            logLength: 7,
            headDigest: 'zDet7',
          }),
      }
    },
  },
  {
    name: 'commitSelfRemovals',
    prepare: async () => {
      const { author: group, joined } = await lifecyclePair()
      await group.processMessage((await proposeSelfRemoval(joined)).frame)
      return { group, build: commitSelfRemovals }
    },
  },
  {
    name: 'renewLeaf',
    prepare: async () => {
      const { group, identity } = await pipelineGroup()
      const binding = await timedBinding({ identity, iat: 150, exp: 250 })
      return { group, build: (group) => renewLeaf(group, binding) }
    },
  },
  {
    name: 'removeLapsedLeaves',
    prepare: async () => {
      const { author, identity } = await lifecyclePair(110)
      const renewed = await renewLeaf(author, await timedBinding({ identity, iat: 150, exp: 250 }))
      return { group: renewed.newGroup, build: removeLapsedLeaves }
    },
  },
  {
    name: 'revokeWithProof',
    prepare: async () => {
      const { author: group, peer } = await lifecyclePair()
      const log = [
        inception,
        createRevoke({
          seed: controllerSeed,
          profile: 0,
          did: controllerID,
          prior: inception.event,
          target: peer.id,
          keyPosition: { gen: 0, seq: 0 },
        }),
      ]
      return { group, build: (group) => revokeWithProof(group, { subject: peer.id, log }) }
    },
  },
]

test.each(builders)(
  'a restricted handle cannot build any private commit: $name',
  async ({ prepare }) => {
    const { group, build } = await prepare()
    const before = encodeClientState(group.state)
    const fold = vi.spyOn(envelopeFold, 'foldEnvelope')
    const gate = vi.spyOn(lifecycle, 'prepareLifecycleGate')
    expect(restrictCommitAuthoring(group)).toBe(group)
    const error = await build(group).then(
      () => null,
      (error: unknown) => error,
    )
    expect(encodeClientState(group.state)).toEqual(before)
    expect(error).toBeInstanceOf(CommitAuthoringRefusedError)
    expect(error).toMatchObject({
      message: 'Private commit authoring requires the control-build permit',
    })
    expect(fold).not.toHaveBeenCalled()
    expect(gate).not.toHaveBeenCalled()
  },
)

test('restriction precedes a failing ledger fold', async () => {
  const { group, peer } = await pair()
  const token = await signLedgerEntry(peer, {
    type: 'kumiai.role',
    groupID: group.groupID,
    subject: peer.id,
    value: 'admin',
  })
  await expect(commitLedgerEntries(group, [token])).rejects.toThrow('cannot enact')
  restrictCommitAuthoring(group)
  await expect(commitLedgerEntries(group, [token])).rejects.toBeInstanceOf(
    CommitAuthoringRefusedError,
  )
})

test('restriction is permanent', async () => {
  const { group } = await pair()
  const retained = (() => restrictCommitAuthoring(group))()
  await expect(commitKeyRotation(retained)).rejects.toBeInstanceOf(CommitAuthoringRefusedError)
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await expect(commitKeyRotation(retained)).rejects.toBeInstanceOf(CommitAuthoringRefusedError)
  expect(restrictCommitAuthoring(retained)).toBe(retained)
  await expect(commitKeyRotation(retained)).rejects.toBeInstanceOf(CommitAuthoringRefusedError)
})

test('derived handles inherit restriction from restricted and permit handles', async () => {
  const { group } = await pair()
  const restore = restoreFromBytes(group)
  restrictCommitAuthoring(group)
  const derived = deriveGroup(group, structuredClone(group.state))
  await expect(commitKeyRotation(derived)).rejects.toBeInstanceOf(CommitAuthoringRefusedError)
  await withCommitPermit(restore, async (permitted) => {
    const derived = deriveGroup(permitted, structuredClone(permitted.state))
    await expect(commitKeyRotation(derived)).rejects.toBeInstanceOf(CommitAuthoringRefusedError)
    const result = await commitKeyRotation(permitted)
    await expect(commitKeyRotation(result.newGroup)).rejects.toBeInstanceOf(
      CommitAuthoringRefusedError,
    )
  })
})

test('proposeSelfRemoval refuses under restriction and under a permit', async () => {
  const { group } = await pipelineGroup()
  const restore = restoreFromBytes(group)
  restrictCommitAuthoring(group)
  const before = encodeClientState(group.state)
  await expect(proposeSelfRemoval(group)).rejects.toMatchObject({
    name: 'CommitAuthoringRefusedError',
    message: 'Own proposals are refused under access',
  })
  expect(encodeClientState(group.state)).toEqual(before)
  await withCommitPermit(restore, async (permitted) => {
    const before = encodeClientState(permitted.state)
    await expect(proposeSelfRemoval(permitted)).rejects.toBeInstanceOf(CommitAuthoringRefusedError)
    expect(encodeClientState(permitted.state)).toEqual(before)
    await commitKeyRotation(permitted)
  })
})

test('an invite receipt binds independent encoded Welcome bytes from its construction', async () => {
  const { group, identity } = await pair()
  const recipient = randomIdentity()
  const { invite } = await createInvite({
    group,
    identity,
    recipientDID: recipient.id,
    permission: 'member',
  })
  const bundle = await createKeyPackageBundle(recipient)
  const { value, receipt } = await withCommitPermit(restoreFromBytes(group), (permitted) =>
    commitInvite(permitted, bundle.publicPackage, invite),
  )
  expect(receipt).toHaveProperty('welcome', value.welcomeMessage)
  const encoded = value.welcomeMessage.slice()
  value.welcomeMessage.fill(0)
  expect(receipt).toHaveProperty('welcome', encoded)
})

test('a permit allows exactly one commit and identifies its encoded bytes', async () => {
  const { group } = await pair()
  let retained = group
  const { value, receipt } = await withCommitPermit(restoreFromBytes(group), async (permitted) => {
    retained = permitted
    const result = await commitKeyRotation(permitted)
    await expect(commitKeyRotation(permitted)).rejects.toBeInstanceOf(CommitAuthoringRefusedError)
    return result
  })
  expect(receipt).toEqual({
    commit: value.commitMessage,
    welcome: null,
    referencedProposals: [],
    epoch: Number(group.epoch),
    authenticatorBefore: group.state.keySchedule.epochAuthenticator,
    candidateAuthenticator: value.newGroup.state.keySchedule.epochAuthenticator,
  })
  const candidateAuthenticator = value.newGroup.state.keySchedule.epochAuthenticator
  const recordedAuthenticator = candidateAuthenticator.slice()
  candidateAuthenticator.fill(0)
  expect(receipt?.candidateAuthenticator).toEqual(recordedAuthenticator)
  receipt?.candidateAuthenticator.fill(1)
  expect(candidateAuthenticator).toEqual(new Uint8Array(candidateAuthenticator.length))
  await expect(commitKeyRotation(retained)).rejects.toBeInstanceOf(CommitAuthoringRefusedError)
})

test.each(['fulfils', 'rejects'] as const)(
  'a permit tracks microtask construction after its callback %s',
  async (callbackOutcome) => {
    const { group } = await pair()
    const receipt: CommitReceipt = {
      commit: new Uint8Array([1]),
      welcome: null,
      referencedProposals: [],
      epoch: Number(group.epoch),
      authenticatorBefore: group.state.keySchedule.epochAuthenticator.slice(),
      candidateAuthenticator: new Uint8Array([2]),
    }
    const failure = new Error('callback failed')
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const attempted = Promise.withResolvers<string>()
    let settled = false
    const scope = withCommitPermit(restoreFromBytes(group), (permitted) => {
      queueMicrotask(() => {
        try {
          attempted.resolve(
            authorPrivateCommit(permitted, async () => {
              started.resolve()
              await release.promise
              return { value: 'commit complete', receipt }
            }),
          )
        } catch (error) {
          started.reject(error)
          attempted.reject(error)
        }
      })
      return callbackOutcome === 'fulfils'
        ? Promise.resolve('callback complete')
        : Promise.reject(failure)
    })
    const outcome = scope.then(
      (value) => {
        settled = true
        return { status: 'fulfilled', value }
      },
      (reason: unknown) => {
        settled = true
        return { status: 'rejected', reason }
      },
    )
    try {
      await started.promise
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(settled).toBe(false)
    } finally {
      release.resolve()
      await attempted.promise
      await outcome
    }
    expect(await attempted.promise).toBe('commit complete')
    expect(await outcome).toEqual(
      callbackOutcome === 'fulfils'
        ? { status: 'fulfilled', value: { value: 'callback complete', receipt } }
        : { status: 'rejected', reason: failure },
    )
  },
)

test('a permit returns the receipt of an unawaited real MLS builder', async () => {
  const { group } = await pair()
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof commitKeyRotation>>>()
  const { value, receipt } = await withCommitPermit(restoreFromBytes(group), async (permitted) => {
    pending.resolve(commitKeyRotation(permitted))
    return 'callback complete'
  })
  const built = await pending.promise
  expect(value).toBe('callback complete')
  expect(built.epoch).toBe(group.epoch + 1n)
  expect(receipt).toEqual({
    commit: built.commitMessage,
    welcome: null,
    referencedProposals: [],
    epoch: Number(group.epoch),
    authenticatorBefore: group.state.keySchedule.epochAuthenticator,
    candidateAuthenticator: built.newGroup.state.keySchedule.epochAuthenticator,
  })
})

test.each(['fulfils', 'rejects'] as const)(
  'construction failure rejects the scope when its callback %s',
  async (callbackOutcome) => {
    const { group } = await pair()
    const failure = new Error('construction failed')
    const started = Promise.withResolvers<void>()
    const construction = Promise.withResolvers<{ value: string; receipt: CommitReceipt }>()
    const scope = withCommitPermit(restoreFromBytes(group), async (permitted) => {
      authorPrivateCommit(permitted, () => construction.promise).catch(() => {})
      started.resolve()
      if (callbackOutcome === 'rejects') throw new Error('callback failed')
      return 'callback complete'
    })
    const rejected = expect(scope).rejects.toBe(failure)
    await started.promise
    construction.reject(failure)
    await rejected
  },
)

test('a caught synchronous construction failure still rejects the scope', async () => {
  const { group } = await pair()
  const failure = new Error('construction failed')
  await expect(
    withCommitPermit(restoreFromBytes(group), async (permitted) => {
      expect(() =>
        authorPrivateCommit(permitted, () => {
          throw failure
        }),
      ).toThrow(failure)
      return 'callback complete'
    }),
  ).rejects.toBe(failure)
})

test('a permit needs a fresh handle, including when a permit is already active', async () => {
  const { group } = await pair()
  const restore = restoreFromBytes(group)
  restrictCommitAuthoring(group)
  const fn = vi.fn()
  await expect(withCommitPermit(async () => group, fn)).rejects.toBeInstanceOf(
    CommitAuthoringRefusedError,
  )
  expect(fn).not.toHaveBeenCalled()
  await withCommitPermit(restore, async (permitted) => {
    await expect(withCommitPermit(async () => permitted, fn)).rejects.toBeInstanceOf(
      CommitAuthoringRefusedError,
    )
    expect(fn).not.toHaveBeenCalled()
  })
})

test('the permit is consumed synchronously before overlapping construction', async () => {
  const { group } = await pair()
  const receipt: CommitReceipt = {
    commit: new Uint8Array([1]),
    welcome: null,
    referencedProposals: [],
    epoch: Number(group.epoch),
    authenticatorBefore: group.state.keySchedule.epochAuthenticator,
    candidateAuthenticator: new Uint8Array([2]),
  }
  const construct = vi.fn(async () => ({
    value: 'second',
    receipt: { ...receipt, commit: new Uint8Array([3]) },
  }))
  const slow = Promise.withResolvers<void>()
  const slowConstruct = vi.fn(async () => {
    await slow.promise
    return { value: 'first', receipt }
  })
  const { value, receipt: recorded } = await withCommitPermit(
    restoreFromBytes(group),
    async (permitted) => {
      const first = authorPrivateCommit(permitted, slowConstruct)
      expect(slowConstruct).toHaveBeenCalledTimes(1)
      expect(() => authorPrivateCommit(permitted, construct)).toThrow(CommitAuthoringRefusedError)
      const both = Promise.allSettled([
        first,
        Promise.resolve().then(() => authorPrivateCommit(permitted, construct)),
      ])
      await Promise.resolve()
      expect(construct).not.toHaveBeenCalled()
      slow.resolve()
      return both
    },
  )
  expect(value).toEqual([
    { status: 'fulfilled', value: 'first' },
    { status: 'rejected', reason: expect.any(CommitAuthoringRefusedError) },
  ])
  expect(recorded).toEqual(receipt)
  expect(construct).not.toHaveBeenCalled()
})

test('failed construction consumes the permit and callback failure revokes it', async () => {
  const { group } = await pair()
  const failure = new Error('construction failed')
  let retained = group
  await expect(
    withCommitPermit(restoreFromBytes(group), async (permitted) => {
      retained = permitted
      expect(() =>
        authorPrivateCommit(permitted, () => {
          throw failure
        }),
      ).toThrow(failure)
      expect(() => authorPrivateCommit(permitted, vi.fn())).toThrow(CommitAuthoringRefusedError)
      throw failure
    }),
  ).rejects.toBe(failure)
  await expect(commitKeyRotation(retained)).rejects.toBeInstanceOf(CommitAuthoringRefusedError)
  const retried = await withCommitPermit(restoreFromBytes(group), commitKeyRotation)
  expect(retried.receipt?.commit).toEqual(retried.value.commitMessage)
})

test('a caught rejected construction leaves the permit consumed and rejects the scope', async () => {
  const { group } = await pair()
  const failure = new Error('construction rejected')
  await expect(
    withCommitPermit(restoreFromBytes(group), async (permitted) => {
      await expect(
        authorPrivateCommit(permitted, async () => {
          throw failure
        }),
      ).rejects.toBe(failure)
      expect(() => authorPrivateCommit(permitted, vi.fn())).toThrow(CommitAuthoringRefusedError)
    }),
  ).rejects.toBe(failure)
})

test('an unused permit is revoked and has no receipt when the callback settles', async () => {
  const { group } = await pair()
  const { value: retained, receipt } = await withCommitPermit(
    restoreFromBytes(group),
    async (p) => p,
  )
  expect(receipt).toBeNull()
  await expect(commitKeyRotation(retained)).rejects.toBeInstanceOf(CommitAuthoringRefusedError)
})

test('restricting a permit is permanent', async () => {
  const { group } = await pair()
  await withCommitPermit(restoreFromBytes(group), async (permitted) => {
    restrictCommitAuthoring(permitted)
    await expect(commitKeyRotation(permitted)).rejects.toBeInstanceOf(CommitAuthoringRefusedError)
  })
})

test('the receipt records both referenced foreign self-removal proposals', async () => {
  const { author, joined } = await lifecyclePair()
  const third = agent(61)
  const added = await lowLevelWelcome(
    author,
    third,
    await timedBinding({ identity: third, iat: 100, exp: 200 }),
  )
  await joined.processMessage(added.message)
  for (const member of [joined, added.joined]) {
    await added.author.processMessage((await proposeSelfRemoval(member)).frame)
  }
  const refs = Object.keys(added.author.state.unappliedProposals)
  expect(refs).toHaveLength(2)
  const { value, receipt } = await withCommitPermit(
    restoreFromBytes(added.author),
    commitSelfRemovals,
  )
  expect(value).not.toBeNull()
  expect(receipt?.referencedProposals).toEqual(refs)
  expect(receipt?.commit).toEqual(value?.commitMessage)
  expect(receipt?.candidateAuthenticator).toEqual(
    value?.newGroup.state.keySchedule.epochAuthenticator,
  )
})

test('the check takes no lock while rotation and concurrent decryption complete', async () => {
  const { group, joined } = await pair()
  const payload = new TextEncoder().encode('concurrent receive')
  const frame = await joined.encrypt(payload)
  await withCommitPermit(restoreFromBytes(group), async (permitted) => {
    const [rotated, opened] = await Promise.all([
      commitKeyRotation(permitted),
      permitted.decrypt(frame),
    ])
    expect(rotated.epoch).toBe(group.epoch + 1n)
    expect(opened.payload).toEqual(payload)
  })
}, 2000)

test('an unmarked handle builds as before', async () => {
  const { group } = await pair()
  const result = await commitKeyRotation(group)
  expect(result.epoch).toBe(group.epoch + 1n)
  expect(result.commitMessage.length).toBeGreaterThan(0)
  expect((await commitKeyRotation(result.newGroup)).epoch).toBe(group.epoch + 2n)
})
