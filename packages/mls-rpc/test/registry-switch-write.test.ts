import { normalizeDID, type OwnIdentity, randomIdentity } from '@kokuin/token'
import {
  type ControllerBinding,
  commitInvite,
  commitKeyRotation,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  decodeClientState,
  encodeClientState,
  processWelcome,
} from '@kumiai/mls'
import type { StagedAdoption } from '@kumiai/rpc'
import { describe, expect, test, vi } from 'vitest'

import { entryCapability } from '../src/entry-capability.js'
import { createRecoverySwitchFactory, toRegistrySwitchWrite } from '../src/index.js'
import { GroupStateUncertainError, StorageOutcomeUnknownError } from '../src/persistence-errors.js'
import {
  decodeCapturedRecoveryCandidate,
  encodeCapturedRecoveryCandidate,
} from '../src/recovery-codec.js'
import { recoveryTrustDigest } from '../src/recovery-trust-digest.js'
import { createGroupHandleRegistry } from '../src/registry/registry.js'
import { recoveryTrustFor } from '../src/registry/trust.js'
import type { RegistrySwitchWrite } from '../src/registry/types.js'
import { verifyRegistryResync } from '../src/registry/verdict.js'
import { deferred } from '../src/runtime.js'
import { createRegistryFixture, registryFixtureRestore } from './fixtures/registry.js'
import { createRegistryRecovery } from './fixtures/registry-recovery.js'
import { registryHandle } from './fixtures/registry-welcome.js'

const lifecycle = (await import(
  new URL('../../mls/test/fixtures/lifecycle-ledger.ts', import.meta.url).href
)) as {
  bindingFor(identity: OwnIdentity): Promise<ControllerBinding>
}
const groupID = 'captured-switch'
const key = { groupID, incarnation: 1 }
const destination = { groupID, incarnation: 2 }

