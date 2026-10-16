import {
  commitKeyRotation,
  decodeClientState,
  decodeEpochRosterFact,
  encodeClientState,
  exportGroupInfo,
  restoreGroup,
} from '@kumiai/mls'
import type { CheckpointFactRecord } from '@kumiai/rpc'
import { toB64U } from '@sozai/codec'
import { describe, expect, test, vi } from 'vitest'

import { prepareCheckpointInstallationFromTrust } from '../src/checkpoint-capture.js'
import { readCheckpointCoverage } from '../src/checkpoint-store.js'
import { entryCapability } from '../src/entry-capability.js'
import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'
import { buildRealCommit, createRealGroup } from './fixtures/real-group.js'
import { createRegistryFixture } from './fixtures/registry.js'
import { createStorageFixture } from './fixtures/storage-persistence.js'
import { installSeed, makeStorageSeed, nextChange } from './fixtures/storage-seed.js'

for (const mode of ['real-mls', 'double'] as const) {
  for (const ownership of ['supplied', 'absent'] as const) {
    describe(`checkpoint installation (${mode}, ${ownership} ownership context)`, () => {
      const groupID = 'checkpoint-installation'
      async function setup() {
        const fixture = await createRegistryFixture({
          groupID,
          mode,
          setup: 'empty',
          ownershipContext:
            ownership === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
        })
        const capability = entryCapability(fixture.device.groups)
        if (capability === null) throw new Error('Missing entry')
        const records = () => capability.read(groupID, (reads) => reads.checkpoints())
        const facts = async () => (await records()).filter((row) => row.kind === 'fact')
        return { fixture, records, facts }
      }

      test('every installation co writes fact and debt', async () => {
        const { fixture, records, facts } = await setup()
        try {
          const genesis = await fixture.makeHandle(0)
          const key = await fixture.registry.seed(genesis, { packageUse: null })
          expect(await facts()).toHaveLength(1)
          const access = await fixture.registry.access(groupID)
          const accepted = await fixture.acceptedOrdinary(access)
          await access.adopt(accepted.candidate, accepted.expected, accepted.write)
          expect(await facts()).toHaveLength(2)
          const recovery = await fixture.confirmedRecovery(key, { confirm: true })
          if (!('format' in recovery.record) || recovery.record.switchMutationID === null)
            throw new Error('Missing confirmed switch identity')
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
          const installed = await facts()
          expect(installed).toHaveLength(3)
          const next = installed.find((row) => row.key.incarnation === destination.incarnation)
          expect(next?.kind).toBe('fact')
          expect(next && decodeEpochRosterFact(next.canonical).parentAuthHash).toBeNull()
          expect(next && decodeEpochRosterFact(next.canonical).confirmedTranscriptHash).toBe(
            toB64U(recovery.candidate.state.groupContext.confirmedTranscriptHash),
          )
          expect((await records()).filter((row) => row.kind === 'publication')).toHaveLength(3)
          expect(
            installed.map((row) => decodeEpochRosterFact(row.canonical).installation.mutationID),
          ).toContain(accepted.write.mutationID)
          const snapshot = await records()
          const reopened = await fixture.reopen()
          try {
            const capability = entryCapability(reopened.device.groups)
            if (capability === null) throw new Error('Missing reopened entry')
            expect(await capability.read(groupID, (reads) => reads.checkpoints())).toEqual(snapshot)
          } finally {
            await reopened.close()
          }
        } finally {
          await fixture.close()
        }
      })

      test('Welcome installation retains exact installed transcript', async () => {
        const { fixture, facts } = await setup()
        try {
          const welcome = await fixture.welcomeHistory('ordinary')
          await fixture.registry.seed(welcome.exact, { packageUse: welcome.packageUse })
          const [fact] = await facts()
          expect(fact && decodeEpochRosterFact(fact.canonical).confirmedTranscriptHash).toBe(
            toB64U(welcome.exact.state.groupContext.confirmedTranscriptHash),
          )
          expect(fact && decodeEpochRosterFact(fact.canonical).parentAuthHash).toBeNull()
          const reopened = await fixture.reopen()
          try {
            const capability = entryCapability(reopened.device.groups)
            if (capability === null) throw new Error('Missing reopened entry')
            const records = await capability.read(groupID, (reads) => reads.checkpoints())
            expect(records.find((row) => row.kind === 'fact')).toEqual(fact)
          } finally {
            await reopened.close()
          }
        } finally {
          await fixture.close()
        }
      })

      test('progress save preserves immutable fact', async () => {
        const { fixture, records } = await setup()
        try {
          await fixture.registry.seed(await fixture.makeHandle(0), { packageUse: null })
          const before = await records()
          const access = await fixture.registry.access(groupID)
          await access.mutate(async (handle) => {
            await fixture.advanceSender(handle)
          })
          expect(await records()).toEqual(before)
        } finally {
          await fixture.close()
        }
      })

      test('installed transcript fact survives reopen without publication', async () => {
        const { fixture, records } = await setup()
        let reopened = fixture
        try {
          const handle = await fixture.makeHandle(0)
          await fixture.registry.seed(handle, { packageUse: null })
          const before = await records()
          const fact = before.find((row) => row.kind === 'fact')
          expect(fact?.kind).toBe('fact')
          if (fact?.kind !== 'fact') throw new Error('Missing installed fact')
          expect(decodeEpochRosterFact(fact.canonical).confirmedTranscriptHash).toBe(
            toB64U(handle.state.groupContext.confirmedTranscriptHash),
          )
          reopened = await fixture.reopen()
          const capability = entryCapability(reopened.device.groups)
          if (capability === null) throw new Error('Missing reopened entry')
          expect(await capability.read(groupID, (reads) => reads.checkpoints())).toEqual(before)
        } finally {
          await reopened.close()
        }
      })

      test('unproven candidates never become facts', async () => {
        const { fixture, records } = await setup()
        try {
          await fixture.registry.seed(await fixture.makeHandle(0), { packageUse: null })
          const access = await fixture.registry.access(groupID)
          const before = await records()
          const built = await fixture.acceptedOrdinary(access, { accepted: false })
          await expect(access.adopt(built.candidate, built.expected, built.write)).resolves.toBe(
            'moved',
          )
          await exportGroupInfo({ group: built.candidate })
          expect(await records()).toEqual(before)
          await fixture.installRows({
            key: access.key,
            control: { commitOnceAcceptance: built.write.expected?.acceptance },
          })
          const expected = await access.readControl(async ({ source }) => source)
          built.write.expected = { ...built.write.expected, ...expected }
          fixture.armWorkFault(built.write.mutationID, 'before-commit')
          await expect(access.adopt(built.candidate, expected, built.write)).rejects.toThrow()
          expect(await records()).toEqual(before)
        } finally {
          await fixture.close()
        }
      })

      test('consecutive parent hashes identify retained lineage', async () => {
        const { fixture, facts } = await setup()
        try {
          await fixture.registry.seed(await fixture.makeHandle(0), { packageUse: null })
          const access = await fixture.registry.access(groupID)
          const accepted = await fixture.acceptedOrdinary(access)
          await access.adopt(accepted.candidate, accepted.expected, accepted.write)
          const [previous, next] = (await facts()).map((row) =>
            decodeEpochRosterFact(row.canonical),
          )
          expect(previous).toBeDefined()
          expect(next).toBeDefined()
          expect(next?.parentAuthHash).toBe(previous?.authHash)
          expect(next?.confirmedTranscriptHash).not.toBe(previous?.confirmedTranscriptHash)
        } finally {
          await fixture.close()
        }
      })

      test('pending proof does not expose installation facts', async () => {
        const { fixture, records } = await setup()
        try {
          await fixture.registry.seed(await fixture.makeHandle(0), { packageUse: null })
          const access = await fixture.registry.access(groupID)
          const accepted = await fixture.acceptedOrdinary(access)
          const before = await records()
          const ciphertext = (await fixture.inspectRows()).checkpoints
          const fault = fixture.armWorkFault(accepted.write.mutationID, 'pending')
          const adoption = access.adopt(accepted.candidate, accepted.expected, accepted.write).then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          )
          await fault.rejected
          expect((await fixture.inspectRows()).checkpoints).toEqual(ciphertext)
          await fault.finish('rollback')
          expect(await adoption).toHaveProperty('error')
          expect(await records()).toEqual(before)
        } finally {
          await fixture.close()
        }
      })
    })
  }
}

