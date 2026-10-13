import {
  commitKeyRotation,
  commitSelfRemovals,
  decodeClientState,
  encodeClientState,
  restoreGroup,
} from '@kumiai/mls'
import type { ControlStore, GroupForkEvidence } from '@kumiai/rpc'
import {
  type AdoptionWrite,
  asLogPosition,
  CONTROL_SEARCH_BUDGET,
  type ControlSlot,
  createControlSearch,
  decodeCommitFrame,
  decodeHandshakeFrame,
  digestAppliedCommit,
  encodeCommitFrame,
  encodeHandshakeFrame,
  encodeLedgerEntries,
  forkEventID,
  HANDSHAKE_KIND,
  type Operation,
  recoveryUnavailableEventID,
  settleControlSlot,
} from '@kumiai/rpc'
import { expect, test, vi } from 'vitest'

import { simpleHandleAccess } from '../src/access.js'
import { createControlAdoptionPort } from '../src/control-adoption.js'
import { createControlBuildPort, createPersistenceBuildSaver } from '../src/control-build.js'
import { decodeControlJournal, encodeControlJournal } from '../src/control-journal.js'
import { createControlValidationPort } from '../src/control-validation.js'
import { createMemoryGroupPersistence } from '../src/memory-group-persistence.js'
import { createMemoryTransaction } from '../src/memory-transaction.js'
import { createGroupMLS } from '../src/mls.js'
import { createOwnerQueues } from '../src/owner-queue.js'
import { createDeterministicAtRestCodec } from './fixtures/at-rest.js'
import { controlAdoptionFixture } from './fixtures/control-adoption.js'
import { buildRealCommit, createRealGroup } from './fixtures/real-group.js'
import { installSeed, makeStorageSeed, nextChange } from './fixtures/storage-seed.js'
import {
  createTransactionalAccess,
  createTransactionalStore,
} from './fixtures/transactional-access.js'

async function retainedRotation(size = 1) {
  const group = await createRealGroup(size, 'retained-rotation')
  const member = group.members[0]
  if (member === undefined) throw new Error('Missing member')
  const store = createTransactionalStore(member.handle)
  const host = await createTransactionalAccess(member, store)
  const builds = vi.fn(async (_op: Operation, handle: typeof member.handle) => {
    const rotation = await commitKeyRotation(handle)
    return {
      commit: rotation.commitMessage,
      digest: digestAppliedCommit(rotation.commitMessage),
      bodies: [],
      welcome: null,
      epoch: Number(handle.epoch),
      incarnation: 1,
      authenticatorBefore: handle.state.keySchedule.epochAuthenticator.slice(),
      journal: encodeClientState(rotation.newGroup.state),
    }
  })
  const intent: Operation & { stage: 'intent' } = {
    id: 'rotation',
    kind: 'rotation',
    revokes: false,
    body: new Uint8Array(),
    seq: 1,
    enqueuedAt: Date.now(),
    deadline: Date.now() + 30_000,
    stage: 'intent',
  }
  const prepare = createControlBuildPort({
    access: host.access,
    control: store.control,
    build: builds,
    saveBuilt: store.saveBuilt,
    now: Date.now,
    newID: () => crypto.randomUUID(),
  })
  const build = async () => {
    await store.control.apply({ putOperations: [intent] }, 'enqueue')
    expect(
      (
        await prepare.prepareBuild(intent, async (built, seal) => ({
          payload: encodeHandshakeFrame(
            HANDSHAKE_KIND.commit,
            encodeCommitFrame(built.commit, (await seal(encodeLedgerEntries(built.bodies))).sealed),
          ),
          publishID: 'rotation-publish',
          expectedHead: null,
        }))
      ).kind,
    ).toBe('saved')
    const slot = (await store.control.load()).commitOnce
    if (slot === null) throw new Error('Missing slot')
    return slot
  }
  const restoreCandidate = async (bytes: Uint8Array) => {
    const state = decodeClientState(bytes)
    if (state === undefined) throw new Error('Invalid candidate')
    return restoreGroup({
      state,
      credential: member.handle.credential,
      ledgerEntries: store.snapshot().ledger,
      options: { resolveLedgerEntries: member.slot.resolve },
    })
  }
  const accept = async (target: typeof store, slot: ControlSlot) => {
    const proof = {
      source: (await target.readEvidence()).source,
      from: slot.searchFrom,
      position: asLogPosition('000001'),
      payloadDigest: slot.payloadDigest,
    }
    await target.control.apply({ commitOnceAcceptance: proof }, 'accept')
    const write: AdoptionWrite = {
      mutationID: 'landed',
      changes: {
        deleteOperations: [intent.id],
        commitOnce: null,
        putApplied: [
          {
            epoch: slot.epoch,
            digest: slot.digest,
            payloadDigest: slot.payloadDigest,
            sequenceID: proof.position,
            opID: intent.id,
            removed: false,
          },
        ],
        cursor: { position: proof.position, epoch: slot.epoch + 1 },
      },
    }
    return { proof, write }
  }
  return { group, member, store, host, builds, build, restoreCandidate, accept }
}

