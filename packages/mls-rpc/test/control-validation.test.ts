import type * as TokenModule from '@kokuin/token'
import { randomIdentity } from '@kokuin/token'
import {
  CommitValidationUnavailableError,
  type ControllerBinding,
  commitInvite,
  commitKeyRotation,
  commitLedgerEntries,
  createInvite,
  createKeyPackageBundle,
  decodeClientState,
  encodeClientState,
  encodeControlEnvelope,
  exportGroupInfo,
  type GroupHandle,
  type GroupOptions,
  joinGroupExternal,
  ledgerEntryDigest,
  nobleCryptoProvider,
  processWelcome,
  readCommitEntryIDs,
  removeMember,
  restoreGroup,
  signLedgerEntry,
} from '@kumiai/mls'
import type { GroupForkEvidence } from '@kumiai/rpc'
import {
  type AdoptionExpected,
  type AdoptionWrite,
  type AnchorStore,
  type AppCursorStore,
  type AppOutbox,
  asLogPosition,
  type BuiltCommit,
  type CertifiedControlRange,
  type ControlLogFrame,
  type ControlSearchWork,
  type ControlValidationPort,
  commitTopic,
  createControlSearch,
  createGroupPeer,
  digestAppliedCommit,
  encodeCommitFrame,
  encodeHandshakeFrame,
  encodeLedgerEntries,
  type GroupPeerParams,
  HANDSHAKE_KIND,
  type LogPosition,
  type Operation,
} from '@kumiai/rpc'
import { sha256 } from '@noble/hashes/sha2.js'
import { toB64U } from '@sozai/codec'
import {
  bytesToBase64,
  createCommit,
  createGroupInfoWithExternalPubAndRatchetTree,
  createProposal,
  decode,
  defaultProposalTypes,
  encode,
  generateKeyPackageWithKey,
  mlsMessageDecoder,
  mlsMessageEncoder,
  nodeTypes,
  protocolVersions,
  joinGroupExternal as rawJoinGroupExternal,
  senderTypes,
  ValidationError,
  wireformats,
} from 'ts-mls'
import { expect, test, vi } from 'vitest'

import { decodeControlJournal, encodeControlJournal } from '../src/control-journal.js'
import { createControlValidationPort } from '../src/control-validation.js'
import { createGroupCrypto, deriveEntryKey, sealEntries } from '../src/crypto.js'
import { createMemoryGroupPersistence } from '../src/memory-group-persistence.js'
import { createMemoryTransaction } from '../src/memory-transaction.js'
import { createGroupMLS, createLedgerEntrySlot } from '../src/mls.js'
import { createOwnerQueues } from '../src/owner-queue.js'
import { createDeterministicAtRestCodec } from './fixtures/at-rest.js'
import { buildRealCommit, createRealGroup, testHandleAccess } from './fixtures/real-group.js'
import { installSeed, makeStorageSeed } from './fixtures/storage-seed.js'
import { createTransactionalStore } from './fixtures/transactional-access.js'

const verifierFault = vi.hoisted((): { token: string; error: Error } => ({
  token: '',
  error: Object.assign(new Error('transient credential verifier'), { transient: true as const }),
}))
vi.mock('@kokuin/token', async (importOriginal) => {
  const actual = await importOriginal<typeof TokenModule>()
  return {
    ...actual,
    verifyToken: (...args: Parameters<typeof actual.verifyToken>) => {
      if (args[0] === verifierFault.token) throw verifierFault.error
      return actual.verifyToken(...args)
    },
  }
})

async function fixture(
  options: GroupOptions = {},
  beforeJoin = 0,
  afterJoin = 0,
  blankLeaf = false,
) {
  const group = await createRealGroup(beforeJoin > 0 ? 0 : blankLeaf ? 2 : 1, 'validation')
  if (beforeJoin > 0) {
    for (let index = 0; index < beforeJoin; index++)
      group.committer.handle = (await commitKeyRotation(group.committer.handle)).newGroup
    const identity = randomIdentity()
    const { invite } = await createInvite({
      group: group.committer.handle,
      identity: group.committer.identity,
      recipientDID: identity.id,
      permission: 'member',
    })
    for (const token of invite.ledgerEntries) group.bodies.set(ledgerEntryDigest(token), token)
    const bundle = await createKeyPackageBundle(identity)
    const added = await commitInvite(group.committer.handle, bundle.publicPackage, invite)
    group.committer.handle = added.newGroup
    const slot = createLedgerEntrySlot()
    slot.install(group.resolveLedgerEntries)
    const joined = await processWelcome({
      identity,
      invite,
      welcome: added.welcomeMessage,
      keyPackageBundle: bundle,
      options: { resolveLedgerEntries: slot.resolve },
    })
    group.members.push({ identity, handle: joined.group, slot })
  }
  const member = group.members[0]
  if (member === undefined) throw new Error('missing member')
  if (blankLeaf) {
    const removed = group.members[1]
    if (removed === undefined) throw new Error('missing removed member')
    const removal = await removeMember(
      group.committer.handle,
      removed.handle.state.privatePath.leafIndex,
    )
    group.committer.handle = removal.newGroup
    await member.handle.processMessage(removal.commitMessage)
    group.members.splice(1, 1)
  }
  for (let index = 0; index < afterJoin; index++) {
    const rotation = await commitKeyRotation(group.committer.handle)
    group.committer.handle = rotation.newGroup
    await member.handle.processMessage(rotation.commitMessage)
  }
  const state = encodeClientState(member.handle.state)
  const source: AdoptionExpected & { identity: NonNullable<AdoptionExpected['identity']> } = {
    key: { groupID: member.handle.groupID, incarnation: 1 },
    stateVersion: 1,
    identity: {
      groupID: member.handle.groupID,
      incarnation: 1,
      epoch: Number(member.handle.epoch),
      authenticator: member.handle.state.keySchedule.epochAuthenticator.slice(),
    },
  }
  const rotation = await commitKeyRotation(member.handle)
  const payload = encodeHandshakeFrame(
    HANDSHAKE_KIND.commit,
    encodeCommitFrame(rotation.commitMessage, new Uint8Array()),
  )
  const built: BuiltCommit = {
    epoch: Number(member.handle.epoch),
    incarnation: 1,
    authenticatorBefore: source.identity.authenticator.slice(),
    searchFrom: asLogPosition('000100'),
    expectedHead: asLogPosition('000100'),
    publishID: 'own',
    payload,
    payloadDigest: toB64U(sha256(payload)),
    digest: digestAppliedCommit(rotation.commitMessage),
    bodies: [],
    welcome: null,
    journal: encodeControlJournal({
      version: 1,
      source,
      checkpoint: asLogPosition('000100'),
      sourceState: state,
      sourceCredential: member.handle.credential,
      sourceLedger: member.handle.ledgerTokens,
      candidate: encodeClientState(rotation.newGroup.state),
    }),
  }
  const port = createControlValidationPort({
    identity: member.identity,
    options,
    restoreCandidate: async (candidate: Uint8Array) => {
      const decoded = decodeClientState(candidate)
      if (decoded == null) throw new Error('missing candidate')
      return restoreGroup({
        state: decoded,
        credential: member.handle.credential,
        ledgerEntries: member.handle.ledgerTokens,
        options,
      })
    },
  })
  const frame = (commit: Uint8Array) => ({
    position: asLogPosition('000101'),
    senderDID: group.committer.identity.id,
    payload: encodeHandshakeFrame(
      HANDSHAKE_KIND.commit,
      encodeCommitFrame(commit, new Uint8Array()),
    ),
  })
  return { group, member, built, source, state, port, frame }
}