test('installation finalisation rejects missing or mismatched capture and debt', async () => {
  const fixture = await createStorageFixture({
    id: 'capture-enforcement',
    mode: 'double',
    setup: 'empty',
  })
  try {
    const seed = await makeStorageSeed({
      id: 'capture-enforcement',
      incarnation: 1,
      epoch: 0,
      mode: 'double',
    })
    const groups = fixture.ports.device.groups
    await expect(
      groups.transition(
        await nextChange(groups, seed.key.groupID, 'uncaptured'),
        async (stores) => {
          await stores.lifetime.save({ ...seed.lifetime, mutationID: 'uncaptured' })
          await stores.incarnation(1).state.save(seed.state)
          await stores.trust.save(seed.trust)
        },
      ),
    ).rejects.toThrow('Checkpoint installation')
    expect(await groups.load(seed.key.groupID)).toBeNull()
  } finally {
    await fixture.close()
  }
})

test('checkpoint frames omit the installed transcript', async () => {
  const seed = await makeStorageSeed({
    id: 'checkpoint-public-body',
    incarnation: 1,
    epoch: 0,
    mode: 'real-mls',
  })
  const fact = decodeEpochRosterFact(
    (
      await prepareCheckpointInstallationFromTrust({
        key: seed.key,
        trust: seed.trust,
        confirmedTranscriptHash: seed.confirmedTranscriptHash,
        mutationID: 'body',
        stateVersion: 1,
        previousFact: null,
      })
    ).canonical,
  )
  const { encodeEpochCheckpoint, decodeEpochCheckpoint } = await import('@kumiai/mls')
  const member = fact.members[0]
  if (member === undefined) throw new Error('Missing signer')
  const body = {
    v: 1 as const,
    type: 'kumiai/checkpoint/v1' as const,
    groupID: seed.key.groupID,
    genesisHash: fact.genesisHash,
    ciphersuite: fact.ciphersuite,
    epoch: fact.epoch,
    authHash: fact.authHash,
    parentAuthHash: fact.parentAuthHash,
    keyHash: member.keyHash,
    leafIndex: member.leafIndex,
  }
  expect(
    decodeEpochCheckpoint(encodeEpochCheckpoint(body, new Uint8Array(64))).body,
  ).not.toHaveProperty('confirmedTranscriptHash')
  expect(() =>
    encodeEpochCheckpoint(
      { ...body, ...{ confirmedTranscriptHash: fact.confirmedTranscriptHash } },
      new Uint8Array(64),
    ),
  ).toThrow()
})