test.each(['generation', 'source-message', 'retained-history', 'eviction'] as const)(
  'accepted restart carries current progress without resurrecting history (%s)',
  async (check) => {
    const f = await retainedRotation()
    const copySender = async () => {
      const sender = f.group.committer.handle
      const state = decodeClientState(encodeClientState(sender.state))
      if (state === undefined) throw new Error('Invalid sender')
      return restoreGroup({
        state,
        credential: sender.credential,
        ledgerEntries: sender.ledgerTokens,
      })
    }
    const evictedSender = await copySender()
    await f.host.access.mutate(async (handle) =>
      handle.processMessage(await buildRealCommit(f.group)),
    )
    const olderSender = await copySender()
    await f.host.access.mutate(async (handle) =>
      handle.processMessage(await buildRealCommit(f.group)),
    )
    // A null cursor is only valid at the retained installation identity.
    await f.store.control.apply({ cursor: { position: asLogPosition('000000'), epoch: 3 } }, 'walk')
    const slot = await f.build()
    const candidate = await f.restoreCandidate(decodeControlJournal(slot.journal).candidate)
    const nextTree = structuredClone(candidate.state.secretTree)
    const originalCandidateAuthenticator = candidate.state.keySchedule.epochAuthenticator.slice()
    const sourceEpoch = BigInt(slot.epoch)
    const ownLeaf = f.host.live().state.privatePath.leafIndex * 2
    const generationAtBuild =
      candidate.state.historicalReceiverData.get(sourceEpoch)?.secretTree.leafNodes[ownLeaf]
        ?.application.generation ?? 0
    const message = await f.group.committer.handle.encrypt(new TextEncoder().encode('source'))
    const olderMessage = await olderSender.encrypt(new TextEncoder().encode('older'))
    const evictedMessage = await evictedSender.encrypt(new TextEncoder().encode('evicted'))
    await f.host.access.mutate(async (handle) => {
      await handle.decrypt(message)
      await handle.decrypt(olderMessage)
      await handle.encrypt(new TextEncoder().encode('one'))
      await handle.encrypt(new TextEncoder().encode('two'))
      handle.state.historicalReceiverData.delete(1n)
    })
    const currentOwnGenerationAtSourceEpoch =
      f.host.live().state.secretTree.leafNodes[ownLeaf]?.application.generation
    const { proof, write } = await f.accept(f.store, slot)
    const storedProofVersion = proof.source.stateVersion
    const store = await f.store.fork()
    const restarted = await createTransactionalAccess(f.member, store)
    const restoredCandidate = await f.restoreCandidate(decodeControlJournal(slot.journal).candidate)
    expect(restoredCandidate.state.keySchedule.epochAuthenticator).toEqual(
      originalCandidateAuthenticator,
    )
    const port = createControlAdoptionPort({
      access: restarted.access,
      control: store.control,
      restoreCandidate: f.restoreCandidate,
    })
    f.builds.mockClear()
    const source = (await store.readEvidence()).source
    expect(source.stateVersion).toBeGreaterThan(storedProofVersion)
    expect(await port.adopt(slot.journal, { ...source, acceptance: proof }, write)).toBe(
      'installed',
    )
    const adopted = restarted.live()
    const adoptedOwnGenerationAtSourceEpoch =
      adopted.state.historicalReceiverData.get(sourceEpoch)?.secretTree.leafNodes[ownLeaf]
        ?.application.generation
    if (check === 'generation') {
      expect(adoptedOwnGenerationAtSourceEpoch).toBe(currentOwnGenerationAtSourceEpoch)
      expect(adoptedOwnGenerationAtSourceEpoch).toBeGreaterThan(generationAtBuild)
    }
    if (check === 'eviction') {
      expect(adopted.state.historicalReceiverData.has(1n)).toBe(false)
      await expect(adopted.decrypt(evictedMessage)).rejects.toThrow()
    }
    if (check === 'retained-history') {
      expect(adopted.state.historicalReceiverData.has(2n)).toBe(true)
      await expect(adopted.decrypt(olderMessage)).rejects.toThrow()
    }
    expect(adopted.state.keySchedule.epochAuthenticator).toEqual(originalCandidateAuthenticator)
    expect(adopted.state.secretTree).toEqual(nextTree)
    if (check === 'source-message') await expect(adopted.decrypt(message)).rejects.toThrow()
    expect(f.builds.mock.calls.length).toBe(0)
  },
)

