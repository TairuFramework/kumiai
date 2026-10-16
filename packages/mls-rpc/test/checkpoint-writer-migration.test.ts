import {
  checkpointAuthHash,
  checkpointGenesisHash,
  checkpointKeyHash,
  commitKeyRotation,
  decodeClientState,
  decodeEpochRosterFact,
  encodeEpochRosterFact,
  restoreGroup,
} from '@kumiai/mls'
import { toB64U } from '@sozai/codec'
import { describe, expect, test, vi } from 'vitest'

import * as checkpointCapture from '../src/checkpoint-capture.js'
import {
  prepareCheckpointInstallation,
  prepareCheckpointInstallationFromTrust,
} from '../src/checkpoint-capture.js'
import { entryCapability } from '../src/entry-capability.js'
import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'
import { createRegistryFixture } from './fixtures/registry.js'
import { createSealedControlAccess } from './fixtures/sealed-control-access.js'
import { memoryModel, restoreMemoryControlHandle } from './fixtures/sealed-memory-mls.js'
import { createStorageFixture } from './fixtures/storage-persistence.js'
import {
  installSeed,
  makeStorageSeed,
  storageTranscript,
  writeInstallationCheckpoint,
} from './fixtures/storage-seed.js'

for (const mode of ['real-mls', 'double'] as const) {
  for (const ownership of ['supplied', 'absent'] as const) {
    describe(`checkpoint writer migration (${mode}, ${ownership} ownership context)`, () => {
      async function setup() {
        const id = 'installation-migration'
        const fixture = await createStorageFixture({
          id,
          mode,
          setup: 'empty',
          ownershipContext:
            ownership === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
        })
        const seed = await makeStorageSeed({ id, incarnation: 1, epoch: 0, mode })
        return { fixture, seed, groups: fixture.ports.device.groups }
      }

      test('direct successful installations prepare matching fact and debt', async () => {
        const { fixture, seed, groups } = await setup()
        try {
          await installSeed(groups, seed, 'direct-install')
          const records = await fixture
            .entry()
            .read(seed.key.groupID, (reads) => reads.checkpoints())
          const facts = records.filter((record) => record.kind === 'fact')
          expect(facts).toHaveLength(1)
          const record = facts[0]
          if (record === undefined) throw new Error('Missing installation fact')
          const fact = decodeEpochRosterFact(record.canonical)
          expect(record.key).toEqual(seed.key)
          expect(record.epoch).toBe(seed.trust.installed.epoch)
          expect(fact.key).toEqual(seed.key)
          expect(record.canonical).toEqual(encodeEpochRosterFact(fact))
          expect(fact.genesisHash).toBe(checkpointGenesisHash(seed.trust.genesisAnchor))
          expect(fact.authHash).toBe(
            checkpointAuthHash({
              groupID: seed.key.groupID,
              genesisHash: fact.genesisHash,
              epoch: seed.state.epoch,
              epochAuthenticator: seed.state.epochAuthenticator,
            }),
          )
          expect(fact.members).toEqual(
            seed.trust.signerTree.flatMap((node, index) =>
              node?.nodeType !== 1
                ? []
                : [
                    {
                      signerDID: seed.trust.credential.id,
                      keyHash: checkpointKeyHash(node.leaf.signaturePublicKey),
                      leafIndex: index / 2,
                      signaturePublicKey: toB64U(node.leaf.signaturePublicKey),
                    },
                  ],
            ),
          )
          expect(fact.installation).toEqual({ mutationID: 'direct-install', stateVersion: 1 })
          expect(records.filter((row) => row.kind === 'publication')).toEqual([
            expect.objectContaining({
              key: seed.key,
              factID: record.id,
              accepted: false,
              frame: null,
            }),
          ])
        } finally {
          await fixture.close()
        }
      })

      test('registry direct installations prepare matching fact and debt', async () => {
        const id = 'registry-installation-migration'
        const fixture = await createRegistryFixture({
          groupID: id,
          mode,
          setup: 'empty',
          ownershipContext:
            ownership === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
        })
        try {
          const seed = await makeStorageSeed({
            id,
            incarnation: 1,
            epoch: 0,
            mode,
            identity: fixture.identity,
            options: fixture.environment.options,
          })
          const bytes = seed.state.state
          seed.state.state = null
          await expect(
            fixture.installRows({ key: seed.key, state: seed.state, trust: seed.trust }),
          ).rejects.toThrow('Missing installed GroupContext')
          expect(await fixture.device.groups.load(id)).toBeNull()
          seed.state.state = bytes
          await fixture.installRows({ key: seed.key, state: seed.state, trust: seed.trust })
          const capability = entryCapability(fixture.device.groups)
          if (capability === null) throw new Error('Missing fixture entry')
          const records = await capability.read(id, (reads) => reads.checkpoints())
          expect(
            records.filter((record) => record.kind !== 'coverage').map((record) => record.kind),
          ).toEqual(['fact', 'publication', 'branch-coverage'])
          const fact = records[0]
          if (fact?.kind !== 'fact') throw new Error('Missing registry installation fact')
          expect(records.find((row) => row.kind === 'branch-coverage')).toMatchObject({
            key: seed.key,
            startedEpoch: seed.state.epoch,
            startedAuthHash: decodeEpochRosterFact(fact.canonical).authHash,
          })
          expect(decodeEpochRosterFact(fact.canonical)).toMatchObject({
            key: seed.key,
            installation: {
              mutationID: (await fixture.device.groups.load(id))?.mutationID,
              stateVersion: 1,
            },
            confirmedTranscriptHash: toB64U(seed.confirmedTranscriptHash),
          })
          expect(records[1]).toMatchObject({
            key: seed.key,
            factID: fact.id,
            accepted: false,
            frame: null,
          })
        } finally {
          await fixture.close()
        }
      })

      test('trust only fixtures supply exact installed transcript', async () => {
        const { fixture, seed, groups } = await setup()
        try {
          if (seed.state.state === null) throw new Error('Missing installed state')
          const client = decodeClientState(seed.state.state)
          if (client === undefined) throw new Error('Invalid installed state')
          await installSeed(groups, seed, 'exact-transcript')
          await fixture.reopen()
          const records = await fixture
            .entry()
            .read(seed.key.groupID, (reads) => reads.checkpoints())
          const record = records.find((row) => row.kind === 'fact')
          expect(record?.kind).toBe('fact')
          if (record?.kind !== 'fact') throw new Error('Missing reopened fact')
          expect(decodeEpochRosterFact(record.canonical).confirmedTranscriptHash).toBe(
            toB64U(client.groupContext.confirmedTranscriptHash),
          )
        } finally {
          await fixture.close()
        }
      })

      test('changed epoch and authenticator capture through direct adoption', async () => {
        const { fixture, seed, groups } = await setup()
        try {
          await installSeed(groups, seed, 'initial')
          if (seed.state.state === null) throw new Error('Missing state')
          const client = decodeClientState(seed.state.state)
          if (client === undefined) throw new Error('Invalid state')
          const restore = mode === 'real-mls' ? restoreGroup : restoreMemoryControlHandle
          const handle = await restore({
            state: client,
            credential: seed.trust.credential,
            ledgerEntries: seed.state.ledger,
          })
          const next =
            mode === 'real-mls'
              ? (await commitKeyRotation(handle)).newGroup
              : await restore({
                  state: structuredClone(handle.state),
                  credential: handle.credential,
                  ledgerEntries: handle.ledgerTokens,
                })
          if (mode === 'double') {
            const model = memoryModel(next)
            await model.adopt(model.buildCommit([]))
          }
          const host = await createSealedControlAccess(
            groups,
            seed.key,
            () => {},
            () => {},
            handle,
            restore,
          )
          await host.access.replace(next, () => ({ mutationID: 'direct-adoption', changes: {} }))
          const records = await fixture
            .entry()
            .read(seed.key.groupID, (reads) => reads.checkpoints())
          const facts = records
            .filter((row) => row.kind === 'fact')
            .sort((a, b) => a.epoch - b.epoch)
          expect(facts).toHaveLength(2)
          const first = facts[0]
          const last = facts[1]
          if (first === undefined || last === undefined) throw new Error('Missing adoption facts')
          const decoded = decodeEpochRosterFact(last.canonical)
          expect(decoded.parentAuthHash).toBe(decodeEpochRosterFact(first.canonical).authHash)
          expect(decoded.confirmedTranscriptHash).toBe(
            toB64U(next.state.groupContext.confirmedTranscriptHash),
          )
          expect(decoded.installation).toEqual({ mutationID: 'direct-adoption', stateVersion: 2 })
          expect(decoded.epoch).toBe(Number(next.epoch))
          expect(records.filter((row) => row.kind === 'publication')).toHaveLength(2)
        } finally {
          await fixture.close()
        }
      })

      test('ratchet progress preserves fact without recapture', async () => {
        const { fixture, seed, groups } = await setup()
        try {
          await installSeed(groups, seed, 'before-progress')
          if (seed.state.state === null) throw new Error('Missing state')
          const client = decodeClientState(seed.state.state)
          if (client === undefined) throw new Error('Invalid state')
          const restore = mode === 'real-mls' ? restoreGroup : restoreMemoryControlHandle
          const handle = await restore({
            state: client,
            credential: seed.trust.credential,
            ledgerEntries: seed.state.ledger,
          })
          const host = await createSealedControlAccess(
            groups,
            seed.key,
            () => {},
            () => {},
            handle,
            restore,
          )
          const before = await fixture
            .entry()
            .read(seed.key.groupID, (reads) => reads.checkpoints())
          expect(before.filter((row) => row.kind === 'fact')).toHaveLength(1)
          const preparation = vi.spyOn(checkpointCapture, 'prepareCheckpointInstallation')
          try {
            await host.access.mutate(async (current) => {
              await current.encrypt(new Uint8Array([7]))
            })
            expect(preparation).not.toHaveBeenCalled()
          } finally {
            preparation.mockRestore()
          }
          const after = await groups.loadState(seed.key)
          if (after === null || after.deleted) throw new Error('Missing progressed state')
          expect(after.epoch).toBe(seed.state.epoch)
          expect(after.epochAuthenticator).toEqual(seed.state.epochAuthenticator)
          expect(after.version).toBe(2)
          expect(after.state).not.toEqual(seed.state.state)
          expect(
            await fixture.entry().read(seed.key.groupID, (reads) => reads.checkpoints()),
          ).toEqual(before)
        } finally {
          await fixture.close()
        }
      })
    })
  }
}

