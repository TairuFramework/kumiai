import type * as Mls from '@kumiai/mls'
import {
  commitKeyRotation,
  commitLedgerEntries,
  decodeClientState,
  encodeClientState,
  type GroupHandle,
  ledgerEntryDigest,
  ownCommitDigest,
  restoreGroup,
  signLedgerEntry,
} from '@kumiai/mls'
import type { Operation, OperationDeps } from '@kumiai/rpc'
import {
  asLogPosition,
  type BuiltCommit,
  controlBuildRef,
  createControlSearch,
  createLedgerEntryResolver,
  decodeCommitFrame,
  decodeHandshakeFrame,
  digestAppliedCommit,
  encodeCommitFrame,
  encodeHandshakeFrame,
  encodeLedgerEntries,
  HANDSHAKE_KIND,
} from '@kumiai/rpc'
import { sha256 } from '@noble/hashes/sha2.js'
import { toB64U } from '@sozai/codec'
import { expect, test, vi } from 'vitest'

import { stepOperation } from '../../rpc/lib/control/operations.js'
import { createControlAdoptionPort } from '../src/control-adoption.js'
import { encodeControlJournal } from '../src/control-journal.js'
import { createControlValidationPort } from '../src/control-validation.js'
import { deriveEntryKey, openEntries, sealEntries } from '../src/crypto.js'
import { createGroupMLS } from '../src/mls.js'
import { createRealGroup, testHandleAccess } from './fixtures/real-group.js'
import { createTransactionalStore } from './fixtures/transactional-access.js'

const recognition = vi.hoisted(() => ({ disabled: false }))
vi.mock('@kumiai/mls', async (importOriginal) => {
  const actual = await importOriginal<typeof Mls>()
  return {
    ...actual,
    ownCommitDigest: (bytes: Uint8Array) =>
      recognition.disabled ? null : actual.ownCommitDigest(bytes),
  }
})

async function fixture(named = false, nonempty = false) {
  const group = await createRealGroup(1, 'own-copy')
  const author = group.committer
  const state = encodeClientState(author.handle.state)
  const token = await signLedgerEntry(author.identity, {
    type: 'note',
    groupID: author.handle.groupID,
    subject: author.identity.id,
    value: 'saved work',
  })
  const prepared = named
    ? await commitLedgerEntries(author.handle, [token])
    : await commitKeyRotation(author.handle)
  const source = {
    key: { groupID: author.handle.groupID, incarnation: 1 },
    stateVersion: 1,
    identity: {
      groupID: author.handle.groupID,
      incarnation: 1,
      epoch: Number(author.handle.epoch),
      authenticator: author.handle.state.keySchedule.epochAuthenticator.slice(),
    },
  }
  const key = await deriveEntryKey(author.handle)
  const frame = (blob: Uint8Array, commit = prepared.commitMessage) =>
    encodeHandshakeFrame(HANDSHAKE_KIND.commit, encodeCommitFrame(commit, blob))
  const blob = named || nonempty ? sealEntries(key, encodeLedgerEntries([token])) : new Uint8Array()
  const payload = frame(blob)
  const built: BuiltCommit = {
    epoch: source.identity.epoch,
    incarnation: 1,
    authenticatorBefore: source.identity.authenticator.slice(),
    searchFrom: null,
    expectedHead: null,
    publishID: 'saved-own-copy',
    payload,
    payloadDigest: toB64U(sha256(payload)),
    digest: digestAppliedCommit(prepared.commitMessage),
    bodies: named ? [token] : [],
    welcome: null,
    journal: encodeControlJournal({
      version: 1,
      source,
      checkpoint: null,
      sourceState: state,
      sourceCredential: author.handle.credential,
      sourceLedger: author.handle.ledgerTokens,
      candidate: encodeClientState(prepared.newGroup.state),
    }),
  }
  const restoreCandidate = async (bytes: Uint8Array): Promise<GroupHandle> => {
    const state = decodeClientState(bytes)
    if (state === undefined) throw new Error('missing candidate')
    return restoreGroup({
      state,
      credential: author.handle.credential,
      ledgerEntries: prepared.newGroup.ledgerTokens,
    })
  }
  const port = createControlValidationPort({
    identity: author.identity,
    options: {},
    restoreCandidate,
  })
  const validation = await port.restoreValidation(built)
  if (validation === null) throw new Error('missing validation')
  const rows: Array<Uint8Array> = []
  const hold = vi.fn(async () => {})
  const haltFork = vi.fn(async () => {})
  const search = createControlSearch({
    ownCommitDigest,
    budget: { maxPasses: 2, maxFetches: 16, maxFrames: 256 },
    validation: port,
    fetch: async (after) => ({
      messages: rows
        .map((payload, index) => ({
          payload,
          sequenceID: String(index + 1),
          senderDID: 'replayer',
          receivedAt: 1,
          topicID: 'commit',
        }))
        .filter((row) => after === null || row.sequenceID > after),
      head: rows.length === 0 ? null : String(rows.length),
      oldest: rows.length === 0 ? null : '1',
      gap: false,
    }),
    readEvidence: async () => ({ source, applied: [], cursor: null, terminal: false }),
    followWinner: async () => ({ kind: 'unavailable' }),
    reconcileAbsent: async () => true,
    hold,
    haltFork,
    safetyHold: () => null,
  })
  return {
    group,
    author,
    prepared,
    state,
    key,
    token,
    built,
    source,
    restoreCandidate,
    frame,
    blob,
    validation,
    search,
    rows,
    hold,
    haltFork,
  }
}

