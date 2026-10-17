import { expect, test } from 'vitest'

import { entryCapability } from '../src/entry-capability.js'
import { createMemoryGroupPersistence } from '../src/memory-group-persistence.js'
import { createMemoryTransaction } from '../src/memory-transaction.js'
import { createOwnerQueues } from '../src/owner-queue.js'
import type { AppOutboxEntry, AppSettlementObligation } from '../src/persistence-types.js'
import { createDeterministicAtRestCodec } from './fixtures/at-rest.js'
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
