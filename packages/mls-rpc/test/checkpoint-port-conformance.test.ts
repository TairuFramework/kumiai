import { type OwnIdentity, randomIdentity } from '@kokuin/token'
import {
  checkpointKeyHash,
  checkpointSignatureInput,
  decodeClientState,
  decodeEpochCheckpoint,
  decodeEpochRosterFact,
  encodeClientState,
  encodeEpochCheckpoint,
  restoreGroup,
} from '@kumiai/mls'
import type { CheckpointPort } from '@kumiai/rpc'
import type { ConformanceCheckpointPort } from '@kumiai/rpc-conformance'
import {
  malformedCheckpointBodies,
  testCheckpointCacheConformance,
  testCheckpointComparisonConformance,
  testCheckpointCoverageConformance,
  testCheckpointPortConformance,
} from '@kumiai/rpc-conformance'
import { ed25519 } from '@noble/curves/ed25519.js'
import { toB64U } from '@sozai/codec'
import { describe, expect, test } from 'vitest'

import { createCheckpointPort } from '../src/checkpoint.js'
import { prepareCheckpointInstallation } from '../src/checkpoint-capture.js'
import { entryCapability } from '../src/entry-capability.js'
import { createGroupHandleRegistry } from '../src/registry/registry.js'
import { recoveryTrustFor } from '../src/registry/trust.js'
import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'
import { buildRealCommit, createRealGroup } from './fixtures/real-group.js'
import { createRegistryFixture } from './fixtures/registry.js'
import { registryHandle } from './fixtures/registry-welcome.js'
import { independentCheckpointFrame } from './fixtures/sealed-memory-mls.js'
import { createStorageFixture } from './fixtures/storage-persistence.js'
import { installSeed, makeStorageSeed, nextChange } from './fixtures/storage-seed.js'

const _checkpointIsAPort = (port: CheckpointPort): ConformanceCheckpointPort => port
const _checkpointCoversPort = (port: ConformanceCheckpointPort): CheckpointPort => port