test.each([true, false])(
  'real saved named work retries identical bytes and ID (delivered: %s)',
  async (delivered) => {
    const f = await fixture(true)
    const store = createTransactionalStore(f.author.handle)
    const intent: Operation & { stage: 'intent' } = {
      id: 'own-copy',
      kind: 'rotation',
      revokes: false,
      body: new Uint8Array(),
      seq: 1,
      enqueuedAt: 0,
      deadline: 30000,
      stage: 'intent',
    }
    await store.control.apply({ putOperations: [intent] }, 'intent')
    expect(await store.saveBuilt(intent, { ...f.built, opID: intent.id }, f.source, 'built')).toBe(
      'saved',
    )
    const operation: Operation = { ...intent, stage: 'built', built: controlBuildRef(f.built) }
    const access = testHandleAccess({
      handle: () => f.author.handle,
      adopt: (handle) => {
        f.author.handle = handle
      },
      stateVersion: () => store.snapshot().revision,
      persist: async (handle, write) =>
        store.save(
          store.snapshot().revision,
          encodeClientState(handle.state),
          handle.ledgerTokens,
          undefined,
          write,
        ),
    })
    const adoption = createControlAdoptionPort({
      access,
      control: store.control,
      restoreCandidate: f.restoreCandidate,
    })
    const bad = f.blob.slice()
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 1
    f.rows.push(f.frame(bad))
    const receiver = f.group.members[0]
    if (receiver === undefined) throw new Error('missing receiver')
    receiver.slot.install(createLedgerEntryResolver(bad, async (blob) => openEntries(f.key, blob)))
    await expect(receiver.handle.processMessage(f.prepared.commitMessage)).rejects.toThrow()
    expect(receiver.handle.epoch).toBe(BigInt(f.built.epoch))
    let now = 1
    let serial = 0
    const prepareBuild = vi.fn<OperationDeps['prepareBuild']>(async () => {
      throw new Error('Unexpected rebuild')
    })
    const publish = vi.fn<OperationDeps['publish']>(async (payload, publishID, expectedHead) => {
      expect(payload).toEqual(f.built.payload)
      expect(publishID).toBe(f.built.publishID)
      expect(expectedHead).toBe('1')
      if (delivered) {
        f.rows.push(payload.slice())
        const frame = decodeCommitFrame(decodeHandshakeFrame(payload).payload)
        receiver.slot.install(
          createLedgerEntryResolver(frame.sealedEntries, async (blob) => openEntries(f.key, blob)),
        )
        await receiver.handle.processMessage(frame.commit)
      }
      return { sequenceID: '2' }
    })
    const deps: OperationDeps = {
      control: store.control,
      safetyHold: () => null,
      haltFork: f.haltFork,
      prepareBuild,
      frame: async () => {
        throw new Error('Unexpected framing')
      },
      adopt: adoption.adopt,
      searchLog: f.search.searchLog,
      readEvidence: store.readEvidence,
      readHead: async () => asLogPosition('1'),
      publish,
      pullToHead: async () => {},
      now: () => now,
      newID: () => `mutation-${++serial}`,
      emit: () => {},
    }
    const result = await stepOperation(deps, operation)
    expect(publish).toHaveBeenCalledOnce()
    if (delivered) {
      expect(result).toBeNull()
      expect((await store.control.load()).outcomes).toMatchObject([
        { kind: 'landed', position: '2' },
      ])
      expect((await store.control.load()).applied).toMatchObject([
        { digest: f.built.digest, payloadDigest: f.built.payloadDigest, sequenceID: '2' },
      ])
      expect(f.author.handle.state.keySchedule.epochAuthenticator).toEqual(
        receiver.handle.state.keySchedule.epochAuthenticator,
      )
      const receiverMLS = createGroupMLS({
        identity: receiver.identity,
        entrySlot: receiver.slot,
        access: testHandleAccess({
          handle: () => receiver.handle,
          adopt: (handle) => {
            receiver.handle = handle
          },
        }),
      })
      expect(await receiverMLS.processCommit(f.prepared.commitMessage, {})).toMatchObject({
        applied: false,
        advanced: false,
      })
      expect(receiver.handle.ledgerTokens.filter((token) => token === f.token)).toEqual([f.token])
    } else {
      expect(result).toEqual(operation)
      await stepOperation(deps, operation)
      expect(publish).toHaveBeenCalledOnce()
      now = 30000
      expect(await stepOperation(deps, operation)).toBeNull()
      const snapshot = await store.control.load()
      expect(snapshot.outcomes).toMatchObject([{ kind: 'unknown' }])
      expect(snapshot.commitOnce).toEqual({ ...f.built, opID: intent.id, expectedHead: '1' })
      expect(snapshot.commitOnceAcceptance).toBeNull()
      expect(snapshot.applied).toEqual([])
    }
    expect(prepareBuild).not.toHaveBeenCalled()
    expect(f.haltFork).not.toHaveBeenCalled()
  },
)

