import { CommitAuthoringRefusedError, commitKeyRotation } from '@kumiai/mls'
import { type AdoptionWrite, asLogPosition, controlAdoptionAllowed } from '@kumiai/rpc'
import { expect, test } from 'vitest'

import { createControlAdoptionPort } from '../src/control-adoption.js'
import { decodeControlJournal } from '../src/control-journal.js'
import { accessKinds, authoringAccessFixture } from './fixtures/authoring-access.js'

for (const kind of accessKinds) {
  test.each([
    'own proposal',
    'foreign proposal',
    'receive after evidence',
    'foreign proposal after reconstruction',
    'history eviction',
  ] as const)(`${kind}: %s after built-save`, async (move) => {
    const f = await authoringAccessFixture(kind)
    try {
      expect((await f.owe()).kind).toBe('saved')
      const slot = (await f.control().load()).commitOnce
      if (slot === null) throw new Error('Missing slot')
      const source = await f.access.readControl(async ({ source }) => source)
      const proof = {
        source,
        from: slot.searchFrom,
        position: asLogPosition('000001'),
        payloadDigest: slot.payloadDigest,
      }
      await f.control().apply({ commitOnceAcceptance: proof }, 'accepted')
      const expected = await f.access.readControl(async ({ source }) => ({
        ...source,
        acceptance: proof,
      }))
      const write: AdoptionWrite = {
        mutationID: 'adopted',
        changes: {
          commitOnce: null,
          deleteOperations: [slot.opID],
          putApplied: [
            {
              epoch: slot.epoch,
              digest: slot.digest,
              payloadDigest: slot.payloadDigest,
              sequenceID: proof.position,
              opID: slot.opID,
              removed: false,
            },
          ],
          cursor: { position: proof.position, epoch: slot.epoch + 1 },
        },
      }
      if (move === 'own proposal') {
        const prior = await f.stored()
        const bare = await f.restoreStored(prior.state)
        const proposal = await bare.proposeSelfRemoval()
        await f.remote.handle.processMessage(proposal.frame)
        await f.rawSave(bare, prior.version)
        await expect(f.remote.handle.processMessage(slot.payload)).rejects.toThrow(
          'Desired gen in the past',
        )
      } else if (move.startsWith('foreign proposal')) {
        const proposer = f.real.members[1]
        if (proposer === undefined) throw new Error('Missing proposer')
        const proposal = await proposer.handle.proposeSelfRemoval()
        await f.access.mutate((handle) => handle.processMessage(proposal.frame))
        if (move.endsWith('reconstruction')) await f.reconstruct()
      } else if (move === 'history eviction') {
        await f.access.mutate(async (handle) => {
          expect(handle.state.historicalReceiverData.size).toBeGreaterThan(0)
          handle.state.historicalReceiverData.clear()
        })
      } else {
        const message = await f.remote.handle.encrypt(new Uint8Array([42]))
        await f.access.mutate((handle) => handle.decrypt(message))
      }
      const before = await f.stored()
      const port = createControlAdoptionPort({
        access: f.access,
        control: f.control(),
        restoreCandidate: f.restoreCandidate,
      })
      expect(await port.adopt(slot.journal, expected, write)).toBe(
        move === 'own proposal' ? 'moved' : 'installed',
      )
      if (move === 'own proposal') expect(await f.stored()).toEqual(before)
      else {
        const adopted = await f.access.read((handle) => handle)
        expect(adopted.state.unappliedProposals).toEqual({})
        if (move === 'history eviction')
          expect([...adopted.state.historicalReceiverData.keys()]).toEqual([BigInt(slot.epoch)])
        expect(adopted.state.keySchedule.epochAuthenticator).toEqual(
          decodeControlJournal(slot.journal).candidateAuthenticator,
        )
        await expect(commitKeyRotation(adopted)).rejects.toBeInstanceOf(CommitAuthoringRefusedError)
      }
    } finally {
      await f.close()
    }
  })
}

test('adoption caller without a callback keeps the exact version', async () => {
  const f = await authoringAccessFixture('transactional')
  try {
    await f.owe()
    const snapshot = await f.control().load()
    const source = await f.access.readControl(async ({ source }) => source)
    const expected = {
      ...source,
      stateVersion: source.stateVersion - 1,
      journal: new Uint8Array([1]),
    }
    expect(controlAdoptionAllowed(snapshot, source, expected)).toBe(false)
    const { journal: _journal, ...nonJournal } = expected
    expect(controlAdoptionAllowed(snapshot, source, nonJournal)).toBe(false)
    expect(
      controlAdoptionAllowed(snapshot, source, nonJournal, () => {
        throw new Error('Non-journal compatibility must not run')
      }),
    ).toBe(false)
  } finally {
    await f.close()
  }
})

test('registry ordinary destination refuses a moved control source before work', async () => {
  const f = await authoringAccessFixture('registry')
  try {
    await f.owe()
    const slot = (await f.control().load()).commitOnce
    if (slot === null) throw new Error('Missing slot')
    const source = await f.access.readControl(async ({ source }) => source)
    const proof = {
      source,
      from: slot.searchFrom,
      position: asLogPosition('000001'),
      payloadDigest: slot.payloadDigest,
    }
    await f.control().apply({ commitOnceAcceptance: proof }, 'accepted')
    const expected = await f.access.readControl(async ({ source }) => ({
      ...source,
      acceptance: proof,
      journal: slot.journal,
    }))
    const candidate = await f.restoreCandidate(decodeControlJournal(slot.journal).candidate)
    const prior = await f.stored()
    const bare = await f.restoreStored(prior.state)
    await bare.proposeSelfRemoval()
    await f.rawSave(bare, prior.version)
    let work = 0
    f.fixture.onPhase('work', () => {
      work++
    })
    const before = await f.stored()
    await expect(
      f.access.replace(candidate, () => ({
        mutationID: 'moved-adoption',
        expected,
        changes: { commitOnce: null, deleteOperations: [slot.opID] },
      })),
    ).rejects.toMatchObject({ name: 'ControlAdoptionMovedError' })
    expect(work).toBe(0)
    expect(await f.stored()).toEqual(before)
  } finally {
    await f.close()
  }
})
