import {
  asLogPosition,
  type ControlChanges,
  type FirstValidCommit,
  type WelcomeObligation,
} from '@kumiai/rpc'
import { describe, expect, test } from 'vitest'

import { encodeControlJournal } from '../src/control-journal.js'
import { entryCapability } from '../src/entry-capability.js'
import { createGroupHandleRegistry } from '../src/registry/registry.js'
import {
  ackRetiredOutcome,
  listRetiredOutcomes,
  retireIncarnation,
  serveRetiredObligations,
} from '../src/registry/retired.js'
import {
  createRegistryFixture,
  type RegistryFixtureBase,
  registryFixtureRestore,
} from './fixtures/registry.js'
import { makeStorageSeed, nextChange } from './fixtures/storage-seed.js'

const key = { groupID: 'retired-service', incarnation: 1 }
const bytes = new Uint8Array([1, 2, 3])
const welcome: WelcomeObligation = { opID: 'invite', welcome: bytes, recipients: ['recipient'] }

async function setup(fixture: RegistryFixtureBase, changes: ControlChanges = {}) {
  const state = await fixture.device.groups.loadState(key)
  const trust = await fixture.device.groups.loadTrust(key.groupID)
  if (state === null || state.deleted || state.state === null || trust === null)
    throw new Error('Missing source')
  const source = { key, stateVersion: state.version, identity: trust.installed }
  const proof: FirstValidCommit = {
    source,
    from: null,
    position: asLogPosition('accepted-position'),
    payloadDigest: 'retained-payload-digest',
  }
  const slot = {
    opID: welcome.opID,
    incarnation: 1,
    epoch: state.epoch,
    authenticatorBefore: state.epochAuthenticator,
    searchFrom: null,
    expectedHead: null,
    publishID: 'retained-publish',
    payload: bytes,
    payloadDigest: proof.payloadDigest,
    digest: 'commit-digest',
    bodies: [],
    welcome: { bytes, recipients: welcome.recipients },
    journal: encodeControlJournal({
      version: 1,
      source,
      checkpoint: null,
      sourceState: state.state,
      sourceCredential: trust.credential,
      sourceLedger: trust.ledger,
      candidate: state.state,
    }),
  }
  await fixture.installRows({
    key,
    control: {
      commitOnce: slot,
      commitOnceAcceptance: proof,
      putWelcomes: [welcome],
      ...changes,
    },
  })
  return { proof, slot }
}

async function retire(fixture: RegistryFixtureBase, mode: 'real-mls' | 'double') {
  const groups = fixture.device.groups
  const seed = await makeStorageSeed({
    id: key.groupID,
    incarnation: 2,
    epoch: 1,
    mode,
    identity: fixture.identity,
    options: fixture.environment.options,
  })
  const mutationID = 'retirement'
  await groups.transition(await nextChange(groups, key.groupID, mutationID), async (stores) => {
    const lifetime = await stores.lifetime.load()
    if (lifetime === null) throw new Error('Missing lifetime')
    await retireIncarnation(stores, { source: key, nextIncarnation: 2, mutationID, at: 12 })
    await stores.lifetime.save({
      ...lifetime,
      latestIncarnation: 2,
      activeIncarnation: 2,
      revision: lifetime.revision + 1,
      mutationID,
    })
    await stores.incarnation(2).state.save(seed.state)
    const trust = await stores.trust.load()
    if (trust === null) throw new Error('Missing trust')
    await stores.trust.save({
      ...seed.trust,
      genesisAnchor: trust.genesisAnchor,
      spentEpochAuthenticators: trust.spentEpochAuthenticators,
    })
  })
}

