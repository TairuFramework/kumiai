import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { HeadMismatchError } from '@kumiai/hub-protocol'
import {
  CommitAuthoringRefusedError,
  commitKeyRotation,
  decodeClientState,
  encodeClientState,
  encodeGroupAnchor,
  restoreGroup,
} from '@kumiai/mls'
import {
  type ControlSlot,
  decodeCommitFrame,
  decodeHandshakeFrame,
  encodeCommitFrame,
  encodeHandshakeFrame,
  HANDSHAKE_KIND,
} from '@kumiai/rpc'
import {
  createCommit,
  createProposal,
  decode,
  defaultProposalTypes,
  encode,
  mlsMessageDecoder,
  mlsMessageEncoder,
  wireformats,
} from 'ts-mls'
import { expect, test } from 'vitest'

import { simpleHandleAccess } from '../src/access.js'
import { decodeControlJournal } from '../src/control-journal.js'
import { createRealGroup } from './fixtures/real-group.js'
import { createControlCrashHarness } from './fixtures/storage-persistence.js'
import { makeStorageSeed } from './fixtures/storage-seed.js'

// Inspect encrypted sender data independently of the build's bookkeeping.
const entry = createRequire(import.meta.url).resolve('ts-mls')
const { decryptSenderData } = (await import(
  new URL('./privateMessage.js', pathToFileURL(entry)).href
)) as {
  decryptSenderData: (
    message: unknown,
    secret: Uint8Array,
    suite: unknown,
  ) => Promise<{ generation: number } | undefined>
}

async function generation(slot: ControlSlot): Promise<number> {
  const journal = decodeControlJournal(slot.journal)
  const state = decodeClientState(journal.sourceState)
  if (state === undefined) throw new Error('Missing source state')
  const source = await restoreGroup({
    state,
    credential: journal.sourceCredential,
    ledgerEntries: journal.sourceLedger,
  })
  const commit = decodeCommitFrame(decodeHandshakeFrame(slot.payload).payload).commit
  const message = decode(mlsMessageDecoder, commit)
  if (message?.wireformat !== wireformats.mls_private_message) throw new Error('Not private')
  const sender = await decryptSenderData(
    message.privateMessage,
    source.state.keySchedule.senderDataSecret,
    source.context.cipherSuite,
  )
  if (sender === undefined) throw new Error('Missing sender data')
  return sender.generation
}

for (const winner of ['historical', 'malformed', 'policy-refused', 'applied'] as const) {
  test.each([false, true])(
    `a ${winner} CAS winner never causes a second source-epoch build (restart: %s)`,
    async (restart) => {
      const group = await createRealGroup(2, 'control-crash')
      const author = group.committer.handle
      const remote = group.members[0]
      const victim = group.members[1]
      if (remote === undefined || victim === undefined) throw new Error('Missing member')
      const seed = await makeStorageSeed({
        id: 'control-crash',
        incarnation: 1,
        epoch: 0,
        mode: 'real-mls',
      })
      const epoch = Number(author.epoch)
      const authenticator = author.state.keySchedule.epochAuthenticator.slice()
      seed.state = {
        ...seed.state,
        epoch,
        epochAuthenticator: authenticator,
        state: encodeClientState(author.state),
        credential: author.credential,
        ledger: author.ledgerTokens,
      }
      seed.trust = {
        ...seed.trust,
        genesisAnchor: encodeGroupAnchor(author.anchor),
        installed: { ...seed.key, epoch, authenticator },
        signerTree: structuredClone(author.state.ratchetTree),
        registry: structuredClone(author.registry),
        credential: author.credential,
        ledger: author.ledgerTokens,
        spentEpochAuthenticators: [authenticator],
      }
      seed.confirmedTranscriptHash = author.state.groupContext.confirmedTranscriptHash.slice()
      const h = await createControlCrashHarness('real-mls', seed)
      try {
        await h.peer.resync()
        const op = await h.intent()
        await h.controlWalk.stepOperation(op.id)
        const built = (await h.control.load()).commitOnce
        if (built === null) throw new Error('Missing saved build')
        const ownGeneration = await generation(built)
        const competing =
          winner === 'malformed'
            ? null
            : await createCommit({
                context: remote.handle.context,
                state:
                  winner === 'historical'
                    ? {
                        ...remote.handle.state,
                        groupContext: {
                          ...remote.handle.state.groupContext,
                          epoch: remote.handle.epoch - 1n,
                        },
                      }
                    : remote.handle.state,
                ...(winner === 'policy-refused'
                  ? {
                      extraProposals: [
                        {
                          proposalType: defaultProposalTypes.remove,
                          remove: { removed: victim.handle.state.privatePath.leafIndex },
                        },
                      ],
                    }
                  : {}),
              })
        const competitor =
          competing === null ? new Uint8Array() : encode(mlsMessageEncoder, competing.commit)
        const publish = h.hub.publish.bind(h.hub)
        let raced = false
        h.hub.publish = async (params) => {
          if (!raced && params.publishID !== undefined) {
            raced = true
            await publish({
              senderDID: remote.identity.id,
              topicID: params.topicID,
              retain: 'log',
              payload: encodeHandshakeFrame(
                HANDSHAKE_KIND.commit,
                encodeCommitFrame(competitor, new Uint8Array()),
              ),
            })
          }
          return publish(params)
        }
        await h.controlWalk.stepOperation(op.id)
        expect(raced).toBe(true)
        expect(h.observations.builds).toBe(1)
        expect(h.publications[0]?.payload).toEqual(built.payload)
        const current = restart ? await h.reopen() : h
        await current.peer.replay()
        await current.controlWalk.walkCommits()
        expect(h.observations.builds).toBe(1)
        expect(await generation(built)).toBe(ownGeneration)
        for (const attempt of h.publications) {
          expect(attempt.payload).toEqual(built.payload)
          expect(attempt.publishID).toBe(built.publishID)
        }
        const snapshot = await current.control.load()
        if (winner === 'historical') {
          expect(snapshot.commitOnce).toBeNull()
          expect(h.observations.ownAdoptions).toBe(1)
        } else if (winner === 'applied') {
          expect(snapshot.commitOnce).toBeNull()
          expect(snapshot.outcomes).toContainEqual(
            expect.objectContaining({ opID: op.id, kind: 'lost' }),
          )
          expect((await current.source()).identity?.epoch).toBe(epoch + 1)
        } else {
          expect(snapshot.commitOnce?.payload).toEqual(built.payload)
          expect(snapshot.commitOnce?.skipped).toBe(true)
          expect(h.publications).toHaveLength(1)
        }
      } finally {
        await h.close()
        await h.fixture.close()
      }
    },
  )
}

