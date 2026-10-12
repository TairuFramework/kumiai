import type { AdoptionWrite, ControlSlot, FirstValidCommit } from '@kumiai/rpc'
import { describe, expect, test } from 'vitest'

import { createControlCrashHarness, runControlProofConflict } from './storage-persistence.js'

function crashAdoptionWrite(slot: ControlSlot, proof: FirstValidCommit): AdoptionWrite {
  return {
    mutationID: 'adopted',
    anchorLanded: slot.digest,
    changes: {
      commitOnce: null,
      deleteOperations: [slot.opID],
      cursor: { position: proof.position, epoch: slot.epoch + 1 },
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
      putOutcomes: [
        {
          id: slot.opID,
          opID: slot.opID,
          at: Date.now(),
          kind: 'landed',
          position: proof.position,
        },
      ],
    },
  }
}

export function testControlCrashBoundaries(mode: 'real-mls' | 'double'): void {
  describe(`sealed control reconstruction: ${mode}`, () => {
    test('death after preparation before built-save releases no bytes', async () => {
      const h = await createControlCrashHarness(mode)
      try {
        await h.peer.resync()
        const op = await h.intent()
        const died = new Error('process died before built-save')
        let first: ControlSlot | undefined
        const saver = h.groups.transition
        h.groups.transition = async () => {
          throw died
        }
        // Capture the framed bytes at the saver boundary, with the hub already attached.
        h.hooks.beforeSave = (slot) => {
          first = slot
        }
        await expect(h.controlWalk.stepOperation(op)).rejects.toBe(died)
        expect(first?.welcome).not.toBeNull()
        expect(first).toBeDefined()
        expect(h.hub.published).toEqual([])
        expect(h.publications).toEqual([])
        expect(h.observations.buildCompletions).toBe(0)
        expect(h.observations.ownAdoptions).toBe(0)
        expect(h.observations.welcomeDeliveries).toBe(0)
        h.groups.transition = saver
        await h.close()
        const reopened = await h.reopen()
        try {
          expect((await reopened.control.load()).commitOnce).toBeNull()
          const secondOp = await reopened.intent()
          expect(secondOp).toEqual(op)
          await reopened.controlWalk.stepOperation(secondOp)
          const second = (await reopened.control.load()).commitOnce
          expect(second).not.toBeNull()
          await reopened.controlWalk.stepOperation(await reopened.operation())
          expect(
            h.publications.some(
              (row) =>
                row.publishID === first?.publishID ||
                JSON.stringify(row.payload) === JSON.stringify(first?.payload),
            ),
          ).toBe(false)
          expect(h.observations.ownAdoptions).toBe(1)
          expect(h.observations.welcomeDeliveries).toBe(1)
        } finally {
          await reopened.close()
        }
      } finally {
        await h.close()
        await h.fixture.close()
      }
    })
    test('built-save first logical operation write rolls back with slot', async () => {
      const h = await createControlCrashHarness(mode)
      try {
        const built = await h.build()
        const before = await h.fixture.inspectRows()
        h.fixture.failNext('after-first-write')
        await expect(
          h.saveBuilt(built.intent, built.slot, built.expected, 'built'),
        ).rejects.toThrow()
        expect(await h.fixture.inspectRows()).toEqual(before)
        const reopened = await h.reopen()
        expect((await reopened.control.load()).commitOnce).toBeNull()
        expect((await reopened.control.load()).operations).toEqual([built.intent])
      } finally {
        await h.fixture.close()
      }
    })
    test('adoption rollback leaves state control and anchor unchanged', async () => {
      const h = await createControlCrashHarness(mode)
      try {
        const built = await h.build()
        await h.saveBuilt(built.intent, built.slot, built.expected, 'built')
        const proof = await h.accept(built.slot, 'accepted')
        await h.armAnchor(built.slot)
        const anchorBefore = await h.loadAnchor()
        const expected = { ...(await h.source()), acceptance: proof }
        const before = await h.fixture.inspectRows()
        h.fixture.failNext('after-first-write')
        await expect(h.adopt(expected, crashAdoptionWrite(built.slot, proof))).rejects.toThrow()
        expect(await h.fixture.inspectRows()).toEqual(before)
        const reopened = await h.reopen()
        expect((await reopened.control.load()).commitOnce).toEqual(built.slot)
        expect((await reopened.control.load()).commitOnceAcceptance).toEqual(proof)
        expect((await reopened.control.load()).applied).toEqual([])
        expect(await reopened.loadAnchor()).toEqual(anchorBefore)
      } finally {
        await h.fixture.close()
      }
    })
    test.each([
      'state-version',
      'lifetime-revision',
      'absent-lifetime',
      'spent-authenticator',
      'missing-trust',
    ] as const)(
      'control adoption preserves the provider %s guard after reconstruction',
      async (guard) => {
        const h = await createControlCrashHarness(mode)
        try {
          const built = await h.build()
          await h.saveBuilt(built.intent, built.slot, built.expected, 'built')
          await h.accept(built.slot, 'accepted')
          const restored = await h.reopen()
          const retained = await restored.control.load()
          if (retained.commitOnce === null || retained.commitOnceAcceptance === null)
            throw new Error('Missing durable accepted slot')
          const expected = {
            ...(await restored.source()),
            acceptance: retained.commitOnceAcceptance,
          }
          if (guard === 'state-version') expected.stateVersion--
          const before = await h.fixture.inspectRows()
          await expect(
            restored.adopt(
              expected,
              crashAdoptionWrite(retained.commitOnce, retained.commitOnceAcceptance),
              {
                staleLifetime: guard === 'lifetime-revision',
                absentLifetime: guard === 'absent-lifetime',
                reuseAuthenticator: guard === 'spent-authenticator',
                skipTrust: guard === 'missing-trust',
              },
            ),
          ).rejects.toThrow()
          expect(await h.fixture.inspectRows()).toEqual(before)
          expect(h.observations.ownAdoptions).toBe(0)
          expect(h.observations.handlePublications).toBe(0)
          expect((await (await h.reopen()).control.load()).commitOnce).toEqual(built.slot)
        } finally {
          await h.fixture.close()
        }
      },
    )
    test('null state retains recovery metadata and control adoption refuses same-incarnation reinstall', async () => {
      const h = await createControlCrashHarness(mode)
      try {
        const built = await h.build()
        await h.saveBuilt(built.intent, built.slot, built.expected, 'built')
        await h.accept(built.slot, 'accepted')
        const trust = await h.recoveryTrust()
        await h.losePrivateState()
        const restored = await h.reopen()
        expect(await restored.recoveryTrust()).toEqual(trust)
        const before = await h.fixture.inspectRows()
        const retained = await restored.control.load()
        if (retained.commitOnce === null || retained.commitOnceAcceptance === null)
          throw new Error('Missing durable accepted slot')
        await expect(
          restored.adopt(
            { ...(await restored.source()), acceptance: retained.commitOnceAcceptance },
            crashAdoptionWrite(retained.commitOnce, retained.commitOnceAcceptance),
          ),
        ).rejects.toThrow()
        expect(await h.fixture.inspectRows()).toEqual(before)
        expect((await restored.control.load()).commitOnce).toEqual(built.slot)
      } finally {
        await h.fixture.close()
      }
    })
    test('committed adoption reconstructs one applied row cursor and landed fact', async () => {
      const h = await createControlCrashHarness(mode)
      try {
        const built = await h.build()
        await h.saveBuilt(built.intent, built.slot, built.expected, 'built')
        const proof = await h.accept(built.slot, 'accepted')
        const write = crashAdoptionWrite(built.slot, proof)
        await h.armAnchor(built.slot)
        h.fixture.onPhase('hook', () => {
          throw new Error('process died after committed adoption')
        })
        await expect(h.adopt({ ...(await h.source()), acceptance: proof }, write)).rejects.toThrow(
          'process died after committed adoption',
        )
        const reopened = await h.reopen()
        const rows = await reopened.control.load()
        expect(rows.applied).toEqual(write.changes.putApplied)
        expect(rows.cursor).toEqual(write.changes.cursor)
        expect(rows.outcomes.filter((row) => row.kind === 'landed')).toEqual(
          write.changes.putOutcomes,
        )
        expect(rows.operations).toEqual([])
        expect(rows.commitOnce).toBeNull()
        expect(rows.commitOnceAcceptance).toBeNull()
        expect((await reopened.source()).identity?.epoch).toBe(built.slot.epoch + 1)
        expect((await reopened.loadAnchor())?.pending?.landed).toBe(true)
      } finally {
        await h.fixture.close()
      }
    })
    for (const stage of ['built', 'accepted', 'adoption'] as const) {
      test(`control transition proof conflict fail-stops before publication Welcome or hooks (${stage})`, async () => {
        const evidence = await runControlProofConflict(mode, stage)
        expect(evidence.publicationsBeforeProof).toBe(0)
        expect(evidence.payloads).toEqual([])
        expect(evidence.ownAdoptions).toBe(0)
        expect(evidence.welcomeDeliveries).toBe(0)
      })
    }
    for (const stage of ['built', 'accepted', 'adoption'] as const) {
      for (const completion of ['commit', 'rollback'] as const) {
        test(`ambiguous built accepted and adoption saves release no bytes before proof (${stage}, ${completion})`, async () => {
          const h = await createControlCrashHarness(mode)
          let fault: ReturnType<typeof h.fixture.rejectCommitPending> | undefined
          let finished = false
          try {
            await h.peer.resync()
            const op = await h.intent()
            if (stage !== 'built') await h.controlWalk.stepOperation(op)
            const built = (await h.control.load()).commitOnce
            if (stage !== 'built') {
              if (built === null) throw new Error('Missing saved slot')
              await h.hub.publish({
                senderDID: h.localDID,
                topicID: await h.topic(),
                payload: built.payload,
                publishID: built.publishID,
                retain: 'log',
              })
            }
            let before = await h.fixture.inspectRows()
            const baseline = h.publications.length
            const started =
              Promise.withResolvers<ReturnType<typeof h.fixture.rejectCommitPending>>()
            const hooks: Array<string> = []
            h.armFault(
              stage,
              async () => {
                before = await h.fixture.inspectRows()
                started.resolve(h.fixture.rejectCommitPending())
              },
              () => {
                hooks.push('commit')
              },
            )
            const action = h.controlWalk.stepOperation(await h.operation()).then(
              (value) => ({ ok: true as const, value }),
              (error: unknown) => ({ ok: false as const, error }),
            )
            fault = await started.promise
            await fault.rejected
            await fault.barrierWaiting
            expect(h.publications).toHaveLength(baseline)
            expect(h.observations.buildCompletions).toBe(stage === 'built' ? 0 : 1)
            expect(h.observations.handlePublications).toBe(0)
            expect(h.observations.ownAdoptions).toBe(0)
            expect(h.observations.welcomeDeliveries).toBe(0)
            expect(hooks).toEqual([])
            expect(await h.fixture.inspectRows()).toEqual(before)
            await fault.finish(completion)
            finished = true
            const settled = await action
            // A rollback cannot release the candidate, even if preparation retries.
            if (completion === 'rollback' && stage !== 'built') expect(settled.ok).toBe(false)
            if (completion === 'commit') {
              expect(settled.ok).toBe(true)
              if (stage === 'built') await h.controlWalk.stepOperation(await h.operation())
              expect(h.observations.ownAdoptions).toBe(1)
              expect(h.observations.welcomeDeliveries).toBe(1)
            }
            await h.close()
            const reopened = await h.reopen()
            try {
              const saved = await reopened.control.load()
              if (completion === 'commit') {
                expect(saved.applied).toHaveLength(1)
                expect(saved.commitOnce).toBeNull()
              } else if (stage !== 'built') {
                expect(saved.commitOnce).toEqual(built)
                expect(saved.applied).toEqual([])
                expect(h.observations.ownAdoptions).toBe(0)
                expect(h.observations.welcomeDeliveries).toBe(0)
              }
            } finally {
              await reopened.close()
            }
          } finally {
            if (!finished) await fault?.finish('rollback')
            await h.close()
            await h.fixture.close()
          }
        })
      }
    }
  })
}
