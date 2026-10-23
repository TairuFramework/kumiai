import type * as Mls from '@kumiai/mls'
import {
  commitKeyRotation,
  commitLedgerEntries,
  decodeClientState,
  encodeClientState,
  GroupHandle,
  GroupRestoreError as InvalidCandidateError,
  ledgerEntryDigest,
  restoreGroup,
  signLedgerEntry,
} from '@kumiai/mls'
import type { Operation, OperationDeps } from '@kumiai/rpc'
import {
  asLogPosition,
  type BuiltCommit,
  consumeOwnOccurrence,
  createLedgerEntryResolver,
  decodeCommitFrame,
  decodeHandshakeFrame,
  digestAppliedCommit,
  encodeCommitFrame,
  encodeHandshakeFrame,
  encodeLedgerEntries,
  HANDSHAKE_KIND,
} from '@kumiai/rpc'
import { stepLiveBuild } from '@kumiai/rpc/testing'
import { sha256 } from '@noble/hashes/sha2.js'
import { toB64U } from '@sozai/codec'
import { expect, test, vi } from 'vitest'

import { createControlAdoptionPort } from '../src/control-adoption.js'
import { encodeControlJournal } from '../src/control-journal.js'
import { createControlValidationPort } from '../src/control-validation.js'
import { deriveEntryKey, openEntries, sealEntries } from '../src/crypto.js'
import { createRealGroup, testHandleAccess } from './fixtures/real-group.js'
import { createTransactionalStore } from './fixtures/transactional-access.js'

const verifierFault = vi.hoisted((): { token: string; error: Error } => ({
  token: '',
  error: new Error('local entry verification unavailable'),
}))
const recognition = vi.hoisted(() => ({ disabled: false }))
vi.mock('@kumiai/mls', async (importOriginal) => {
  const actual = await importOriginal<typeof Mls>()
  return {
    ...actual,
    verifyLedgerEntry: (token: string) => {
      if (token === verifierFault.token) throw verifierFault.error
      return actual.verifyLedgerEntry(token)
    },
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
    opID: 'own-copy',
    kind: 'ledger',
    revokes: false,
    enqueuedAt: 0,
    deadline: 30000,
    epoch: source.identity.epoch,
    incarnation: 1,
    authenticatorBefore: source.identity.authenticator.slice(),
    head: null,
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
    if (state === undefined) throw new InvalidCandidateError('missing candidate')
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
  const validate = async (payload: Uint8Array, position = '1') =>
    validation.validateFrame(
      { payload, position: asLogPosition(position), senderDID: 'replayer' },
      built,
    )
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
    validate,
    validationPort: port,
    rows,
    hold,
    haltFork,
  }
}

test.each([true, false])(
  'failed own copy blocks identical retry and a later exact occurrence installs unknown (delivered: %s)',
  async (delivered) => {
    const f = await fixture(true)
    const store = createTransactionalStore(f.author.handle)
    const intent: Operation = {
      id: f.built.opID,
      kind: f.built.kind,
      revokes: false,
      body: new Uint8Array(),
      seq: 1,
      enqueuedAt: 0,
      deadline: 30000,
      stage: 'intent',
    }
    await store.control.apply({ putOperations: [intent] }, 'intent')
    expect(
      await store.saveBuilt(
        intent,
        f.built,
        { ...f.source, stateVersion: store.snapshot().revision },
        'build',
      ),
    ).toBe('saved')
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
    expect(
      await consumeOwnOccurrence(
        {
          control: store.control,
          validation: f.validationPort,
          adoption,
          now: () => 1,
          newID: () => crypto.randomUUID(),
          emit: () => {},
        },
        { payload: f.frame(bad), position: asLogPosition('1'), senderDID: 'replayer' },
      ),
    ).toBe('invalid')
    const beforeSkip = (await store.control.load()).commitOnce
    if (beforeSkip === null) throw new Error('Missing build')
    await store.control.apply(
      {
        // r28h: mirror the walker's classified own-copy skip, including the retry ban.
        commitOnce: { ...beforeSkip, skipped: true, retryForbidden: true },
        cursor: { position: asLogPosition('1'), epoch: f.built.epoch },
      },
      'skip',
    )
    const publish = vi.fn(async () => ({ sequenceID: '2' }))
    const deps: OperationDeps = {
      control: store.control,
      haltFork: f.haltFork,
      safetyHold: () => null,
      prepareBuild: async () => {
        throw new Error('Unexpected rebuild')
      },
      adopt: adoption.adopt,
      frame: async () => {
        throw new Error('Unexpected framing')
      },
      readEvidence: store.readEvidence,
      readHead: async () => asLogPosition('1'),
      publish,
      pullToHead: async () => {},
      now: () => 1,
      newID: () => crypto.randomUUID(),
      emit: () => {},
    }
    await stepLiveBuild(deps)
    expect(publish).not.toHaveBeenCalled()
    if (delivered) {
      expect(
        await consumeOwnOccurrence(
          {
            control: store.control,
            validation: f.validationPort,
            adoption,
            now: () => 2,
            newID: () => crypto.randomUUID(),
            emit: () => {},
          },
          { payload: f.built.payload, position: asLogPosition('2'), senderDID: 'replayer' },
        ),
      ).toBe('installed')
      expect(store.snapshot().control.commitOnce).toBeNull()
      expect(store.snapshot().control.outcomes).toMatchObject([
        { kind: 'unknown', opID: f.built.opID },
      ])
      expect(f.author.handle.state.keySchedule.epochAuthenticator).toEqual(
        f.prepared.newGroup.state.keySchedule.epochAuthenticator,
      )
    } else {
      expect(store.snapshot().control.commitOnce?.skipped).toBe(true)
      expect(store.snapshot().control.outcomes).toEqual([])
    }
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
    expect(await f.validate(changed)).toMatchObject({ kind: 'valid', own: true })
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
  } finally {
    recognition.disabled = false
  }
})

