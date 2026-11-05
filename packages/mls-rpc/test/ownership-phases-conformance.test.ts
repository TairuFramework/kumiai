import { decodeClientState, encodeClientState } from '@kumiai/mls'
import { testOwnershipPhasesConformance } from '@kumiai/rpc-conformance'
import { expect, test } from 'vitest'

import { createOwnerQueues } from '../src/owner-queue.js'
import { PersistencePhaseError } from '../src/persistence-errors.js'
import type { GroupStores, MemoryTransaction } from '../src/persistence-types.js'
import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'
import { createStorageFixture, writeSideRow } from './fixtures/storage-persistence.js'
import { makeStorageSeed } from './fixtures/storage-seed.js'

for (const mode of ['real-mls', 'double'] as const) {
  const params = {
    label: mode,
    async lowerEpochCandidate(groupID: string) {
      const candidate = await makeStorageSeed({ id: groupID, incarnation: 1, epoch: 2, mode })
      const client =
        candidate.state.state === null ? undefined : decodeClientState(candidate.state.state)
      if (client === undefined) throw new Error('Missing lower-epoch state')
      // Evict retained epochs so receive-progress checks cannot mask epoch monotonicity.
      client.historicalReceiverData.clear()
      candidate.state.state = encodeClientState(client)
      return candidate
    },
    ownershipContext: createAsyncLocalOwnershipContext,
    writeSideRow,
    createFixture: (
      id: string,
      options?: Pick<Parameters<typeof createStorageFixture>[0], 'effects' | 'ownershipContext'>,
    ) => createStorageFixture({ id, mode, ...options }),
  }
  testOwnershipPhasesConformance<MemoryTransaction>(params)
}

test('retry-attempt capability expiry rejects old stores before fresh work', async () => {
  const owners = createOwnerQueues()
  const hooks: Array<string> = []
  await owners.run('transition', { groupID: 'retry', ownerDID: null }, async (entry) => {
    await entry.enter('prepare')
    await entry.enter('work')
    entry.onCommit(() => hooks.push('stale-commit'))
    entry.onRollback(() => hooks.push('rolled-back'))
    entry.afterRelease(() => hooks.push('stale-release'))
    const old = entry.attempt()
    const oldStore = { load: () => entry.operation(old, async () => 'old') }
    expect(await oldStore.load()).toBe('old')
    await entry.enter('outcome')
    entry.settle('rolled-back')
    expect(hooks).toEqual(['rolled-back'])
    await entry.retryRolledBack()
    await expect(oldStore.load()).rejects.toBeInstanceOf(PersistencePhaseError)
    expect(old.revoked).toBe(true)
    const current = entry.attempt()
    expect(await entry.operation(current, async () => 'fresh')).toBe('fresh')
    entry.onCommit(() => hooks.push('fresh-commit'))
    await entry.enter('outcome')
    entry.settle('committed')
  })
  for (let i = 0; i < 20; i++) await Promise.resolve()
  expect(hooks).toEqual(['rolled-back', 'fresh-commit'])
})

for (const mode of ['real-mls', 'double'] as const) {
  test(`rolled-back certification expires actual prepare stores during retry (${mode})`, async () => {
    const f = await createStorageFixture({ id: crypto.randomUUID(), mode })
    try {
      const life = (await f.ports.device.groups.list())[0]
      if (life?.activeIncarnation == null) throw new Error('Missing active source')
      const key = { groupID: life.groupID, incarnation: life.activeIncarnation }
      const state = await f.ports.device.groups.loadState(key)
      if (state === null || state.deleted) throw new Error('Missing state')
      const outbox = f.ports.device.groups.ports(key).outbox
      await outbox.put({
        seq: 0,
        protocol: 'chat',
        prc: 'posted',
        status: 'accepted',
        data: new TextEncoder().encode(
          '{"v":2,"payload":{"typ":"event","prc":"posted","data":{}}}',
        ),
        lastAttempt: {
          incarnation: key.incarnation,
          epoch: state.epoch,
          segment: state.epoch,
          topicID: 'sealed-topic',
          publishID: 'attempt',
          attempts: 1,
          floor: null,
        },
      })
      const source = (await f.ports.device.groups.readEvidence(key)).source
      if (source.identity === null) throw new Error('Missing identity')
      let old: GroupStores<MemoryTransaction> | undefined
      f.onPhase('prepare', () => {
        old = f.constructPrepareStores(key)
      })
      let checked = false
      f.onPhase('retry', async () => {
        if (old === undefined) throw new Error('Missing old stores')
        await expect(old.lifetime.load()).rejects.toBeInstanceOf(PersistencePhaseError)
        checked = true
      })
      const fault = f.armNextWorkFault('pending')
      const pending = outbox.recordSettlement(
        0,
        { sequenceID: 'ack', attemptID: 'attempt', topicID: 'sealed-topic', outcome: 'published' },
        { identity: source.identity, stateVersion: source.stateVersion, attemptID: 'attempt' },
      )
      await fault.rejected
      await fault.finish('rollback')
      expect(await pending).toEqual({ recorded: true })
      expect(checked).toBe(true)
    } finally {
      await f.close()
    }
  })
}