test('group history keeps current within count and age bounds', async () => {
  const fixture = await createStorageFixture({
    id: 'checkpoint-retention',
    mode: 'double',
    setup: 'empty',
  })
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
  try {
    const groups = fixture.ports.device.groups
    const seed = await makeStorageSeed({
      id: 'checkpoint-retention',
      incarnation: 1,
      epoch: 0,
      mode: 'double',
    })
    const client = seed.state.state === null ? undefined : decodeClientState(seed.state.state)
    if (client === undefined) throw new Error('Missing state')
    for (let epoch = 0; epoch < 257; epoch++) {
      const incarnation = epoch < 128 ? 1 : 2
      seed.key.incarnation = incarnation
      seed.lifetime.activeIncarnation = seed.lifetime.latestIncarnation = incarnation
      seed.state.incarnation = seed.trust.installed.incarnation = incarnation
      seed.state.epoch = seed.trust.installed.epoch = epoch
      seed.state.version = epoch < 128 ? epoch + 1 : epoch - 127
      client.groupContext.epoch = BigInt(epoch)
      const authenticator = crypto.getRandomValues(new Uint8Array(32))
      client.keySchedule.epochAuthenticator = authenticator
      seed.state.epochAuthenticator = seed.trust.installed.authenticator = authenticator
      seed.state.state = encodeClientState(client)
      seed.trust.spentEpochAuthenticators =
        (await groups.loadTrust(seed.key.groupID))?.spentEpochAuthenticators ?? []
      await installSeed(groups, seed, `retention-${epoch}`)
    }
    const records = () => fixture.entry().read(seed.key.groupID, (reads) => reads.checkpoints())
    const retained = (await records()).filter((row) => row.kind === 'fact')
    expect(retained).toHaveLength(256)
    expect(readCheckpointCoverage(seed.key.groupID, await records())).toMatchObject({
      current: { key: seed.key, epoch: 256 },
      effectiveFloor: 1,
      retained: [
        { key: { ...seed.key, incarnation: 1 }, from: 1, through: 127 },
        { key: seed.key, from: 128, through: 256 },
      ],
      gaps: expect.arrayContaining([
        { key: { ...seed.key, incarnation: 1 }, from: 0, through: 0, reason: 'expired' },
      ]),
    })
    now.mockReturnValue(1000 + 604800000 - 1)
    await groups.transition(
      await nextChange(groups, seed.key.groupID, 'before-expiry'),
      async () => {},
    )
    expect((await records()).filter((row) => row.kind === 'fact')).toHaveLength(256)
    now.mockReturnValue(1000 + 604800000)
    expect(readCheckpointCoverage(seed.key.groupID, await records()).effectiveFloor).toBe(256)
    await groups.transition(await nextChange(groups, seed.key.groupID, 'at-expiry'), async () => {})
    const after = await records()
    expect(after.filter((row) => row.kind === 'fact')).toHaveLength(1)
    expect(after.filter((row) => row.kind === 'publication')).toHaveLength(1)
    expect(readCheckpointCoverage(seed.key.groupID, after)).toMatchObject({
      effectiveFloor: 256,
      retained: [{ key: seed.key, from: 256, through: 256 }],
      gaps: expect.arrayContaining([
        { key: { ...seed.key, incarnation: 1 }, from: 0, through: 127, reason: 'expired' },
        { key: seed.key, from: 128, through: 255, reason: 'expired' },
      ]),
    })
    expect(
      await fixture.entry().read(seed.key.groupID, (reads) => reads.checkpoints()),
    ).not.toContainEqual(retained[0])
    await fixture.reopen()
    expect(await records()).toEqual(after)
  } finally {
    now.mockRestore()
    await fixture.close()
  }
}, 60000)