test('extra proposal is omitted cleared and requires reproposal', async () => {
  const f = await retainedRotation(2)
  const slot = await f.build()
  const proposer = f.group.members[1]
  if (proposer === undefined) throw new Error('Missing proposer')
  const proposal = await proposer.handle.proposeSelfRemoval()
  await f.host.access.mutate(async (handle) => handle.processMessage(proposal.frame))
  expect(Object.keys(f.host.live().state.unappliedProposals)).toHaveLength(1)
  const { proof, write } = await f.accept(f.store, slot)
  const port = createControlAdoptionPort({
    access: f.host.access,
    control: f.store.control,
    restoreCandidate: f.restoreCandidate,
  })
  expect(
    await port.adopt(
      slot.journal,
      { ...(await f.store.readEvidence()).source, acceptance: proof },
      write,
    ),
  ).toBe('installed')
  const adopted = f.host.live()
  const targetDID = proposer.identity.id
  expect(adopted.listMembers().map((member) => member.id)).toContain(targetDID)
  expect(adopted.state.unappliedProposals).toEqual({})
  const omitted = await commitKeyRotation(adopted)
  expect(omitted.newGroup.listMembers().map((member) => member.id)).toContain(targetDID)
  await proposer.handle.processMessage(
    decodeCommitFrame(decodeHandshakeFrame(slot.payload).payload).commit,
  )
  await proposer.handle.processMessage(omitted.commitMessage)
  await f.host.access.replace(omitted.newGroup)
  const later = f.host.live()
  const reproposed = await proposer.handle.proposeSelfRemoval()
  await later.processMessage(reproposed.frame)
  expect(Object.keys(later.state.unappliedProposals)).toHaveLength(1)
  const enacted = await commitSelfRemovals(later)
  expect(enacted).not.toBeNull()
  expect(enacted?.newGroup.listMembers().map((member) => member.id)).not.toContain(targetDID)
  expect(enacted?.newGroup.state.unappliedProposals).toEqual({})
})

test('acceptance persistence refreshes adoption expectations without rewriting historical proof', async () => {
  const f = await retainedRotation()
  const slot = await f.build()
  const position = asLogPosition('000001')
  const beforeAcceptance = (await f.store.readEvidence()).source
  const safety = safetyCallbacks(f.store.control)
  const search = createControlSearch({
    ...safety,
    budget: CONTROL_SEARCH_BUDGET,
    validation: createControlValidationPort({
      identity: f.member.identity,
      options: {},
      restoreCandidate: f.restoreCandidate,
    }),
    readEvidence: f.store.readEvidence,
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
                senderDID: f.member.identity.id,
                payload: slot.payload,
              },
            ],
    }),
    followWinner: async () => {
      throw new Error('Unexpected competitor')
    },
    reconcileAbsent: async () => true,
    hold: async (controlHold) => f.store.control.apply({ controlHold }, crypto.randomUUID()),
  })
  const port = createControlAdoptionPort({
    access: f.host.access,
    control: f.store.control,
    restoreCandidate: f.restoreCandidate,
  })
  expect(
    await settleControlSlot({
      ...safety,
      control: f.store.control,
      search,
      readEvidence: f.store.readEvidence,
      adoption: {
        adopt: async (journal, expected, write) => {
          expect(expected.acceptance.source).toEqual(beforeAcceptance)
          expect(expected.stateVersion).toBeGreaterThan(expected.acceptance.source.stateVersion)
          expect(expected.stateVersion).toBe((await f.store.readEvidence()).source.stateVersion)
          return port.adopt(journal, expected, write)
        },
      },
      now: Date.now,
      newID: () => crypto.randomUUID(),
      emit: () => {},
    }),
  ).toBe('landed')
  expect(f.host.live().epoch).toBe(BigInt(slot.epoch + 1))
  expect((await f.store.control.load()).commitOnce).toBeNull()
  expect((await f.store.control.load()).outcomes).toEqual([
    expect.objectContaining({ kind: 'landed', opID: slot.opID, position }),
  ])
})