async function searchReal(
  f: Awaited<ReturnType<typeof fixture>>,
  competitor?: Uint8Array,
  validation: ControlValidationPort = f.port,
  competitorPayload?: Uint8Array,
) {
  const store = createTransactionalStore(f.member.handle)
  const intent: Operation & { stage: 'intent' } = {
    id: 'own',
    kind: 'rotation',
    revokes: false,
    body: new Uint8Array(),
    seq: 1,
    enqueuedAt: 0,
    deadline: 30000,
    stage: 'intent',
  }
  await store.control.apply(
    { putOperations: [intent], cursor: { position: f.built.searchFrom, epoch: f.built.epoch } },
    'intent',
  )
  expect(await store.saveBuilt(intent, { ...f.built, opID: intent.id }, f.source, 'built')).toBe(
    'saved',
  )
  const persisted = vi.fn(async (handle: GroupHandle, write?: AdoptionWrite) =>
    store.save(
      store.snapshot().revision,
      encodeClientState(handle.state),
      handle.ledgerTokens,
      undefined,
      write,
    ),
  )
  const access = testHandleAccess({
    handle: () => f.member.handle,
    adopt: (next) => {
      f.member.handle = next
    },
    stateVersion: () => store.snapshot().revision,
    persist: persisted,
  })
  const mls = createGroupMLS({ access, identity: f.member.identity, entrySlot: f.member.slot })
  const rows = [
    ...(competitor === undefined
      ? []
      : [
          {
            ...f.frame(competitor),
            ...(competitorPayload === undefined ? {} : { payload: competitorPayload }),
            position: asLogPosition('000101'),
          },
        ]),
    {
      payload: f.built.payload,
      position: asLogPosition(competitor === undefined ? '000101' : '000102'),
      senderDID: 'replayer',
    },
  ]
  const fetch = vi.fn(async (after: LogPosition | null) => ({
    messages: rows
      .filter((row) => after === null || row.position > after)
      .map((row) => ({
        sequenceID: row.position,
        payload: row.payload,
        senderDID: row.senderDID,
        topicID: 'commit',
        receivedAt: 1,
      })),
    head: rows.at(-1)?.position ?? null,
    oldest: rows[0]?.position ?? null,
    gap: false,
  }))
  const hold = vi.fn(async () => {})
  const followWinner = vi.fn(
    async (frame: ControlLogFrame, _range: CertifiedControlRange, work: ControlSearchWork) => {
      if (competitor === undefined) throw new Error('missing competitor')
      if (!work.takeFrame()) return { kind: 'unavailable' as const }
      const result = await mls.processCommit(competitor, {
        resolveLedgerEntries: f.group.resolveLedgerEntries,
        adoption: (staged) => ({
          mutationID: 'winner',
          changes: {
            putApplied: [
              {
                epoch: f.built.epoch,
                digest: digestAppliedCommit(competitor),
                payloadDigest: toB64U(sha256(frame.payload)),
                sequenceID: frame.position,
                opID: null,
                removed: staged.removed,
              },
            ],
            cursor: {
              position: frame.position,
              epoch: staged.epochAfter,
              ...(staged.removed ? { stranded: true as const } : {}),
            },
          },
        }),
      })
      return result.applied
        ? { kind: 'applied' as const, position: frame.position }
        : { kind: 'refused' as const }
    },
  )
  const safety = safetyCallbacks()
  const search = createControlSearch({
    ...safety,
    budget: { maxPasses: 2, maxFetches: 16, maxFrames: 256 },
    fetch,
    validation,
    readEvidence: store.readEvidence,
    followWinner,
    reconcileAbsent: async () => true,
    hold,
  })
  const result = await search.searchLog(f.built)
  return { result, store, fetch, hold, haltFork: safety.haltFork, followWinner, persisted }
}

test('first-valid lands on a trimmed log', async () => {
  const f = await fixture({}, 65)
  expect(f.built.epoch).toBe(66)
  const validator = await f.port.restoreValidation(f.built)
  if (validator === null) throw new Error('missing validator')
  const validateFrame = vi.fn(validator.validateFrame)
  const result = await searchReal(f, undefined, {
    restoreValidation: async () => ({ ...validator, validateFrame }),
  })
  expect(result.result).toMatchObject({ kind: 'first-valid', proof: { from: f.built.searchFrom } })
  expect(result.fetch).toHaveBeenCalledWith(f.built.searchFrom)
  expect(
    validateFrame.mock.calls.every(([frame]) => frame.position > (f.built.searchFrom ?? '')),
  ).toBe(true)
  expect(result.followWinner).not.toHaveBeenCalled()
  expect(result.persisted).not.toHaveBeenCalled()
}, 10000)

test('normal second-epoch build needs no retained pre-checkpoint applied rows', async () => {
  const f = await fixture({}, 0, 1)
  const result = await searchReal(f)
  expect(f.built.epoch).toBe(2)
  expect((await result.store.control.load()).applied).toEqual([])
  expect(result.result).toMatchObject({ kind: 'first-valid', proof: { from: f.built.searchFrom } })
  expect(result.fetch).toHaveBeenCalledWith(f.built.searchFrom)
  expect(result.persisted).not.toHaveBeenCalled()
})

test('budget discovery continues for an expired operation with its retained slot', async () => {
  const f = await fixture()
  const store = createTransactionalStore(f.member.handle)
  const intent: Operation & { stage: 'intent' } = {
    id: 'expired',
    kind: 'rotation',
    revokes: false,
    body: new Uint8Array(),
    seq: 1,
    enqueuedAt: 0,
    deadline: 1,
    stage: 'intent',
  }
  await store.control.apply(
    { putOperations: [intent], cursor: { position: f.built.searchFrom, epoch: f.built.epoch } },
    'intent',
  )
  expect(await store.saveBuilt(intent, { ...f.built, opID: intent.id }, f.source, 'built')).toBe(
    'saved',
  )
  const positions = Array.from({ length: 270 }, (_, index) =>
    asLogPosition(String(101 + index).padStart(6, '0')),
  )
  const fetch = vi.fn(async (after: LogPosition | null) => ({
    messages: positions
      .filter((position) => after === null || position > after)
      .map((position, index, suffix) => ({
        sequenceID: position,
        payload: index === suffix.length - 1 ? f.built.payload : new Uint8Array(),
        senderDID: 'relay',
        topicID: 'commits',
        receivedAt: 1,
      })),
    head: '000370',
    oldest: '000101',
    gap: false,
  }))
  const followWinner = vi.fn(async () => ({ kind: 'refused' as const }))
  const deps = {
    ...safetyCallbacks(),
    budget: { maxPasses: 2, maxFetches: 16, maxFrames: 256 },
    fetch,
    validation: f.port,
    readEvidence: store.readEvidence,
    followWinner,
    reconcileAbsent: async () => false,
    hold: async () => {},
  }
  const search = createControlSearch(deps)
  expect(intent.deadline).toBeLessThan(Date.now())
  expect(await search.searchLog(f.built)).toEqual({ kind: 'unknown' })
  expect(await search.searchLog(f.built)).toMatchObject({
    kind: 'first-valid',
    proof: { position: asLogPosition('000370') },
  })
  expect(fetch.mock.calls.map(([after]) => after)).toEqual([
    f.built.searchFrom,
    asLogPosition('000356'),
  ])
  expect(await createControlSearch(deps).searchLog(f.built)).toEqual({ kind: 'unknown' })
  expect(fetch.mock.calls[2]?.[0]).toBe(f.built.searchFrom)
  expect((await store.control.load()).commitOnce?.payloadDigest).toBe(f.built.payloadDigest)
  expect((await store.control.load()).cursor?.position).toBe(f.built.searchFrom)
  expect((await store.control.load()).welcomes).toEqual([])
  expect(followWinner).not.toHaveBeenCalled()
})

test.each(['private', 'public', 'external'] as const)(
  'earlier valid competitor supersedes an alternate-ID exact own replay: %s',
  async (kind) => {
    const f = await fixture()
    const competitor =
      kind === 'external'
        ? (
            await joinGroupExternal({
              identity: f.group.committer.identity,
              groupInfo: (await exportGroupInfo({ group: f.group.committer.handle })).groupInfo,
              credential: f.group.committer.handle.credential,
              resync: true,
            })
          ).commitMessage
        : kind === 'private'
          ? (await commitKeyRotation(f.group.committer.handle)).commitMessage
          : encode(
              mlsMessageEncoder,
              (
                await createCommit({
                  context: f.group.committer.handle.context,
                  state: f.group.committer.handle.state,
                  wireAsPublicMessage: true,
                  authenticatedData: encodeControlEnvelope({ v: 1 }),
                })
              ).commit,
            )
    const result = await searchReal(f, competitor)
    expect(result.result).toEqual({ kind: 'superseded', winner: asLogPosition('000101') })
    const evidence = await result.store.readEvidence()
    expect(evidence.cursor?.position).toBe(asLogPosition('000101'))
    expect(evidence.applied[0]?.payloadDigest).toBe(toB64U(sha256(f.frame(competitor).payload)))
    expect(f.member.handle.state.keySchedule.epochAuthenticator).toEqual(
      evidence.source.identity?.authenticator,
    )
    expect(evidence.source.identity?.authenticator).not.toEqual(f.source.identity?.authenticator)
    expect((await result.store.control.load()).welcomes).toEqual([])
    expect(result.persisted).toHaveBeenCalledOnce()
  },
)

test('first-valid self-removal wins without epoch advance', async () => {
  const f = await fixture()
  const removal = await removeMember(
    f.group.committer.handle,
    f.member.handle.state.privatePath.leafIndex,
  )
  const result = await searchReal(f, removal.commitMessage)
  expect(result.result).toEqual({ kind: 'superseded', winner: asLogPosition('000101') })
  const evidence = await result.store.readEvidence()
  expect(evidence.terminal).toBe(true)
  expect(evidence.source.identity?.epoch).toBe(f.built.epoch)
  expect(evidence.applied[0]?.removed).toBe(true)
  expect(evidence.cursor?.position).toBe(asLogPosition('000101'))
  expect((await result.store.control.load()).welcomes).toEqual([])
})