test('coverage query exposes effective floor and holes', async () => {
  let fixture = await createStorageFixture({
    id: 'checkpoint-holes',
    mode: 'double',
    setup: 'empty',
  })
  try {
    const groups = fixture.ports.device.groups
    const seed = await makeStorageSeed({
      id: 'checkpoint-holes',
      incarnation: 1,
      epoch: 3,
      mode: 'double',
    })
    await installSeed(groups, seed, 'pre-join')
    const client = seed.state.state === null ? undefined : decodeClientState(seed.state.state)
    if (client === undefined) throw new Error('Missing state')
    client.groupContext.epoch = 6n
    seed.state.epoch = seed.trust.installed.epoch = 6
    seed.state.version++
    seed.state.epochAuthenticator =
      seed.trust.installed.authenticator =
      client.keySchedule.epochAuthenticator =
        crypto.getRandomValues(new Uint8Array(32))
    seed.state.state = encodeClientState(client)
    await installSeed(groups, seed, 'skipped')
    seed.trust.spentEpochAuthenticators =
      (await groups.loadTrust(seed.key.groupID))?.spentEpochAuthenticators ?? []
    seed.state.epoch = seed.trust.installed.epoch = 7
    client.groupContext.epoch = 7n
    seed.state.version++
    seed.state.epochAuthenticator =
      seed.trust.installed.authenticator =
      client.keySchedule.epochAuthenticator =
        crypto.getRandomValues(new Uint8Array(32))
    seed.state.state = encodeClientState(client)
    await installSeed(groups, seed, 'consecutive')
    const records = await fixture.entry().read(seed.key.groupID, (reads) => reads.checkpoints())
    const facts = records.filter((row): row is CheckpointFactRecord => row.kind === 'fact')
    const firstFact = facts[0]
    if (firstFact === undefined) throw new Error('Missing retained fact')
    expect(decodeEpochRosterFact(facts[1]?.canonical ?? new Uint8Array()).parentAuthHash).toBeNull()
    expect(
      readCheckpointCoverage(seed.key.groupID, [
        ...records,
        {
          kind: 'fact',
          id: 'uninstalled',
          key: seed.key,
          epoch: 0,
          canonical: new Uint8Array([0]),
          supersededAt: null,
        },
        {
          kind: 'fact',
          id: firstFact.id,
          key: { groupID: 'foreign', incarnation: 1 },
          epoch: 0,
          canonical: new Uint8Array([0]),
          supersededAt: null,
        },
      ]),
    ).toEqual({
      groupID: seed.key.groupID,
      current: { key: seed.key, epoch: 7 },
      effectiveFloor: 3,
      retained: [
        { key: seed.key, from: 3, through: 3 },
        { key: seed.key, from: 6, through: 7 },
      ],
      gaps: [
        { key: seed.key, from: 0, through: 2, reason: 'pre-join' },
        { key: seed.key, from: 4, through: 5, reason: 'skipped' },
      ],
    })
    const reordered = await fixture.inspectRows()
    reordered.checkpoints = new Map([...(reordered.checkpoints ?? [])].reverse())
    await fixture.close()
    fixture = await createStorageFixture({
      id: seed.key.groupID,
      mode: 'double',
      setup: 'empty',
      rows: reordered,
    })
    seed.trust.spentEpochAuthenticators =
      (await fixture.ports.device.groups.loadTrust(seed.key.groupID))?.spentEpochAuthenticators ??
      []
    seed.state.epoch = seed.trust.installed.epoch = 8
    client.groupContext.epoch = 8n
    seed.state.version++
    seed.state.epochAuthenticator =
      seed.trust.installed.authenticator =
      client.keySchedule.epochAuthenticator =
        crypto.getRandomValues(new Uint8Array(32))
    seed.state.state = encodeClientState(client)
    await installSeed(fixture.ports.device.groups, seed, 'reordered-installation')
    const after = await fixture.entry().read(seed.key.groupID, (reads) => reads.checkpoints())
    const coverage = after.find((row) => row.kind === 'coverage')
    expect(coverage?.kind === 'coverage' && coverage.installations.map((row) => row.epoch)).toEqual(
      [3, 6, 7, 8],
    )
    expect(after.find((row) => row.kind === 'fact' && row.epoch === 7)).toMatchObject({
      supersededAt: expect.any(Number),
    })
  } finally {
    await fixture.close()
  }
})

