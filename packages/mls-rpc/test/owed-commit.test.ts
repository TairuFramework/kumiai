import { CommitAuthoringRefusedError, commitKeyRotation, readMessageEpoch } from '@kumiai/mls'
import { type AdoptionWrite, asLogPosition, controlAdoptionAllowed } from '@kumiai/rpc'
import { expect, test } from 'vitest'

import { createControlAdoptionPort } from '../src/control-adoption.js'
import { decodeControlJournal } from '../src/control-journal.js'
import { accessKinds, authoringAccessFixture, rotationIntent } from './fixtures/authoring-access.js'

for (const kind of accessKinds) {
  test.each([
    'own proposal',
    'foreign proposal',
    'receive after evidence',
    'foreign proposal after reconstruction',
    'history eviction',
    'history eviction after reconstruction',
    'own sends after capture',
  ] as const)(`${kind}: %s after built-save`, async (move) => {
    const f = await authoringAccessFixture(kind)
    try {
      if (move === 'own sends after capture') {
        await f.control().apply({ putOperations: [rotationIntent] }, 'intent')
        const port = f.port(async (op, permitted) => {
          const frame = await f.access.mutate((handle) => handle.encrypt(new Uint8Array([11])))
          expect(readMessageEpoch(frame)).toBe(permitted.epoch)
          await f.remote.handle.decrypt(frame)
          return f.build(op, permitted)
        })
        expect(
          (
            await port.prepareBuild(rotationIntent, async (host) => ({
              payload: host.commit,
              publishID: 'own-send',
              expectedHead: null,
            }))
          ).kind,
        ).toBe('saved')
      } else expect((await f.owe()).kind).toBe('saved')
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
      } else if (move.startsWith('history eviction')) {
        await f.access.mutate(async (handle) => {
          expect(handle.state.historicalReceiverData.size).toBeGreaterThan(0)
          handle.state.historicalReceiverData.clear()
        })
        if (move.endsWith('reconstruction')) await f.reconstruct()
      } else if (move === 'own sends after capture') {
        const message = await f.access.mutate((handle) => handle.encrypt(new Uint8Array([12])))
        await f.remote.handle.decrypt(message)
        await f.remote.handle.processMessage(slot.payload)
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
        if (move.startsWith('history eviction'))
          expect([...adopted.state.historicalReceiverData.keys()]).toEqual([BigInt(slot.epoch)])
        expect(adopted.state.keySchedule.epochAuthenticator).toEqual(
          decodeControlJournal(slot.journal).candidateAuthenticator,
        )
        if (move === 'own sends after capture') {
          const leaf = adopted.state.privatePath.leafIndex * 2
          const retained = adopted.state.historicalReceiverData.get(BigInt(slot.epoch))
          expect(retained?.secretTree.leafNodes[leaf]?.application.generation).toBe(2)
          const priorHistory = structuredClone(retained)
          const message = await f.access.mutate((handle) => handle.encrypt(new Uint8Array([13])))
          expect(readMessageEpoch(message)).toBe(BigInt(slot.epoch + 1))
          expect((await f.remote.handle.decrypt(message)).payload).toEqual(new Uint8Array([13]))
          await f.access.read((handle) => {
            expect(handle.state.secretTree.leafNodes[leaf]?.application.generation).toBe(
              kind === 'registry' ? 17 : 1,
            )
            expect(handle.state.historicalReceiverData.get(BigInt(slot.epoch))).toEqual(
              priorHistory,
            )
            expect(handle.state.secretTree.leafNodes[leaf]?.application.secret).not.toEqual(
              retained?.secretTree.leafNodes[leaf]?.application.secret,
            )
          })
        }
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
    expect(
      controlAdoptionAllowed(snapshot, source, { ...expected, stateVersion: source.stateVersion }),
    ).toBe(true)
    expect(controlAdoptionAllowed(snapshot, source, expected)).toBe(false)
    const { journal: _journal, ...nonJournal } = expected
    expect(
      controlAdoptionAllowed(snapshot, source, {
        ...nonJournal,
        stateVersion: source.stateVersion,
      }),
    ).toBe(true)
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