test('retained own construction verifies without processing own receive keys', async () => {
  const f = await fixture()
  const validation = await f.port.restoreValidation(f.built)
  expect(validation).not.toBeNull()
  expect(await validation?.verifyOwn(f.built)).toBe(true)
  expect(
    await validation?.validateFrame(
      { position: asLogPosition('000101'), payload: f.built.payload, senderDID: 'replayer' },
      f.built,
    ),
  ).toMatchObject({ kind: 'valid', own: true })
  expect(encodeClientState(f.member.handle.state)).toEqual(f.state)
})

test('mismatched journal checkpoint refuses proof', async () => {
  const f = await fixture()
  const corrupted = { ...f.built, searchFrom: asLogPosition('000099') }
  expect(await f.port.restoreValidation(corrupted)).toBeNull()
  const followWinner = vi.fn(async () => ({ kind: 'refused' as const }))
  const safety = safetyCallbacks()
  const search = createControlSearch({
    ...safety,
    budget: { maxPasses: 2, maxFetches: 16, maxFrames: 256 },
    fetch: async () => {
      throw new Error('must not fetch')
    },
    validation: f.port,
    readEvidence: async () => ({ source: f.source, applied: [], cursor: null, terminal: false }),
    followWinner,
    reconcileAbsent: async () => false,
    hold: async () => {},
  })
  expect(await search.searchLog(corrupted)).toEqual({ kind: 'unknown' })
  expect(followWinner).not.toHaveBeenCalled()
})

test('public member authentication precedes missing referenced proposal resolution', async () => {
  const f = await fixture()
  const committer = f.group.committer.handle
  const pending = {
    [bytesToBase64(new Uint8Array(32).fill(8))]: {
      proposal: {
        proposalType: defaultProposalTypes.remove,
        remove: { removed: f.member.handle.state.privatePath.leafIndex },
      },
      senderLeafIndex: committer.state.privatePath.leafIndex,
    },
  }
  const result = await createCommit({
    context: committer.context,
    state: { ...committer.state, unappliedProposals: pending },
    wireAsPublicMessage: true,
    authenticatedData: encodeControlEnvelope({ v: 1 }),
  })
  if (result.commit.wireformat !== wireformats.mls_public_message)
    throw new Error('expected public')
  const validation = await f.port.restoreValidation(f.built)
  const validMembership = encode(mlsMessageEncoder, result.commit)
  expect(await validation?.validateFrame(f.frame(validMembership), f.built)).toEqual({
    kind: 'unavailable',
    reason: 'missing-proposal',
  })
  const unavailable = await searchReal(f, validMembership)
  expect(unavailable.result).toEqual({ kind: 'unknown' })
  expect(unavailable.followWinner).not.toHaveBeenCalled()
  expect((await unavailable.store.control.load()).cursor?.position).toBe(f.built.searchFrom)
  expect((await unavailable.store.control.load()).commitOnce?.payloadDigest).toBe(
    f.built.payloadDigest,
  )
  if (result.commit.publicMessage.senderType !== senderTypes.member)
    throw new Error('expected member')
  const badMembership = encode(mlsMessageEncoder, {
    ...result.commit,
    publicMessage: {
      ...result.commit.publicMessage,
      membershipTag: new Uint8Array(result.commit.publicMessage.membershipTag.length),
    },
  })
  expect(await validation?.validateFrame(f.frame(badMembership), f.built)).toEqual({
    kind: 'invalid',
    reason: 'authentication',
  })
  expect((await searchReal(f, badMembership)).result).toMatchObject({ kind: 'first-valid' })
})

test('validator owns resolver callbacks and buffers on refused resolution', async () => {
  const onLedgerEntries = vi.fn()
  const f = await fixture({ onLedgerEntries })
  const before = {
    state: encodeClientState(f.member.handle.state),
    ledger: f.member.handle.ledgerTokens,
    admission: f.member.handle.sendAdmission(),
  }
  const commit = await buildRealCommit(f.group)
  const validation = await f.port.restoreValidation(f.built)
  expect(await validation?.validateFrame(f.frame(commit), f.built)).toMatchObject({
    kind: 'invalid',
  })
  expect(encodeClientState(f.member.handle.state)).toEqual(before.state)
  expect(f.member.handle.ledgerTokens).toEqual(before.ledger)
  expect(f.member.handle.sendAdmission()).toEqual(before.admission)
  expect(onLedgerEntries).not.toHaveBeenCalled()
})

async function publicLedger(f: Awaited<ReturnType<typeof fixture>>) {
  const token = await signLedgerEntry(f.group.committer.identity, {
    type: 'note',
    groupID: f.member.handle.groupID,
    subject: f.member.identity.id,
    value: 'isolated body',
  })
  f.group.bodies.set(ledgerEntryDigest(token), token)
  const prepared = await commitLedgerEntries(f.group.committer.handle, [token])
  const result = await createCommit({
    context: f.group.committer.handle.context,
    state: f.group.committer.handle.state,
    wireAsPublicMessage: true,
    authenticatedData: encodeControlEnvelope({ v: 1, entries: [ledgerEntryDigest(token)] }),
    extraProposals: [
      {
        proposalType: defaultProposalTypes.group_context_extensions,
        groupContextExtensions: { extensions: prepared.newGroup.state.groupContext.extensions },
      },
    ],
  })
  const commit = encode(mlsMessageEncoder, result.commit)
  const key = await deriveEntryKey(f.member.handle)
  const payload = encodeHandshakeFrame(
    HANDSHAKE_KIND.commit,
    encodeCommitFrame(commit, sealEntries(key, encodeLedgerEntries([token]))),
  )
  key.fill(0)
  return {
    commit,
    token,
    frame: { position: asLogPosition('000101'), senderDID: 'relay', payload },
  }
}

test('public member ledger commits run mandatory policy checks', async () => {
  const policy = vi.fn(() => 'accept' as const)
  const f = await fixture({ commitPolicy: policy })
  const ledger = await publicLedger(f)
  expect(readCommitEntryIDs(ledger.commit)).toEqual([ledgerEntryDigest(ledger.token)])
  const validation = await f.port.restoreValidation(f.built)
  expect(await validation?.validateFrame(ledger.frame, f.built)).toMatchObject({
    kind: 'valid',
    own: false,
  })
  expect(policy).toHaveBeenCalled()
  const searched = await searchReal(f, ledger.commit, f.port, ledger.frame.payload)
  expect(searched.result).toEqual({ kind: 'superseded', winner: asLogPosition('000101') })
  expect((await searched.store.control.load()).welcomes).toEqual([])
  const refused = await fixture({ commitPolicy: () => 'reject' })
  const rejectedLedger = await publicLedger(refused)
  expect(
    await (await refused.port.restoreValidation(refused.built))?.validateFrame(
      rejectedLedger.frame,
      refused.built,
    ),
  ).toEqual({ kind: 'invalid', reason: 'policy' })
})

test.each(['malformed-list', 'not-sealed'] as const)(
  'malformed ledger body reports malformed: %s',
  async (kind) => {
    const f = await fixture()
    const ledger = await publicLedger(f)
    const key = await deriveEntryKey(f.member.handle)
    const sealed =
      kind === 'malformed-list' ? sealEntries(key, new Uint8Array([1])) : new Uint8Array([1])
    key.fill(0)
    const frame = {
      ...ledger.frame,
      payload: encodeHandshakeFrame(
        HANDSHAKE_KIND.commit,
        encodeCommitFrame(ledger.commit, sealed),
      ),
    }
    const validation = await f.port.restoreValidation(f.built)
    expect(await validation?.validateFrame(frame, f.built)).toEqual({
      kind: 'invalid',
      reason: 'malformed',
    })
  },
)

test('one source restore per header and frame, and own verification reuses its candidate', async () => {
  const getCiphersuiteImpl = vi.fn(nobleCryptoProvider.getCiphersuiteImpl)
  const f = await fixture({ cryptoProvider: { getCiphersuiteImpl } })
  const competitor = (await commitKeyRotation(f.group.committer.handle)).commitMessage
  const validation = await f.port.restoreValidation(f.built)
  if (validation === null) throw new Error('missing validation')
  getCiphersuiteImpl.mockClear()
  const header = await validation.readCommitHeader(competitor)
  expect(await validation.validateFrame(f.frame(competitor), f.built, header)).toMatchObject({
    kind: 'valid',
    own: false,
  })
  expect(getCiphersuiteImpl).toHaveBeenCalledOnce()
  getCiphersuiteImpl.mockClear()
  const { decodeCommitFrame, decodeHandshakeFrame } = await import('@kumiai/rpc')
  const ownCommit = decodeCommitFrame(decodeHandshakeFrame(f.built.payload).payload).commit
  const ownHeader = await validation.readCommitHeader(ownCommit)
  expect(
    await validation.validateFrame(
      { ...f.frame(ownCommit), payload: f.built.payload },
      f.built,
      ownHeader,
    ),
  ).toMatchObject({ kind: 'valid', own: true })
  expect(await validation.verifyOwn(f.built)).toBe(true)
  expect(getCiphersuiteImpl).toHaveBeenCalledTimes(2)
})