test('a live build blocks a second same-epoch intent after lost CAS and restart', async () => {
  const h = await createControlCrashHarness('real-mls')
  try {
    await h.peer.resync()
    const op = await h.intent()
    h.hub.publish = async () => {
      throw new HeadMismatchError('refused handoff')
    }
    await h.controlWalk.stepOperation(op.id)
    await h.controlWalk.stepOperation(op.id)
    const built = (await h.control.load()).commitOnce
    if (built === null) throw new Error('Missing build')
    const reopened = await h.reopen()
    const next = { ...op, id: 'next-invite', seq: op.seq + 1 }
    await reopened.control.apply({ putOperations: [next] }, 'next-intent')
    await reopened.controlWalk.stepOperation(next.id)
    expect(h.observations.builds).toBe(1)
    expect((await reopened.control.load()).commitOnce?.payload).toEqual(built.payload)
    expect(h.publications.length).toBeGreaterThanOrEqual(1)
    for (const attempt of h.publications) {
      expect(attempt.payload).toEqual(built.payload)
      expect(attempt.publishID).toBe(built.publishID)
    }
  } finally {
    await h.close()
    await h.fixture.close()
  }
})

test('failed built-save releases no frame and permits preparation again after restart', async () => {
  const h = await createControlCrashHarness('real-mls')
  try {
    await h.peer.resync()
    const op = await h.intent()
    const failed = new Error('built-save failed')
    h.hooks.beforeSave = () => {
      throw failed
    }
    await expect(h.controlWalk.stepOperation(op.id)).rejects.toBe(failed)
    expect(h.publications).toEqual([])
    expect((await h.control.load()).commitOnce).toBeNull()
    const reopened = await h.reopen()
    await reopened.controlWalk.stepOperation(op.id)
    await reopened.controlWalk.walkCommits()
    expect(h.observations.builds).toBe(2)
    expect(h.observations.ownAdoptions).toBe(1)
    expect(h.publications).toHaveLength(1)
  } finally {
    await h.close()
    await h.fixture.close()
  }
})

