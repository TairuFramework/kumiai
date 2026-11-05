import { AsyncLocalStorage } from 'node:async_hooks'
import { normalizeDID } from '@kokuin/token'
import { decodeClientState, decodeEpochRosterFact, type GroupHandle } from '@kumiai/mls'
import type { MemoryTransaction, PendingAppFrame } from '@kumiai/mls-rpc'
import type { AppCursorStore, HandlerCompletion } from '@kumiai/rpc'

import {
  currentCheckpointFact,
  prepareCheckpointInstallationFromTrust,
} from '../../../packages/mls-rpc/src/checkpoint-capture.js'
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
    let publish: (() => void) | undefined
    return await entry.run(
      { groupID: key.groupID, mutationID },
      async (reads, closing) => {
        const lifetime = await reads.lifetime()
        const previous = await reads.state(key.incarnation)
        const retained = await reads.trust()
        if (previous?.deleted) throw new Error('Deleted member state')
        const context = writes.getStore()
        type Plan = {
          record: Exclude<typeof previous, null | { deleted: true }> | null
          trust: typeof retained
          checkpoint: Awaited<ReturnType<typeof prepareCheckpointInstallationFromTrust>> | null
          signable: boolean
          journal: Parameters<Commit>[0] | null
          pending: PendingAppFrame | null
        }
        let plan: Plan = {
          record: null,
          trust: null,
          checkpoint: null,
          signable: false,
          journal: null,
          pending: null,
        }
        const result = await work(async (journal, publication) => {
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
          const epoch = Number(client.groupContext.epoch)
          const version = (previous?.version ?? 0) + 1
          const record =
            previous === null || journal.version !== base.database.currentVersion('state')
              ? {
                  ...key,
                  version,
                  deleted: false as const,
                  terminal: client.groupActiveState.kind === 'removedFromGroup',
                  epoch,
                  epochAuthenticator: client.keySchedule.epochAuthenticator.slice(),
                  state,
                  credential: initial.credential,
                  ledger: currentLedger,
                  senderHWM: previous?.epoch === epoch ? previous.senderHWM : 0,
                }
              : null
          const handle = context?.handle
          const trust =
            handle !== undefined && (retained === null || retained.installed.epoch !== epoch)
              ? recoveryTrustFor(handle, key, retained)
              : null
          let checkpoint: Plan['checkpoint'] = null
          if (previous === null || previous.epoch !== epoch) {
            const installed = trust ?? retained
            if (installed === null) throw new Error('Missing installed trust')
            checkpoint = await prepareCheckpointInstallationFromTrust({
              key,
              trust: installed,
              confirmedTranscriptHash: client.groupContext.confirmedTranscriptHash,
              mutationID,
              stateVersion: version,
              previousFact: currentCheckpointFact(await reads.checkpoints())?.canonical ?? null,
            })
          }
          journal.state = new TextEncoder().encode(
            JSON.stringify({ state: Array.from(state), ledger: currentLedger }),
          )
          plan = {
            record,
            trust,
            checkpoint,
            journal,
            pending: context?.record ?? null,
            signable:
              checkpoint !== null &&
              decodeEpochRosterFact(checkpoint.canonical).members.some(
                (member) => member.signerDID === normalizeDID(initial.credential.id),
              ),
          }
          publish = publication
        })
        const prepared = { expected: lifetime, value: { ...plan, result } }
        return plan.record?.terminal && previous !== null && !previous.terminal
          ? closing.freeze({
              source: key,
              reason: 'terminal',
              prepared,
              domain: { states: [plan.record], lifetime: null },
            })
          : prepared
      },
      async (stores, plan) => {
        const rows = stores.incarnation(key.incarnation)
        if (plan.record !== null) {
          if ((await stores.lifetime.load()) === null)
            await stores.lifetime.save({
              ...key,
              activeIncarnation: key.incarnation,
              latestIncarnation: key.incarnation,
              revision: 1,
              mutationID,
              restorePending: false,
            })
          await rows.state.save(plan.record)
        }
        if (plan.trust !== null) await stores.trust.save(plan.trust)
        if (plan.checkpoint !== null) {
          await stores.checkpoints.put(plan.checkpoint)
          if (plan.signable)
            await stores.checkpoints.put({
              kind: 'publication',
              id: `publication:${plan.checkpoint.id}`,
              key,
              factID: plan.checkpoint.id,
              frame: null,
              publishID: null,
              accepted: false,
              nextHeartbeatAt: null,
            })
        }
        if (plan.pending !== null) await rows.pending.put([plan.pending])
        if (plan.journal !== null) {
          const hostRows = stores.tx.rows['host-journal']
          if (hostRows === undefined) throw new Error('Missing host journal namespace')
          const address = { ...key, namespace: 'host-journal', recordID: 'state' }
          hostRows.set(physicalRecordKey(address), await sealRecord(atRest, address, plan.journal))
          if (publish === undefined) throw new Error('Missing publication callback')
          stores.tx.onCommit(publish)
        }
        return plan.result
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