test('a valid swapped named-entry blob uses the receiver reference predicate', async () => {
  const f = await fixture(true)
  const swapped = sealEntries(f.key, encodeLedgerEntries(['unrelated extra body', f.token]))
  expect(swapped).not.toEqual(f.blob)
  f.rows.push(f.frame(swapped))
  expect(await f.validate(f.frame(swapped))).toMatchObject({ kind: 'valid', own: true })
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
  'a failed named-entry %s copy is refused while a later exact occurrence validates',
  async (fault) => {
    const f = await fixture(true)
    let bad = sealEntries(f.key, encodeLedgerEntries([]))
    if (fault === 'tag') {
      bad = f.blob.slice()
      bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 1
    } else if (fault === 'version') bad = new Uint8Array([99])
    f.rows.push(f.frame(bad))
    expect(await f.validate(f.frame(bad))).toMatchObject({
      kind: 'unavailable',
      reason: 'unexplained-own',
    })
    f.rows.push(f.built.payload.slice())
    expect(await f.validate(f.built.payload, '2')).toMatchObject({ kind: 'valid', own: true })
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

test('a failed re-encoded own copy does not invalidate a later exact occurrence', async () => {
  const f = await fixture(true)
  const original = f.prepared.commitMessage
  const reencoded = new Uint8Array([
    ...original.subarray(0, 4),
    0x40,
    original[4] ?? 0,
    ...original.subarray(5),
  ])
  f.rows.push(f.frame(new Uint8Array([99]), reencoded))
  expect(await f.validate(f.frame(new Uint8Array([99]), reencoded))).toMatchObject({
    kind: 'unavailable',
    reason: 'unexplained-own',
  })
  f.rows.push(f.built.payload)
  expect(await f.validate(f.built.payload, '2')).toMatchObject({ kind: 'valid', own: true })
})

test('own named-entry local verifier failure preserves the provider error identity', async () => {
  const f = await fixture(true)
  verifierFault.token = f.token
  try {
    await expect(f.validate(f.built.payload)).rejects.toBe(verifierFault.error)
  } finally {
    verifierFault.token = ''
  }
})

test('own saved-source signature verification preserves local provider errors', async () => {
  const f = await fixture()
  const providerError = new Error('saved source signature provider unavailable')
  const verify = vi
    .spyOn(GroupHandle.prototype, 'verifyCommitSignature')
    .mockRejectedValue(providerError)
  try {
    await expect(f.validation.verifyOwn(f.built)).rejects.toBe(providerError)
  } finally {
    verify.mockRestore()
  }
})