test.each(['receive', 'remove'] as const)(
  '%s commit captures installed context through registry mutation',
  async (kind) => {
    const groupID = 'checkpoint-receive'
    const real = await createRealGroup(1, groupID)
    const member = real.members[0]
    if (member === undefined) throw new Error('Missing receiver')
    const fixture = await createRegistryFixture({
      groupID,
      mode: 'real-mls',
      setup: 'empty',
      identity: member.identity,
      options: { resolveLedgerEntries: real.resolveLedgerEntries },
    })
    try {
      const key = await fixture.registry.seed(
        await restoreGroup({
          state: member.handle.state,
          credential: member.handle.credential,
          ledgerEntries: member.handle.ledgerTokens,
          options: fixture.environment.options,
        }),
        { packageUse: { sourceID: 'receiver', ref: 'receiver-package', kind: 'ordinary' } },
      )
      const access = await fixture.registry.access(groupID)
      const capability = entryCapability(fixture.device.groups)
      if (capability === null) throw new Error('Missing entry')
      const records = () => capability.read(groupID, (reads) => reads.checkpoints())
      const before = await records()
      const commit =
        kind === 'remove'
          ? await buildRealCommit(real, { removes: 0 })
          : (await commitKeyRotation(real.committer.handle)).commitMessage
      await access.mutate(async (handle, persist) => {
        await handle.processMessage(commit, { persist })
      })
      const installed = await fixture.device.groups.loadState(key)
      const after = await records()
      const fact = after.filter((row) => row.kind === 'fact').at(-1)
      expect(fact?.epoch).toBe(kind === 'remove' ? 1 : 2)
      if (
        fact?.kind !== 'fact' ||
        installed === null ||
        installed.deleted ||
        installed.state === null
      )
        throw new Error('Missing received installation')
      expect(decodeEpochRosterFact(fact.canonical).confirmedTranscriptHash).toBe(
        toB64U(
          decodeClientState(installed.state)?.groupContext.confirmedTranscriptHash ??
            new Uint8Array(),
        ),
      )
      expect(installed.terminal).toBe(kind === 'remove')
      const signable =
        !installed.terminal &&
        after.some((row) => row.kind === 'publication' && row.factID === fact.id)
      expect(signable).toBe(kind !== 'remove')
      expect(after.filter((row) => row.kind === 'publication')).toHaveLength(
        before.filter((row) => row.kind === 'publication').length + (kind === 'remove' ? 0 : 1),
      )
      await expect(
        access.mutate(async (handle, persist) => {
          await handle.processMessage(new Uint8Array([0]), { persist })
        }),
      ).rejects.toThrow()
      expect(await records()).toEqual(after)
    } finally {
      await fixture.close()
    }
  },
)