test('stale adoption version leaves state and control unchanged', async () => {
  const f = await controlAdoptionFixture()
  const expected = await f.expected()
  f.store.bump()
  const before = structuredClone(f.store.snapshot())
  expect(await f.port.adopt(f.slot.journal, expected, f.write)).toBe('moved')
  expect(f.store.snapshot()).toEqual(before)
  expect(await f.port.adopt(f.slot.journal, await f.expected(), f.write)).toBe('installed')
  expect(f.host.live().state.keySchedule.epochAuthenticator).toEqual(
    f.rotation.newGroup.state.keySchedule.epochAuthenticator,
  )
})

test('adoption rollback leaves state control and anchor unchanged', async () => {
  const f = await controlAdoptionFixture()
  const before = structuredClone(f.store.snapshot())
  const live = f.host.live()
  f.store.beforeWrite = () => {
    throw new Error('rollback')
  }
  await expect(f.port.adopt(f.slot.journal, await f.expected(), f.write)).rejects.toThrow(
    'rollback',
  )
  expect(f.store.snapshot()).toEqual(before)
  expect(f.host.live()).toBe(live)
  f.store.beforeWrite = undefined
  expect(await f.port.adopt(f.slot.journal, await f.expected(), f.write)).toBe('installed')
  expect(f.store.snapshot().control.applied).toHaveLength(1)
  expect(f.store.snapshot().control.outcomes).toHaveLength(1)
  expect(f.store.snapshot().anchorSlot?.pending?.landed).toBe(true)
})

test('no-op requires committed payload evidence', async () => {
  const f = await controlAdoptionFixture()
  await f.host.access.replace(f.rotation.newGroup)
  const before = structuredClone(f.store.snapshot())
  expect(await f.port.adopt(f.slot.journal, await f.expected(), f.write)).toBe('moved')
  expect(f.store.snapshot()).toEqual(before)
})

test('committed adoption replay does not recreate acknowledged landed facts', async () => {
  const f = await controlAdoptionFixture()
  expect(await f.port.adopt(f.slot.journal, await f.expected(), f.write)).toBe('installed')
  await f.store.control.apply({ deleteOutcomes: ['landed-fact'] }, 'ack')
  const before = structuredClone(f.store.snapshot())
  expect(await f.port.adopt(f.slot.journal, await f.expected(), f.write)).toBe('noop')
  expect(f.store.snapshot()).toEqual(before)
})

test('own authorship requires the content signature rather than sender data alone', async () => {
  const group = await createRealGroup(1, 'own-authorship')
  const member = group.members[0]
  if (member === undefined) throw new Error('missing member')
  const store = createTransactionalStore(member.handle)
  const host = await createTransactionalAccess(member, store)
  const mls = createGroupMLS({
    access: host.access,
    identity: member.identity,
    entrySlot: member.slot,
  })
  const rotation = await commitKeyRotation(member.handle)
  const tampered = rotation.commitMessage.slice()
  tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1
  expect(await member.handle.verifyCommitSignature(tampered)).toBe(false)
  expect(await mls.readCommitHeader(tampered)).not.toHaveProperty('committerDID')
})

test('a durable control hold refuses installation with an otherwise current proof', async () => {
  const f = await controlAdoptionFixture()
  await f.store.control.apply(
    { controlHold: { reason: 'unsupported-version', position: f.proof.position } },
    'hold',
  )
  const before = structuredClone(f.store.snapshot())
  expect(await f.port.adopt(f.slot.journal, await f.expected(), f.write)).toBe('moved')
  expect(f.store.snapshot()).toEqual(before)
})

test.each(['strand', 'cursor'] as const)(
  'retained adoption refuses a durable %s with an otherwise current proof',
  async (evidence) => {
    const f = await controlAdoptionFixture()
    await f.store.control.apply(
      evidence === 'strand'
        ? { strand: { reason: 'ahead' } }
        : { cursor: { position: null, epoch: f.slot.epoch, stranded: true } },
      'ahead',
    )
    const before = structuredClone(f.store.snapshot())
    expect(await f.port.adopt(f.slot.journal, await f.expected(), f.write)).toBe('moved')
    expect(f.store.snapshot()).toEqual(before)
  },
)

