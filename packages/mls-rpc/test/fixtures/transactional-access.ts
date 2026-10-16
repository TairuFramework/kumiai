import {
  decodeClientState,
  encodeClientState,
  type GroupHandle,
  type GroupOptions,
  restoreGroup,
} from '@kumiai/mls'
import {
  type AdoptionWrite,
  type AnchorSlot,
  applyChanges,
  type CheckpointRecord,
  type CheckpointStore,
  type CommitOnceWriteContext,
  type ControlEvidenceSnapshot,
  type ControlSnapshot,
  type ControlStore,
  controlAdoptionAllowed,
  controlBuildRef,
  controlSafetyHeld,
  type PendingAppFrame,
} from '@kumiai/rpc'

import type { ControlRead, HandleAccess } from '../../src/access.js'
import type { SaveControlBuild } from '../../src/control-build.js'
import { decodeControlJournal } from '../../src/control-journal.js'
import { sameStoredValue } from '../../src/memory-incarnation-stores.js'
import { DisplacedGroupHandleError } from '../../src/persistence-errors.js'
import type { RealMember } from './real-group.js'

export class RevisionConflictError extends Error {
  constructor(expected: number, actual: number) {
    super(`state revision ${expected} is stale; the row is at ${actual}`)
    this.name = 'RevisionConflictError'
  }
}

export type StoredRow = {
  checkpoints: Array<CheckpointRecord>
  state: Uint8Array
  initialState: Uint8Array
  ledger: Array<string>
  revision: number
  control: ControlSnapshot
  mutationID: string | null
  anchorSlot: AnchorSlot | null
}

/**
 * A host's durable group row plus pending table. Every write is conditional on the revision the
 * writer read and bumps it, so a same-epoch stale state cannot land after a newer one. Writes are
 * serialised, which orders an earlier save ahead of a later open.
 */
export type TransactionalStore = {
  checkpoints: CheckpointStore
  control: ControlStore
  saveBuilt: SaveControlBuild
  snapshot(): StoredRow
  save(
    expected: number,
    state: Uint8Array,
    ledger: Array<string>,
    record?: PendingAppFrame,
    write?: AdoptionWrite,
  ): Promise<void>
  records: Map<string, PendingAppFrame>
  /** Resolves once every write issued so far has settled: a read after it sees them. */
  settled(): Promise<void>
  readEvidence(): Promise<ControlEvidenceSnapshot>
  /** Another connection's commit to the row: same state, next revision. */
  bump(): void
  /**
   * Once queued writes settle, a store over a copy of the row and the same pending table: a
   * restarted process reads what was committed, and its writes stay its own.
   */
  fork(): Promise<TransactionalStore>
  /** Runs inside a write, before the row changes. Tests throw, wait or bump from here. */
  beforeWrite?: (() => void | Promise<void>) | undefined
}

export function createTransactionalStore(
  handle: GroupHandle,
  anchorSlot: AnchorSlot | null = null,
): TransactionalStore {
  return storeOver(
    {
      checkpoints: [],
      state: encodeClientState(handle.state),
      initialState: encodeClientState(handle.state),
      ledger: handle.ledgerTokens,
      revision: 0,
      mutationID: null,
      anchorSlot: structuredClone(anchorSlot),
      control: {
        commitOnce: null,
        commitOnceAcceptance: null,
        controlHold: null,
        forkHalt: null,
        recoveryUnavailable: null,
        strand: null,
        operations: [],
        rejoin: null,
        recoveryEpochFloor: null,
        settledRejoins: [],
        outcomes: [],
        welcomes: [],
        applied: [],
        responses: [],
        cursor: null,
      },
    },
    new Map(),
  )
}

