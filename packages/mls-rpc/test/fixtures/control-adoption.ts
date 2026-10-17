import {
  commitKeyRotation,
  decodeClientState,
  encodeClientState,
  GroupRestoreError as InvalidCandidateError,
  restoreGroup,
} from '@kumiai/mls'
import {
  type AdoptionWrite,
  asLogPosition,
  type ControlSlot,
  type FirstValidCommit,
  type Operation,
} from '@kumiai/rpc'
import { expect } from 'vitest'

import { createControlAdoptionPort } from '../../src/control-adoption.js'
import { encodeControlJournal } from '../../src/control-journal.js'
import { createRealGroup } from './real-group.js'
import { createTransactionalAccess, createTransactionalStore } from './transactional-access.js'

export async function controlAdoptionFixture() {
  const group = await createRealGroup(1, 'control-adoption')
  const member = group.members[0]
  if (member === undefined) throw new Error('missing member')
  const store = createTransactionalStore(member.handle, {
    anchor: { epoch: Number(member.handle.epoch), secret: new Uint8Array(32).fill(9) },
    pending: {
      epochBefore: Number(member.handle.epoch),
      epochAfter: Number(member.handle.epoch) + 1,
      rosterBefore: [member.identity.id],
      forced: false,
      advance: 'rotation-commit',
    },
  })
  const host = await createTransactionalAccess(member, store)
  const original = (await store.readEvidence()).source
  const rotation = await commitKeyRotation(member.handle)
  const intent: Operation & { stage: 'intent' } = {
    id: 'rotation',
    kind: 'rotation',
    revokes: false,
    body: new Uint8Array(),
    seq: 1,
    enqueuedAt: 0,
    deadline: 30_000,
    stage: 'intent',
  }
  await store.control.apply({ putOperations: [intent] }, 'enqueue')
  const source = (await store.readEvidence()).source
  const position = asLogPosition('000001')
  const slot: ControlSlot = {
    opID: intent.id,
    incarnation: 1,
    epoch: Number(member.handle.epoch),
    authenticatorBefore: member.handle.state.keySchedule.epochAuthenticator.slice(),
    searchFrom: null,
    expectedHead: null,
    publishID: 'rotation-publish',
    payload: new Uint8Array([1, 2, 3]),
    payloadDigest: 'exact-full-payload',
    digest: 'rotation-commit',
    bodies: [],
    welcome: null,
    journal: encodeControlJournal({
      version: 1,
      source: original,
      checkpoint: null,
      sourceState: encodeClientState(member.handle.state),
      sourceCredential: member.handle.credential,
      sourceLedger: member.handle.ledgerTokens,
      candidate: encodeClientState(rotation.newGroup.state),
    }),
  }
  expect(await store.saveBuilt(intent, slot, source, 'build')).toBe('saved')
  const proof: FirstValidCommit = {
    source: (await store.readEvidence()).source,
    from: null,
    position,
    payloadDigest: slot.payloadDigest,
  }
  await store.control.apply({ commitOnceAcceptance: proof }, 'accept')
  const write: AdoptionWrite = {
    mutationID: 'landed',
    anchorLanded: 'rotation-commit',
    changes: {
      deleteOperations: [intent.id],
      commitOnce: null,
      putApplied: [
        {
          epoch: slot.epoch,
          digest: slot.digest,
          payloadDigest: slot.payloadDigest,
          sequenceID: position,
          opID: intent.id,
          removed: false,
        },
      ],
      cursor: { position, epoch: slot.epoch + 1 },
      putOutcomes: [{ id: 'landed-fact', opID: intent.id, at: 100, kind: 'landed', position }],
    },
  }
  const restoreCandidate = async (bytes: Uint8Array) => {
    const state = decodeClientState(bytes)
    if (state === undefined) throw new InvalidCandidateError('invalid candidate')
    return restoreGroup({
      state,
      credential: member.handle.credential,
      ledgerEntries: member.handle.ledgerTokens,
      options: { resolveLedgerEntries: member.slot.resolve },
    })
  }
  const port = createControlAdoptionPort({
    access: host.access,
    control: store.control,
    restoreCandidate,
  })
  const expected = async () => ({ ...(await store.readEvidence()).source, acceptance: proof })
  return { store, host, slot, proof, write, port, expected, rotation, member, restoreCandidate }
}