test('transport clearing preserves a durable control hold and its cursor evidence', async () => {
  const db = createMemoryTransaction({ rows: {} })
  const groups = createMemoryGroupPersistence({
    db,
    owners: createOwnerQueues(),
    atRest: createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(17) }),
    providerID: 'memory',
  })
  const seed = await makeStorageSeed({ id: 'held-group', incarnation: 1, epoch: 2, mode: 'double' })
  await installSeed(groups, seed, 'seed')
  const controlHold = { reason: 'unsupported-version' as const, position: asLogPosition('002') }
  const cursor = { position: asLogPosition('001'), epoch: 2, stranded: true as const }
  await groups.transition(await nextChange(groups, seed.key.groupID, 'hold'), async (stores) => {
    await stores
      .incarnation(1)
      .control.apply({ controlHold, cursor, strand: { reason: 'unsupported-version' } }, 'hold')
  })
  await groups.transition(await nextChange(groups, seed.key.groupID, 'clear'), async (stores) => {
    await stores.incarnation(1).clearTransport()
  })
  expect(await groups.ports(seed.key).control.load()).toMatchObject({
    controlHold,
    cursor,
    strand: { reason: 'unsupported-version' },
  })
})

test('2.1 adoption rolls back and co-commits trust spent anchor and opaque side writes', async () => {
  const db = createMemoryTransaction({ rows: { side: new Map() } })
  const groups = createMemoryGroupPersistence({
    db,
    owners: createOwnerQueues(),
    atRest: createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(18) }),
    providerID: 'memory',
  })
  const seed = await makeStorageSeed({
    id: 'coupled-adoption',
    incarnation: 1,
    epoch: 0,
    mode: 'real-mls',
  })
  await installSeed(groups, seed, 'seed')
  const restoreCandidate = async (bytes: Uint8Array) => {
    const state = decodeClientState(bytes)
    if (state === undefined) throw new Error('Invalid candidate')
    return restoreGroup({
      state,
      credential: seed.trust.credential,
      ledgerEntries: seed.trust.ledger,
    })
  }
  if (seed.state.state === null) throw new Error('Missing seed state')
  let current = await restoreCandidate(seed.state.state)
  let rollback = true
  let holdDuringPersist = false
  let holdInsideTransaction = false
  const access = simpleHandleAccess({
    handle: () => current,
    adopt: (next) => {
      current = next
    },
    key: seed.key,
    stateVersion: async () => (await groups.loadState(seed.key))?.version ?? 0,
    persist: async (next, write) => {
      if (write === undefined) throw new Error('Missing adoption write')
      if (holdDuringPersist)
        await groups
          .ports(seed.key)
          .control.apply(
            { controlHold: { reason: 'unsupported-version', position: asLogPosition('held') } },
            'hold-in-persist',
          )
      await groups.transition(
        await nextChange(groups, seed.key.groupID, write.mutationID),
        async (stores) => {
          const rows = stores.incarnation(1)
          const state = await rows.state.load()
          if (state === null || state.deleted || state.version !== write.expected?.stateVersion)
            throw Object.assign(new Error('Stale state'), { name: 'ControlAdoptionMovedError' })
          const trust = await stores.trust.load()
          if (trust === null) throw new Error('Missing trust')
          await stores.trust.save({
            ...trust,
            installed: {
              ...seed.key,
              epoch: Number(next.epoch),
              authenticator: next.state.keySchedule.epochAuthenticator,
            },
            signerTree: next.state.ratchetTree,
            registry: next.registry,
            credential: next.credential,
            ledger: next.ledgerTokens,
          })
          if (holdInsideTransaction)
            await rows.control.apply(
              {
                controlHold: {
                  reason: 'unsupported-version',
                  position: asLogPosition('held-in-tx'),
                },
              },
              write.mutationID,
            )
          await rows.state.save(
            {
              ...state,
              version: state.version + 1,
              epoch: Number(next.epoch),
              epochAuthenticator: next.state.keySchedule.epochAuthenticator,
              state: encodeClientState(next.state),
              ledger: next.ledgerTokens,
            },
            write.expected,
          )
          await rows.control.apply(write.changes, write.mutationID)
          const anchor = await rows.anchor.load()
          if (anchor?.pending !== undefined && anchor.pending.advance === write.anchorLanded)
            await rows.anchor.save({ ...anchor, pending: { ...anchor.pending, landed: true } })
          stores.tx.rows.side?.set('handler', new Uint8Array([7]))
          if (rollback) throw new Error('coupled rollback')
        },
      )
    },
  })
  const control = groups.ports(seed.key).control
  const rotation = await commitKeyRotation(current)
  const intent: Operation & { stage: 'intent' } = {
    id: 'coupled',
    kind: 'rotation',
    revokes: false,
    body: new Uint8Array(),
    seq: 1,
    enqueuedAt: 0,
    deadline: 30_000,
    stage: 'intent',
  }
  await control.apply({ putOperations: [intent] }, 'intent')
  const build = createControlBuildPort({
    access,
    control,
    now: () => 0,
    newID: () => 'build',
    saveBuilt: createPersistenceBuildSaver({ persistence: groups, key: seed.key }),
    build: async () => ({
      commit: rotation.commitMessage,
      bodies: [],
      welcome: null,
      journal: encodeClientState(rotation.newGroup.state),
      epoch: 0,
      incarnation: 1,
      authenticatorBefore: current.state.keySchedule.epochAuthenticator,
      digest: 'rotation',
    }),
  })
  expect(
    (
      await build.prepareBuild(intent, async () => ({
        payload: new Uint8Array([1]),
        publishID: 'publish',
        expectedHead: null,
      }))
    ).kind,
  ).toBe('saved')
  const slot = (await control.load()).commitOnce
  if (slot === null) throw new Error('Missing slot')
  const position = asLogPosition('001')
  const proof = {
    source: (await groups.readEvidence(seed.key)).source,
    from: null,
    position,
    payloadDigest: slot.payloadDigest,
  }
  await control.apply({ commitOnceAcceptance: proof }, 'accept')
  await groups.ports(seed.key).anchor.save({
    anchor: { epoch: 0, secret: new Uint8Array(32).fill(1) },
    pending: {
      epochBefore: 0,
      epochAfter: 1,
      rosterBefore: [current.credential.id],
      forced: false,
      advance: 'rotation',
    },
  })
  const port = createControlAdoptionPort({ access, control, restoreCandidate })
  const write: AdoptionWrite = {
    mutationID: 'landed-coupled',
    anchorLanded: 'rotation',
    changes: {
      commitOnce: null,
      deleteOperations: [intent.id],
      cursor: { position, epoch: 1 },
      putApplied: [
        {
          epoch: 0,
          digest: slot.digest,
          payloadDigest: slot.payloadDigest,
          sequenceID: position,
          opID: intent.id,
          removed: false,
        },
      ],
      putOutcomes: [{ id: 'landed-coupled', opID: intent.id, kind: 'landed', at: 1, position }],
    },
  }
  const expected = { ...(await groups.readEvidence(seed.key)).source, acceptance: proof }
  holdDuringPersist = true
  rollback = false
  expect(await port.adopt(slot.journal, expected, write)).toBe('moved')
  expect(current.epoch).toBe(0n)
  expect(await groups.loadState(seed.key)).toMatchObject({ deleted: false, epoch: 0 })
  expect((await groups.loadState(seed.key))?.version).toBeGreaterThan(expected.stateVersion)
  await control.apply({ controlHold: null }, 'clear-probe-hold')
  holdDuringPersist = false
  Object.assign(expected, (await groups.readEvidence(seed.key)).source)
  holdInsideTransaction = true
  expect(await port.adopt(slot.journal, expected, write)).toBe('moved')
  expect(current.epoch).toBe(0n)
  expect((await control.load()).controlHold).toBeNull()
  holdInsideTransaction = false
  rollback = true
  const before = db.snapshot()
  await expect(port.adopt(slot.journal, expected, write)).rejects.toThrow('coupled rollback')
  expect(db.snapshot()).toEqual(before)
  expect(current.epoch).toBe(0n)
  rollback = false
  expect(await port.adopt(slot.journal, expected, write)).toBe('installed')
  const trust = await groups.loadTrust(seed.key.groupID)
  expect(trust?.installed.authenticator).toEqual(
    rotation.newGroup.state.keySchedule.epochAuthenticator,
  )
  expect(trust?.spentEpochAuthenticators).toEqual(
    expect.arrayContaining([
      seed.state.epochAuthenticator,
      rotation.newGroup.state.keySchedule.epochAuthenticator,
    ]),
  )
  expect((await groups.ports(seed.key).anchor.load())?.pending?.landed).toBe(true)
  expect(db.snapshot().side?.get('handler')).toEqual(new Uint8Array([7]))
  expect((await control.load()).applied).toHaveLength(1)
  expect((await control.load()).outcomes).toHaveLength(1)
})

