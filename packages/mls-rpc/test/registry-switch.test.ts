import { randomIdentity } from '@kokuin/token'
import {
  commitInvite,
  commitKeyRotation,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  encodeClientState,
  processWelcome,
  signLedgerEntry,
} from '@kumiai/mls'
import {
  APP_TOPIC_LABEL,
  asLogPosition,
  type CapturedRejoinRecord,
  type ControlChanges,
} from '@kumiai/rpc'
import { describe, expect, test, vi } from 'vitest'

import { entryCapability } from '../src/entry-capability.js'
import {
  decodeCapturedRecoveryCandidate,
  decodeRecoveryCandidate,
  encodeRecoveryCandidate,
} from '../src/recovery-codec.js'
import { recoveryTrustDigest } from '../src/recovery-trust-digest.js'
import { createRecoveryContinuationPort } from '../src/registry/continuation.js'
import { createGroupHandleRegistry } from '../src/registry/registry.js'
import { recoveryTrustFor } from '../src/registry/trust.js'
import type { RegistrySwitchWrite } from '../src/registry/types.js'
import { deferred } from '../src/runtime.js'
import {
  createRegistryFixture,
  type RegistryFixtureBase,
  registryFixtureCapturedRecovery,
  registryFixtureRestore,
  registryFixtureRetirement,
} from './fixtures/registry.js'
import { createRegistryRecovery } from './fixtures/registry-recovery.js'
import { registryHandle } from './fixtures/registry-welcome.js'
import { nextChange } from './fixtures/storage-seed.js'

const groupID = 'registry-switch'
const key = { groupID, incarnation: 1 }
const destination = { groupID, incarnation: 2 }
const utf8 = (value: string) => new TextEncoder().encode(value)

function registry(fixture: RegistryFixtureBase) {
  return createGroupHandleRegistry({
    persistence: fixture.device,
    providerID: fixture.device.providerID,
    recovery: fixture.environment,
    restore: registryFixtureRestore(fixture),
    restoreCandidate: async () => {
      throw new Error('Switch must not restore a candidate')
    },
  })
}