for (const mode of ['real-mls', 'double'] as const) {
  test(`retry rechecks captured expectations and returns entry-missing without mutation (${mode})`, async () => {
    const f = await createStorageFixture({ id: crypto.randomUUID(), mode })
    try {
      const life = (await f.ports.device.groups.list())[0]
      if (life?.activeIncarnation == null) throw new Error('Missing source')
      const key = { groupID: life.groupID, incarnation: life.activeIncarnation }
      const state = await f.ports.device.groups.loadState(key)
      if (state === null || state.deleted) throw new Error('Missing state')
      const outbox = f.ports.device.groups.ports(key).outbox
      await outbox.put({
        seq: 0,
        protocol: 'chat',
        prc: 'posted',
        status: 'accepted',
        data: new TextEncoder().encode(
          '{"v":2,"payload":{"typ":"event","prc":"posted","data":{}}}',
        ),
        lastAttempt: {
          incarnation: key.incarnation,
          epoch: state.epoch,
          segment: state.epoch,
          topicID: 'topic',
          publishID: 'attempt',
          attempts: 1,
          floor: null,
        },
      })
      const source = (await f.ports.device.groups.readEvidence(key)).source
      if (source.identity === null) throw new Error('Missing identity')
      let before: Awaited<ReturnType<typeof f.inspectRows>> | undefined
      f.onPhase('retry', async () => {
        const row = (await f.inspectRawBytes()).find(
          (row) => row.namespace === 'outbox' && row.recordID === '0',
        )
        if (row === undefined) throw new Error('Missing outbox row')
        await f.deleteCommittedRow('outbox', row.key)
        before = await f.inspectRows()
      })
      const fault = f.armNextWorkFault('pending')
      const pending = outbox.recordSettlement(
        0,
        { sequenceID: 'ack', attemptID: 'attempt', topicID: 'topic', outcome: 'published' },
        { identity: source.identity, stateVersion: source.stateVersion, attemptID: 'attempt' },
      )
      await fault.rejected
      await fault.finish('rollback')
      expect(await pending).toEqual({ recorded: false, reason: 'entry-missing' })
      expect(await f.inspectRows()).toEqual(before)
      expect(await outbox.loadSettlement(0)).toBeNull()
    } finally {
      await f.close()
    }
  })
}

test('retry refuses unsettled or committed outcomes', async () => {
  const owners = createOwnerQueues()
  await owners.run('transition', { groupID: 'retry-refusal', ownerDID: null }, async (entry) => {
    await entry.enter('prepare')
    await entry.enter('work')
    await expect(entry.retryRolledBack()).rejects.toBeInstanceOf(PersistencePhaseError)
    await entry.enter('outcome')
    entry.settle('committed')
    await expect(entry.retryRolledBack()).rejects.toBeInstanceOf(PersistencePhaseError)
  })
})

test('memory command cancellation revokes continuations and releases without a provider outcome', async () => {
  const { sourceExecutorFixture } = await import('./fixtures/source-executor.js')
  const { deferred } = await import('../src/runtime.js')
  const f = await sourceExecutorFixture()
  await f.control.admit(f.seed.key, 'source')
  const entered = deferred<void>()
  const late = deferred<void>()
  const cancellation = new AbortController()
  let authority: { assertLive(): void } | undefined
  let effects = 0
  const pending = f.entry.command(
    f.seed.key.groupID,
    async (attempt) => {
      authority = attempt
      entered.resolve()
      await late.promise
      attempt.assertLive()
      effects++
      return 'late'
    },
    { signal: cancellation.signal },
  )
  const rejected = expect(pending).rejects.toBeInstanceOf(PersistencePhaseError)
  try {
    await entered.promise
    cancellation.abort(new Error('Command cancelled'))
    await rejected
    expect(() => authority?.assertLive()).toThrow(PersistencePhaseError)
    await expect(f.persistence.groups.load(f.seed.key.groupID)).resolves.toMatchObject({
      activeIncarnation: 1,
    })
  } finally {
    late.resolve()
  }
  await f.flushReady()
  expect(effects).toBe(0)
})