test('handle and explicit public context prepare identical facts without signing authority', async () => {
  const seed = await makeStorageSeed({
    id: 'capture-helpers',
    incarnation: 1,
    epoch: 0,
    mode: 'real-mls',
  })
  if (seed.state.state === null) throw new Error('Missing state')
  const client = decodeClientState(seed.state.state)
  if (client === undefined) throw new Error('Invalid state')
  const handle = await restoreGroup({
    state: client,
    credential: seed.trust.credential,
    ledgerEntries: seed.state.ledger,
  })
  const params = { key: seed.key, mutationID: 'prepared', stateVersion: 1, previousFact: null }
  const explicit = await prepareCheckpointInstallationFromTrust({
    ...params,
    trust: seed.trust,
    confirmedTranscriptHash: seed.confirmedTranscriptHash,
  })
  expect(await prepareCheckpointInstallation({ ...params, handle })).toEqual(explicit)
  expect(decodeEpochRosterFact(explicit.canonical).parentAuthHash).toBeNull()
  expect(explicit).not.toHaveProperty('signature')
})

test.each([
  'groupID',
  'installed groupID',
  'incarnation',
  'invalid incarnation',
  'credential',
] as const)('capture rejects inconsistent public binding: %s', async (field) => {
  const seed = await makeStorageSeed({
    id: 'capture-binding',
    incarnation: 1,
    epoch: 0,
    mode: 'double',
  })
  if (field === 'groupID') seed.trust.groupID = 'other'
  if (field === 'installed groupID') seed.trust.installed.groupID = 'other'
  if (field === 'incarnation') seed.trust.installed.incarnation = 2
  if (field === 'invalid incarnation') {
    seed.key.incarnation = 0
    seed.trust.installed.incarnation = 0
  }
  if (field === 'credential') {
    const node = seed.trust.signerTree[0]
    if (node?.nodeType !== 1) throw new Error('Missing leaf')
    node.leaf.credential = { credentialType: 1, identity: new Uint8Array() }
  }
  await expect(
    prepareCheckpointInstallationFromTrust({
      key: seed.key,
      trust: seed.trust,
      confirmedTranscriptHash: seed.confirmedTranscriptHash,
      mutationID: 'invalid',
      stateVersion: 1,
      previousFact: null,
    }),
  ).rejects.toThrow()
})

