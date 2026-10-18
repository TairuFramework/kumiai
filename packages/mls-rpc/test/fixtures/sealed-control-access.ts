import {
  decodeClientState,
  encodeClientState,
  type GroupHandle,
  GroupRestoreError as InvalidCandidateError,
  restoreGroup,
  restrictCommitAuthoring,
} from '@kumiai/mls'
import type { AdoptionWrite, ControlStore } from '@kumiai/rpc'

import type { ControlRead, HandleAccess, PersistContext } from '../../src/access.js'
import { decodeControlJournal } from '../../src/control-journal.js'
import { DisplacedGroupHandleError } from '../../src/persistence-errors.js'
import type { GroupKey, GroupPersistence, MemoryTransaction } from '../../src/persistence-types.js'
import { nextChange, writeInstallationCheckpoint } from './storage-seed.js'

export type AdoptionFault = {
  skipTrust?: boolean
  reuseAuthenticator?: boolean
  staleLifetime?: boolean
  absentLifetime?: boolean
}

export async function createSealedControlAccess(
  groups: GroupPersistence<MemoryTransaction>,
  key: GroupKey,
  adopted: () => void,
  beforeAdopt: () => void,
  fallback: GroupHandle,
  restore: (params: {
    state: GroupHandle['state']
    credential: GroupHandle['credential']
    ledgerEntries: Array<string>
  }) => Promise<GroupHandle> = restoreGroup,
) {
  const read = async () => {
    const row = await groups.loadState(key)
    if (row === null || row.deleted) throw new Error('Missing adoption source')
    const retained = (await groups.ports(key).control.load()).commitOnce
    const bytes =
      row.state ??
      (retained === null ? undefined : decodeControlJournal(retained.journal).sourceState)
    if (bytes === undefined) throw new Error('Missing retained adoption source')
    const state = decodeClientState(bytes)
    if (state === undefined) throw new Error('Invalid adoption source')
    const handle = restrictCommitAuthoring(
      await restore({
        state,
        credential: row.credential,
        ledgerEntries: row.ledger,
      }),
    )
    const source = {
      key,
      stateVersion: row.version,
      identity: { ...key, epoch: row.epoch, authenticator: row.epochAuthenticator.slice() },
    }
    return { row, handle, source }
  }
  let live = restrictCommitAuthoring(fallback)
  let tail: Promise<void> = Promise.resolve()
  let fault: AdoptionFault = {}
  const serial = async <T>(work: () => Promise<T>): Promise<T> => {
    const previous = tail
    const latch = Promise.withResolvers<void>()
    tail = latch.promise
    await previous
    try {
      return await work()
    } finally {
      latch.resolve()
    }
  }
  const persist = async (next: GroupHandle, write?: AdoptionWrite) => {
    const change = await nextChange(groups, key.groupID, write?.mutationID ?? crypto.randomUUID())
    if (fault.staleLifetime && change.expected !== null)
      change.expected = { ...change.expected, revision: change.expected.revision - 1 }
    if (fault.absentLifetime) change.expected = null
    await groups.transition(change, async (stores) => {
      const rows = stores.incarnation(key.incarnation)
      const state = await rows.state.load()
      const trust = await stores.trust.load()
      if (state === null || state.deleted || trust === null)
        throw new Error('Missing adoption source')
      const candidate = decodeClientState(encodeClientState(next.state))
      if (candidate === undefined) throw new InvalidCandidateError('Invalid candidate')
      if (fault.reuseAuthenticator)
        candidate.keySchedule.epochAuthenticator = state.epochAuthenticator.slice()
      await rows.state.save(
        {
          ...state,
          version: state.version + 1,
          state: encodeClientState(candidate),
          ledger: next.ledgerTokens,
          epoch: Number(candidate.groupContext.epoch),
          epochAuthenticator: candidate.keySchedule.epochAuthenticator,
        },
        write?.expected,
      )
      if (!fault.skipTrust)
        await stores.trust.save({
          ...trust,
          installed: {
            ...key,
            epoch: Number(candidate.groupContext.epoch),
            authenticator: candidate.keySchedule.epochAuthenticator,
          },
          signerTree: candidate.ratchetTree,
          ledger: next.ledgerTokens,
          registry: next.registry,
        })
      if (!fault.skipTrust && !fault.reuseAuthenticator)
        await writeInstallationCheckpoint(stores, {
          key,
          handle: next,
          mutationID: change.mutationID,
          stateVersion: state.version + 1,
        })
      if (write !== undefined) {
        await rows.control.apply(write.changes, write.mutationID)
        const anchor = await rows.anchor.load()
        if (anchor?.pending !== undefined && anchor.pending.advance === write.anchorLanded)
          await rows.anchor.save({ ...anchor, pending: { ...anchor.pending, landed: true } })
      }
    })
  }
  const access: HandleAccess = {
    epoch: () => Number(live.epoch),
    admission: () => live.sendAdmission(),
    read: (fn) => serial(async () => fn(live)),
    readControl: (fn) =>
      serial(async () => {
        let active = true
        const refresh = async (): Promise<ControlRead> => {
          if (!active) throw new Error('Control read scope has ended')
          const { handle, source } = await read()
          if (!active) throw new Error('Control read scope has ended')
          return { handle, source }
        }
        const loadControl = async (control: ControlStore = groups.ports(key).control) => {
          if (!active) throw new Error('Control read scope has ended')
          if (control.key.groupID !== key.groupID || control.key.incarnation !== key.incarnation)
            throw new DisplacedGroupHandleError('Control store belongs to another incarnation')
          const value = await control.load()
          if (!active) throw new Error('Control read scope has ended')
          return value
        }
        try {
          return await fn({ ...(await refresh()), refresh, loadControl })
        } finally {
          active = false
        }
      }),
    replace: (next, adoption, prepare) =>
      serial(async () => {
        const current = await read()
        if (prepare !== undefined && !(await prepare(current.handle, current.source))) return
        const write = adoption?.({
          incarnation: key.incarnation,
          epochAfter: Number(next.epoch),
          epochAuthenticator: next.state.keySchedule.epochAuthenticator.slice(),
          removed: false,
        })
        if (write?.expected?.journal !== undefined && write.expected.acceptance !== undefined)
          await current.handle.carryReceiveProgress(next)
        beforeAdopt()
        await persist(next, write)
        live = restrictCommitAuthoring(next)
        next.confirmAdopted()
        adopted()
      }),
    mutate: (fn, adoption) =>
      serial(async () => {
        const current = await read()
        let saved = false
        const save = async (handle: GroupHandle, _ctx?: PersistContext) => {
          const write = adoption?.({
            incarnation: key.incarnation,
            epochAfter: Number(handle.epoch),
            epochAuthenticator: handle.state.keySchedule.epochAuthenticator.slice(),
            removed: false,
          })
          await persist(handle, write)
          saved = true
        }
        const result = await fn(current.handle, save)
        if (!saved) await save(current.handle)
        live = current.handle
        return result
      }),
    open: async () => {
      throw new Error('Crash harness has no application frames')
    },
  }
  return {
    access,
    live: () => live,
    fault: (value: AdoptionFault) => {
      fault = value
    },
  }
}