for (const mode of ['real-mls', 'double'] as const) {
  describe(`incarnation switch -- ${mode}`, () => {
    async function setup(extra?: ControlChanges) {
      const fixture = await createRegistryFixture({ mode, setup: 'seeded', groupID })
      if (extra !== undefined) await fixture.installRows({ key, control: extra })
      const recovery = await fixture.confirmedRecovery(key, { confirm: true, format: 'legacy' })
      const owner = registry(fixture)
      const access = await owner.access(groupID)
      let hooks = 0
      access.onRetire(async () => {
        hooks++
      })
      const write: RegistrySwitchWrite = {
        mutationID: crypto.randomUUID(),
        source: { rejoinID: recovery.record.id },
        destination: {
          control: {
            cursor: {
              position: recovery.proof.position,
              epoch: Number(recovery.candidate.epoch),
            },
          },
        },
      }
      const params = {
        source: recovery.source,
        rejoinID: recovery.record.id,
        proof: recovery.proof,
        write,
      }
      return { fixture, owner, access, recovery, params, hooks: () => hooks }
    }
    type Setup = Awaited<ReturnType<typeof setup>>
    const run = (s: Setup) => s.owner.switchIncarnation(s.recovery.candidate, s.params)
    async function unchanged(s: Setup, name?: string) {
      const before = await s.fixture.inspectRows()
      const call = expect(run(s)).rejects
      if (name === undefined) await call.toThrow()
      else await call.toMatchObject({ name })
      expect(await s.fixture.inspectRows()).toEqual(before)
      expect(await s.access.read((handle) => handle.groupID)).toBe(groupID)
    }

    test.each(['legacy', 'captured'] as const)(
      '%s fixture preserves origin and exact bytes through a confirmed switch',
      async (format) => {
        const fixture = await createRegistryFixture({ mode, setup: 'seeded', groupID })
        try {
          const stored = await fixture.device.groups.loadState(key)
          if (stored === null || stored.deleted) throw new Error('Missing fixture source')
          const recovery =
            format === 'captured'
              ? await registryFixtureCapturedRecovery(fixture, key, { confirm: true })
              : await fixture.confirmedRecovery(key, { confirm: true, format: 'legacy' })
          const before = structuredClone(recovery.record)
          if ('format' in recovery.record) {
            expect(recovery.record.source.identity?.epoch).toBe(stored.epoch)
            expect(recovery.record.source.stateVersion).toBe(stored.version)
            const snapshot = decodeCapturedRecoveryCandidate(
              recovery.record.candidate,
              recovery.record.requestKey,
            )
            expect(snapshot.source).toEqual(recovery.record.source)
            expect(snapshot.target).toEqual(recovery.record.target)
            expect(snapshot.attestedReply.length).toBeGreaterThan(0)
            expect(recovery.record.expectedHead).toBe(recovery.record.captureHead)
            expect(recovery.record.searchFrom).toBe(recovery.record.captureHead)
          } else {
            expect(recovery.record.source.epoch).toBe(stored.epoch)
          }
          const owner = registry(fixture)
          if ('format' in recovery.record && recovery.record.switchMutationID === null)
            throw new Error('Missing switch ID')
          await owner.switchIncarnation(recovery.candidate, {
            source: recovery.source,
            rejoinID: recovery.record.id,
            proof: recovery.proof,
            write: {
              mutationID:
                'format' in recovery.record && recovery.record.switchMutationID !== null
                  ? recovery.record.switchMutationID
                  : crypto.randomUUID(),
              source: { rejoinID: recovery.record.id },
              destination: {
                control: {
                  cursor: { position: recovery.proof.position, epoch: recovery.record.epochAfter },
                },
              },
            },
          })
          expect((await fixture.device.groups.ports(key).control.load()).rejoin).toEqual({
            ...before,
            stage: 'adopted',
            ...('format' in before ? { destinationKey: destination } : {}),
          })
          const installed = await fixture.device.groups.loadState(destination)
          if (installed === null || installed.deleted) throw new Error('Missing destination')
          expect(installed.epoch).toBe(before.epochAfter)
          expect(before.epochAfter).toBeGreaterThan(stored.epoch)
          expect(recovery.record).toEqual(before)
        } finally {
          await fixture.close()
        }
      },
    )

    test.each(['confirmed', 'adopted', 'after-drain', 'work'] as const)(
      'malformed captured switch record is retained on refusal or movement: %s',
      async (phase) => {
        const s = await setup()
        try {
          const { source: _source, ...common } = s.recovery.record
          Reflect.deleteProperty(common, 'conflictEpoch')
          const record: CapturedRejoinRecord = {
            ...common,
            stage: phase === 'adopted' ? 'adopted' : 'confirmed',
            format: 2,
            source: {
              ...s.recovery.source,
              trustDigest: recoveryTrustDigest(s.recovery.source.trust),
            },
            target: {
              targetID: s.recovery.proof.targetID,
              topicID: s.recovery.proof.topicID,
              groupInfoEpoch: s.recovery.proof.groupInfoEpoch,
              groupInfoAuthenticator: s.recovery.source.trust.installed.authenticator.slice(),
              captureHead: s.recovery.proof.captureHead,
            },
            captureHead: s.recovery.proof.captureHead,
            searchFrom: s.recovery.proof.captureHead,
            trigger: 'automatic',
            authorisationID: null,
            switchMutationID: s.params.write.mutationID,
            destinationKey: phase === 'adopted' ? destination : null,
          }
          const save = () => s.fixture.installRows({ key, control: { putRejoin: record } })
          if (phase === 'after-drain') s.access.onRetire(save)
          else if (phase === 'work') {
            const capability = entryCapability(s.fixture.device.groups)
            if (capability === null) throw new Error('Missing entry capability')
            const run = capability.run.bind(capability)
            vi.spyOn(capability, 'run').mockImplementation((request, prepare, work) =>
              run(request, prepare, async (stores, prepared) => {
                if (request.mutationID === null) throw new Error('Missing switch mutation ID')
                await stores
                  .incarnation(key.incarnation)
                  .control.apply({ putRejoin: record }, request.mutationID)
                return work(stores, prepared)
              }),
            )
          } else await save()
          const before = await s.fixture.inspectRows()
          await expect(run(s)).rejects.toMatchObject(
            phase === 'work'
              ? {
                  name: 'GroupStateConflictError',
                  message: 'Registry switch confirmed record moved',
                }
              : phase === 'adopted'
                ? { reason: 'malformed' }
                : { name: 'RegistrySourceMovedError', message: 'Registry switch source moved' },
          )
          expect((await s.fixture.device.groups.ports(key).control.load()).rejoin).toEqual(
            phase === 'work' ? s.recovery.record : record,
          )
          expect(await s.fixture.device.groups.load(groupID)).toMatchObject({
            activeIncarnation: 1,
          })
          expect(await s.fixture.device.groups.loadState(destination)).toBeNull()
          if (phase !== 'after-drain') expect(await s.fixture.inspectRows()).toEqual(before)
        } finally {
          await s.fixture.close()
        }
      },
    )

    test.each(['device', 'group'] as const)(
      'switch refuses pending %s restore before retirement',
      async (scope) => {
        const fixture = await createRegistryFixture({ mode, setup: 'seeded', groupID })
        try {
          const recovery = await fixture.confirmedRecovery(key, { confirm: true, format: 'legacy' })
          if (scope === 'device') {
            await fixture.device.transition(
              {
                mutationID: 'pending-device-restore',
                expectedRevision: (await fixture.device.load()).revision,
                group: null,
              },
              async (stores) => {
                await stores.restore.save({
                  id: 'switch-restore',
                  stage: 'groups',
                  remainingGroups: [groupID],
                })
              },
            )
          } else {
            await fixture.device.groups.transition(
              await nextChange(fixture.device.groups, groupID, 'pending-group-restore'),
              async (stores) => {
                const lifetime = await stores.lifetime.load()
                if (lifetime === null) throw new Error('Missing source lifetime')
                await stores.lifetime.save({
                  ...lifetime,
                  revision: lifetime.revision + 1,
                  mutationID: 'pending-group-restore',
                  restorePending: true,
                })
              },
            )
          }
          const owner = registry(fixture)
          const retirement = registryFixtureRetirement(owner)
          const begin = vi.spyOn(retirement, 'beginRetirement')
          const before = await fixture.inspectRows()
          const restores = fixture.restoreCount(groupID)
          await expect(
            owner.switchIncarnation(recovery.candidate, {
              source: recovery.source,
              rejoinID: recovery.record.id,
              proof: recovery.proof,
              write: {
                mutationID: crypto.randomUUID(),
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
            }),
          ).rejects.toMatchObject({ reason: 'restore-pending' })
          expect(begin).not.toHaveBeenCalled()
          expect(await fixture.inspectRows()).toEqual(before)
          expect(fixture.restoreCount(groupID)).toBe(restores)
          expect(() => retirement.assertAvailable(groupID)).not.toThrow()
          await owner.dispose()
        } finally {
          await fixture.close()
        }
      },
    )

    test('switch recovers unreadable source ciphertext without restoring the old handle', async () => {
      const fixture = await createRegistryFixture({ mode, setup: 'seeded', groupID })
      try {
        const recovery = await fixture.confirmedRecovery(key, { confirm: true, format: 'legacy' })
        const owner = registry(fixture)
        await fixture.corruptState(key)
        await expect(fixture.device.groups.loadState(key)).rejects.toThrow()
        const source = await owner.recoverySource(groupID)
        expect(source).toEqual(recovery.source)
        const restores = fixture.restoreCount(groupID)
        expect(
          await owner.switchIncarnation(recovery.candidate, {
            source,
            rejoinID: recovery.record.id,
            proof: recovery.proof,
            write: {
              mutationID: crypto.randomUUID(),
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
          }),
        ).toEqual(destination)
        expect(fixture.restoreCount(groupID)).toBe(restores)
        expect(await fixture.device.groups.loadState(key)).toMatchObject({ deleted: true })
        expect(await fixture.device.groups.loadState(destination)).toMatchObject({
          version: 1,
          deleted: false,
          state: encodeClientState(recovery.candidate.state),
          ledger: recovery.candidate.ledgerTokens,
          senderHWM: 0,
        })
        expect(await fixture.device.groups.ports(key).control.load()).toMatchObject({
          rejoin: { ...recovery.record, stage: 'adopted' },
        })
        expect((await owner.access(groupID)).key).toEqual(destination)
        await owner.dispose()
      } finally {
        await fixture.close()
      }
    })

    test('switch atomicity and isolation', async () => {
      const s = await setup({
        putApplied: [
          {
            epoch: 0,
            digest: 'old',
            payloadDigest: 'old-payload',
            sequenceID: 'old-position',
            opID: null,
            removed: false,
          },
        ],
        putResponses: [
          {
            position: asLogPosition('old-response'),
            digest: 'old',
            kind: 'applied',
            epoch: 0,
            epochAfter: 1,
          },
        ],
        putOperations: [
          {
            id: 'queued',
            kind: 'rotation',
            revokes: true,
            body: utf8('rotate'),
            seq: 1,
            enqueuedAt: 1,
            deadline: 100,
            stage: 'intent',
          },
        ],
        cursor: { position: asLogPosition('old-position'), epoch: 0 },
      })
      try {
        const groups = s.fixture.device.groups
        const oldSecret = await s.access.read((handle) =>
          handle.exportSecret(APP_TOPIC_LABEL, new Uint8Array(), 32),
        )
        await s.fixture.installRows({
          key,
          anchor: { anchor: { epoch: 0, secret: oldSecret } },
          outbox: [
            {
              seq: 3,
              protocol: 'chat',
              prc: 'send',
              data: utf8('old'),
              status: 'accepted',
              lastAttempt: null,
            },
          ],
        })
        s.params.source = await s.owner.recoverySource(groupID)
        const candidateBytes = encodeClientState(s.recovery.candidate.state)
        expect(await run(s)).toEqual(destination)
        expect(s.hooks()).toBe(1)
        expect(await groups.loadState(key)).toMatchObject({ deleted: true })
        expect(await groups.loadState(destination)).toMatchObject({
          version: 1,
          deleted: false,
          state: candidateBytes,
          senderHWM: 0,
          ledger: s.recovery.candidate.ledgerTokens,
        })
        expect(await groups.ports(destination).control.load()).toEqual({
          commitOnce: null,
          commitOnceAcceptance: null,
          controlHold: null,
          forkHalt: null,
          recoveryUnavailable: null,
          strand: null,
          operations: [],
          rejoin: null,
          recoveryEpochFloor: null,
          settledRejoins: [],
          outcomes: [],
          welcomes: [],
          applied: [],
          responses: [],
          cursor: {
            position: s.recovery.proof.position,
            epoch: Number(s.recovery.candidate.epoch),
          },
        })
        const anchor = await groups.ports(destination).anchor.load()
        expect(anchor).toEqual({
          anchor: {
            epoch: Number(s.recovery.candidate.epoch),
            secret: await s.recovery.candidate.exportSecret(APP_TOPIC_LABEL, new Uint8Array(), 32),
          },
        })
        expect(anchor?.anchor.secret).not.toEqual(oldSecret)
        expect(await groups.ports(destination).cursor.load('app-topic')).toBeNull()
        expect(await groups.ports(destination).outbox.list()).toEqual([])
        expect(await groups.ports(key).control.load()).toMatchObject({
          rejoin: { ...s.recovery.record, stage: 'adopted' },
          operations: [],
          outcomes: [{ id: 'queued', kind: 'unknown' }],
        })
        expect(await groups.ports(key).outbox.events()).toMatchObject([
          { kind: 'failed', reason: 'incarnation-abandoned', nextIncarnation: 2 },
        ])
        expect(s.access.runtime.snapshot()).toBeNull()
        await expect(s.access.read(() => {})).rejects.toMatchObject({
          name: 'DisplacedGroupHandleError',
        })
        expect((await s.owner.access(groupID)).key).toEqual(destination)
      } finally {
        await s.fixture.close()
      }
    })

    test('switch runtime notification runs after ownership release', async () => {
      const s = await setup()
      try {
        const read = deferred<unknown>()
        s.access.runtime.onEpochChanged(() => {
          try {
            void s.fixture.device.groups.load(groupID).then(read.resolve, read.resolve)
          } catch (error) {
            read.resolve(error)
          }
        })
        await run(s)
        expect(await read.promise).toMatchObject({ activeIncarnation: 2 })
      } finally {
        await s.fixture.close()
      }
    })

    test('A4 source installs a lower-epoch external candidate with a fresh anchor', async () => {
      const fixture = await createRegistryFixture({ mode, setup: 'empty', groupID })
      try {
        const options = fixture.environment.options
        const signer = randomIdentity()
        const genesis = (await createGroup(fixture.identity, groupID, options)).group
        const bundle = await createKeyPackageBundle(signer)
        const { invite } = await createInvite({
          group: genesis,
          identity: fixture.identity,
          recipientDID: signer.id,
          permission: 'member',
        })
        const added = await commitInvite(genesis, bundle.publicPackage, invite)
        const remote = (
          await processWelcome({
            identity: signer,
            invite,
            welcome: added.welcomeMessage,
            keyPackageBundle: bundle,
            options,
          })
        ).group
        let handle = added.newGroup
        while (handle.epoch < 4n) handle = (await commitKeyRotation(handle)).newGroup
        handle = await registryHandle({ mode, handle, options })
        const recovery = await createRegistryRecovery({
          mode,
          identity: fixture.identity,
          options,
          source: handle,
          sourceKey: key,
          responder: {
            identity: signer,
            group: await registryHandle({ mode, handle: remote, options }),
          },
        })
        expect(handle.epoch).toBe(4n)
        expect(recovery.candidate.epoch).toBe(2n)
        const secret = await handle.exportSecret(APP_TOPIC_LABEL, new Uint8Array(), 32)
        await fixture.installRows({
          key,
          state: {
            ...key,
            version: 1,
            deleted: false,
            terminal: false,
            epoch: 4,
            epochAuthenticator: handle.state.keySchedule.epochAuthenticator,
            state: encodeClientState(handle.state),
            credential: handle.credential,
            ledger: handle.ledgerTokens,
            senderHWM: 42,
          },
          trust: recoveryTrustFor(handle, key, null),
          control: { putRejoin: recovery.record },
          anchor: {
            anchor: { epoch: 4, secret },
            pending: {
              epochBefore: 3,
              epochAfter: 4,
              rosterBefore: [fixture.identity.id],
              forced: true,
              advance: 'source-rotation',
            },
          },
        })
        const owner = registry(fixture)
        await owner.switchIncarnation(recovery.candidate, {
          source: await owner.recoverySource(groupID),
          rejoinID: recovery.record.id,
          proof: recovery.proof,
          write: {
            mutationID: 'lower-epoch-switch',
            source: { rejoinID: recovery.record.id },
            destination: { control: { cursor: { position: recovery.proof.position, epoch: 2 } } },
          },
        })
        const state = await fixture.device.groups.loadState(destination)
        expect(state).toMatchObject({
          epoch: 2,
          version: 1,
          senderHWM: 0,
          state: encodeClientState(recovery.candidate.state),
        })
        const anchor = await fixture.device.groups.ports(destination).anchor.load()
        expect(anchor?.anchor.epoch).toBe(2)
        expect(anchor?.anchor.secret).not.toEqual(secret)
        expect(anchor).not.toHaveProperty('pending')
      } finally {
        await fixture.close()
      }
    })

    test.each([
      'key',
      'version',
      'identity',
      'revision',
      'trust',
      'unconfirmed',
      'refused',
      'spent',
      'cursor position',
      'cursor epoch',
      'rejoinID',
      'write rejoinID',
      'candidate history',
    ] as const)('switch stale and unaccepted guards: %s', async (fault) => {
      const s = await setup()
      try {
        if (fault === 'key') s.params.source.key.incarnation++
        if (fault === 'version') s.params.source.stateVersion++
        if (fault === 'identity' && s.params.source.identity !== null)
          s.params.source.identity.authenticator.fill(0)
        if (fault === 'revision') s.params.source.lifetimeRevision--
        if (fault === 'trust')
          s.params.source.trust.registry.controllers = new Map(
            s.params.source.trust.registry.controllers,
          ).set('unrelated-controller', { recordedLog: [], genFloor: 1, timeFloor: 0 })
        if (fault === 'unconfirmed' || fault === 'refused')
          await s.fixture.installRows({
            key,
            control: {
              putRejoin: {
                ...s.recovery.record,
                stage: fault === 'refused' ? 'refused' : 'published',
              },
            },
          })
        if (fault === 'spent') {
          const trust = await s.fixture.device.groups.loadTrust(groupID)
          if (trust === null) throw new Error('Missing trust')
          trust.spentEpochAuthenticators.push(
            s.recovery.candidate.state.keySchedule.epochAuthenticator.slice(),
          )
          await s.fixture.installRows({ key, trust })
          s.params.source = await s.owner.recoverySource(groupID)
        }
        if (fault === 'cursor position')
          s.params.write.destination.control.cursor.position = asLogPosition('wrong')
        if (fault === 'cursor epoch') s.params.write.destination.control.cursor.epoch++
        if (fault === 'rejoinID') s.params.rejoinID = 'wrong'
        if (fault === 'write rejoinID') s.params.write.source.rejoinID = 'wrong'
        if (fault === 'candidate history') {
          const snapshot = decodeRecoveryCandidate(
            s.recovery.record.candidate,
            s.recovery.record.requestKey,
          )
          snapshot.state.keySchedule.exporterSecret.fill(0)
          await s.fixture.installRows({
            key,
            control: {
              putRejoin: {
                ...s.recovery.record,
                candidate: encodeRecoveryCandidate(snapshot, s.recovery.record.requestKey),
              },
            },
          })
          s.params.source = await s.owner.recoverySource(groupID)
        }
        await unchanged(s)
      } finally {
        await s.fixture.close()
      }
    })

    test('switch mid-write rollback', async () => {
      const s = await setup()
      try {
        s.fixture.armWorkFault(s.params.write.mutationID, 'after-first-write')
        await unchanged(s)
        expect(s.hooks()).toBe(1)
        expect(await run(s)).toEqual(destination)
      } finally {
        await s.fixture.close()
      }
    })

    test('switch replay resolves adopted evidence before stale source and spent', async () => {
      const s = await setup({ putOutcomes: [{ id: 'owed', opID: null, kind: 'unknown', at: 1 }] })
      try {
        expect(await run(s)).toEqual(destination)
        await s.fixture.device.groups
          .ports(key)
          .control.apply({ deleteOutcomes: ['owed'] }, 'later-owed-write')
        const before = await s.fixture.inspectRows()
        const restores = s.fixture.restoreCount(groupID)
        expect(await run(s)).toEqual(destination)
        s.params.write.mutationID = 'different-replay-mutation'
        expect(await run(s)).toEqual(destination)
        expect(s.hooks()).toBe(1)
        expect(s.fixture.restoreCount(groupID)).toBe(restores)
        expect(await s.fixture.inspectRows()).toEqual(before)
        s.params.proof = { ...s.params.proof, payloadDigest: 'different' }
        await expect(run(s)).rejects.toThrow()
        s.params.proof = s.recovery.proof
        const alternate = await s.fixture.advance(s.recovery.candidate)
        await expect(s.owner.switchIncarnation(alternate, s.params)).rejects.toThrow()
        expect(await s.fixture.inspectRows()).toEqual(before)
        // Replay is still owed after the installed incarnation is retired.
        const groups = s.fixture.device.groups
        await groups.transition(
          await nextChange(groups, groupID, 'delete-destination'),
          async (stores) => {
            const lifetime = await stores.lifetime.load()
            if (lifetime === null) throw new Error('Missing lifetime')
            await stores.lifetime.save({
              ...lifetime,
              activeIncarnation: null,
              revision: lifetime.revision + 1,
              mutationID: 'delete-destination',
            })
          },
        )
        const deleted = await s.fixture.inspectRows()
        expect(await run(s)).toEqual(destination)
        expect(await s.fixture.inspectRows()).toEqual(deleted)
      } finally {
        await s.fixture.close()
      }
    })

    test('committed marker without adopted evidence refuses conflict', async () => {
      const s = await setup()
      try {
        await s.fixture.device.groups
          .ports(key)
          .control.apply({ deleteOutcomes: [] }, s.params.write.mutationID)
        await unchanged(s, 'GroupStateConflictError')
        expect(s.hooks()).toBe(0)
      } finally {
        await s.fixture.close()
      }
    })

    test('switch reopen retains bootstrap continuation', async () => {
      const s = await setup()
      let current = s.fixture
      try {
        const missing = await signLedgerEntry(s.fixture.identity, {
          type: 'kumiai.role',
          groupID,
          subject: s.fixture.identity.id,
          value: 'member',
        })
        const state = await s.fixture.device.groups.loadState(key)
        const trust = await s.fixture.device.groups.loadTrust(groupID)
        if (state === null || state.deleted || trust === null) throw new Error('Missing source')
        const ledger = [missing, ...state.ledger, missing]
        s.recovery.record.ledgerBefore = ledger
        await s.fixture.installRows({
          key,
          state: { ...state, version: state.version + 1, ledger },
          trust: { ...trust, ledger },
          control: { putRejoin: s.recovery.record },
        })
        s.params.source = await s.owner.recoverySource(groupID)
        expect(s.recovery.candidate.ledgerTokens).not.toContain(missing)
        await run(s)
        current = await s.fixture.reopen()
        const control = await current.device.groups.ports(key).control.load()
        expect(control.rejoin).toEqual({ ...s.recovery.record, stage: 'adopted' })
        expect(control.rejoin?.ledgerBefore).toEqual(ledger)
        const continuation = await createRecoveryContinuationPort({
          registry: registry(current),
          persistence: current.device.groups,
        }).loadRecoveryContinuation(destination)
        expect(continuation).toEqual({ source: key, destination, record: control.rejoin })
        expect(control.outcomes.some((row) => row.id === s.recovery.record.id)).toBe(false)
        expect((await current.device.groups.ports(destination).control.load()).operations).toEqual(
          [],
        )
      } finally {
        await current.close()
      }
    })

    test('switch revision-only drift refuses', async () => {
      const s = await setup({
        putWelcomes: [
          { opID: 'owed', welcome: utf8('welcome'), recipients: ['recipient'], committed: true },
        ],
      })
      try {
        await run(s)
        const next = await s.fixture.confirmedRecovery(destination, {
          confirm: true,
          format: 'legacy',
        })
        const savedSource = await s.owner.recoverySource(groupID)
        await s.fixture.device.groups
          .ports(key)
          .control.apply({ deleteWelcomes: ['owed'] }, 'retired-owed-only')
        const fresh = await s.owner.recoverySource(groupID)
        expect(fresh.key).toEqual(savedSource.key)
        expect(fresh.identity).toEqual(savedSource.identity)
        expect(fresh.stateVersion).toEqual(savedSource.stateVersion)
        expect(fresh.trust).toEqual(savedSource.trust)
        expect(fresh.lifetimeRevision).toBe(savedSource.lifetimeRevision + 1)
        const before = await s.fixture.inspectRows()
        let writes = 0
        s.fixture.onPhase('work', () => {
          writes++
        })
        await expect(
          s.owner.switchIncarnation(next.candidate, {
            source: savedSource,
            rejoinID: next.record.id,
            proof: next.proof,
            write: {
              mutationID: 'revision-drift-switch',
              source: { rejoinID: next.record.id },
              destination: {
                control: {
                  cursor: { position: next.proof.position, epoch: Number(next.candidate.epoch) },
                },
              },
            },
          }),
        ).rejects.toThrow()
        expect(writes).toBe(0)
        expect(await s.fixture.inspectRows()).toEqual(before)
      } finally {
        await s.fixture.close()
      }
    })

    test.each([
      'source applied',
      'source responses',
      'source cursor',
      'source anchor',
      'destination applied',
      'destination responses',
      'destination operations',
      'app cursor',
      'anchor',
      'progress',
      'anchorLanded',
    ] as const)('switch inherited destination fields refuse: %s', async (field) => {
      const s = await setup()
      try {
        const write = structuredClone(s.params.write)
        const source = write.source as unknown as Record<string, unknown>
        const dest = write.destination as unknown as Record<string, unknown>
        const control = write.destination.control as unknown as Record<string, unknown>
        if (field.startsWith('source ')) source[field.slice(7)] = []
        else if (field.startsWith('destination ')) control[field.slice(12)] = []
        else dest[field] = []
        s.params.write = write
        await unchanged(s, 'TypeError')
        expect(s.hooks()).toBe(0)
      } finally {
        await s.fixture.close()
      }
    })

    test('competing switches cannot undo winner fence', async () => {
      const s = await setup()
      const entered = deferred<void>()
      const released = deferred<void>()
      try {
        s.access.onRetire(async () => {
          entered.resolve()
          await released.promise
        })
        const first = run(s)
        await entered.promise
        await expect(
          s.owner.switchIncarnation(s.recovery.candidate, {
            ...s.params,
            write: { ...s.params.write, mutationID: 'competitor' },
          }),
        ).rejects.toMatchObject({ name: 'RegistryRetiringError' })
        await expect(s.access.read(() => {})).rejects.toMatchObject({
          name: 'RegistryRetiringError',
        })
        released.resolve()
        expect(await first).toEqual(destination)
      } finally {
        released.resolve()
        await s.fixture.close()
      }
    })

    test.each(['commit', 'rollback'] as const)(
      'switch ambiguous proof retains hold: %s',
      async (outcome) => {
        const s = await setup()
        try {
          const before = await s.fixture.inspectRows()
          const fault = s.fixture.armWorkFault(s.params.write.mutationID, 'pending')
          const changes: Array<unknown> = []
          s.access.runtime.onEpochChanged((value) => {
            changes.push(value)
          })
          const operation = run(s)
          const result = operation.then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          )
          await fault.rejected
          expect(s.access.runtime.snapshot()?.incarnation).toBe(1)
          expect(changes).toEqual([])
          await expect(s.access.read(() => {})).rejects.toMatchObject({
            name: 'RegistryRetiringError',
          })
          const replay =
            outcome === 'commit'
              ? run(s).then(
                  (value) => ({ value }),
                  (error: unknown) => ({ error }),
                )
              : undefined
          await fault.finish(outcome)
          const settled = await result
          if (outcome === 'commit') {
            expect(settled).toEqual({ value: destination })
            expect(await replay).toEqual({ value: destination })
            expect(changes).toEqual([null])
            expect(s.hooks()).toBe(1)
          } else {
            expect(settled).toHaveProperty('error')
            expect(await s.fixture.inspectRows()).toEqual(before)
            expect(changes).toEqual([])
            expect(await s.access.read((handle) => handle.groupID)).toBe(groupID)
            expect(s.hooks()).toBe(1)
            expect(await run(s)).toEqual(destination)
            expect(s.hooks()).toBe(2)
          }
        } finally {
          await s.fixture.close()
        }
      },
    )

    test('old applied cannot mask self-removal', async () => {
      const s = await setup({
        putApplied: [
          {
            epoch: 100,
            digest: 'old-removal',
            payloadDigest: 'old',
            sequenceID: 'old',
            opID: null,
            removed: true,
          },
        ],
      })
      try {
        await run(s)
        const groups = s.fixture.device.groups
        await groups.transition(
          await nextChange(groups, groupID, 'self-removal'),
          async (stores) => {
            const rows = stores.incarnation(2)
            const state = await rows.state.load()
            if (state === null || state.deleted) throw new Error('Missing destination')
            await rows.state.save({ ...state, version: state.version + 1, terminal: true })
            await rows.control.apply(
              {
                putApplied: [
                  {
                    epoch: state.epoch,
                    digest: 'new-removal',
                    payloadDigest: 'new',
                    sequenceID: 'new',
                    opID: null,
                    removed: true,
                  },
                ],
              },
              'self-removal',
            )
          },
        )
        const access = await s.owner.access(groupID)
        expect(access.admission()).toMatchObject({ admissible: false, reason: 'terminal' })
        expect((await groups.readEvidence(destination)).terminal).toBe(true)
        expect((await groups.readEvidence(destination)).applied).toHaveLength(1)
      } finally {
        await s.fixture.close()
      }
    })
  })
}