test.each([
  { nonempty: false, reencoded: false },
  { nonempty: true, reencoded: false },
  { nonempty: true, reencoded: true },
])(
  'a blob-changed no-entry copy recognises saved work ($nonempty, re-encoded: $reencoded)',
  async ({ nonempty, reencoded }) => {
    const f = await fixture(false, nonempty)
    const saved = { ...f.built, payload: f.built.payload.slice(), journal: f.built.journal.slice() }
    const original = f.prepared.commitMessage
    const commit = reencoded
      ? new Uint8Array([
          ...original.subarray(0, 4),
          0x40,
          original[4] ?? 0,
          ...original.subarray(5),
        ])
      : original
    const changed = f.frame(new Uint8Array([99, 42]), commit)
    expect(
      await f.validation.validateFrame(
        { payload: changed, position: asLogPosition('1'), senderDID: 'replayer' },
        f.built,
      ),
    ).toMatchObject({ kind: 'valid', own: true })
    f.rows.push(changed)
    expect(await f.search.searchLog(f.built)).toMatchObject({
      kind: 'first-valid',
      proof: { position: '1', payloadDigest: f.built.payloadDigest },
    })
    expect(f.built).toEqual(saved)
    expect(encodeClientState(f.author.handle.state)).toEqual(f.state)
    expect(f.haltFork).not.toHaveBeenCalled()
    const receiver = f.group.members[0]
    if (receiver === undefined) throw new Error('missing receiver')
    receiver.slot.install(
      createLedgerEntryResolver(new Uint8Array([99]), async () => {
        throw new Error('Unused blob')
      }),
    )
    await receiver.handle.processMessage(commit)
    expect(receiver.handle.state.keySchedule.epochAuthenticator).toEqual(
      f.prepared.newGroup.state.keySchedule.epochAuthenticator,
    )
  },
)