test.each(['consecutive', 'skipped', 'group', 'incarnation', 'genesis', 'ciphersuite'] as const)(
  'preparation binds consecutive parents only: %s',
  async (binding) => {
    const seed = await makeStorageSeed({
      id: 'capture-lineage',
      incarnation: 1,
      epoch: 3,
      mode: 'double',
    })
    const params = {
      key: seed.key,
      trust: seed.trust,
      confirmedTranscriptHash: seed.confirmedTranscriptHash,
      mutationID: 'current',
      stateVersion: 2,
      previousFact: null,
    }
    const previous = decodeEpochRosterFact(
      (
        await prepareCheckpointInstallationFromTrust({
          ...params,
          trust: { ...seed.trust, installed: { ...seed.trust.installed, epoch: 2 } },
          mutationID: 'previous',
          stateVersion: 1,
        })
      ).canonical,
    )
    if (binding === 'skipped') previous.epoch = 1
    if (binding === 'group') previous.key.groupID = 'other-group'
    if (binding === 'incarnation') previous.key.incarnation = 2
    if (binding === 'genesis') previous.genesisHash = toB64U(new Uint8Array(32))
    if (binding === 'ciphersuite') previous.ciphersuite = 3
    const fact = await prepareCheckpointInstallationFromTrust({
      ...params,
      previousFact: encodeEpochRosterFact(previous),
    })
    expect(decodeEpochRosterFact(fact.canonical).parentAuthHash).toBe(
      binding === 'consecutive' ? previous.authHash : null,
    )
  },
)