test('a hold committed after preparation prevents the 2.1 build save', async () => {
  const db = createMemoryTransaction({ rows: {} })
  const groups = createMemoryGroupPersistence({
    db,
    owners: createOwnerQueues(),
    atRest: createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(19) }),
    providerID: 'memory',
  })
  const seed = await makeStorageSeed({ id: 'held-save', incarnation: 1, epoch: 2, mode: 'double' })
  await installSeed(groups, seed, 'seed')
  const control = groups.ports(seed.key).control
  const intent: Operation & { stage: 'intent' } = {
    id: 'held',
    kind: 'rotation',
    revokes: false,
    body: new Uint8Array(),
    seq: 1,
    enqueuedAt: 0,
    deadline: 30_000,
    stage: 'intent',
  }
  await control.apply({ putOperations: [intent] }, 'intent')
  const source = (await groups.readEvidence(seed.key)).source
  if (seed.state.state === null) throw new Error('Missing state')
  const slot: ControlSlot = {
    opID: intent.id,
    incarnation: 1,
    epoch: 2,
    authenticatorBefore: seed.state.epochAuthenticator,
    searchFrom: null,
    expectedHead: null,
    publishID: 'held-publish',
    payload: new Uint8Array([1]),
    payloadDigest: 'held-payload',
    digest: 'held-commit',
    bodies: [],
    welcome: null,
    journal: encodeControlJournal({
      version: 1,
      source,
      checkpoint: null,
      sourceState: seed.state.state,
      sourceCredential: seed.trust.credential,
      sourceLedger: seed.trust.ledger,
      candidate: seed.state.state,
    }),
  }
  await control.apply(
    { controlHold: { reason: 'unsupported-version', position: asLogPosition('001') } },
    'hold',
  )
  const save = createPersistenceBuildSaver({ persistence: groups, key: seed.key })
  expect(await save(intent, slot, source, 'stale-preparation')).toBe('moved')
  expect((await control.load()).commitOnce).toBeNull()
})