test('control source capture grants no commit or proposal authoring authority', async () => {
  const h = await createControlCrashHarness('real-mls')
  try {
    const row = await h.groups.loadState(h.key)
    if (row === null || row.deleted || row.state === null) throw new Error('Missing state')
    const state = decodeClientState(row.state)
    if (state === undefined) throw new Error('Missing state')
    const reservation = { epoch: state.groupContext.epoch, generation: 1, consumed: true }
    const imported = decodeClientState(
      encodeClientState({ ...state, handshakeReservation: reservation }),
    )
    if (imported === undefined) throw new Error('Invalid imported source')
    const handle = await restoreGroup({
      state: imported,
      credential: row.credential,
      ledgerEntries: row.ledger,
    })
    const access = simpleHandleAccess({
      key: h.key,
      handle: () => handle,
      stateVersion: () => row.version,
      adopt: () => {
        throw new Error('Capture must not adopt')
      },
    })
    const before = encodeClientState(handle.state)
    const captured = await access.readControl(async (scope) => {
      const bytes = encodeClientState(scope.handle.state)
      expect(scope.source.stateVersion).toBe(row.version)
      await expect(commitKeyRotation(scope.handle)).rejects.toBeInstanceOf(
        CommitAuthoringRefusedError,
      )
      await expect(scope.handle.proposeSelfRemoval()).rejects.toBeInstanceOf(
        CommitAuthoringRefusedError,
      )
      return { handle: scope.handle, bytes }
    })
    await expect(commitKeyRotation(captured.handle)).rejects.toBeInstanceOf(
      CommitAuthoringRefusedError,
    )
    await expect(captured.handle.proposeSelfRemoval()).rejects.toBeInstanceOf(
      CommitAuthoringRefusedError,
    )
    expect(captured.bytes).toEqual(before)
    expect(encodeClientState(captured.handle.state)).toEqual(before)
    expect(await h.groups.loadState(h.key)).toEqual(row)
    expect(h.publications).toEqual([])
  } finally {
    await h.fixture.close()
  }
})

test.each([false, true])(
  'an imported main reservation survives a failed built-save safely (consumed: %s)',
  async (consumed) => {
    const seed = await makeStorageSeed({
      id: 'control-crash',
      incarnation: 1,
      epoch: 3,
      mode: 'real-mls',
    })
    if (seed.state.state === null) throw new Error('Missing source')
    const state = decodeClientState(seed.state.state)
    if (state === undefined) throw new Error('Invalid source')
    const source = await restoreGroup({
      state,
      credential: seed.state.credential,
      ledgerEntries: seed.state.ledger,
    })
    const derived = await createProposal({
      context: source.context,
      state,
      proposal: {
        proposalType: defaultProposalTypes.remove,
        remove: { removed: state.privatePath.leafIndex },
      },
    })
    seed.state.state = encodeClientState({
      ...state,
      secretTree: derived.newState.secretTree,
      handshakeReservation: { epoch: source.epoch, generation: 1, consumed },
    })
    expect(seed.state.state[1]).toBe(1)
    const h = await createControlCrashHarness('real-mls', seed)
    try {
      await h.peer.resync()
      const op = await h.intent()
      const failure = new Error('crash before built-save')
      let prepared: ControlSlot | undefined
      h.hooks.beforeSave = (slot) => {
        prepared = slot
        throw failure
      }
      await expect(h.controlWalk.stepOperation(op.id)).rejects.toBe(failure)
      if (prepared === undefined) throw new Error('Missing prepared build')
      expect(await generation(prepared)).toBe(2)
      expect(decodeControlJournal(prepared.journal).candidate[1]).toBe(0)
      expect(h.publications).toEqual([])
      const unchanged = await h.groups.loadState(h.key)
      if (unchanged === null || unchanged.deleted) throw new Error('Missing stored state')
      if (unchanged.state === null) throw new Error('Missing source state')
      const retained = decodeClientState(unchanged.state)
      // The walker's ordinary state save can persist the restore-time skip before built-save.
      expect(retained?.handshakeReservation).toBeUndefined()
      expect(unchanged.state[1]).toBe(0)
      expect(
        retained?.secretTree.leafNodes[2 * state.privatePath.leafIndex]?.handshake.generation,
      ).toBe(2)
      const reopened = await h.reopen()
      let saved: ControlSlot | undefined
      reopened.hooks.beforeSave = (slot) => {
        saved = slot
      }
      await reopened.controlWalk.stepOperation(op.id)
      await reopened.controlWalk.walkCommits()
      if (saved === undefined) throw new Error('Missing replayed build')
      expect(await generation(saved)).toBe(2)
      expect(h.observations.ownAdoptions).toBe(1)
      const installed = await reopened.groups.loadState(h.key)
      if (installed === null || installed.deleted || installed.state === null)
        throw new Error('Missing installed state')
      expect(installed.state[1]).toBe(0)
      expect(decodeClientState(installed.state)?.handshakeReservation).toBeUndefined()
    } finally {
      await h.close()
      await h.fixture.close()
    }
  },
)