test.each(['anchor', 'suite'] as const)(
  'handle capture rejects missing public context: %s',
  async (field) => {
    const seed = await makeStorageSeed({
      id: 'missing-context',
      incarnation: 1,
      epoch: 0,
      mode: 'real-mls',
    })
    if (seed.state.state === null) throw new Error('Missing state')
    const client = decodeClientState(seed.state.state)
    if (client === undefined) throw new Error('Invalid state')
    const handle = await restoreGroup({
      state: client,
      credential: seed.trust.credential,
      ledgerEntries: seed.state.ledger,
    })
    if (field === 'anchor') handle.state.groupContext.extensions = []
    else (handle.state.groupContext as { cipherSuite: number }).cipherSuite = 65535
    await expect(
      prepareCheckpointInstallation({
        key: seed.key,
        handle,
        mutationID: 'missing-context',
        stateVersion: 1,
        previousFact: null,
      }),
    ).rejects.toThrow('Missing checkpoint group context')
  },
)

test('trust only fixture refuses missing or malformed installed context', () => {
  expect(() => storageTranscript(null)).toThrow('Missing installed GroupContext')
  expect(() => storageTranscript(new Uint8Array())).toThrow()
})

test('storage only removed installation retains its fact without publication', async () => {
  const seed = await makeStorageSeed({
    id: 'removed-installation',
    incarnation: 1,
    epoch: 0,
    mode: 'double',
  })
  if (seed.state.state === null) throw new Error('Missing state')
  const client = decodeClientState(seed.state.state)
  if (client === undefined) throw new Error('Invalid state')
  client.ratchetTree = []
  client.groupActiveState = { kind: 'removedFromGroup' }
  seed.state.state = null
  seed.state.terminal = true
  seed.trust.signerTree = []
  const fixture = await createStorageFixture({
    id: seed.key.groupID,
    mode: 'double',
    setup: 'empty',
  })
  try {
    await installSeed(fixture.ports.device.groups, seed, 'removed')
    const records = await fixture.entry().read(seed.key.groupID, (reads) => reads.checkpoints())
    expect(
      records.filter((record) => record.kind !== 'coverage').map((record) => record.kind),
    ).toEqual(['fact', 'branch-coverage'])
    const fact = records[0]
    if (fact?.kind !== 'fact') throw new Error('Missing removed installation fact')
    expect(records.find((row) => row.kind === 'branch-coverage')).toMatchObject({
      key: seed.key,
      startedEpoch: seed.state.epoch,
      startedAuthHash: decodeEpochRosterFact(fact.canonical).authHash,
    })
    expect(decodeEpochRosterFact(fact.canonical)).toMatchObject({
      members: [],
      confirmedTranscriptHash: toB64U(client.groupContext.confirmedTranscriptHash),
    })
  } finally {
    await fixture.close()
  }
})

test('fixture checkpoint capture requires installed trust', async () => {
  const seed = await makeStorageSeed({
    id: 'missing-installed-trust',
    incarnation: 1,
    epoch: 0,
    mode: 'double',
  })
  const fixture = await createStorageFixture({
    id: seed.key.groupID,
    mode: 'double',
    setup: 'empty',
  })
  try {
    await expect(
      fixture.ports.device.groups.transition(
        { groupID: seed.key.groupID, mutationID: 'missing-trust', expected: null },
        (stores) =>
          writeInstallationCheckpoint(stores, {
            key: seed.key,
            confirmedTranscriptHash: seed.confirmedTranscriptHash,
            mutationID: 'missing-trust',
            stateVersion: 1,
          }),
      ),
    ).rejects.toThrow('Missing installed trust')
    expect(await fixture.ports.device.groups.load(seed.key.groupID)).toBeNull()
  } finally {
    await fixture.close()
  }
})

test('shared fixture reads transcript from captured state bytes', async () => {
  const seed = await makeStorageSeed({
    id: 'captured-public-context',
    incarnation: 1,
    epoch: 0,
    mode: 'double',
  })
  const fixture = await createStorageFixture({
    id: seed.key.groupID,
    mode: 'double',
    setup: 'empty',
  })
  try {
    expect(await fixture.ports.readConfirmedTranscriptHash(seed.state.state)).toEqual(
      seed.confirmedTranscriptHash,
    )
    expect(await fixture.ports.device.groups.load(seed.key.groupID)).toBeNull()
  } finally {
    await fixture.close()
  }
})
