import { forkEventID, GroupSafetyHeldError, type SafetyHold } from '@kumiai/rpc'
import { describe, expect, test } from 'vitest'

import { createCheckpointService } from '../src/checkpoint.js'
import { createGroupCrypto } from '../src/crypto.js'
import { createLedgerEntrySlot } from '../src/mls.js'
import { registryConsumers } from '../src/registry/consumers.js'
import { createRegistrySafetyLatch } from '../src/registry/runtime.js'
import { registrySafety } from '../src/registry/safety.js'
import { createRegistryGroupMLS } from '../src/registry-group-mls.js'
import { createRegistryHandleAccess } from '../src/registry-handle-access.js'
import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'
import { createRegistryFixture, type RegistryFixture } from './fixtures/registry.js'

for (const mode of ['real-mls', 'double'] as const) {
  for (const context of ['supplied', 'absent'] as const) {
    describe(`live hold release / ${mode} / ownership context ${context}`, () => {
      const key = { groupID: `live-release-${mode}-${context}`, incarnation: 1 }
      async function run(work: (f: RegistryFixture) => Promise<void>) {
        const f = await createRegistryFixture({
          mode,
          groupID: key.groupID,
          setup: 'seeded',
          ownershipContext: context === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
        })
        try {
          await work(f)
        } finally {
          await f.close()
        }
      }
      async function report(f: RegistryFixture) {
        await f.safety().reportFork(key, {
          kind: 'unexplained-own-commit',
          epoch: 0,
          position: '1',
          digest: 'app-observation',
        })
      }
      const consumers = (f: RegistryFixture) =>
        registryConsumers({ registry: f.registry, persistence: f.device.groups })

      test('clear app halt resumes ordinary walk', () =>
        run(async (f) => {
          const access = await f.registry.access(key.groupID)
          const before = access.admission()
          const changed: Array<SafetyHold> = []
          const held: Array<SafetyHold> = []
          consumers(f).onSafetyChanged(key, (reason) => changed.push(reason))
          consumers(f).onSafetyHold(key, (reason) => held.push(reason))
          await report(f)
          expect(access.admission()).toMatchObject({ admissible: false, reason: 'fork-halted' })
          await f.safety().clearHold(key)
          expect(access.admission()).toEqual(before)
          expect((await f.safety().status(key)).hold).toBeNull()
          expect(changed).toEqual(['fork-halted', null])
          expect(held).toEqual(['fork-halted'])
          const work = await f.acceptedOrdinary(access, { accepted: true })
          await access.adopt(work.candidate, work.expected, work.write)
          expect(access.admission().epoch).toBe(before.epoch + 1)
        }))

      test('clear before proof leaves every live lane closed', () =>
        run(async (f) => {
          const access = await f.registry.access(key.groupID)
          const cryptoPort = createGroupCrypto({
            access: {
              ...createRegistryHandleAccess({ access }),
              open: async () => {
                throw new Error('Held opens must not reach storage')
              },
            },
          })
          const { sealed } = await cryptoPort.sealEntries(new Uint8Array([1]))
          const changed: Array<SafetyHold> = []
          consumers(f).onSafetyChanged(key, (reason) => changed.push(reason))
          await report(f)
          const fault = f.armNextWorkFault('commit-then-reject')
          const pending = f.safety().clearHold(key)
          const proof = f.holdProof(await fault.mutationID)
          try {
            await proof.started
            expect(access.admission()).toMatchObject({ admissible: false, reason: 'fork-halted' })
            await expect(cryptoPort.openEntries(sealed)).rejects.toBeInstanceOf(
              GroupSafetyHeldError,
            )
            await expect(cryptoPort.unwrap(new Uint8Array())).rejects.toBeInstanceOf(
              GroupSafetyHeldError,
            )
            expect(changed).toEqual(['fork-halted'])
          } finally {
            proof.release()
          }
          await pending
          expect(access.admission().admissible).toBe(true)
          expect(changed).toEqual(['fork-halted', null])
        }))

      test('clear cannot erase a newer internal latch', () =>
        run(async (f) => {
          await f.registry.access(key.groupID)
          await report(f)
          const fault = f.armNextWorkFault('commit-then-reject')
          const pending = f.safety().clearHold(key)
          const proof = f.holdProof(await fault.mutationID)
          try {
            await proof.started
            registrySafety(f.registry)?.latch(key, 'fork-halted')
          } finally {
            proof.release()
          }
          await pending
          const internalHoldAfterAppClear = (await f.safety().status(key)).hold
          expect(internalHoldAfterAppClear).not.toBeNull()
          expect((await f.registry.access(key.groupID)).admission()).toMatchObject({
            reason: 'fork-halted',
          })
        }))

      test('clear recomputes admission from a remaining volatile diagnosis', () =>
        run(async (f) => {
          const access = await f.registry.access(key.groupID)
          await report(f)
          registrySafety(f.registry)?.latch(key, 'recovery-unavailable')
          await f.safety().clearHold(key)
          expect((await f.safety().status(key)).hold).toBe('recovery-unavailable')
          expect(access.admission()).toMatchObject({ reason: 'recovery-unavailable' })
        }))

      test('legacy halt stays held live and after restart', () =>
        run(async (f) => {
          const legacy = {
            eventID: forkEventID(key),
            detectedAt: 42,
            evidence: {
              kind: 'unexplained-own-commit' as const,
              epoch: 0,
              position: '1',
              digest: 'legacy',
            },
          }
          await f.installRows({ key, control: { forkHalt: legacy } })
          const access = await f.registry.access(key.groupID)
          const changed: Array<SafetyHold> = []
          consumers(f).onSafetyChanged(key, (reason) => changed.push(reason))
          await f.safety().clearHold(key)
          expect(changed).toEqual(['fork-halted'])
          expect(access.admission()).toMatchObject({ reason: 'fork-halted' })
          const reopened = await f.reopen()
          try {
            await reopened.safety().clearHold(key)
            expect((await reopened.safety().status(key)).hold).toBe('fork-halted')
            expect((await reopened.device.groups.ports(key).control.load()).forkHalt).toEqual(
              legacy,
            )
          } finally {
            await reopened.close()
          }
        }))

      test('an unproven trust diagnosis preserves the existing internal hold', () =>
        run(async (f) => {
          await f.installRows({
            key,
            control: {
              forkHalt: {
                producer: 'internal',
                eventID: forkEventID(key),
                detectedAt: 42,
                evidence: {
                  kind: 'unexplained-own-commit',
                  epoch: 0,
                  position: '1',
                  digest: 'internal',
                },
              },
            },
          })
          const reopened = await f.reopen()
          try {
            await reopened.corruptTrust(key.groupID)
            const fault = reopened.armNextWorkFault('pending')
            const pending = reopened.registry
              .recoverySource(key.groupID)
              .catch((error: unknown) => error)
            try {
              await fault.rejected
              expect(consumers(reopened).safetyHold(key)).toBe('fork-halted')
            } finally {
              await fault.finish('rollback')
            }
            await pending
          } finally {
            await reopened.close()
          }
        }))

      test('unchanged heartbeat replay does not affect holds', () =>
        run(async (f) => {
          const service = createCheckpointService({
            registry: f.registry,
            key,
            identity: f.identity,
          })
          const fact = (await service.readRecords()).find((row) => row.kind === 'fact')
          if (fact?.kind !== 'fact') throw new Error('Missing checkpoint fact')
          await service.signInstalled(fact.id)
          const [frame] = await service.exportCheckpoints(key, [fact.epoch])
          if (frame === undefined) throw new Error('Missing signed checkpoint')
          await report(f)
          const changed: Array<SafetyHold> = []
          consumers(f).onSafetyChanged(key, (reason) => changed.push(reason))
          await service.importCheckpoint(key, frame)
          await service.importCheckpoint(key, frame)
          expect((await f.safety().status(key)).hold).toBe('fork-halted')
          expect(changed).toEqual(['fork-halted'])
        }))

      if (mode === 'real-mls')
        test('nullable port subscription refreshes synchronous admission', () =>
          run(async (f) => {
            const mls = await createRegistryGroupMLS({
              registry: f.registry,
              key,
              identity: f.identity,
              recovery: f.environment,
              target: { targetID: 'live-hub', topicID: 'live-commits' },
              entrySlot: createLedgerEntrySlot(),
            })
            await report(f)
            expect(mls.sendAdmission()).toMatchObject({ reason: 'fork-halted' })
            const changed: Array<SafetyHold> = []
            mls.onSafetyChanged?.((reason) => changed.push(reason))
            await f.safety().clearHold(key)
            expect(mls.sendAdmission().admissible).toBe(true)
            expect(changed).toEqual(['fork-halted', null])
          }))
    })
  }
}

test('release proof belongs to the captured app incident even for identical reports', () => {
  const latch = createRegistrySafetyLatch()
  const halt = {
    producer: 'app-report' as const,
    eventID: 'repeated-report',
    detectedAt: 42,
    evidence: { kind: 'unexplained-own-commit' as const, epoch: 0, position: '1', digest: 'same' },
  }
  latch.report(halt, true)
  const observedRelease = latch.prepareRelease(halt)
  latch.report(halt)
  observedRelease()
  expect(latch.held()).toBeNull()
  latch.report(halt, true)
  const release = latch.prepareRelease(halt)
  latch.report(halt, true)
  release()
  expect(latch.held()).toBe('fork-halted')
  latch.prepareRelease(halt)()
  expect(latch.held()).toBeNull()
})
