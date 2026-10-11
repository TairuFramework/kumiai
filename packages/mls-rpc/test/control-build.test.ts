import { decodeClientState, encodeClientState, restoreGroup } from '@kumiai/mls'
import {
  type AdoptionExpected,
  asLogPosition,
  type ControlSlot,
  type GroupCrypto,
  type HostBuilt,
  type Operation,
} from '@kumiai/rpc'
import { expect, test } from 'vitest'

import { simpleHandleAccess } from '../src/access.js'
import { createControlBuildPort, createPersistenceBuildSaver } from '../src/control-build.js'
import { decodeControlJournal, encodeControlJournal } from '../src/control-journal.js'
import { memoryFaults } from '../src/memory-faults.js'
import { createMemoryGroupPersistence } from '../src/memory-group-persistence.js'
import { createMemoryTransaction } from '../src/memory-transaction.js'
import { createOwnerQueues } from '../src/owner-queue.js'
import { createDeterministicAtRestCodec } from './fixtures/at-rest.js'
import { installSeed, makeStorageSeed } from './fixtures/storage-seed.js'

const intent: Operation & { stage: 'intent' } = {
  id: 'operation',
  kind: 'rotation',
  revokes: false,
  body: new Uint8Array(),
  seq: 1,
  enqueuedAt: 1,
  deadline: 30_001,
  stage: 'intent',
}

async function setup() {
  const key = { groupID: 'build', incarnation: 1 }
  const db = createMemoryTransaction({ rows: {} })
  let inTransaction = false
  const groups = createMemoryGroupPersistence({
    owners: createOwnerQueues(),
    db: {
      ...db,
      async transact(scope, work, options) {
        return db.transact(
          scope,
          async (tx) => {
            inTransaction = true
            try {
              return await work(tx)
            } finally {
              inTransaction = false
            }
          },
          options,
        )
      },
    },
    atRest: createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(67) }),
    providerID: 'build',
  })
  const seed = await makeStorageSeed({
    id: key.groupID,
    incarnation: 1,
    epoch: 0,
    mode: 'real-mls',
  })
  await installSeed(groups, seed, 'seed')
  const state = decodeClientState(seed.state.state!)
  if (state == null) throw new Error('missing state')
  const handle = await restoreGroup({
    state,
    credential: seed.trust.credential,
    ledgerEntries: seed.state.ledger,
  })
  const control = groups.ports(key).control
  await control.apply({ putOperations: [intent], cursor: { position: null, epoch: 0 } }, 'intent')
  const access = simpleHandleAccess({
    handle: () => handle,
    adopt: () => {},
    stateVersion: async () => (await groups.loadState(key))!.version,
  })
  const saver = createPersistenceBuildSaver({ persistence: groups, key })
  let buildCalls = 0
  let frameCalls = 0
  const build = async (_op: Operation, supplied: typeof handle): Promise<HostBuilt> => {
    expect(inTransaction).toBe(false)
    expect(supplied).toBe(handle)
    buildCalls++
    return {
      commit: new Uint8Array([1, 2]),
      epoch: Number(handle.epoch),
      incarnation: 1,
      authenticatorBefore: handle.state.keySchedule.epochAuthenticator.slice(),
      digest: 'commit',
      bodies: ['body'],
      journal: new Uint8Array([7, 8, 9]),
      welcome: { bytes: new Uint8Array([10]), recipients: ['recipient'] },
    }
  }
  const framed = { payload: new Uint8Array([1, 2, 3]), publishID: 'publish', expectedHead: null }
  const frame = async (_built: HostBuilt, seal: GroupCrypto['sealEntries']) => {
    expect(inTransaction).toBe(false)
    frameCalls++
    const result = await seal(new Uint8Array([4]))
    expect(result.epoch).toBe(0)
    return framed
  }
  const make = (saveBuilt = saver, now = () => 10) =>
    createControlBuildPort({
      access,
      control,
      build,
      saveBuilt,
      now,
      newID: () => crypto.randomUUID(),
    })
  const source = async (): Promise<AdoptionExpected> =>
    access.readControl(async (scope) => scope.source)
  const slot = async (): Promise<ControlSlot> => ({
    opID: intent.id,
    epoch: 0,
    incarnation: 1,
    authenticatorBefore: handle.state.keySchedule.epochAuthenticator.slice(),
    digest: 'commit',
    payloadDigest: 'full-payload',
    ...framed,
    searchFrom: null,
    bodies: [],
    welcome: null,
    journal: encodeControlJournal({
      version: 1,
      source: await source(),
      checkpoint: null,
      sourceState: encodeClientState(handle.state),
      sourceCredential: handle.credential,
      sourceLedger: handle.ledgerTokens,
      candidate: new Uint8Array([7]),
    }),
  })
  return {
    key,
    db,
    groups,
    control,
    access,
    saver,
    make,
    source,
    slot,
    frame,
    framed,
    handle,
    counts: () => ({ buildCalls, frameCalls }),
  }
}

test('raw built-save rejects changed version', async () => {
  const host = await setup()
  const built = await host.slot()
  const expected = await host.source()
  await host.control.apply(
    { putOutcomes: [{ id: 'other', opID: null, at: 3, kind: 'unknown' }] },
    'version',
  )
  const before = host.db.snapshot()
  expect(await host.saver(intent, built, expected, 'stale')).toBe('moved')
  expect(host.db.snapshot()).toEqual(before)
  expect(await host.control.lastMutation()).toBe('version')
})

