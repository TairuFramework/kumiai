import { decodeClientState, encodeClientState, type GroupHandle } from '@kumiai/mls'
import type { MemoryTransaction, PendingAppFrame } from '@kumiai/mls-rpc'
import type { AppCursorStore, HandlerCompletion } from '@kumiai/rpc'

import { entryCapability } from '../../../packages/mls-rpc/src/entry-capability.js'
import { createHandlerCompletion } from '../../../packages/mls-rpc/src/handler-completion.js'
import { recoveryTrustFor } from '../../../packages/mls-rpc/src/registry/trust.js'
import {
  createMemoryGroupPersistence,
  createMemoryTransaction,
  createOwnerQueues,
  memoryFaults,
} from '../../../packages/mls-rpc/src/testing.js'
import { createDeterministicAtRestCodec } from '../../../packages/mls-rpc/test/fixtures/at-rest.js'
import { writeInstallationCheckpoint } from '../../../packages/mls-rpc/test/fixtures/storage-seed.js'
import type { StateStore } from './app-lane-e2e.js'

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

/** The legacy host journal still supplies control/publication fault seams. Restores use this state. */
export function createMemberPersistence(
  base: StateStore,
  initial: GroupHandle,
  ledger: () => Array<string>,
): MemberPersistence {
  const key = { ...base.control.key }
  const db = createMemoryTransaction({ rows: {} })
  const persistence = createMemoryGroupPersistence({
    db,
    owners: createOwnerQueues(),
    atRest: createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(61) }),
    providerID: `integration-member:${key.groupID}`,
  })
  const capability = entryCapability(persistence)
  if (capability === null) throw new Error('Missing member persistence capability')
  const entry = capability
  let ready = Promise.resolve()
  const save = async (
    state: Uint8Array,
    ledger: Array<string>,
    record?: PendingAppFrame,
    handle?: GroupHandle,
  ) => {
    const client = decodeClientState(state)
    if (client === undefined) throw new Error('Invalid member state')
    const mutationID = crypto.randomUUID()
    await entry.run(
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
        await rows.state.save({
          ...key,
          version,
          deleted: false,
          terminal: client.groupActiveState.kind === 'removedFromGroup',
          epoch,
          epochAuthenticator: client.keySchedule.epochAuthenticator.slice(),
          state,
          credential: initial.credential,
          ledger,
          senderHWM: previous?.epoch === epoch ? previous.senderHWM : 0,
        })
        if (handle !== undefined && (trust === null || trust.installed.epoch !== epoch))
          await stores.trust.save(recoveryTrustFor(handle, key, trust))
        if (previous === null || previous.epoch !== epoch)
          await writeInstallationCheckpoint(stores, {
            key,
            confirmedTranscriptHash: client.groupContext.confirmedTranscriptHash,
            mutationID,
            stateVersion: version,
          })
        if (record !== undefined) await rows.pending.put([record])
      },
    )
  }
  ready = save(encodeClientState(initial.state), initial.ledgerTokens, undefined, initial)
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
      await base.save(handle, write)
      await save(encodeClientState(handle.state), handle.ledgerTokens, undefined, handle)
    },
    async prepareApp(...args) {
      await ready
      await base.prepareApp(...args)
      const handle = args[2]
      await save(encodeClientState(handle.state), handle.ledgerTokens, undefined, handle)
    },
    async saved() {
      await ready
      const record = await persistence.loadState(key)
      return record === null || record.deleted || record.state === null
        ? null
        : { state: record.state, ledger: record.ledger }
    },
  }
  return {
    stateStore,
    completion,
    cursor: { ...cursor, stored: cursor.load },
    pending: {
      async persistOpened(state: Uint8Array, record: PendingAppFrame) {
        await ready
        await save(state, ledger(), record)
        await base.saveOpened(state, ledger())
      },
      list,
      complete: (id: string) => completion.complete([id]),
    },
  }
}