test('a frame at another epoch is malformed for this retained source', async () => {
  const f = await fixture()
  const rotation = await commitKeyRotation(f.group.committer.handle)
  const future = (await commitKeyRotation(rotation.newGroup)).commitMessage
  const validation = await f.port.restoreValidation(f.built)
  expect(await validation?.validateFrame(f.frame(future), f.built)).toEqual({
    kind: 'invalid',
    reason: 'malformed',
  })
})

test('validator owns its resolver callbacks and buffers', async () => {
  const validatorNotifications = vi.fn()
  const f = await fixture({ onLedgerEntries: validatorNotifications })
  const liveNotifications = vi.fn()
  const state = decodeClientState(f.state)
  if (state === undefined) throw new Error('missing state')
  f.member.handle = await restoreGroup({
    state,
    credential: f.member.handle.credential,
    ledgerEntries: f.member.handle.ledgerTokens,
    options: { onLedgerEntries: liveNotifications, resolveLedgerEntries: f.member.slot.resolve },
  })
  const events = vi.fn()
  f.member.handle.events.on('deviceRevoked', events)
  f.member.handle.events.on('controllerBeaconChanged', events)
  const ledger = await publicLedger(f)
  const validation = await f.port.restoreValidation(f.built)
  if (validation === null) throw new Error('missing validation')
  const before = {
    state: encodeClientState(f.member.handle.state),
    ledger: f.member.handle.ledgerTokens,
    admission: f.member.handle.sendAdmission(),
  }
  const pending = [
    validation.validateFrame(ledger.frame, f.built),
    validation.validateFrame(ledger.frame, f.built),
  ]
  expect(await Promise.all(pending)).toEqual([
    expect.objectContaining({ kind: 'valid' }),
    expect.objectContaining({ kind: 'valid' }),
  ])
  expect(encodeClientState(f.member.handle.state)).toEqual(before.state)
  expect(f.member.handle.ledgerTokens).toEqual(before.ledger)
  expect(f.member.handle.sendAdmission()).toEqual(before.admission)
  expect(validatorNotifications).not.toHaveBeenCalled()
  expect(liveNotifications).not.toHaveBeenCalled()
  expect(events).not.toHaveBeenCalled()
  const persist = vi.fn(async () => {})
  const access = testHandleAccess({
    handle: () => f.member.handle,
    adopt: (next) => {
      f.member.handle = next
    },
    persist,
  })
  const live = createGroupMLS({ access, identity: f.member.identity, entrySlot: f.member.slot })
  const [validated, applied] = await Promise.all([
    validation.validateFrame(ledger.frame, f.built),
    live.processCommit(ledger.commit, { resolveLedgerEntries: f.group.resolveLedgerEntries }),
  ])
  expect(validated.kind).toBe('valid')
  expect(applied).toMatchObject({ applied: true, advanced: true })
  expect(liveNotifications).toHaveBeenCalledOnce()
  expect(validatorNotifications).not.toHaveBeenCalled()
  expect(persist).toHaveBeenCalledOnce()
  expect(events).not.toHaveBeenCalled()
  await expect(f.member.slot.resolve(['uninstalled'])).rejects.toThrow()
})

test.each(['Desired gen in the past', 'transient member AEAD'] as const)(
  'unavailable header or body resolution cannot hide an earlier winner: %s',
  async (message) => {
    const error = message.startsWith('Desired') ? new ValidationError(message) : new Error(message)
    const f = await fixture({
      cryptoProvider: {
        getCiphersuiteImpl: async (id) => {
          const suite = await nobleCryptoProvider.getCiphersuiteImpl(id)
          return {
            ...suite,
            hpke: {
              ...suite.hpke,
              decryptAead: async () => {
                throw error
              },
            },
          }
        },
      },
    })
    const competitor = (await commitKeyRotation(f.group.committer.handle)).commitMessage
    const validation = await f.port.restoreValidation(f.built)
    expect(await validation?.validateFrame(f.frame(competitor), f.built)).toMatchObject({
      kind: 'unavailable',
    })
    const result = await searchReal(f, competitor)
    expect(result.result).toEqual({ kind: 'unknown' })
    expect(result.persisted).not.toHaveBeenCalled()
    expect(result.followWinner).not.toHaveBeenCalled()
    expect((await result.store.control.load()).commitOnce?.payloadDigest).toBe(
      f.built.payloadDigest,
    )
    expect((await result.store.control.load()).cursor?.position).toBe(f.built.searchFrom)
    expect((await result.store.control.load()).welcomes).toEqual([])
    const state = decodeClientState(f.state)
    if (state === undefined) throw new Error('missing state')
    const capable = await restoreGroup({
      state,
      credential: f.member.handle.credential,
      ledgerEntries: f.member.handle.ledgerTokens,
    })
    await capable.processMessage(competitor)
    expect(capable.epoch).toBe(BigInt(f.built.epoch + 1))
  },
)

test('sender-data derivation failures propagate typed unavailable diagnostics', async () => {
  const f = await fixture({
    cryptoProvider: {
      getCiphersuiteImpl: async (id) => {
        const suite = await nobleCryptoProvider.getCiphersuiteImpl(id)
        return {
          ...suite,
          kdf: {
            ...suite.kdf,
            expand: async (secret, info, length) => {
              if (new TextDecoder().decode(info).includes('MLS 1.0 key'))
                throw new Error('transient sender-data KDF')
              return suite.kdf.expand(secret, info, length)
            },
          },
        }
      },
    },
  })
  const competitor = (await commitKeyRotation(f.group.committer.handle)).commitMessage
  const state = decodeClientState(f.state)
  if (state === undefined) throw new Error('missing state')
  const unavailable = await restoreGroup({
    state,
    credential: f.member.handle.credential,
    ledgerEntries: f.member.handle.ledgerTokens,
    options: {
      cryptoProvider: {
        getCiphersuiteImpl: async (id) => {
          const suite = await nobleCryptoProvider.getCiphersuiteImpl(id)
          return {
            ...suite,
            kdf: {
              ...suite.kdf,
              expand: async () => {
                throw new Error('transient sender-data KDF')
              },
            },
          }
        },
      },
    },
  })
  await expect(unavailable.readCommitHeader(competitor)).rejects.toMatchObject({
    name: 'CommitValidationUnavailableError',
    cause: { message: 'transient sender-data KDF' },
  })
  const searched = await searchReal(f, competitor)
  expect(searched.result).toEqual({ kind: 'unknown' })
  expect(searched.followWinner).not.toHaveBeenCalled()
})

test('typed unavailable reason survives a message without diagnostic keywords', async () => {
  const f = await fixture({
    cryptoProvider: {
      getCiphersuiteImpl: async (id) => {
        const suite = await nobleCryptoProvider.getCiphersuiteImpl(id)
        return {
          ...suite,
          hpke: {
            ...suite.hpke,
            decryptAead: async () => {
              throw new CommitValidationUnavailableError('retry later', { reason: 'missing-key' })
            },
          },
        }
      },
    },
  })
  const competitor = (await commitKeyRotation(f.group.committer.handle)).commitMessage
  const validation = await f.port.restoreValidation(f.built)
  expect(await validation?.validateFrame(f.frame(competitor), f.built)).toEqual({
    kind: 'unavailable',
    reason: 'missing-key',
  })
})

test('an authenticated alternate own copy preserves unknown acceptance', async () => {
  const f = await fixture()
  const other = (await commitKeyRotation(f.member.handle)).commitMessage
  const validation = await f.port.restoreValidation(f.built)
  expect(await validation?.validateFrame(f.frame(other), f.built)).toEqual({
    kind: 'unavailable',
    reason: 'unexplained-own',
  })
  const searched = await searchReal(f, other)
  expect(searched.result).toEqual({ kind: 'unknown' })
  expect(searched.haltFork).not.toHaveBeenCalled()
  expect(searched.persisted).not.toHaveBeenCalled()
})

test('live unavailable validation refuses without moving or saving', async () => {
  const options: GroupOptions = {
    cryptoProvider: {
      getCiphersuiteImpl: async (id) => {
        const suite = await nobleCryptoProvider.getCiphersuiteImpl(id)
        return {
          ...suite,
          hpke: {
            ...suite.hpke,
            decryptAead: async () => {
              throw new ValidationError('Desired gen in the past')
            },
          },
        }
      },
    },
  }
  const f = await fixture(options)
  const state = decodeClientState(f.state)
  if (state === undefined) throw new Error('missing state')
  const handle = await restoreGroup({
    state,
    credential: f.member.handle.credential,
    ledgerEntries: f.member.handle.ledgerTokens,
    options,
  })
  const persist = vi.fn(async () => {})
  const access = testHandleAccess({
    handle: () => handle,
    adopt: () => {
      throw new Error('must not adopt')
    },
    persist,
  })
  const live = createGroupMLS({
    access,
    identity: f.member.identity,
    entrySlot: createLedgerEntrySlot(),
  })
  const competitor = (await commitKeyRotation(f.group.committer.handle)).commitMessage
  expect(await live.processCommit(competitor, {})).toEqual({
    applied: false,
    advanced: false,
    epochBefore: f.built.epoch,
    epochAfter: f.built.epoch,
    validation: 'unavailable',
  })
  expect(encodeClientState(handle.state)).toEqual(f.state)
  expect(persist).not.toHaveBeenCalled()
})