test('two null recognition digests never recognise a changed copy', async () => {
  const f = await fixture()
  recognition.disabled = true
  try {
    f.rows.push(f.frame(new Uint8Array([99])))
    expect(
      await f.validation.validateFrame(
        {
          payload: f.rows[0] ?? new Uint8Array(),
          position: asLogPosition('1'),
          senderDID: 'replayer',
        },
        f.built,
      ),
    ).toEqual({ kind: 'unavailable', reason: 'unexplained-own' })
    expect(await f.search.searchLog(f.built)).toEqual({ kind: 'unknown', retryHead: '1' })
  } finally {
    recognition.disabled = false
  }
})

test('a valid swapped named-entry blob uses the receiver reference predicate', async () => {
  const f = await fixture(true)
  const swapped = sealEntries(f.key, encodeLedgerEntries(['unrelated extra body', f.token]))
  expect(swapped).not.toEqual(f.blob)
  f.rows.push(f.frame(swapped))
  expect(await f.search.searchLog(f.built)).toMatchObject({
    kind: 'first-valid',
    proof: { payloadDigest: f.built.payloadDigest },
  })
  const receiver = f.group.members[0]
  if (receiver === undefined) throw new Error('missing receiver')
  receiver.slot.install(
    createLedgerEntryResolver(swapped, async (blob) => openEntries(f.key, blob)),
  )
  await receiver.handle.processMessage(f.prepared.commitMessage)
  expect(
    receiver.handle.ledgerTokens.filter(
      (token) => ledgerEntryDigest(token) === ledgerEntryDigest(f.token),
    ),
  ).toEqual([f.token])
  expect(receiver.handle.state.keySchedule.epochAuthenticator).toEqual(
    f.prepared.newGroup.state.keySchedule.epochAuthenticator,
  )
})

test.each(['tag', 'reference', 'version'] as const)(
  'a failed named-entry %s copy stays unknown before identical replay applies once',
  async (fault) => {
    const f = await fixture(true)
    let bad = sealEntries(f.key, encodeLedgerEntries([]))
    if (fault === 'tag') {
      bad = f.blob.slice()
      bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 1
    } else if (fault === 'version') bad = new Uint8Array([99])
    f.rows.push(f.frame(bad))
    expect(await f.search.searchLog(f.built)).toEqual({ kind: 'unknown', retryHead: '1' })
    f.rows.push(f.built.payload.slice())
    expect(await f.search.searchLog(f.built)).toMatchObject({
      kind: 'first-valid',
      proof: { position: '2', payloadDigest: f.built.payloadDigest },
    })
    const receiver = f.group.members[0]
    if (receiver === undefined) throw new Error('missing receiver')
    for (const payload of f.rows) {
      const copy = decodeCommitFrame(decodeHandshakeFrame(payload).payload)
      receiver.slot.install(
        createLedgerEntryResolver(copy.sealedEntries, async (blob) => openEntries(f.key, blob)),
      )
      try {
        await receiver.handle.processMessage(copy.commit)
      } catch {}
    }
    expect(receiver.handle.epoch).toBe(f.prepared.newGroup.epoch)
    expect(receiver.handle.ledgerTokens.filter((token) => token === f.token)).toEqual([f.token])
    expect(f.haltFork).not.toHaveBeenCalled()
    expect(f.built.publishID).toBe('saved-own-copy')
  },
)

test('a failed re-encoded own copy permits retry and a later exact occurrence', async () => {
  const f = await fixture(true)
  const original = f.prepared.commitMessage
  const reencoded = new Uint8Array([
    ...original.subarray(0, 4),
    0x40,
    original[4] ?? 0,
    ...original.subarray(5),
  ])
  f.rows.push(f.frame(new Uint8Array([99]), reencoded))
  expect(await f.search.searchLog(f.built)).toEqual({ kind: 'unknown', retryHead: '1' })
  f.rows.push(f.built.payload)
  expect(await f.search.searchLog(f.built)).toMatchObject({
    kind: 'first-valid',
    proof: { position: '2', payloadDigest: f.built.payloadDigest },
  })
})
