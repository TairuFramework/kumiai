import { expect, test } from 'vitest'

import type { AccountedGroupObservation } from '../src/entry-capability.js'
import { entryCapability } from '../src/entry-capability.js'
import { createMemoryGroupPersistence } from '../src/memory-group-persistence.js'
import { createMemoryTransaction } from '../src/memory-transaction.js'
import { createOwnerQueues } from '../src/owner-queue.js'
import type { AppOutboxEntry, AppSettlementObligation, GroupKey } from '../src/persistence-types.js'
import { createDeterministicAtRestCodec } from './fixtures/at-rest.js'
import {
  createStorageFixture,
  type RegistryStorageFixture,
} from './fixtures/storage-persistence.js'
import { installSeed, makeStorageSeed, nextChange } from './fixtures/storage-seed.js'

async function setup() {
  const groups = createMemoryGroupPersistence({
    db: createMemoryTransaction({ rows: {} }),
    owners: createOwnerQueues(),
    atRest: createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(68) }),
    providerID: 'metadata-clock',
  })
  const seed = await makeStorageSeed({
    id: 'metadata-clock',
    incarnation: 1,
    epoch: 0,
    mode: 'real-mls',
  })
  await installSeed(groups, seed, 'seed')
  const capability = entryCapability(groups)
  if (capability === null) throw new Error('Missing entry capability')
  const versions = () =>
    capability.read(seed.key.groupID, async (reads) => ({
      state: (await reads.state(1))?.version,
      metadata: (await reads.metadata(1))?.version,
    }))
  return { groups, seed, versions }
}

const entry: AppOutboxEntry = {
  seq: 1,
  protocol: 'app',
  prc: 'message',
  data: new Uint8Array([1]),
  lastAttempt: {
    incarnation: 1,
    epoch: 0,
    floor: null,
    attempts: 1,
    publishID: 'publish',
    segment: 0,
    topicID: 'app-topic',
  },
  status: 'accepted',
}

const obligation: AppSettlementObligation = {
  sequenceID: '1',
  attemptID: 'publish',
  topicID: 'app-topic',
  outcome: 'published',
}

test.each(['pending', 'poison', 'cursor'] as const)(
  'a %s-only transition leaves state and metadata versions unchanged',
  async (namespace) => {
    const { groups, seed, versions } = await setup()
    const before = await versions()
    expect(before).toEqual({ state: 1, metadata: 1 })
    const frame = {
      ...seed.key,
      id: 'frame',
      protocol: 'app',
      procedure: 'message',
      topicID: 'app-topic',
      segment: 0,
      position: '1',
    }
    await groups.transition(
      await nextChange(groups, seed.key.groupID, namespace),
      async (stores) => {
        const rows = stores.incarnation(1)
        if (namespace === 'pending') {
          const pending = {
            frame,
            payload: new Uint8Array([1]),
            senderDID: seed.trust.credential.id,
            epoch: 0,
            idempotencyKey: 'message',
          }
          await rows.pending.put([pending])
          expect(await rows.pending.list()).toEqual([pending])
        } else if (namespace === 'poison') {
          const poison = { frame, reason: 'malformed-plaintext', keyConsumed: true }
          await rows.pending.poison([poison])
          expect(await rows.pending.listPoison()).toEqual([poison])
        } else {
          await rows.cursor.save(frame.topicID, frame.position)
          expect(await rows.cursor.load(frame.topicID)).toBe('1')
        }
      },
    )
    expect(await versions()).toEqual(before)
  },
)

test.each(['meta', 'outbox', 'control'] as const)(
  'a %s write still bumps state and metadata versions',
  async (namespace) => {
    const { groups, seed, versions } = await setup()
    expect(await versions()).toEqual({ state: 1, metadata: 1 })
    await groups.transition(
      await nextChange(groups, seed.key.groupID, namespace),
      async (stores) => {
        const rows = stores.incarnation(1)
        if (namespace === 'meta') await rows.meta.putSettlement(entry.seq, obligation)
        else if (namespace === 'outbox') await rows.outbox.put([entry])
        else
          await rows.control.apply(
            { putOutcomes: [{ id: 'outcome', opID: null, at: 1, kind: 'unknown' }] },
            namespace,
          )
      },
    )
    expect(await versions()).toEqual({ state: 2, metadata: 2 })
  },
)

