import { AsyncLocalStorage } from 'node:async_hooks'
import { decodeClientState, type GroupHandle } from '@kumiai/mls'
import type { MemoryTransaction, PendingAppFrame } from '@kumiai/mls-rpc'
import type { AppCursorStore, HandlerCompletion } from '@kumiai/rpc'

import { entryCapability } from '../../../packages/mls-rpc/src/entry-capability.js'
import { createHandlerCompletion } from '../../../packages/mls-rpc/src/handler-completion.js'
import { physicalRecordKey, sealRecord } from '../../../packages/mls-rpc/src/persistence-codec.js'
import { recoveryTrustFor } from '../../../packages/mls-rpc/src/registry/trust.js'
import {
  createMemoryGroupPersistence,
  createMemoryTransaction,
  createOwnerQueues,
  memoryFaults,
} from '../../../packages/mls-rpc/src/testing.js'
import { createDeterministicAtRestCodec } from '../../../packages/mls-rpc/test/fixtures/at-rest.js'
import { writeInstallationCheckpoint } from '../../../packages/mls-rpc/test/fixtures/storage-seed.js'
import type { MemoryHostTransaction } from '../../../packages/rpc/test/fixtures/host-db.js'
import type { StateStore } from './app-lane-e2e.js'

const members = new WeakMap<StateStore['database'], MemberPersistence>()

export type MemberPersistence = {
  stateStore: StateStore
  completion: HandlerCompletion<MemoryTransaction>
  cursor: AppCursorStore & { stored: AppCursorStore['load'] }
  pending: {
    persistOpened(state: Uint8Array, record: PendingAppFrame): Promise<void>
    list(): Promise<Array<PendingAppFrame>>
    complete(id: string): Promise<void>
  }
}

/** The host journal participates in the production transaction before its cache and fault seams publish. */
export function createMemberPersistence(base: StateStore, initial: GroupHandle): MemberPersistence {
  const retained = members.get(base.database)
  if (retained !== undefined) return retained
  const key = { ...base.control.key }
  const db = createMemoryTransaction({ rows: { 'host-journal': new Map() } })
  const atRest = createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(61) })
  const persistence = createMemoryGroupPersistence({
    db,
    owners: createOwnerQueues(),
    atRest,
    providerID: `integration-member:${key.groupID}`,
  })
  const capability = entryCapability(persistence)
  if (capability === null) throw new Error('Missing member persistence capability')
  const entry = capability
  const writes = new AsyncLocalStorage<{
    handle?: GroupHandle
    record?: PendingAppFrame
    initialising?: boolean
  }>()
  let ready = Promise.resolve()
  type Commit = Parameters<Parameters<MemoryHostTransaction>[1]>[0]
  const transact = async (work: Parameters<MemoryHostTransaction>[1]) => {
    const mutationID = crypto.randomUUID()
    return await entry.run(
      { groupID: key.groupID, mutationID },
      async (reads) => ({
        expected: await reads.lifetime(),
        value: {
          previous: await reads.state(key.incarnation),
          trust: await reads.trust(),
        },
      }),
      async (stores, { previous, trust }) => {
        if (previous?.deleted) throw new Error('Deleted member state')
        const context = writes.getStore()
        const commit: Commit = async (journal, publish) => {
          const saved =
            journal.state === null
              ? null
              : (JSON.parse(new TextDecoder().decode(journal.state)) as {
                  state: Array<number>
                  ledger: Array<string>
                })
          const state = saved === null ? previous?.state : Uint8Array.from(saved.state)
          const client = state == null ? undefined : decodeClientState(state)
          if (client === undefined || state == null) throw new Error('Invalid member state')
          const currentLedger =
            context?.record === undefined ? (saved?.ledger ?? previous?.ledger) : previous?.ledger
          if (currentLedger === undefined) throw new Error('Missing member ledger')
          const rows = stores.incarnation(key.incarnation)
          if (previous === null) {
            await stores.lifetime.save({
              ...key,
              activeIncarnation: key.incarnation,
              latestIncarnation: key.incarnation,
              revision: 1,
              mutationID,
              restorePending: false,
            })
          }
          const epoch = Number(client.groupContext.epoch)
          const version = (previous?.version ?? 0) + 1
          if (previous === null || journal.version !== base.database.currentVersion('state'))
            await rows.state.save({
              ...key,
              version,
              deleted: false,
              terminal: client.groupActiveState.kind === 'removedFromGroup',
              epoch,
              epochAuthenticator: client.keySchedule.epochAuthenticator.slice(),
              state,
              credential: initial.credential,
              ledger: currentLedger,
              senderHWM: previous?.epoch === epoch ? previous.senderHWM : 0,
            })
          const handle = context?.handle
          if (handle !== undefined && (trust === null || trust.installed.epoch !== epoch))
            await stores.trust.save(recoveryTrustFor(handle, key, trust))
          if (previous === null || previous.epoch !== epoch)
            await writeInstallationCheckpoint(stores, {
              key,
              confirmedTranscriptHash: client.groupContext.confirmedTranscriptHash,
              mutationID,
              stateVersion: version,
            })
          if (context?.record !== undefined) await rows.pending.put([context.record])
          journal.state = new TextEncoder().encode(
            JSON.stringify({ state: Array.from(state), ledger: currentLedger }),
          )
          const hostRows = stores.tx.rows['host-journal']
          if (hostRows === undefined) throw new Error('Missing host journal namespace')
          const address = { ...key, namespace: 'host-journal', recordID: 'state' }
          hostRows.set(physicalRecordKey(address), await sealRecord(atRest, address, journal))
          stores.tx.onCommit(publish)
        }
        return await work(commit)
      },
    )
  }
  base.database.bindTransactions(async (storageID, work) => {
    if (storageID !== 'state') throw new Error('Unexpected member storage identity')
    if (writes.getStore()?.initialising !== true) await ready
    return await transact(work)
  })
  ready = writes.run({ handle: initial, initialising: true }, () => base.save(initial))
  const list = async () => {
    await ready
    return entry.read(key.groupID, (reads) => reads.pendingFrames(key.incarnation))
  }
  const completion = createHandlerCompletion({ persistence, key })
  const cursor = persistence.ports(key).cursor
  const database = {
    ...base.database,
    commitThenRejectNext(point: Parameters<typeof base.database.commitThenRejectNext>[0]) {
      if (point === 'save') memoryFaults(db).commitThenReject()
      base.database.commitThenRejectNext(point)
    },
  }
  const stateStore: StateStore = {
    ...base,
    database,
    async save(handle, write) {
      await ready
      await writes.run({ handle }, () => base.save(handle, write))
    },
    async prepareApp(...args) {
      await ready
      const handle = args[2]
      await writes.run({ handle }, () => base.prepareApp(...args))
    },
    async saved() {
      await ready
      const record = await persistence.loadState(key)
      return record === null || record.deleted || record.state === null
        ? null
        : { state: record.state, ledger: record.ledger }
    },
  }
  const member: MemberPersistence = {
    stateStore,
    completion,
    cursor: { ...cursor, stored: cursor.load },
    pending: {
      async persistOpened(state: Uint8Array, record: PendingAppFrame) {
        await ready
        const previous = await stateStore.saved()
        if (previous === null) throw new Error('Missing member state')
        await writes.run({ record }, () => base.saveOpened(state, previous.ledger))
      },
      list,
      complete: (id: string) => completion.complete([id]),
    },
  }
  members.set(base.database, member)
  members.set(database, member)
  return member
}