test.each(['copy', 'transcript', 'mutation', 'version', 'debt', 'removed-debt'] as const)(
  'installation refuses forged %s capture',
  async (kind) => {
    const groupID = 'checkpoint-forgery'
    const fixture = await createStorageFixture({ id: groupID, mode: 'double', setup: 'empty' })
    try {
      const seed = await makeStorageSeed({ id: groupID, incarnation: 1, epoch: 0, mode: 'double' })
      seed.state.terminal = kind === 'removed-debt'
      const groups = fixture.ports.device.groups
      const fact = await prepareCheckpointInstallationFromTrust({
        key: seed.key,
        trust: seed.trust,
        confirmedTranscriptHash:
          kind === 'transcript' ? new Uint8Array(32) : seed.confirmedTranscriptHash,
        mutationID: kind === 'mutation' ? 'wrong' : 'forgery',
        stateVersion: kind === 'version' ? 2 : 1,
        previousFact: null,
      })
      await expect(
        groups.transition(await nextChange(groups, groupID, 'forgery'), async (stores) => {
          await stores.lifetime.save({ ...seed.lifetime, mutationID: 'forgery' })
          await stores.incarnation(1).state.save(seed.state)
          await stores.trust.save(seed.trust)
          await stores.checkpoints.put(kind === 'copy' ? structuredClone(fact) : fact)
          if (kind !== 'debt')
            await stores.checkpoints.put({
              kind: 'publication',
              id: `publication:${fact.id}`,
              key: seed.key,
              factID: fact.id,
              frame: null,
              publishID: null,
              accepted: false,
              nextHeartbeatAt: null,
            })
        }),
      ).rejects.toThrow('Checkpoint installation')
      expect(await groups.load(groupID)).toBeNull()
    } finally {
      await fixture.close()
    }
  },
)

test.each(['fact', 'coverage', 'remove', 'remove-coverage', 'debt'] as const)(
  'ordinary checkpoint writes cannot alter installed %s authority',
  async (kind) => {
    const groupID = 'checkpoint-authority'
    const fixture = await createStorageFixture({ id: groupID, mode: 'double' })
    try {
      const groups = fixture.ports.device.groups
      const records = await fixture.entry().read(groupID, (reads) => reads.checkpoints())
      const fact = records.find((row) => row.kind === 'fact')
      const coverage = records.find((row) => row.kind === 'coverage')
      if (fact?.kind !== 'fact' || coverage?.kind !== 'coverage')
        throw new Error('Missing protected authority')
      await expect(
        groups.transition(await nextChange(groups, groupID, 'overwrite'), async (stores) => {
          if (kind === 'fact')
            await stores.checkpoints.put({ ...fact, canonical: new Uint8Array([1]) })
          if (kind === 'coverage')
            await stores.checkpoints.put({ ...coverage, effectiveFloor: 0, gaps: [] })
          if (kind === 'remove') await stores.checkpoints.remove([fact.id])
          if (kind === 'remove-coverage') await stores.checkpoints.remove([coverage.id])
          if (kind === 'debt')
            await stores.checkpoints.put({
              kind: 'publication',
              id: `publication:${fact.id}`,
              key: fact.key,
              factID: 'forged',
              frame: null,
              publishID: null,
              accepted: false,
              nextHeartbeatAt: null,
            })
        }),
      ).rejects.toThrow('Checkpoint')
      expect(await fixture.entry().read(groupID, (reads) => reads.checkpoints())).toEqual(records)
    } finally {
      await fixture.close()
    }
  },
)