test('outbox settlement is not refused by app metadata', async () => {
  const { groups, seed } = await setup()
  const ports = groups.ports(seed.key)
  await ports.outbox.put(entry)
  const expected = (await groups.readEvidence(seed.key)).source
  if (expected.identity === null) throw new Error('Missing identity')
  await ports.cursor.save('app-topic', '1')
  expect(
    await ports.outbox.recordSettlement(entry.seq, obligation, {
      identity: expected.identity,
      stateVersion: expected.stateVersion,
      attemptID: 'publish',
    }),
  ).toEqual({ recorded: true })
  expect(await ports.outbox.loadSettlement(entry.seq)).toEqual(obligation)
})

for (const terminal of [false, true]) {
  test.each(['envelope', 'null', 'malformed'] as const)(
    `terminal projection survives unreadable state and tombstone (terminal=${terminal}, %s)`,
    async (damage) => {
      const { fixture, groups, key } = await terminalFixture(terminal)
      try {
        await groups.transition(
          await nextChange(groups, key.groupID, 'certify'),
          async (stores) => {
            await stores.incarnation(1).outbox.put([entry])
            await stores.incarnation(1).meta.putSettlement(1, obligation)
          },
        )
        await damageState(fixture, key, damage)
        const observations: Array<AccountedGroupObservation> = []
        fixture.entry().observe(key.groupID, (value) => observations.push(value))
        const privateOpens: Array<string> = []
        fixture.observeCodec((kind, namespace) => {
          if (kind === 'open' && namespace === 'state') privateOpens.push(namespace)
        })
        // Administrative hold changes accounting without loading private state.
        await fixture.entry().finaliseCertifiedApp(key, 1)
        expect(observations.at(-1)?.terminal).toBe(terminal)
        expect(privateOpens, 'administrative accounting must not open private state').toEqual([])
        const metadata = await fixture.entry().read(key.groupID, (reads) => reads.metadata(1))
        expect(metadata).toMatchObject({ ...key, deleted: false, terminal })
        await groups.transition(
          await nextChange(groups, key.groupID, 'tombstone'),
          async (stores) => {
            await stores
              .incarnation(1)
              .state.save({ ...key, version: (metadata?.version ?? 0) + 1, deleted: true })
            const life = await stores.lifetime.load()
            if (life === null) throw new Error('Missing lifetime')
            await stores.lifetime.save({
              ...life,
              activeIncarnation: null,
              revision: life.revision + 1,
              mutationID: 'tombstone',
            })
          },
        )
        expect(await fixture.entry().read(key.groupID, (reads) => reads.metadata(1))).toMatchObject(
          { deleted: true, terminal },
        )
        expect(privateOpens).toEqual([])
      } finally {
        await fixture.close()
      }
    },
  )

  test.each(['commit', 'rollback'] as const)(
    `every accounting path preserves terminal projection (terminal=${terminal}, %s)`,
    async (outcome) => {
      const { fixture, groups, key } = await terminalFixture(terminal)
      try {
        const observations: Array<AccountedGroupObservation> = []
        fixture.entry().observe(key.groupID, (value) => observations.push(value))
        const state = await groups.loadState(key)
        if (state === null || state.deleted) throw new Error('Missing state')
        await groups.transition(
          await nextChange(groups, key.groupID, 'state-save'),
          async (stores) => {
            await stores.incarnation(1).state.save({ ...state, version: state.version + 1 })
          },
        )
        expect(observations.at(-1)?.terminal).toBe(terminal)
        await groups.ports(key).outbox.put(entry)
        expect(observations.at(-1)?.metadata).toContainEqual(expect.objectContaining({ terminal }))
        const before = observations.length
        const fault = fixture.armWorkFault('delayed-flag', 'pending')
        const change = await nextChange(groups, key.groupID, 'delayed-flag')
        const current = await groups.loadState(key)
        if (current === null || current.deleted) throw new Error('Missing state')
        const work = groups
          .transition(change, async (stores) => {
            await stores
              .incarnation(1)
              .state.save({ ...current, version: current.version + 1, terminal: true })
          })
          .catch((error: unknown) => error)
        await fault.rejected
        expect(observations).toHaveLength(before)
        await fault.finish(outcome)
        if (outcome === 'commit') {
          await work
          expect(observations).toHaveLength(before + 1)
          expect(observations.at(-1)?.terminal).toBe(true)
        } else {
          expect(await work).toMatchObject({ name: 'StorageOutcomeUnknownError' })
          expect(observations).toHaveLength(before)
        }
        expect(await fixture.entry().read(key.groupID, (reads) => reads.metadata(1))).toMatchObject(
          { terminal: outcome === 'commit' ? true : terminal },
        )
      } finally {
        await fixture.close()
      }
    },
  )
}