function storeOver(initial: StoredRow, records: Map<string, PendingAppFrame>): TransactionalStore {
  let row = initial
  let tail: Promise<void> = Promise.resolve()
  const identityOf = (state: Uint8Array) => {
    const decoded = decodeClientState(state)
    if (decoded == null) throw new Error('Invalid stored state')
    return {
      groupID: new TextDecoder().decode(decoded.groupContext.groupId),
      incarnation: 1,
      epoch: Number(decoded.groupContext.epoch),
      authenticator: decoded.keySchedule.epochAuthenticator.slice(),
    }
  }
  const key = { groupID: identityOf(initial.state).groupID, incarnation: 1 }
  const queue = <TValue>(work: () => Promise<TValue>): Promise<TValue> => {
    const saving = tail.then(work)
    tail = saving.then(
      () => {},
      () => {},
    )
    return saving
  }
  const store: TransactionalStore = {
    checkpoints: {
      async load(id) {
        await tail
        return structuredClone(row.checkpoints.find((record) => record.id === id) ?? null)
      },
      async list() {
        await tail
        return structuredClone(row.checkpoints)
      },
      put(record) {
        const owned = structuredClone(record)
        return queue(async () => {
          if (
            owned.key.groupID !== key.groupID ||
            !Number.isSafeInteger(owned.key.incarnation) ||
            owned.key.incarnation < 1 ||
            !['fact', 'publication', 'cursor'].includes(owned.kind)
          )
            throw new Error('Checkpoint group binding mismatch')
          await store.beforeWrite?.()
          const records = row.checkpoints.slice()
          const index = records.findIndex((value) => value.id === owned.id)
          if (index === -1) records.push(owned)
          else records[index] = owned
          row = { ...row, checkpoints: records }
        })
      },
      remove(ids) {
        const owned = ids.slice()
        return queue(async () => {
          await store.beforeWrite?.()
          row = {
            ...row,
            checkpoints: row.checkpoints.filter((record) => !owned.includes(record.id)),
          }
        })
      },
    },
    readEvidence: async () => {
      await tail
      const snapshot = structuredClone(row)
      const identity = identityOf(snapshot.state)
      const state = decodeClientState(snapshot.state)
      if (state === undefined) throw new Error('Invalid evidence state')
      return {
        source: { key: { ...key }, stateVersion: snapshot.revision, identity },
        applied: snapshot.control.applied,
        cursor: snapshot.control.cursor,
        terminal: state.groupActiveState.kind === 'removedFromGroup',
      }
    },
    control: {
      get key() {
        return { ...key }
      },
      load: async () => {
        await tail
        return structuredClone(row.control)
      },
      lastMutation: async () => {
        await tail
        return row.mutationID
      },
      apply: (changes, mutationID) => {
        const owned = structuredClone(changes)
        return queue(async () => {
          await store.beforeWrite?.()
          const source = identityOf(row.state)
          row = {
            ...row,
            revision: row.revision + 1,
            control: applyChanges(row.control, owned, { kind: 'head', source }, key),
            mutationID,
          }
        })
      },
    },
    saveBuilt: (intent, built, expected, mutationID) => {
      const owned = structuredClone({ intent, built, expected })
      return queue(async () => {
        await store.beforeWrite?.()
        const journal = decodeControlJournal(owned.built.journal)
        const identity = identityOf(row.state)
        if (
          controlSafetyHeld(row.control) !== null ||
          row.control.controlHold !== null ||
          !sameStoredValue(owned.expected.key, key) ||
          !sameStoredValue(owned.expected.identity, identity) ||
          row.revision !== owned.expected.stateVersion ||
          (row.control.cursor === null &&
            !sameStoredValue(identityOf(row.initialState), identity)) ||
          !sameStoredValue(row.control.operations[0], owned.intent) ||
          journal.checkpoint !== owned.built.searchFrom ||
          owned.built.searchFrom !== (row.control.cursor?.position ?? null) ||
          (row.control.cursor !== null &&
            (row.control.cursor.epoch !== identity.epoch || row.control.cursor.stranded))
        )
          return 'moved'
        if (row.control.commitOnce !== null && row.control.commitOnce.epoch >= identity.epoch)
          return 'occupied'
        const context: CommitOnceWriteContext = {
          kind: 'build',
          source: owned.expected,
          queueHeadID: owned.intent.id,
          checkpoint: journal.checkpoint,
        }
        const control = applyChanges(
          row.control,
          {
            putOperations: [
              { ...owned.intent, stage: 'built', built: controlBuildRef(owned.built) },
            ],
            commitOnce: owned.built,
            commitOnceAcceptance: null,
          },
          context,
          key,
        )
        row = { ...row, revision: row.revision + 1, control, mutationID }
        return 'saved'
      })
    },
    snapshot: () => row,
    records,
    settled: () => tail,
    bump: () => {
      row = { ...row, revision: row.revision + 1 }
    },
    fork: async () => {
      await tail
      return storeOver(
        {
          ...row,
          state: row.state.slice(),
          anchorSlot: structuredClone(row.anchorSlot),
          checkpoints: structuredClone(row.checkpoints),
        },
        records,
      )
    },
    save: (expected, state, ledger, record, write) => {
      const saving = tail.then(async () => {
        await store.beforeWrite?.()
        if (row.revision !== expected) throw new RevisionConflictError(expected, row.revision)
        // One transaction: the state row and the pending row together. A duplicate frame ID keeps
        // its first record; the key is still consumed once, by this state.
        if (
          controlSafetyHeld(row.control) !== null ||
          (write !== undefined &&
            row.control.controlHold !== null &&
            row.control.controlHold.reason !== 'acceptance-unknown')
        )
          throw new RevisionConflictError(expected, row.revision)
        if (
          write?.expected !== undefined &&
          !controlAdoptionAllowed(
            row.control,
            {
              key: store.control.key,
              identity: identityOf(row.state),
              stateVersion: row.revision,
            },
            write.expected,
          )
        )
          throw new RevisionConflictError(write.expected.stateVersion, row.revision)
        const next: StoredRow = {
          checkpoints: structuredClone(row.checkpoints),
          state: state.slice(),
          initialState: row.initialState.slice(),
          ledger,
          revision: expected + 1,
          control:
            write == null
              ? row.control
              : applyChanges(
                  row.control,
                  write.changes,
                  {
                    kind: 'adoption',
                    before: identityOf(row.state),
                    after: identityOf(state),
                  },
                  key,
                ),
          mutationID: write?.mutationID ?? row.mutationID,
          anchorSlot: structuredClone(row.anchorSlot),
        }
        if (
          write?.anchorLanded != null &&
          next.anchorSlot?.pending?.advance === write.anchorLanded
        ) {
          next.anchorSlot.pending.landed = true
        }
        row = next
        if (record != null && !store.records.has(record.frame.id)) {
          store.records.set(record.frame.id, record)
        }
      })
      tail = saving.catch(() => {})
      return saving
    },
  }
  return store
}