test('transactional save rechecks the hold after its write gate before publishing state', async () => {
  const f = await controlAdoptionFixture()
  const before = f.host.live().epoch
  f.store.beforeWrite = () => {
    f.store.snapshot().control.controlHold = {
      reason: 'unsupported-version',
      position: f.proof.position,
    }
  }
  expect(await f.port.adopt(f.slot.journal, await f.expected(), f.write)).toBe('moved')
  expect(f.host.live().epoch).toBe(before)
  expect(f.store.snapshot().control.applied).toEqual([])
  expect(f.store.snapshot().control.controlHold?.reason).toBe('unsupported-version')
})

test.each(['fork-halted', 'recovery-unavailable'] as const)(
  'field-only %s refuses adoption before restoring the candidate',
  async (reason) => {
    const f = await retainedRotation()
    const slot = await f.build()
    const { proof, write } = await f.accept(f.store, slot)
    const key = f.store.control.key
    await f.store.control.apply(
      reason === 'fork-halted'
        ? {
            forkHalt: {
              eventID: forkEventID(key),
              detectedAt: 1,
              evidence: {
                kind: 'unexplained-own-commit',
                epoch: slot.epoch,
                position: '1',
                digest: 'foreign',
              },
            },
          }
        : {
            recoveryUnavailable: {
              ...key,
              id: recoveryUnavailableEventID(key),
              kind: 'group:recovery-unavailable',
              reason: 'trust-unreadable',
            },
          },
      'hold',
    )
    const before = structuredClone(f.store.snapshot())
    const restoreCandidate = vi.fn(f.restoreCandidate)
    const port = createControlAdoptionPort({
      access: f.host.access,
      control: f.store.control,
      restoreCandidate,
    })
    const source = (await f.store.readEvidence()).source
    expect(await port.adopt(slot.journal, { ...source, acceptance: proof }, write)).toBe('moved')
    expect(restoreCandidate).not.toHaveBeenCalled()
    expect(f.store.snapshot()).toEqual(before)
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