test.each(['missing', 'string', 'conflict'] as const)(
  'missing malformed or conflicting terminal projection refuses (%s)',
  async (damage) => {
    const { fixture, groups, key } = await terminalFixture(true)
    try {
      await fixture.mutateMetadata(key, (value) => {
        const record = value as Record<string, unknown>
        if (damage === 'missing') {
          delete record.terminal
          return record
        }
        return { ...record, terminal: damage === 'string' ? 'true' : false }
      })
      if (damage !== 'conflict')
        await expect(
          fixture.entry().read(key.groupID, (reads) => reads.metadata(1)),
        ).rejects.toMatchObject({ name: 'GroupStateConflictError' })
      await expect(groups.loadState(key)).rejects.toMatchObject({ name: 'GroupStateConflictError' })
    } finally {
      await fixture.close()
    }
  },
)

test('same-incarnation terminal projection cannot revert after private state is lost', async () => {
  const { fixture, groups, key } = await terminalFixture(true)
  try {
    const state = await groups.loadState(key)
    if (state === null || state.deleted) throw new Error('Missing state')
    await damageState(fixture, key, 'null')
    await expect(
      groups.transition(await nextChange(groups, key.groupID, 'resurrect'), async (stores) => {
        await stores
          .incarnation(1)
          .state.save({ ...state, terminal: false, version: state.version + 1 })
      }),
    ).rejects.toMatchObject({ name: 'GroupStateConflictError' })
  } finally {
    await fixture.close()
  }
})

async function terminalFixture(terminal: boolean) {
  const seed = await makeStorageSeed({
    id: 'terminal-projection',
    incarnation: 1,
    epoch: 0,
    mode: 'double',
  })
  const fixture = await createStorageFixture({
    id: seed.key.groupID,
    mode: 'double',
    setup: 'empty',
  })
  const groups = fixture.ports.device.groups
  await installSeed(groups, seed, 'seed')
  if (terminal)
    await groups.transition(
      await nextChange(groups, seed.key.groupID, 'terminal'),
      async (stores) => {
        await stores.incarnation(1).state.save({ ...seed.state, version: 2, terminal: true })
      },
    )
  return { fixture, groups, key: seed.key }
}

async function damageState(
  fixture: RegistryStorageFixture,
  key: GroupKey,
  damage: 'envelope' | 'null' | 'malformed',
) {
  const record = (await fixture.inspectRawBytes()).find(
    (row) => row.namespace === 'state' && row.groupID === key.groupID,
  )
  if (record === undefined) throw new Error('Missing state bytes')
  if (damage === 'envelope')
    await fixture.mutateStoredRecord('state', record.key, () => new Uint8Array([255]))
  else {
    // Reuse the fixture codec to corrupt the inner state while keeping the envelope authentic.
    await fixture.mutateState(key, (value) => ({
      ...value,
      state: damage === 'null' ? null : new Uint8Array([255]),
    }))
  }
}