test('already adopted own build requires committed full payload evidence after restart', async () => {
  const f = await fixture()
  const journal = decodeControlJournal(f.built.journal)
  const state = decodeClientState(journal.candidate)
  if (state === undefined) throw new Error('missing candidate')
  const restarted = await restoreGroup({
    state,
    credential: f.member.handle.credential,
    ledgerEntries: f.member.handle.ledgerTokens,
  })
  const source = {
    ...f.source,
    stateVersion: 7,
    identity: {
      ...f.source.identity,
      epoch: Number(restarted.epoch),
      authenticator: restarted.state.keySchedule.epochAuthenticator,
    },
  }
  const followWinner = vi.fn(async () => ({ kind: 'refused' as const }))
  const hold = vi.fn(async () => {})
  let applied: Array<{
    epoch: number
    digest: string
    payloadDigest: string
    sequenceID: LogPosition
    opID: string | null
    removed: boolean
  }> = []
  const deps = {
    ...safetyCallbacks(),
    budget: { maxPasses: 2, maxFetches: 16, maxFrames: 256 },
    validation: f.port,
    readEvidence: async () => ({
      source,
      applied,
      cursor: { position: asLogPosition('000101'), epoch: Number(restarted.epoch) },
      terminal: false,
    }),
    fetch: async () => ({
      messages: [
        {
          sequenceID: '000101',
          senderDID: 'relay',
          payload: f.built.payload,
          topicID: 'commits',
          receivedAt: 1,
        },
      ],
      head: '000101',
      oldest: '000101',
      gap: false,
    }),
    followWinner,
    reconcileAbsent: async () => false,
    hold,
  }
  expect(await createControlSearch(deps).searchLog(f.built)).toEqual({ kind: 'unknown' })
  applied = [
    {
      epoch: f.built.epoch,
      digest: f.built.digest,
      payloadDigest: f.built.payloadDigest,
      sequenceID: asLogPosition('000101'),
      opID: 'own',
      removed: false,
    },
  ]
  expect(await createControlSearch(deps).searchLog(f.built)).toMatchObject({
    kind: 'first-valid',
    proof: { position: asLogPosition('000101') },
  })
  const committed = applied[0]
  if (committed === undefined) throw new Error('missing applied row')
  applied = [{ ...committed, payloadDigest: 'conflicting-full-bytes' }]
  expect(await createControlSearch(deps).searchLog(f.built)).toEqual({ kind: 'unknown' })
  expect(deps.haltFork).not.toHaveBeenCalled()
  expect(followWinner).not.toHaveBeenCalled()
})

test('conclusive member AEAD rejection is skippable poison', async () => {
  const f = await fixture()
  const competitor = (await commitKeyRotation(f.group.committer.handle)).commitMessage
  competitor[competitor.length - 1] = (competitor[competitor.length - 1] ?? 0) ^ 1
  const validation = await f.port.restoreValidation(f.built)
  expect(await validation?.validateFrame(f.frame(competitor), f.built)).toEqual({
    kind: 'invalid',
    reason: 'authentication',
  })
})

async function forgeSender(f: Awaited<ReturnType<typeof fixture>>, leafIndex: number) {
  const author = f.group.committer.handle
  const suite = author.context.cipherSuite
  const result = await createCommit({
    context: {
      ...author.context,
      cipherSuite: {
        ...suite,
        hpke: {
          ...suite.hpke,
          encryptAead: async (key, nonce, aad, plaintext) => {
            const altered = plaintext.slice()
            if (plaintext.length === 12) {
              new DataView(altered.buffer).setUint32(0, leafIndex)
            }
            return suite.hpke.encryptAead(key, nonce, aad, altered)
          },
        },
      },
    },
    state: author.state,
    authenticatedData: encodeControlEnvelope({ v: 1 }),
  })
  return encode(mlsMessageEncoder, result.commit)
}

test.each(['tampered-own', 'forged-own-sender', 'forged-own-signature'] as const)(
  'unauthenticated own claim is poison without a fork hold: %s',
  async (kind) => {
    const f = await fixture()
    let commit: Uint8Array
    if (kind === 'tampered-own') {
      const { decodeCommitFrame, decodeHandshakeFrame } = await import('@kumiai/rpc')
      commit = decodeCommitFrame(decodeHandshakeFrame(f.built.payload).payload).commit.slice()
      const parsed = decode(mlsMessageDecoder, commit)
      if (parsed?.wireformat !== wireformats.mls_private_message)
        throw new Error('expected private')
      expect(parsed.privateMessage.ciphertext.length).toBeGreaterThan(
        f.member.handle.context.cipherSuite.kdf.size,
      )
      const last = parsed.privateMessage.ciphertext.length - 1
      parsed.privateMessage.ciphertext[last] = (parsed.privateMessage.ciphertext[last] ?? 0) ^ 1
      commit = encode(mlsMessageEncoder, parsed)
    } else if (kind === 'forged-own-sender')
      commit = await forgeSender(f, f.member.handle.state.privatePath.leafIndex)
    else {
      const state = decodeClientState(f.state)
      if (state === undefined) throw new Error('missing source')
      state.signaturePrivateKey = f.group.committer.identity.privateKey
      const forged = await createCommit({
        context: f.member.handle.context,
        state,
        authenticatedData: encodeControlEnvelope({ v: 1 }),
      })
      commit = encode(mlsMessageEncoder, forged.commit)
    }
    const validation = await f.port.restoreValidation(f.built)
    expect(await validation?.readCommitHeader(commit)).toMatchObject({
      committerDID: f.member.identity.id,
    })
    expect(await validation?.validateFrame(f.frame(commit), f.built)).toEqual({
      kind: 'invalid',
      reason: 'authentication',
    })
    const searched = await searchReal(f, commit)
    expect(searched.result).toMatchObject({
      kind: 'first-valid',
      proof: { position: asLogPosition('000102') },
    })
    expect(searched.hold).not.toHaveBeenCalled()
    expect(searched.persisted).not.toHaveBeenCalled()
  },
)

test.each(['blank', 'unknown'] as const)(
  'forged %s sender leaf is authentication poison in validation and the ordinary port',
  async (kind) => {
    const f = await fixture({}, 0, 0, kind === 'blank')
    const leaf = kind === 'blank' ? 2 : 999
    expect(f.member.handle.state.ratchetTree[leaf * 2]).toBeUndefined()
    const commit = await forgeSender(f, leaf)
    expect(await f.member.handle.readCommitHeader(commit)).toEqual({ epoch: f.member.handle.epoch })
    const validation = await f.port.restoreValidation(f.built)
    expect(await validation?.validateFrame(f.frame(commit), f.built)).toEqual({
      kind: 'invalid',
      reason: 'authentication',
    })
    const live = createGroupMLS({
      access: testHandleAccess({
        handle: () => f.member.handle,
        adopt: () => {
          throw new Error('must not adopt')
        },
      }),
      identity: f.member.identity,
      entrySlot: f.member.slot,
    })
    const refused = await live.processCommit(commit, {})
    expect(refused.validation).toBeUndefined()
    expect(refused).toMatchObject({
      applied: false,
      advanced: false,
      epochBefore: f.built.epoch,
      epochAfter: f.built.epoch,
    })
    const searched = await searchReal(f, commit)
    expect(searched.result).toMatchObject({ kind: 'first-valid' })
    expect(searched.hold).not.toHaveBeenCalled()
  },
)