test('version-only preparation retry refreshes under owned access', async () => {
  const host = await setup()
  let attempts = 0
  let secondExpected: AdoptionExpected | undefined
  const port = host.make(async (op, slot, expected, id) => {
    attempts++
    if (attempts === 1) await host.control.apply({ putOutcomes: [] }, 'bump')
    else secondExpected = expected
    return host.saver(op, slot, expected, id)
  })
  expect((await port.prepareBuild(intent, host.frame)).kind).toBe('saved')
  expect(attempts).toBe(2)
  expect(host.counts()).toEqual({ buildCalls: 1, frameCalls: 1 })
  const saved = await host.control.load()
  expect(saved.commitOnce?.payload).toEqual(host.framed.payload)
  expect(saved.commitOnce?.publishID).toBe(host.framed.publishID)
  expect(secondExpected?.stateVersion).toBeGreaterThan(
    decodeControlJournal(saved.commitOnce!.journal).source.stateVersion,
  )
  expect(saved.outcomes).toEqual([])
})

test.each(['key', 'epoch', 'authenticator', 'checkpoint', 'cursor epoch', 'queue'] as const)(
  'built-save rejects an identity checkpoint or queue move: %s',
  async (move) => {
    const host = await setup()
    let before: ReturnType<typeof host.db.snapshot> | undefined
    const port = host.make(async (op, slot, captured, id) => {
      let expected = captured
      if (move === 'key') expected = { ...expected, key: { ...expected.key, groupID: 'other' } }
      if (move === 'epoch')
        expected = { ...expected, identity: { ...expected.identity!, epoch: 1 } }
      if (move === 'authenticator')
        expected = {
          ...expected,
          identity: { ...expected.identity!, authenticator: new Uint8Array([0]) },
        }
      if (move === 'checkpoint')
        await host.control.apply({ cursor: { position: asLogPosition('2'), epoch: 0 } }, 'move')
      if (move === 'cursor epoch')
        await host.control.apply({ cursor: { position: null, epoch: 1 } }, 'move')
      if (move === 'queue')
        await host.control.apply({ putOperations: [{ ...intent, id: 'first', seq: 0 }] }, 'move')
      before = host.db.snapshot()
      return host.saver(op, slot, expected, id)
    })
    expect((await port.prepareBuild(intent, host.frame)).kind).toBe('moved')
    expect(host.db.snapshot()).toEqual(before)
    expect(host.counts()).toEqual({ buildCalls: 1, frameCalls: 1 })
  },
)

test('preparation framing does not reenter access', async () => {
  const host = await setup()
  const nested = () => {
    throw new Error('nested access')
  }
  host.access.read = nested
  expect((await host.make().prepareBuild(intent, host.frame)).kind).toBe('saved')
})

test('same-source direct and queued preparation share one slot', async () => {
  const host = await setup()
  const port = host.make()
  expect((await port.prepareBuild(intent, host.frame)).kind).toBe('saved')
  const second = { ...intent, id: 'second', seq: 2 }
  await host.control.apply({ deleteOperations: [intent.id], putOperations: [second] }, 'next')
  const result = await port.prepareBuild(second, host.frame)
  expect(result).toEqual({ kind: 'occupied', operation: second })
  expect(host.counts()).toEqual({ buildCalls: 1, frameCalls: 1 })
})

test('rolled-back save retries prepared bytes without another build', async () => {
  const host = await setup()
  const attempts: Array<ControlSlot> = []
  const port = host.make(async (op, slot, expected, id) => {
    attempts.push(structuredClone(slot))
    if (attempts.length === 1) {
      const transition = host.groups.transition
      host.groups.transition = (change, work) => {
        host.groups.transition = transition
        memoryFaults(host.db).failNext('before-commit')
        return transition(change, work)
      }
    }
    return host.saver(op, slot, expected, id)
  })
  expect((await port.prepareBuild(intent, host.frame)).kind).toBe('saved')
  expect(attempts).toHaveLength(2)
  expect(attempts[1]).toEqual(attempts[0])
  expect(host.counts()).toEqual({ buildCalls: 1, frameCalls: 1 })
})

test('built-save first logical operation write rolls back with slot', async () => {
  const host = await setup()
  const built = await host.slot()
  const expected = await host.source()
  const before = host.db.snapshot()
  memoryFaults(host.db).failNext('after-first-write')
  await expect(host.saver(intent, built, expected, 'rollback')).rejects.toThrow()
  expect(host.db.snapshot()).toEqual(before)
  expect((await host.control.load()).operations).toEqual([intent])
})

test('preparation and framing run outside provider transactions', async () => {
  const host = await setup()
  expect((await host.make().prepareBuild(intent, host.frame)).kind).toBe('saved')
  const slot = (await host.control.load()).commitOnce!
  const journal = decodeControlJournal(slot.journal)
  expect(journal.sourceState).toEqual(encodeClientState(host.handle.state))
  expect(journal.checkpoint).toBe(slot.searchFrom)
  expect(journal.candidate).toEqual(new Uint8Array([7, 8, 9]))
})

test('expired saved intent returns without construction or settlement', async () => {
  const host = await setup()
  expect(
    (await host.make(undefined, () => intent.deadline).prepareBuild(intent, host.frame)).kind,
  ).toBe('expired')
  expect(host.counts()).toEqual({ buildCalls: 0, frameCalls: 0 })
  expect((await host.control.load()).operations).toEqual([intent])
})