async function setup(mode: 'real-mls' | 'double', advanced = false, trustMaps = false) {
  const identity = randomIdentity()
  const signer = randomIdentity()
  const fixture = await createRegistryFixture({
    mode,
    setup: 'empty',
    groupID,
    identity,
    options: { controller: await lifecycle.bindingFor(identity) },
  })
  const options = fixture.environment.options
  const initial = (await createGroup(identity, groupID, options)).group
  const bundle = await createKeyPackageBundle(signer, {
    controller: await lifecycle.bindingFor(signer),
  })
  const { invite } = await createInvite({ group: initial, identity, recipientDID: signer.id })
  const added = await commitInvite(initial, bundle.publicPackage, invite)
  const source = added.newGroup
  let remote = (
    await processWelcome({
      identity: signer,
      invite,
      welcome: added.welcomeMessage,
      keyPackageBundle: bundle,
      options,
    })
  ).group
  if (advanced) {
    const outsider = randomIdentity()
    const packageBundle = await createKeyPackageBundle(outsider, {
      controller: await lifecycle.bindingFor(outsider),
    })
    const offered = await createInvite({
      group: remote,
      identity: signer,
      recipientDID: outsider.id,
    })
    remote = (await commitInvite(remote, packageBundle.publicPackage, offered.invite)).newGroup
    remote = (await commitKeyRotation(remote)).newGroup
  }
  const trust = recoveryTrustFor(source, key, null)
  trust.spentEpochAuthenticators.push(trust.installed.authenticator.slice())
  if (trustMaps) {
    const controller = source.anchor.controller
    if (controller == null) throw new Error('Missing controller')
    trust.registry.devices = new Map([
      [normalizeDID(identity.id), { controller, status: 'active' }],
      [normalizeDID(signer.id), { controller, status: 'active' }],
    ])
  }
  const stored = await registryHandle({ mode, handle: source, options })
  await fixture.installRows({
    key,
    trust,
    state: {
      ...key,
      version: 1,
      deleted: false,
      terminal: false,
      epoch: Number(source.epoch),
      epochAuthenticator: trust.installed.authenticator,
      state: encodeClientState(stored.state),
      credential: source.credential,
      ledger: source.ledgerTokens,
      senderHWM: 0,
    },
  })
  const recovery = await createRegistryRecovery({
    format: 'captured',
    mode,
    identity,
    options,
    source,
    sourceKey: key,
    sourceTrust: trust,
    responder: { identity: signer, group: remote },
  })
  await fixture.installRows({ key, control: { putRejoin: recovery.record } })
  const owner = createGroupHandleRegistry({
    persistence: fixture.device,
    providerID: fixture.device.providerID,
    recovery: fixture.environment,
    restore: registryFixtureRestore(fixture),
    restoreCandidate: async () => {
      throw new Error('Unexpected restore')
    },
  })
  recovery.source = {
    ...(await owner.recoverySource(groupID)),
    trustDigest: recoveryTrustDigest(trust),
  }
  const write: RegistrySwitchWrite = {
    mutationID: recovery.record.switchMutationID as string,
    source: { rejoinID: recovery.record.id },
    destination: {
      control: { cursor: { position: recovery.proof.position, epoch: recovery.record.epochAfter } },
    },
  }
  const run = () =>
    owner.switchIncarnation(recovery.candidate, {
      source: recovery.source,
      rejoinID: recovery.record.id,
      proof: recovery.proof,
      write,
    })
  const staged: StagedAdoption = {
    incarnation: 2,
    epochAfter: recovery.record.epochAfter,
    removed: false,
    epochAuthenticator: recovery.candidate.state.keySchedule.epochAuthenticator.slice(),
  }
  return { ...recovery, recovery, fixture, owner, write, run, staged }
}
for (const mode of ['real-mls', 'double'] as const) {
  describe(`captured restricted switch -- ${mode}`, () => {
    test('offered membership and path advance from origin before installing once', async () => {
      const s = await setup(mode, true)
      try {
        const snapshot = decodeCapturedRecoveryCandidate(s.record.candidate, s.record.requestKey)
        expect(snapshot.sourceTree).not.toEqual(s.source.trust.signerTree)
        expect(s.record.digest).not.toBe(s.record.payloadDigest)
        await expect(verifyRegistryResync(s)).resolves.toBeUndefined()
        const original = structuredClone(s.record)
        await expect(s.run()).resolves.toEqual(destination)
        const rows = await s.fixture.inspectRows()
        await expect(s.run()).resolves.toEqual(destination)
        expect(await s.fixture.inspectRows()).toEqual(rows)
        expect(await s.fixture.device.groups.loadState(destination)).toMatchObject({
          version: 1,
          senderHWM: 0,
          epoch: s.record.epochAfter,
        })
        const installed = await s.fixture.device.groups.loadState(destination)
        if (installed === null || installed.deleted || installed.state === null)
          throw new Error('Missing destination')
        expect(decodeClientState(installed.state)?.historicalReceiverData.size).toBe(0)
        const control = await s.fixture.device.groups.ports(destination).control.load()
        expect(control.applied).toEqual([])
        expect(control.cursor).toEqual({ position: s.proof.position, epoch: s.record.epochAfter })
        expect((await s.fixture.device.groups.ports(key).control.load()).rejoin).toEqual({
          ...original,
          stage: 'adopted',
          destinationKey: destination,
        })
        const trust = await s.fixture.device.groups.loadTrust(groupID)
        expect(trust?.spentEpochAuthenticators).toContainEqual(
          s.candidate.state.keySchedule.epochAuthenticator,
        )
        expect(await s.fixture.device.groups.ports(destination).anchor.load()).toMatchObject({
          anchor: { epoch: s.record.epochAfter },
        })
      } finally {
        await s.fixture.close()
      }
    })

    test.each([
      'target',
      'topic',
      'epoch',
      'authenticator',
      'head',
      'reply',
      'source tree',
      'candidate',
      'request',
      'request key',
      'digest',
      'payload digest',
      'position',
      'verdict',
      'mutation ID',
      'origin digest',
      'manual',
    ] as const)('%s tampering performs zero writes', async (fault) => {
      const s = await setup(mode)
      try {
        if (fault === 'target') s.proof.targetID = 'different-hub'
        if (fault === 'topic') s.proof.topicID = 'different-topic'
        if (fault === 'epoch') s.proof.groupInfoEpoch++
        if (fault === 'authenticator') s.proof.groupInfoAuthenticator.fill(0)
        if (fault === 'head') s.proof.captureHead = null
        if (fault === 'reply' || fault === 'source tree') {
          const snapshot = decodeCapturedRecoveryCandidate(s.record.candidate, s.record.requestKey)
          if (fault === 'reply')
            snapshot.attestedReply[snapshot.attestedReply.length - 1] =
              (snapshot.attestedReply.at(-1) ?? 0) ^ 1
          else snapshot.sourceTree = snapshot.source.trust.signerTree.slice(0, 1)
          s.record.candidate = encodeCapturedRecoveryCandidate(snapshot, s.record.requestKey)
        }
        if (fault === 'candidate') s.record.candidate[30] = (s.record.candidate[30] ?? 0) ^ 1
        if (fault === 'request') s.record.request = new TextEncoder().encode('invalid-request')
        if (fault === 'request key') s.record.requestKey.fill(0)
        if (fault === 'digest') s.record.digest = 'different-commit'
        if (fault === 'payload digest') s.record.payloadDigest = 'different-payload'
        if (fault === 'position') s.proof.position = 'different-position' as typeof s.proof.position
        if (fault === 'verdict')
          s.proof.verdict = await s.sealVerdict({
            verdict: { commitDigest: s.record.payloadDigest },
          })
        if (fault === 'mutation ID') s.write.mutationID = 'unsaved-switch'
        if (fault === 'origin digest') s.record.source.trustDigest = 'different-trust'
        if (fault === 'manual') {
          s.record.trigger = 'manual'
          s.record.authorisationID = 'manual-authorisation'
        }
        await s.fixture.installRows({ key, control: { putRejoin: s.record } })
        const before = await s.fixture.inspectRows()
        await expect(s.run()).rejects.toThrow()
        expect(await s.fixture.inspectRows()).toEqual(before)
        expect(await s.fixture.device.groups.loadState(destination)).toBeNull()
      } finally {
        await s.fixture.close()
      }
    })

    test('saved ledger union and source owed rows survive without narrowing to origin ledger', async () => {
      const s = await setup(mode)
      try {
        const owed = ['in-flight-token', 'awaiting-bootstrap-token']
        s.record.ledgerBefore = [...s.source.trust.ledger, ...owed]
        await s.fixture.installRows({
          key,
          control: {
            putRejoin: s.record,
            putOutcomes: [{ id: 'existing-outcome', opID: null, at: 1, kind: 'unknown' }],
            putWelcomes: [
              {
                opID: 'owed-welcome',
                welcome: new Uint8Array([9]),
                recipients: ['recipient'],
                committed: true,
              },
            ],
            putApplied: [
              {
                epoch: 0,
                digest: 'history-digest',
                payloadDigest: 'history-payload',
                sequenceID: 'old-position' as typeof s.proof.position,
                opID: null,
                removed: false,
              },
            ],
          },
        })
        s.recovery.source = {
          ...(await s.owner.recoverySource(groupID)),
          trustDigest: s.source.trustDigest,
        }
        const before = await s.fixture.device.groups.ports(key).control.load()
        await s.run()
        const after = await s.fixture.device.groups.ports(key).control.load()
        expect(after.rejoin?.ledgerBefore).toEqual([...s.source.trust.ledger, ...owed])
        expect(after.outcomes).toEqual(before.outcomes)
        expect(after.welcomes).toEqual(before.welcomes)
        expect(after.applied).toEqual(before.applied)
      } finally {
        await s.fixture.close()
      }
    })

    test('factory keeps saved mutation ID across rollback and rejects unrestricted adoption writes', async () => {
      const s = await setup(mode)
      try {
        const factory = createRecoverySwitchFactory(s.record)
        expect(() => createRecoverySwitchFactory({ ...s.record, switchMutationID: null })).toThrow()
        const adoption = factory(s.staged)
        expect(adoption.mutationID).toBe(s.write.mutationID)
        expect(
          toRegistrySwitchWrite({ record: s.record, write: adoption, staged: s.staged }),
        ).toEqual(s.write)
        for (const changed of [
          { ...adoption, anchorLanded: s.record.digest },
          { ...adoption, extra: true },
          { ...adoption, changes: { ...adoption.changes, putApplied: [] } },
          {
            ...adoption,
            changes: {
              ...adoption.changes,
              putRejoin: { ...s.record, stage: 'adopted' as const, ledgerBefore: [] },
            },
          },
        ]) {
          expect(() =>
            toRegistrySwitchWrite({ record: s.record, write: changed, staged: s.staged }),
          ).toThrow()
        }
        s.fixture.armWorkFault(s.write.mutationID, 'before-commit')
        await expect(s.run()).rejects.toThrow()
        expect((await s.fixture.device.groups.ports(key).control.load()).rejoin).toEqual(s.record)
        expect(factory(s.staged)).toEqual(adoption)
        await expect(s.run()).resolves.toEqual(destination)
      } finally {
        await s.fixture.close()
      }
    })

    test('suspended retirement hook blocks destination writes', async () => {
      const s = await setup(mode)
      const entered = deferred<void>()
      const released = deferred<void>()
      try {
        const access = await s.owner.access(groupID)
        access.onRetire(async () => {
          entered.resolve()
          await released.promise
        })
        const operation = s.run()
        await Promise.race([
          entered.promise,
          operation.then(() => {
            throw new Error('Switch completed before drain')
          }),
        ])
        expect(await s.fixture.device.groups.loadState(destination)).toBeNull()
        released.resolve()
        await expect(operation).resolves.toEqual(destination)
      } finally {
        released.resolve()
        await s.fixture.close()
      }
    })

    test.each(['uncertain', 'unhooked storage unknown'] as const)(
      '%s releases retirement fence',
      async (fault) => {
        const s = await setup(mode)
        try {
          const access = await s.owner.access(groupID)
          const capability = entryCapability(s.fixture.device.groups)
          if (capability == null) throw new Error('Missing capability')
          const error =
            fault === 'uncertain'
              ? new GroupStateUncertainError('proof pending')
              : new StorageOutcomeUnknownError('no work hook')
          vi.spyOn(capability, 'run').mockRejectedValueOnce(error)
          await expect(s.run()).rejects.toBe(error)
          expect((await s.fixture.device.groups.ports(key).control.load()).rejoin?.stage).toBe(
            'confirmed',
          )
          await expect(access.read((handle) => handle.groupID)).resolves.toBe(groupID)
        } finally {
          await s.fixture.close()
        }
      },
    )

    test.each(['commit', 'rollback'] as const)(
      'hooked ambiguous switch retains the fence until %s proof',
      async (outcome) => {
        const s = await setup(mode)
        try {
          const access = await s.owner.access(groupID)
          const before = await s.fixture.inspectRows()
          const fault = s.fixture.armWorkFault(s.write.mutationID, 'pending')
          const result = s.run().then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          )
          await fault.rejected
          await expect(access.read(() => {})).rejects.toMatchObject({
            name: 'RegistryRetiringError',
          })
          await fault.finish(outcome)
          const settled = await result
          if (outcome === 'commit') {
            expect(settled).toEqual({ value: destination })
            await expect(s.run()).resolves.toEqual(destination)
          } else {
            expect(settled).toHaveProperty('error')
            expect(await s.fixture.inspectRows()).toEqual(before)
            await expect(access.read((handle) => handle.groupID)).resolves.toBe(groupID)
            await expect(s.run()).resolves.toEqual(destination)
          }
        } finally {
          await s.fixture.close()
        }
      },
    )

    test('adopted evidence permits replay with an uncertain saved-ID marker', async () => {
      const s = await setup(mode)
      try {
        await s.run()
        const error = new GroupStateUncertainError('Saved mutation proof pending')
        vi.spyOn(s.fixture.device.groups, 'resolve').mockRejectedValueOnce(error)
        const before = await s.fixture.inspectRows()
        await expect(s.run()).resolves.toEqual(destination)
        expect(await s.fixture.inspectRows()).toEqual(before)
        expect((await s.fixture.device.groups.ports(key).control.load()).rejoin?.stage).toBe(
          'adopted',
        )
      } finally {
        await s.fixture.close()
      }
    })

    test('equivalent reordered trust maps retain the saved authority', async () => {
      const s = await setup(mode, false, true)
      try {
        const trust = s.recovery.source.trust
        expect(trust.registry.devices.size).toBeGreaterThan(1)
        trust.registry.devices = new Map([...trust.registry.devices].reverse())
        expect(recoveryTrustDigest(trust)).toBe(s.record.source.trustDigest)
        await expect(s.run()).resolves.toEqual(destination)
      } finally {
        await s.fixture.close()
      }
    })

    test('expectation-only movement in work has a distinct error', async () => {
      const s = await setup(mode)
      try {
        const capability = entryCapability(s.fixture.device.groups)
        if (capability === null) throw new Error('Missing capability')
        const run = capability.run.bind(capability)
        vi.spyOn(capability, 'run').mockImplementation((request, prepare, work) =>
          run(request, prepare, async (stores, prepared) => {
            const lifetime = await stores.lifetime.load()
            if (lifetime === null || request.mutationID === null)
              throw new Error('Missing work expectation')
            await stores.lifetime.save({
              ...lifetime,
              revision: lifetime.revision + 1,
              mutationID: request.mutationID,
            })
            return work(stores, prepared)
          }),
        )
        const before = await s.fixture.inspectRows()
        await expect(s.run()).rejects.toMatchObject({ name: 'RegistrySourceMovedError' })
        expect(await s.fixture.inspectRows()).toEqual(before)
      } finally {
        await s.fixture.close()
      }
    })

    test('expectation movement has a distinct error and preserves confirmed record', async () => {
      const s = await setup(mode)
      try {
        s.recovery.source.lifetimeRevision--
        const before = await s.fixture.inspectRows()
        await expect(s.run()).rejects.toMatchObject({ name: 'RegistrySourceMovedError' })
        expect(await s.fixture.inspectRows()).toEqual(before)
      } finally {
        await s.fixture.close()
      }
    })
  })
}