for (const mode of ['real-mls', 'double'] as const) {
  describe(`retired storage service (${mode})`, () => {
    const create = () => createRegistryFixture({ mode, groupID: key.groupID, setup: 'seeded' })

    test.each([
      'no-proof',
      'wrong-digest',
      'wrong-from',
      'wrong-position',
      'wrong-key',
      'wrong-identity',
      'unknown',
      'superseded',
      'absent',
      'strand',
      'stranded-cursor',
      'hard-hold',
      'wrong-opID',
    ])('uncommitted retired Welcome never releases: %s', async (reason) => {
      const fixture = await create()
      try {
        const changes: ControlChanges = {}
        if (reason === 'no-proof') changes.commitOnceAcceptance = null
        if (reason === 'strand') changes.strand = { reason: 'retention-gap' }
        if (reason === 'stranded-cursor')
          changes.cursor = { epoch: 0, position: null, stranded: true }
        if (reason === 'hard-hold')
          changes.controlHold = { reason: 'unsupported-version', position: asLogPosition('hold') }
        if (reason === 'wrong-opID') changes.putWelcomes = [{ ...welcome, opID: 'other-invite' }]
        const { proof } = await setup(fixture, changes)
        await retire(fixture, mode)
        let deliveries = 0
        const recheck = { ...proof }
        if (reason === 'wrong-digest') recheck.payloadDigest = 'other-digest'
        if (reason === 'wrong-from') recheck.from = asLogPosition('other-from')
        if (reason === 'wrong-position') recheck.position = asLogPosition('other-position')
        if (reason === 'wrong-key')
          recheck.source = { ...proof.source, key: { ...key, incarnation: 2 } }
        if (reason === 'wrong-identity') {
          if (proof.source.identity === null) throw new Error('Missing identity')
          recheck.source = {
            ...proof.source,
            identity: { ...proof.source.identity, authenticator: new Uint8Array([99]) },
          }
        }
        const result = await serveRetiredObligations({
          persistence: fixture.device.groups,
          key,
          search: {
            searchLog: async () => {
              if (reason === 'unknown' || reason === 'absent') return { kind: reason }
              if (reason === 'superseded') return { kind: 'superseded', winner: proof.position }
              return { kind: 'first-valid', proof: recheck }
            },
          },
          deliverWelcome: async () => {
            deliveries++
          },
        })
        expect(deliveries).toBe(0)
        expect(result).toEqual({
          delivered: [],
          remaining: [reason === 'wrong-opID' ? 'other-invite' : welcome.opID],
          failures: [],
        })
      } finally {
        await fixture.close()
      }
    })

    test('first-valid and committed obligations deliver outside ownership then delete', async () => {
      const fixture = await create()
      try {
        const { proof, slot } = await setup(fixture, {
          putWelcomes: [welcome, { ...welcome, opID: 'committed', committed: true }],
        })
        await retire(fixture, mode)
        const lifetime = await fixture.device.groups.load(key.groupID)
        const capability = entryCapability(fixture.device.groups)
        if (capability === null) throw new Error('Missing capability')
        const activity = capability.activity(key.groupID)
        const calls: Array<string> = []
        const result = await serveRetiredObligations({
          persistence: fixture.device.groups,
          key,
          search: {
            searchLog: async (built) => {
              expect(built).toEqual(slot)
              expect(await fixture.device.groups.load(key.groupID)).toEqual(lifetime)
              calls.push('search')
              return { kind: 'first-valid', proof }
            },
          },
          deliverWelcome: async (obligation) => {
            expect(await fixture.device.groups.load(key.groupID)).toMatchObject({
              activeIncarnation: 2,
            })
            calls.push(obligation.opID)
          },
        })
        expect(calls).toEqual(['search', 'invite', 'committed'])
        expect(result).toEqual({ delivered: ['invite', 'committed'], remaining: [], failures: [] })
        expect(capability.activity(key.groupID).generation - activity.generation).toBe(4)
        expect(fixture.restoreCount(key.groupID)).toBe(0)
      } finally {
        await fixture.close()
      }
    })

    test('transport accepted crash before deletion repeats identical Welcome after durable reopen', async () => {
      let fixture = await create()
      try {
        await setup(fixture, { putWelcomes: [{ ...welcome, committed: true }] })
        await retire(fixture, mode)
        fixture.armNextWorkFault('before-commit')
        const accepted: Array<WelcomeObligation> = []
        const serve = () =>
          serveRetiredObligations({
            persistence: fixture.device.groups,
            key,
            search: { searchLog: async () => ({ kind: 'unknown' }) },
            deliverWelcome: async (obligation) => {
              accepted.push(obligation)
            },
          })
        const first = await serve()
        expect(first.delivered).toEqual([])
        expect(first.remaining).toEqual(['invite'])
        expect(first.failures).toHaveLength(1)
        fixture = await fixture.reopen()
        expect(await serve()).toEqual({ delivered: ['invite'], remaining: [], failures: [] })
        expect(accepted).toEqual([
          { ...welcome, committed: true },
          { ...welcome, committed: true },
        ])
      } finally {
        await fixture.close()
      }
    })

    test('one failed delivery does not block other obligations', async () => {
      const fixture = await create()
      try {
        await setup(fixture, {
          putWelcomes: [
            { ...welcome, committed: true },
            { ...welcome, opID: 'other', committed: true },
          ],
        })
        await retire(fixture, mode)
        const failure = new Error('transport failed')
        const result = await serveRetiredObligations({
          persistence: fixture.device.groups,
          key,
          search: { searchLog: async () => ({ kind: 'unknown' }) },
          deliverWelcome: async (obligation) => {
            if (obligation.opID === 'invite') throw failure
          },
        })
        expect(result).toEqual({ delivered: ['other'], remaining: ['invite'], failures: [failure] })
      } finally {
        await fixture.close()
      }
    })

    test('retired outcome ack is fixed-key and idempotent; active keys refuse', async () => {
      const fixture = await create()
      try {
        const outcome = { id: 'owed', opID: 'invite', at: 5, kind: 'unknown' as const }
        await setup(fixture, { putOutcomes: [outcome] })
        const params = { persistence: fixture.device.groups, key }
        await expect(listRetiredOutcomes(params)).rejects.toThrow()
        await expect(ackRetiredOutcome({ ...params, id: 'owed' })).rejects.toThrow()
        await expect(
          serveRetiredObligations({
            ...params,
            search: { searchLog: async () => ({ kind: 'unknown' }) },
            deliverWelcome: async () => {
              throw new Error('Active delivery')
            },
          }),
        ).rejects.toThrow()
        await retire(fixture, mode)
        await fixture.device.groups
          .ports({ ...key, incarnation: 2 })
          .control.apply({ putOutcomes: [outcome] }, 'new-outcome')
        expect(await listRetiredOutcomes(params)).toEqual([outcome])
        await ackRetiredOutcome({ ...params, id: 'owed' })
        await ackRetiredOutcome({ ...params, id: 'owed' })
        expect(await listRetiredOutcomes(params)).toEqual([])
        expect(
          (await fixture.device.groups.ports({ ...key, incarnation: 2 }).control.load()).outcomes,
        ).toEqual([outcome])
      } finally {
        await fixture.close()
      }
    })

    test('old access cannot supply a restarted owner', async () => {
      const fixture = await create()
      try {
        const owner = createGroupHandleRegistry({
          persistence: fixture.device,
          providerID: fixture.device.providerID,
          recovery: fixture.environment,
          restore: registryFixtureRestore(fixture),
          restoreCandidate: async () => {
            throw new Error('No old candidate')
          },
        })
        const access = await owner.access(key.groupID)
        await setup(fixture)
        await retire(fixture, mode)
        let constructed = false
        await expect(
          access.read(() => {
            constructed = true
          }),
        ).rejects.toMatchObject({ name: 'DisplacedGroupHandleError' })
        expect(constructed).toBe(false)
      } finally {
        await fixture.close()
      }
    })
  })
}