test.each([
  { postSignatureFailure: false, resync: false },
  { postSignatureFailure: true, resync: false },
  { postSignatureFailure: false, resync: true },
])(
  'a self-signed external commit copying our DID is policy poison without a fork hold: $postSignatureFailure/$resync',
  async ({ postSignatureFailure, resync }) => {
    const postSignature = vi.fn(async () => {
      throw new ValidationError('Invalid proposals')
    })
    const f = await fixture(
      postSignatureFailure
        ? {
            cryptoProvider: {
              getCiphersuiteImpl: async (id) => {
                const suite = await nobleCryptoProvider.getCiphersuiteImpl(id)
                return {
                  ...suite,
                  hpke: { ...suite.hpke, importSecret: postSignature },
                }
              },
            },
          }
        : {},
    )
    const author = f.group.committer.handle
    const attacker = resync ? f.member.identity : randomIdentity()
    const bundle = await generateKeyPackageWithKey({
      credential: {
        credentialType: 1,
        identity: new TextEncoder().encode(JSON.stringify({ id: f.member.identity.id })),
      },
      signatureKeyPair: { signKey: attacker.privateKey, publicKey: attacker.publicKey },
      cipherSuite: author.context.cipherSuite,
      capabilities:
        author.state.ratchetTree[0]?.nodeType === nodeTypes.leaf
          ? author.state.ratchetTree[0].leaf.capabilities
          : undefined,
    })
    const result = await rawJoinGroupExternal({
      context: { ...author.context, authService: { validateCredential: async () => true } },
      groupInfo: await createGroupInfoWithExternalPubAndRatchetTree(
        author.state,
        [],
        author.context.cipherSuite,
      ),
      keyPackage: bundle.publicPackage,
      privateKeys: bundle.privatePackage,
      resync,
    })
    const commit = encode(mlsMessageEncoder, {
      version: protocolVersions.mls10,
      wireformat: wireformats.mls_public_message,
      publicMessage: result.publicMessage,
    })
    const validation = await f.port.restoreValidation(f.built)
    expect(await validation?.readCommitHeader(commit)).toMatchObject({
      committerDID: f.member.identity.id,
      external: true,
    })
    if (postSignatureFailure) expect(postSignature).toHaveBeenCalled()
    expect.soft(await validation?.validateFrame(f.frame(commit), f.built)).toEqual({
      kind: 'invalid',
      reason: 'policy',
    })
    expect.soft(await f.member.handle.verifyCommitSignature(commit)).toBe(false)
    const searched = await searchReal(f, commit)
    expect.soft(searched.result).toMatchObject({
      kind: 'first-valid',
      proof: { position: asLogPosition('000102') },
    })
    expect.soft(searched.hold).not.toHaveBeenCalled()
    expect(searched.followWinner).not.toHaveBeenCalled()
    expect(searched.persisted).not.toHaveBeenCalled()
    await expectPolicyPoison(f, commit, true)
  },
)

test.each([false, true])(
  'own signature verification rejects a different member (public: %s)',
  async (publicFrame) => {
    const f = await fixture()
    const result = await createCommit({
      context: f.group.committer.handle.context,
      state: f.group.committer.handle.state,
      wireAsPublicMessage: publicFrame,
      authenticatedData: encodeControlEnvelope({ v: 1 }),
    })
    const commit = encode(mlsMessageEncoder, result.commit)
    expect(await f.member.handle.verifyCommitSignature(commit)).toBe(false)
    expect(await f.group.committer.handle.verifyCommitSignature(commit)).toBe(true)
  },
)

async function credentialAdd(
  f: Awaited<ReturnType<typeof fixture>>,
  identity: ReturnType<typeof randomIdentity>,
  credentialIdentity: Uint8Array,
) {
  const author = f.group.committer.handle
  const bundle = await generateKeyPackageWithKey({
    credential: { credentialType: 1, identity: credentialIdentity },
    signatureKeyPair: { signKey: identity.privateKey, publicKey: identity.publicKey },
    cipherSuite: author.context.cipherSuite,
    capabilities:
      author.state.ratchetTree[0]?.nodeType === nodeTypes.leaf
        ? author.state.ratchetTree[0].leaf.capabilities
        : undefined,
  })
  const result = await createCommit({
    context: { ...author.context, authService: { validateCredential: async () => true } },
    state: author.state,
    wireAsPublicMessage: true,
    authenticatedData: encodeControlEnvelope({ v: 1 }),
    extraProposals: [
      { proposalType: defaultProposalTypes.add, add: { keyPackage: bundle.publicPackage } },
    ],
  })
  return encode(mlsMessageEncoder, result.commit)
}

async function expectPolicyPoison(
  f: Awaited<ReturnType<typeof fixture>>,
  commit: Uint8Array,
  external = false,
) {
  const validation = await f.port.restoreValidation(f.built)
  expect(await validation?.readCommitHeader(commit)).toMatchObject({
    committerDID: external ? f.member.identity.id : f.group.committer.identity.id,
  })
  expect.soft(await validation?.validateFrame(f.frame(commit), f.built)).toEqual({
    kind: 'invalid',
    reason: 'policy',
  })
  const persisted = vi.fn(async () => {})
  const access = testHandleAccess({
    handle: () => f.member.handle,
    adopt: (next) => {
      f.member.handle = next
    },
    persist: persisted,
  })
  const live = createGroupMLS({
    access,
    identity: f.member.identity,
    entrySlot: f.member.slot,
  })
  expect.soft(await live.processCommit(commit, {})).toEqual({
    applied: false,
    advanced: false,
    epochBefore: f.built.epoch,
    epochAfter: f.built.epoch,
    refusal: external ? 'policy' : 'binding',
  })
  expect(encodeClientState(f.member.handle.state)).toEqual(f.state)
  expect(persisted).not.toHaveBeenCalled()
  const loadFixture = (name: string) =>
    import(new URL(`../../rpc/test/fixtures/${name}.ts`, import.meta.url).href)
  const { FakeHub } = (await loadFixture('fake-hub')) as {
    FakeHub: new () => GroupPeerParams<Record<string, never>>['hub']
  }
  const { createMemoryAnchorStore } = (await loadFixture('anchor')) as {
    createMemoryAnchorStore(): AnchorStore
  }
  const { createMemoryAppCursorStore } = (await loadFixture('app-cursor')) as {
    createMemoryAppCursorStore(): AppCursorStore
  }
  const { createMemoryAppOutbox } = (await loadFixture('outbox')) as {
    createMemoryAppOutbox(): AppOutbox
  }
  const hub = new FakeHub()
  const poison = await hub.publish({
    senderDID: f.group.committer.identity.id,
    topicID: commitTopic(await live.exportRecoverySecret()),
    payload: f.frame(commit).payload,
    retain: 'log',
  })
  const store = createTransactionalStore(f.member.handle)
  const onStrand = vi.fn()
  const peer = createGroupPeer({
    hub,
    crypto: createGroupCrypto({ access }),
    mls: live,
    control: store.control,
    prepareBuild: async () => {
      throw new Error('No pending operation')
    },
    validation: f.port,
    readEvidence: store.readEvidence,
    adopt: async () => 'moved',
    deliverWelcome: async () => {},
    anchorStore: createMemoryAnchorStore(),
    appCursorStore: createMemoryAppCursorStore(),
    appOutbox: createMemoryAppOutbox(),
    appOutboxLimit: 16,
    localDID: f.member.identity.id,
    protocols: {},
    handlers: {},
    onStrand,
  })
  try {
    await vi.waitFor(async () => {
      const cursor = (await store.control.load()).cursor
      expect(onStrand.mock.calls.length > 0 || cursor?.position === poison.sequenceID).toBe(true)
    })
    expect((await store.control.load()).cursor).toMatchObject({ position: poison.sequenceID })
    expect((await store.control.load()).cursor?.stranded).toBeUndefined()
    expect(onStrand).not.toHaveBeenCalled()
    expect(await live.readEpoch()).toBe(f.built.epoch)
    expect(persisted).not.toHaveBeenCalled()
  } finally {
    await peer.dispose()
  }
  const searched = await searchReal(f, commit)
  expect.soft(searched.result).toMatchObject({
    kind: 'first-valid',
    proof: { position: asLogPosition('000102') },
  })
  expect(searched.hold).not.toHaveBeenCalled()
  expect(searched.persisted).not.toHaveBeenCalled()
}

test.each(['malformed-capability', 'Token expired', 'Unsupported signature algorithm'] as const)(
  'deterministic credential rejection is policy poison in validation and the ordinary port: %s',
  async (kind) => {
    const f = await fixture()
    const newcomer = randomIdentity()
    const helpers = (await import(
      new URL('../../mls/test/fixtures/lifecycle-pipeline.ts', import.meta.url).href
    )) as {
      timedBinding(params: {
        identity: typeof newcomer
        iat: number
        exp: number
      }): Promise<ControllerBinding>
    }
    const now = Math.floor(Date.now() / 1000)
    const binding = await helpers.timedBinding({
      identity: newcomer,
      iat: now - 10,
      exp: now + 500,
    })
    if (kind === 'malformed-capability') binding.capability = 'malformed'
    const commit = await credentialAdd(
      f,
      newcomer,
      new TextEncoder().encode(JSON.stringify({ id: newcomer.id, controller: binding })),
    )
    const previousError = verifierFault.error
    if (kind !== 'malformed-capability') {
      verifierFault.token = binding.capability
      verifierFault.error = new Error(kind)
    }
    try {
      await expectPolicyPoison(f, commit)
    } finally {
      verifierFault.token = ''
      verifierFault.error = previousError
    }
  },
)

test.each(['not JSON', '{"v":2,"id":"did:key:invalid"}', '{"id":42}'])(
  'credential parse rejection is policy poison in validation and the ordinary port: %s',
  async (identity) => {
    const f = await fixture()
    const commit = await credentialAdd(f, randomIdentity(), new TextEncoder().encode(identity))
    await expectPolicyPoison(f, commit)
  },
)