for (const mode of ['real-mls', 'double'] as const) {
  for (const ownership of ['supplied', 'absent'] as const) {
    const groupID = `checkpoint-port-${mode}-${ownership}`
    async function setup(identity?: OwnIdentity) {
      const fixture = await createRegistryFixture({
        groupID,
        mode,
        setup: 'empty',
        identity,
        ownershipContext: ownership === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
      })
      const key = await fixture.registry.seed(await fixture.makeHandle(0), { packageUse: null })
      const entry = entryCapability(fixture.device.groups)
      if (entry === null) throw new Error('Missing coordinator')
      const records = () => entry.read(groupID, (reads) => reads.checkpoints())
      const installed = async () => {
        const rows = await records()
        const coverage = rows.find((row) => row.kind === 'coverage')
        const id = coverage?.kind === 'coverage' ? coverage.installations.at(-1)?.id : undefined
        const fact = rows.find((row) => row.kind === 'fact' && row.id === id)
        if (fact?.kind !== 'fact') throw new Error('Missing installation')
        return fact
      }
      const port = createCheckpointPort({
        registry: fixture.registry,
        key,
        identity: fixture.identity,
      })
      return { fixture, key, port, records, installed }
    }
    testCheckpointPortConformance({
      label: `${mode}, ${ownership} ownership context`,
      createFixture: async () => {
        const { fixture, key, port, records, installed } = await setup()
        return {
          key,
          port,
          installed,
          async advance() {
            const access = await fixture.registry.access(groupID)
            const accepted = await fixture.acceptedOrdinary(access)
            await access.adopt(accepted.candidate, accepted.expected, accepted.write)
          },
          async generations() {
            const access = await fixture.registry.access(groupID)
            return access.read((handle) => ({
              version: access.stateVersion(),
              epoch: handle.epoch,
              state: encodeClientState(handle.state),
              runtime: access.runtime.snapshot(),
            }))
          },
          async unproven(kind) {
            const fact = await installed()
            const forged = {
              ...fact,
              id: `unproven-${kind}`,
              key: kind === 'foreign-key' ? { ...key, groupID: 'foreign' } : key,
            }
            if (kind === 'foreign-key') {
              const other = await fixture.registry.seed(await fixture.makeHandle(0, 'foreign'), {
                packageUse: null,
              })
              const foreign = await entryCapability(fixture.device.groups)?.read(
                other.groupID,
                (reads) => reads.checkpoints(),
              )
              const row = foreign?.find((row) => row.kind === 'fact')
              if (row === undefined) throw new Error('Missing foreign fact')
              return row.id
            }
            if (kind === 'fabricated-fact') {
              await fixture.device.groups.transition(
                await nextChange(fixture.device.groups, groupID, crypto.randomUUID()),
                async (stores) => {
                  await stores.checkpoints.put(forged)
                  await stores.checkpoints.put({
                    kind: 'publication',
                    id: `publication:${forged.id}`,
                    key,
                    factID: forged.id,
                    frame: null,
                    publishID: null,
                    accepted: false,
                    nextHeartbeatAt: null,
                  })
                },
              )
            }
            if (kind === 'speculative' || kind === 'rolled-back') {
              const access = await fixture.registry.access(groupID)
              const accepted = await fixture.acceptedOrdinary(access, {
                accepted: kind === 'rolled-back',
              })
              const candidateFact = await prepareCheckpointInstallation({
                key,
                handle: accepted.candidate,
                mutationID: accepted.write.mutationID,
                stateVersion: accepted.expected.stateVersion + 1,
                previousFact: fact.canonical,
              })
              if (kind === 'rolled-back') {
                fixture.armWorkFault(accepted.write.mutationID, 'before-commit')
                await expect(
                  access.adopt(accepted.candidate, accepted.expected, accepted.write),
                ).rejects.toThrow()
              }
              expect((await records()).filter((row) => row.kind === 'fact')).toHaveLength(1)
              return candidateFact.id
            }
            return forged.id
          },
          async retire() {
            const recovery = await fixture.confirmedRecovery(key, { confirm: true })
            if (!('format' in recovery.record) || recovery.record.switchMutationID === null)
              throw new Error('Missing switch')
            const destination = await fixture.registry.switchIncarnation(recovery.candidate, {
              source: recovery.source,
              rejoinID: recovery.record.id,
              proof: recovery.proof,
              write: {
                mutationID: recovery.record.switchMutationID,
                source: { rejoinID: recovery.record.id },
                destination: {
                  control: {
                    cursor: {
                      position: recovery.proof.position,
                      epoch: Number(recovery.candidate.epoch),
                    },
                  },
                },
              },
            })
            const replacement = createCheckpointPort({
              registry: fixture.registry,
              key: destination,
              identity: fixture.identity,
            })
            const rows = await records()
            const next = rows.find(
              (row) => row.kind === 'fact' && row.key.incarnation === destination.incarnation,
            )
            if (next === undefined) throw new Error('Missing replacement fact')
            expect(await replacement.signInstalled(next.id)).not.toBeNull()
            const previous = rows.find(
              (row) => row.kind === 'fact' && row.key.incarnation === key.incarnation,
            )
            if (previous === undefined) throw new Error('Missing source fact')
            expect(await replacement.signInstalled(previous.id)).toBeNull()
            await expect(port.signInstalled(next.id)).rejects.toThrow()
          },
          decodeEpoch: (frame) => decodeEpochCheckpoint(frame).body.epoch,
          close: fixture.close,
        }
      },
    })
    testCheckpointCacheConformance({
      label: `${mode}, ${ownership} ownership context`,
      createFixture: async () => {
        const real = await createRealGroup(1, `${groupID}-cached-signers`)
        const local = real.members[0]
        if (local === undefined) throw new Error('Missing local member')
        const fixture = await createRegistryFixture({
          groupID: local.handle.groupID,
          mode,
          setup: 'empty',
          identity: local.identity,
          options: { resolveLedgerEntries: real.resolveLedgerEntries },
          ownershipContext:
            ownership === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
        })
        const handle = await registryHandle({
          mode,
          options: fixture.environment.options,
          handle: await restoreGroup({
            state: local.handle.state,
            credential: local.handle.credential,
            ledgerEntries: local.handle.ledgerTokens,
            options: fixture.environment.options,
          }),
        })
        const key = await fixture.registry.seed(handle, {
          packageUse: { sourceID: 'cached-signers', ref: 'local-package', kind: 'ordinary' },
        })
        const port = createCheckpointPort({
          registry: fixture.registry,
          key,
          identity: fixture.identity,
        })
        const entry = entryCapability(fixture.device.groups)
        if (entry === null) throw new Error('Missing coordinator')
        const records = () => entry.read(key.groupID, (reads) => reads.checkpoints())
        return {
          port,
          key,
          async installed() {
            const rows = await records()
            const coverage = rows.find((row) => row.kind === 'coverage')
            const id = coverage?.kind === 'coverage' ? coverage.installations.at(-1)?.id : undefined
            const fact = rows.find((row) => row.kind === 'fact' && row.id === id)
            if (fact?.kind !== 'fact') throw new Error('Missing installation')
            return fact
          },
          async advance() {
            const access = await fixture.registry.access(key.groupID)
            const accepted = await fixture.acceptedOrdinary(access)
            await access.adopt(accepted.candidate, accepted.expected, accepted.write)
          },
          async saveFrame(factID, frame) {
            const debt = (await records()).find(
              (row) => row.kind === 'publication' && row.factID === factID,
            )
            if (debt?.kind !== 'publication') throw new Error('Missing publication')
            await fixture.device.groups.transition(
              await nextChange(fixture.device.groups, key.groupID, crypto.randomUUID()),
              (stores) => stores.checkpoints.put({ ...debt, frame }),
            )
          },
          signBody: (body, otherSigner) =>
            independentCheckpointFrame(
              body,
              (otherSigner ? real.committer.identity : fixture.identity).privateKey,
            ),
          otherKeyHash: checkpointKeyHash(real.committer.identity.publicKey),
          close: fixture.close,
        }
      },
    })
    testCheckpointCoverageConformance({
      label: `${mode}, ${ownership}`,
      createFixture: async () => {
        const identity = randomIdentity()
        const groupID = `coverage-${mode}-${ownership}`
        const fixture = await createStorageFixture({
          id: groupID,
          mode,
          setup: 'empty',
          identity,
          ownershipContext:
            ownership === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
        })
        const seed = await makeStorageSeed({
          id: groupID,
          mode,
          incarnation: 1,
          epoch: 3,
          identity,
        })
        const client = seed.state.state === null ? undefined : decodeClientState(seed.state.state)
        if (client === undefined) throw new Error('Missing client state')
        function registry() {
          return createGroupHandleRegistry({
            persistence: fixture.ports.device,
            providerID: fixture.ports.device.providerID,
            recovery: { identity, options: {} },
            restore: async () => {
              throw new Error('Coverage must not restore private state')
            },
            restoreCandidate: async () => {
              throw new Error('Coverage must not restore candidates')
            },
          })
        }
        let owner = registry()
        let port = createCheckpointPort({ registry: owner, key: seed.key, identity })
        return {
          groupID,
          port: () => port,
          async install(incarnation, epoch) {
            seed.key.incarnation =
              seed.state.incarnation =
              seed.trust.installed.incarnation =
                incarnation
            seed.lifetime.activeIncarnation = seed.lifetime.latestIncarnation = incarnation
            seed.state.version =
              (await fixture.ports.device.groups.loadState({ groupID, incarnation }))?.version ?? 0
            seed.state.version++
            seed.state.epoch = seed.trust.installed.epoch = epoch
            client.groupContext.epoch = BigInt(epoch)
            client.keySchedule.epochAuthenticator = crypto.getRandomValues(new Uint8Array(32))
            seed.state.epochAuthenticator = seed.trust.installed.authenticator =
              client.keySchedule.epochAuthenticator
            seed.state.state = encodeClientState(client)
            seed.trust.spentEpochAuthenticators =
              (await fixture.ports.device.groups.loadTrust(groupID))?.spentEpochAuthenticators ?? []
            await installSeed(fixture.ports.device.groups, seed, crypto.randomUUID())
          },
          async restart() {
            await owner.dispose()
            await fixture.reopen()
            owner = registry()
            port = createCheckpointPort({ registry: owner, key: seed.key, identity })
          },
          async prune() {
            const groups = fixture.ports.device.groups
            await groups.transition(
              await nextChange(groups, groupID, crypto.randomUUID()),
              async () => {},
            )
          },
          async close() {
            await owner.dispose()
            await fixture.close()
          },
        }
      },
    })
    testCheckpointComparisonConformance({
      label: `${mode}, ${ownership}`,
      createFixture: async () => {
        const real = await createRealGroup(2, `${groupID}-divergent`)
        const local = real.members[0]
        const remote = real.members[1]
        if (local === undefined || remote === undefined) throw new Error('Missing real members')
        const fixture = await createRegistryFixture({
          groupID: local.handle.groupID,
          mode,
          setup: 'empty',
          identity: local.identity,
          options: { resolveLedgerEntries: real.resolveLedgerEntries },
          ownershipContext:
            ownership === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
        })
        const key = await fixture.registry.seed(
          await registryHandle({
            mode,
            handle: await restoreGroup({
              state: local.handle.state,
              credential: local.handle.credential,
              ledgerEntries: local.handle.ledgerTokens,
              options: fixture.environment.options,
            }),
            options: fixture.environment.options,
          }),
          { packageUse: { sourceID: 'comparison', ref: 'local-package', kind: 'ordinary' } },
        )
        const port = createCheckpointPort({
          registry: fixture.registry,
          key,
          identity: fixture.identity,
        })
        const before = await fixture.device.groups.loadState(key)
        if (before === null || before.deleted) throw new Error('Missing installed state')
        const commit = await buildRealCommit(real, { removes: 1 })
        await local.handle.processMessage(commit)
        const handle = await registryHandle({
          mode,
          handle: await restoreGroup({
            state: local.handle.state,
            credential: local.handle.credential,
            ledgerEntries: local.handle.ledgerTokens,
            options: fixture.environment.options,
          }),
          options: fixture.environment.options,
        })
        await fixture.installRows({
          key,
          state: {
            ...before,
            version: before.version + 1,
            epoch: Number(handle.epoch),
            state: encodeClientState(handle.state),
            epochAuthenticator: handle.state.keySchedule.epochAuthenticator.slice(),
            ledger: handle.ledgerTokens,
          },
          trust: recoveryTrustFor(handle, key, await fixture.device.groups.loadTrust(key.groupID)),
        })
        const factBytes = await port.checkpointFact(key, Number(handle.epoch))
        if (factBytes === null) throw new Error('Missing divergent fact')
        const fact = decodeEpochRosterFact(factBytes)
        expect(fact.members.some((member) => member.signerDID === remote.identity.id)).toBe(false)
        const body = {
          v: 1 as const,
          type: 'kumiai/checkpoint/v1' as const,
          groupID: key.groupID,
          genesisHash: fact.genesisHash,
          ciphersuite: fact.ciphersuite,
          epoch: fact.epoch,
          authHash: toB64U(crypto.getRandomValues(new Uint8Array(32))),
          parentAuthHash: fact.parentAuthHash,
          keyHash: checkpointKeyHash(remote.identity.publicKey),
          leafIndex: 123,
        }
        const sign = (value: typeof body, identity = remote.identity) =>
          encodeEpochCheckpoint(
            value,
            ed25519.sign(checkpointSignatureInput(value), identity.privateKey),
          )
        const other = randomIdentity()
        return {
          port,
          key,
          malformedFrames: malformedCheckpointBodies(body).map((body) =>
            independentCheckpointFrame(body, remote.identity.privateKey),
          ),
          sharedRosterDID: remote.identity.id,
          frame: sign(body),
          wrongKeyFrame: sign({ ...body, keyHash: checkpointKeyHash(other.publicKey) }, other),
          wrongBindingFrame: sign({ ...body, genesisHash: toB64U(new Uint8Array(32).fill(9)) }),
          close: fixture.close,
        }
      },
    })
    describe(`checkpoint binding (${mode}, ${ownership})`, () => {
      test('signing persists exact frame and ID only after proof outside provider work', async () => {
        const own = randomIdentity()
        let keyReads = 0
        const identity = {
          ...own,
          get privateKey() {
            keyReads++
            return own.privateKey
          },
        }
        const { fixture, port, installed, records } = await setup(identity)
        const fact = await installed()
        const before = await records()
        keyReads = 0
        let inWork = false
        fixture.onPhase('work', () => {
          inWork = true
          expect(keyReads).toBe(1)
        })
        const pending = fixture.armNextWorkFault('pending')
        let released = false
        const signing = port.signInstalled(fact.id).then(
          (value) => {
            released = true
            return value
          },
          (error: unknown) => {
            released = true
            return error
          },
        )
        try {
          await pending.rejected
          expect(inWork).toBe(true)
          expect(released).toBe(false)
          await pending.finish('rollback')
          expect(await signing).toBeInstanceOf(Error)
          expect(await records()).toEqual(before)
        } finally {
          await fixture.close()
        }
      })
      test('saved frames and publication IDs survive restart', async () => {
        const setupResult = await setup()
        let fixture = setupResult.fixture
        try {
          const fact = await setupResult.installed()
          const frame = await setupResult.port.signInstalled(fact.id)
          const rows = await setupResult.records()
          const publication = rows.find(
            (row) => row.kind === 'publication' && row.factID === fact.id,
          )
          expect(publication).toMatchObject({ frame, publishID: expect.any(String) })
          fixture = await fixture.reopen()
          const port = createCheckpointPort({
            registry: fixture.registry,
            key: setupResult.key,
            identity: fixture.identity,
          })
          expect(await port.signInstalled(fact.id)).toEqual(frame)
          const entry = entryCapability(fixture.device.groups)
          expect(await entry?.read(groupID, (reads) => reads.checkpoints())).toEqual(rows)
          await expect(setupResult.port.signInstalled(fact.id)).rejects.toThrow()
        } finally {
          await fixture.close()
        }
      })
      test('copied and unregistered registries refuse construction', async () => {
        const { fixture, key } = await setup()
        try {
          expect(() =>
            createCheckpointPort({
              registry: { ...fixture.registry },
              key,
              identity: fixture.identity,
            }),
          ).toThrow()
          expect(() =>
            createCheckpointPort({ registry: fixture.registry, key, identity: randomIdentity() }),
          ).toThrow()
          await fixture.registry.dispose()
          expect(() =>
            createCheckpointPort({ registry: fixture.registry, key, identity: fixture.identity }),
          ).toThrow()
        } finally {
          await fixture.close()
        }
      })
      test('comparison cannot request signing', async () => {
        const own = randomIdentity()
        let keyReads = 0
        const identity = {
          ...own,
          get privateKey() {
            keyReads++
            return own.privateKey
          },
        }
        const { fixture, key, port, installed, records } = await setup(identity)
        try {
          const fact = await installed()
          const before = await records()
          keyReads = 0
          expect(await port.compare(key, new Uint8Array([0]))).toEqual({ kind: 'invalid' })
          expect(await records()).toEqual(before)
          expect(keyReads).toBe(0)
          const frame = await port.signInstalled(fact.id)
          if (frame === null) throw new Error('Missing frame')
          keyReads = 0
          expect(await port.compare(key, frame)).toMatchObject({
            kind: 'agreement',
            signerDID: fixture.identity.id,
          })
          expect(keyReads).toBe(0)
          expect(await port.checkpointCoverage(groupID)).toMatchObject({
            effectiveFloor: 0,
            gaps: [],
            current: { key, epoch: 0 },
          })
          expect(
            decodeEpochRosterFact((await port.checkpointFact(key, 0)) ?? new Uint8Array()).epoch,
          ).toBe(0)
        } finally {
          await fixture.close()
        }
      })
    })
  }
}