export type TransactionalAccess = {
  access: HandleAccess
  pending: {
    persistOpened(stagedState: Uint8Array, record: PendingAppFrame): Promise<void>
    list(): Promise<Array<PendingAppFrame>>
    complete(id: string): Promise<void>
  }
  live(): GroupHandle
}

/**
 * A transactional {@link HandleAccess}: every mutation and open works on a handle restored from
 * the stored row and is published only after its conditional write commits. An open holds the
 * handle lock only to read the row and to publish, never across the write.
 */
export async function createTransactionalAccess(
  member: RealMember,
  store: TransactionalStore,
  callbacks: Pick<GroupOptions, 'onLedgerEntries'> = {},
): Promise<TransactionalAccess> {
  const restore = async (row: StoredRow): Promise<GroupHandle> => {
    const state = decodeClientState(row.state)
    if (state == null) throw new Error('bad stored state')
    return await restoreGroup({
      state,
      credential: member.handle.credential,
      ledgerEntries: row.ledger,
      options: { ...callbacks, resolveLedgerEntries: member.slot.resolve },
    })
  }

  let live = await restore(store.snapshot())
  let publishedAdmission = live.sendAdmission()
  let liveRevision = store.snapshot().revision
  let tail: Promise<void> = Promise.resolve()
  const locked = async <TValue>(fn: () => Promise<TValue>): Promise<TValue> => {
    const previous = tail
    let release: () => void = () => {}
    tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await fn()
    } finally {
      release()
    }
  }
  // A handle is published only if its write is newer than the live one's: an open publishes
  // after its lock is released, and a mutation may have committed in between.
  const publish = (next: GroupHandle, revision: number): void => {
    if (revision <= liveRevision) return
    live = next
    liveRevision = revision
    publishedAdmission = next.sendAdmission()
  }

  // Opens are serialised among themselves, so the revision below belongs to the one in flight.
  let openTail: Promise<void> = Promise.resolve()
  let openRevision = -1

  const readControl = async (): Promise<ControlRead> => {
    // Wait for storage writes, never the open publication that needs this gate.
    await store.settled()
    const row = store.snapshot()
    const handle = await restore(row)
    const key = { groupID: handle.groupID, incarnation: 1 }
    return {
      handle,
      source: {
        key,
        stateVersion: row.revision,
        identity: {
          ...key,
          epoch: Number(handle.epoch),
          authenticator: handle.state.keySchedule.epochAuthenticator.slice(),
        },
      },
    }
  }
  const access: HandleAccess = {
    readControl: (fn) =>
      locked(async () => {
        let active = true
        const refresh = async (): Promise<ControlRead> => {
          if (!active) throw new Error('Control read scope has ended')
          const value = await readControl()
          if (!active) throw new Error('Control read scope has ended')
          return value
        }
        const loadControl = async (
          control: ControlStore = store.control,
        ): Promise<ControlSnapshot> => {
          if (!active) throw new Error('Control read scope has ended')
          if (!sameStoredValue(control.key, store.control.key))
            throw new DisplacedGroupHandleError('Control store belongs to another incarnation')
          const value = await control.load()
          if (!active) throw new Error('Control read scope has ended')
          return value
        }
        try {
          return await fn({ ...(await readControl()), refresh, loadControl })
        } finally {
          active = false
        }
      }),
    epoch: () => publishedAdmission.epoch,
    admission: () => publishedAdmission,
    read: (fn) => locked(async () => await fn(live)),
    mutate: (fn, adoption) =>
      locked(async () => {
        await store.settled()
        const row = store.snapshot()
        const working = await restore(row)
        const save = async (current: GroupHandle) => {
          const write = adoption?.({
            incarnation: 1,
            epochAfter: Number(current.epoch),
            removed: !current
              .listMembers()
              .some((entry) => entry.leafIndex === current.state.privatePath.leafIndex),
            epochAuthenticator: current.state.keySchedule.epochAuthenticator.slice(),
          })
          await store.save(
            row.revision,
            encodeClientState(current.state),
            current.ledgerTokens,
            undefined,
            write,
          )
        }
        let saved = false
        const result = await fn(working, async (current) => {
          await save(current)
          saved = true
        })
        if (!saved) {
          await save(working)
        }
        publish(working, row.revision + 1)
        return result
      }),
    replace: (next, adoption, prepare) =>
      locked(async () => {
        await store.settled()
        const row = store.snapshot()
        const current = await restore(row)
        const key = { groupID: current.groupID, incarnation: 1 }
        const source = {
          key,
          stateVersion: row.revision,
          identity: {
            ...key,
            epoch: Number(current.epoch),
            authenticator: current.state.keySchedule.epochAuthenticator.slice(),
          },
        }
        if (prepare != null && !(await prepare(current, source))) return
        const write = adoption?.({
          incarnation: 1,
          epochAfter: Number(next.epoch),
          removed: !next
            .listMembers()
            .some((entry) => entry.leafIndex === next.state.privatePath.leafIndex),
          epochAuthenticator: next.state.keySchedule.epochAuthenticator.slice(),
        })
        if (write?.expected?.journal !== undefined && write.expected.acceptance !== undefined)
          await current.carryReceiveProgress(next)
        await store.save(
          row.revision,
          encodeClientState(next.state),
          next.ledgerTokens,
          undefined,
          write,
        )
        publish(next, row.revision + 1)
        next.confirmAdopted()
      }),
    open: (fn, persistOpened) => {
      const run = openTail.then(async () => {
        while (true) {
          const row = await locked(async () => {
            await store.settled()
            return store.snapshot()
          })
          const working = await restore(row)
          let staged: { state: Uint8Array; record: PendingAppFrame } | undefined
          const result = await fn(working, async (state, record) => {
            staged = { state, record }
          })
          if (staged == null) return result
          openRevision = row.revision
          try {
            await persistOpened(staged.state, staged.record)
          } catch (error) {
            if (error instanceof Error && error.cause instanceof RevisionConflictError) continue
            throw error
          }
          await locked(async () => publish(working, row.revision + 1))
          return result
        }
      })
      openTail = run.then(
        () => {},
        () => {},
      )
      return run
    },
  }

  return {
    access,
    pending: {
      persistOpened: (state, record) =>
        store.save(openRevision, state, store.snapshot().ledger, record),
      list: async () => [...store.records.values()],
      complete: async (id) => {
        store.records.delete(id)
      },
    },
    live: () => live,
  }
}