test('authenticated public Add refused by credential authentication is policy poison', async () => {
  const f = await fixture()
  const author = f.group.committer.handle
  const stranger = randomIdentity()
  const bundle = await generateKeyPackageWithKey({
    credential: {
      credentialType: 1,
      identity: new TextEncoder().encode(JSON.stringify({ id: randomIdentity().id })),
    },
    signatureKeyPair: { signKey: stranger.privateKey, publicKey: stranger.publicKey },
    cipherSuite: author.context.cipherSuite,
    capabilities:
      author.state.ratchetTree[0]?.nodeType === nodeTypes.leaf
        ? author.state.ratchetTree[0].leaf.capabilities
        : undefined,
  })
  const result = await createCommit({
    context: { ...author.context, authService: { validateCredential: async () => true } },
    state: author.state,
    wireAsPublicMessage: true,
    authenticatedData: encodeControlEnvelope({ v: 1 }),
    extraProposals: [
      { proposalType: defaultProposalTypes.add, add: { keyPackage: bundle.publicPackage } },
    ],
  })
  const commit = encode(mlsMessageEncoder, result.commit)
  const validation = await f.port.restoreValidation(f.built)
  expect(await validation?.readCommitHeader(commit)).toMatchObject({
    committerDID: f.group.committer.identity.id,
  })
  expect(await validation?.validateFrame(f.frame(commit), f.built)).toEqual({
    kind: 'invalid',
    reason: 'policy',
  })
  expect((await searchReal(f, commit)).result).toMatchObject({ kind: 'first-valid' })
})

test.each(['credential', 'holder'] as const)(
  'transient credential verifier failure stops before a later exact own occurrence: %s',
  async (path) => {
    const f = await fixture()
    const newcomer = randomIdentity()
    const helpers = (await import(
      new URL('../../mls/test/fixtures/lifecycle-pipeline.ts', import.meta.url).href
    )) as {
      timedBinding(params: {
        identity: typeof newcomer
        iat: number
        exp: number
        issuer?: typeof newcomer
        parent?: string
      }): Promise<ControllerBinding>
    }
    const now = Math.floor(Date.now() / 1000)
    const holder = randomIdentity()
    const parent = await helpers.timedBinding({ identity: holder, iat: now - 20, exp: now + 1000 })
    const binding = await helpers.timedBinding({
      identity: newcomer,
      iat: now - 10,
      exp: now + 500,
      ...(path === 'holder' ? { issuer: holder, parent: parent.capability } : {}),
    })
    const bundle = await createKeyPackageBundle(newcomer, { controller: binding })
    const { invite } = await createInvite({
      group: f.group.committer.handle,
      identity: f.group.committer.identity,
      recipientDID: newcomer.id,
      permission: 'member',
    })
    const added = await commitInvite(f.group.committer.handle, bundle.publicPackage, invite)
    const commit = added.commitMessage
    const key = await deriveEntryKey(f.member.handle)
    const payload = encodeHandshakeFrame(
      HANDSHAKE_KIND.commit,
      encodeCommitFrame(commit, sealEntries(key, encodeLedgerEntries(invite.ledgerEntries))),
    )
    key.fill(0)
    const validation = await f.port.restoreValidation(f.built)
    expect(await validation?.validateFrame({ ...f.frame(commit), payload }, f.built)).toMatchObject(
      { kind: 'valid', own: false },
    )
    const token = path === 'holder' ? binding.holderGrant : binding.capability
    if (token === undefined) throw new Error('missing holder grant')
    verifierFault.token = token
    try {
      expect(
        await validation?.validateFrame({ ...f.frame(commit), payload }, f.built),
      ).toMatchObject({ kind: 'unavailable' })
      const searched = await searchReal(f, commit, f.port, payload)
      expect(searched.result).toEqual({ kind: 'unknown' })
      expect(searched.followWinner).not.toHaveBeenCalled()
      expect(searched.persisted).not.toHaveBeenCalled()
      expect((await searched.store.control.load()).cursor?.position).toBe(f.built.searchFrom)
      expect((await searched.store.control.load()).commitOnce?.payloadDigest).toBe(
        f.built.payloadDigest,
      )
      expect((await searched.store.control.load()).welcomes).toEqual([])
      const persisted = vi.fn(async () => {})
      const live = createGroupMLS({
        access: testHandleAccess({
          handle: () => f.member.handle,
          adopt: () => {
            throw new Error('must not adopt')
          },
          persist: persisted,
        }),
        identity: f.member.identity,
        entrySlot: f.member.slot,
      })
      expect(
        await live.processCommit(commit, {
          resolveLedgerEntries: async (ids) =>
            invite.ledgerEntries.filter((token) => ids.includes(ledgerEntryDigest(token))),
        }),
      ).toMatchObject({
        validation: 'unavailable',
        applied: false,
        advanced: false,
        epochBefore: f.built.epoch,
        epochAfter: f.built.epoch,
      })
      expect(persisted).not.toHaveBeenCalled()
    } finally {
      verifierFault.token = ''
    }
  },
)

test('provider evidence reads identity version terminal and control in one snapshot', async () => {
  const db = createMemoryTransaction({ rows: {} })
  const groups = createMemoryGroupPersistence({
    owners: createOwnerQueues(),
    db,
    atRest: createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(39) }),
    providerID: 'evidence',
  })
  const seed = await makeStorageSeed({ id: 'evidence', incarnation: 1, epoch: 0, mode: 'real-mls' })
  await installSeed(groups, seed, 'seed')
  const transact = vi.spyOn(db, 'transact')
  const evidence = await groups.readEvidence(seed.key)
  expect(evidence).toMatchObject({
    source: {
      key: seed.key,
      stateVersion: seed.state.version,
      identity: { ...seed.key, epoch: seed.state.epoch },
    },
    cursor: null,
    applied: [],
    terminal: false,
  })
  expect(evidence.source.identity?.authenticator).toEqual(seed.state.epochAuthenticator)
  expect(transact).toHaveBeenCalledOnce()
})

test('dependency diagnostics survive binding-error replacement', async () => {
  const f = await fixture()
  const committer = f.group.committer.handle
  const pending = {
    [bytesToBase64(new Uint8Array(32).fill(8))]: {
      proposal: {
        proposalType: defaultProposalTypes.remove,
        remove: { removed: f.member.handle.state.privatePath.leafIndex },
      },
      senderLeafIndex: committer.state.privatePath.leafIndex,
    },
  }
  const reference = await createCommit({
    context: committer.context,
    state: { ...committer.state, unappliedProposals: pending },
    wireAsPublicMessage: true,
    authenticatedData: encodeControlEnvelope({ v: 1 }),
  })
  const receiver = async () => {
    const state = decodeClientState(f.state)
    if (state === undefined) throw new Error('missing state')
    return restoreGroup({
      state,
      credential: f.member.handle.credential,
      ledgerEntries: f.member.handle.ledgerTokens,
    })
  }
  const causeOf = async (group: GroupHandle, bytes: Uint8Array) => {
    try {
      await group.processMessage(bytes)
    } catch (error) {
      if (error instanceof Error && error.cause instanceof Error) return error.cause
      throw error
    }
    throw new Error('expected dependency refusal')
  }
  const missingReference = await causeOf(
    await receiver(),
    encode(mlsMessageEncoder, reference.commit),
  )
  expect(missingReference.message).toBe('Could not find proposal with supplied reference')
  const proposed = await createProposal({
    context: committer.context,
    state: committer.state,
    proposal: {
      proposalType: defaultProposalTypes.group_context_extensions,
      groupContextExtensions: { extensions: committer.state.groupContext.extensions },
    },
  })
  const farState = decodeClientState(encodeClientState(proposed.newState))
  if (farState === undefined) throw new Error('missing future state')
  const sender = farState.secretTree.leafNodes[committer.state.privatePath.leafIndex * 2]
  if (sender === undefined) throw new Error('missing sender ratchet')
  sender.handshake.generation = 10000
  const future = await createCommit({
    context: committer.context,
    state: { ...farState, unappliedProposals: {} },
    authenticatedData: encodeControlEnvelope({ v: 1 }),
  })
  const futureBytes = encode(mlsMessageEncoder, future.commit)
  const futureGeneration = await causeOf(await receiver(), futureBytes)
  expect(futureGeneration.message).toBe('Desired generation too far in the future')
  const consumed = await receiver()
  await consumed.processMessage(encode(mlsMessageEncoder, proposed.message))
  const past = (await commitKeyRotation(committer)).commitMessage
  const consumedGeneration = await causeOf(consumed, past)
  expect(consumedGeneration.message).toBe('Desired gen in the past')
  const validation = await f.port.restoreValidation(f.built)
  const result = await validation?.validateFrame(f.frame(futureBytes), f.built)
  expect(result).toEqual({ kind: 'invalid', reason: 'authentication' })
  expect((await searchReal(f, futureBytes)).result).toMatchObject({ kind: 'first-valid' })
  const journal = decodeControlJournal(f.built.journal)
  const consumedBuild = {
    ...f.built,
    journal: encodeControlJournal({ ...journal, sourceState: encodeClientState(consumed.state) }),
  }
  const consumedValidation = await f.port.restoreValidation(consumedBuild)
  expect(await consumedValidation?.validateFrame(f.frame(past), consumedBuild)).toEqual({
    kind: 'unavailable',
    reason: 'missing-key',
  })
})

test.each(['external-authentication', 'body-resolver'] as const)(
  'unavailable header or body resolution cannot hide an earlier winner: %s',
  async (seam) => {
    const fault = new Error('transient dependency')
    const f = await fixture({
      cryptoProvider: {
        getCiphersuiteImpl: async (id) => {
          const suite = await nobleCryptoProvider.getCiphersuiteImpl(id)
          return seam === 'external-authentication'
            ? {
                ...suite,
                signature: {
                  ...suite.signature,
                  verify: async () => {
                    throw fault
                  },
                },
              }
            : {
                ...suite,
                kdf: {
                  ...suite.kdf,
                  expand: async (secret, info, length) => {
                    if (new TextDecoder().decode(info).includes('kumiai/ledger-entries/v1'))
                      throw fault
                    return suite.kdf.expand(secret, info, length)
                  },
                },
              }
        },
      },
    })
    const competitor =
      seam === 'external-authentication'
        ? (
            await joinGroupExternal({
              identity: f.group.committer.identity,
              groupInfo: (await exportGroupInfo({ group: f.group.committer.handle })).groupInfo,
              credential: f.group.committer.handle.credential,
              resync: true,
            })
          ).commitMessage
        : (await publicLedger(f)).commit
    const result = await searchReal(f, competitor)
    expect(result.result).toEqual({ kind: 'unknown' })
    expect(result.followWinner).not.toHaveBeenCalled()
    expect(result.persisted).not.toHaveBeenCalled()
    expect((await result.store.control.load()).cursor?.position).toBe(f.built.searchFrom)
    expect((await result.store.control.load()).commitOnce?.payloadDigest).toBe(
      f.built.payloadDigest,
    )
    expect((await result.store.control.load()).welcomes).toEqual([])
  },
)

test.each(['refused', 'unavailable'] as const)(
  'validator and live winner disagreement holds: live %s',
  async (kind) => {
    const f = await fixture()
    const competitor = (await commitKeyRotation(f.group.committer.handle)).commitMessage
    const followWinner = vi.fn(async () => ({ kind }))
    const safety = safetyCallbacks()
    const search = createControlSearch({
      ...safety,
      budget: { maxPasses: 2, maxFetches: 16, maxFrames: 256 },
      validation: f.port,
      readEvidence: async () => ({
        source: f.source,
        applied: [],
        cursor: { position: f.built.searchFrom, epoch: f.built.epoch },
        terminal: false,
      }),
      fetch: async () => ({
        messages: [
          f.frame(competitor),
          { ...f.frame(competitor), position: asLogPosition('000102'), payload: f.built.payload },
        ].map((row) => ({
          sequenceID: row.position,
          senderDID: row.senderDID,
          payload: row.payload,
          topicID: 'commits',
          receivedAt: 1,
        })),
        head: '000102',
        oldest: '000101',
        gap: false,
      }),
      followWinner,
      reconcileAbsent: async () => false,
      hold: async () => {},
    })
    expect(await search.searchLog(f.built)).toEqual({ kind: 'unknown' })
    expect(followWinner).toHaveBeenCalledOnce()
  },
)

function safetyCallbacks() {
  let held = false
  return {
    safetyHold: () => (held ? ('fork-halted' as const) : null),
    haltFork: vi.fn(async (_evidence: GroupForkEvidence) => {
      held = true
    }),
  }
}

test.each(['outer', 'inner'] as const)(
  'real sealed-entry %s version poison advances the peer and preserves saved work',
  async (layer) => {
    const f = await fixture()
    const ledger = await publicLedger(f)
    const key = await deriveEntryKey(f.member.handle)
    const entries = encodeLedgerEntries([ledger.token])
    if (layer === 'inner') entries[0] = 2
    const sealed = sealEntries(key, entries)
    key.fill(0)
    if (layer === 'outer') sealed[0] = 2
    const payload = encodeHandshakeFrame(
      HANDSHAKE_KIND.commit,
      encodeCommitFrame(ledger.commit, sealed),
    )
    const validation = await f.port.restoreValidation(f.built)
    expect(await validation?.validateFrame({ ...ledger.frame, payload }, f.built)).toEqual({
      kind: 'unavailable',
      reason: 'unsupported-version',
    })
    const searched = await searchReal(f, ledger.commit, f.port, payload)
    expect(searched.result).toEqual({ kind: 'unknown' })
    expect(searched.hold).not.toHaveBeenCalled()
    expect(searched.followWinner).not.toHaveBeenCalled()
    const store = searched.store
    const operation = (await store.control.load()).operations[0]
    if (operation === undefined) throw new Error('missing saved operation')
    const now = Date.now()
    await store.control.apply(
      {
        putOperations: [{ ...operation, enqueuedAt: now, deadline: now + 30000 }],
        putOutcomes: [{ id: 'owed-outcome', opID: null, at: 1, kind: 'unknown' }],
        putWelcomes: [
          { opID: 'owed-welcome', welcome: new Uint8Array([7]), recipients: ['invitee'] },
        ],
      },
      'owed-work',
    )
    const before = await store.control.load()
    expect(before.commitOnce).not.toBeNull()
    expect(before.operations).toHaveLength(1)
    const loadFixture = (name: string) =>
      import(new URL(`../../rpc/test/fixtures/${name}.ts`, import.meta.url).href)
    const { FakeHub } = (await loadFixture('fake-hub')) as {
      FakeHub: new () => GroupPeerParams<Record<string, never>>['hub']
    }
    const { createMemoryAnchorStore } = (await loadFixture('anchor')) as {
      createMemoryAnchorStore(): AnchorStore
    }
    const { createMemoryAppCursorStore } = (await loadFixture('app-cursor')) as {
      createMemoryAppCursorStore(): AppCursorStore
    }
    const { createMemoryAppOutbox } = (await loadFixture('outbox')) as {
      createMemoryAppOutbox(): AppOutbox
    }
    const hub = new FakeHub()
    vi.spyOn(hub, 'fetchTopic').mockImplementation(async (request) => ({
      gap: false,
      head: '000101',
      oldest: '000101',
      messages:
        request.after != null && request.after >= '000101'
          ? []
          : [
              {
                topicID: request.topicID,
                sequenceID: '000101',
                senderDID: 'relay',
                payload,
                receivedAt: 1,
              },
            ],
    }))
    const access = testHandleAccess({
      handle: () => f.member.handle,
      adopt: () => {
        throw new Error('poison must not adopt')
      },
      persist: async () => {
        throw new Error('poison must not persist MLS')
      },
    })
    const mls = createGroupMLS({ access, identity: f.member.identity, entrySlot: f.member.slot })
    const onStrand = vi.fn()
    const onRecovery = vi.fn()
    const deliverWelcome = vi.fn(async () => {})
    const peer = createGroupPeer({
      hub,
      crypto: createGroupCrypto({ access }),
      mls,
      control: store.control,
      prepareBuild: async () => {
        throw new Error('must retain the saved slot')
      },
      validation: f.port,
      readEvidence: store.readEvidence,
      adopt: async () => 'moved',
      deliverWelcome,
      anchorStore: createMemoryAnchorStore(),
      appCursorStore: createMemoryAppCursorStore(),
      appOutbox: createMemoryAppOutbox(),
      appOutboxLimit: 16,
      localDID: f.member.identity.id,
      protocols: {},
      handlers: {},
      onStrand,
      onRecovery,
    })
    try {
      await peer.replay()
      const after = await store.control.load()
      expect(after.cursor).toMatchObject({ position: '000101', epoch: f.built.epoch })
      expect(after.cursor?.stranded).toBeUndefined()
      expect(after.strand).toBeNull()
      expect(after.forkHalt).toBeNull()
      expect(after.controlHold?.reason).not.toBe('unsupported-version')
      expect(after.commitOnce).toEqual(before.commitOnce)
      expect(after.operations).toEqual(before.operations)
      expect(after.outcomes).toEqual(before.outcomes)
      expect(after.welcomes).toEqual(before.welcomes)
      expect(after.applied).toEqual(before.applied)
      expect(after.responses).toEqual(before.responses)
      expect(onStrand).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'unknown-version',
          confidence: 'claimed',
          diagnostic: 'upgrade-required',
        }),
      )
      expect(onRecovery).not.toHaveBeenCalled()
      expect(deliverWelcome).not.toHaveBeenCalled()
      expect(encodeClientState(f.member.handle.state)).toEqual(f.state)
    } finally {
      await peer.dispose()
    }
  },
)
