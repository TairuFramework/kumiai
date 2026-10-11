import type { AnchorSlot, AnchorStore } from '../../src/anchor.js'
import {
  applyChanges,
  type CommitOnceWriteContext,
  controlSettled,
  readmissionChanges,
} from '../../src/control/store.js'
import type {
  AdoptionExpected,
  AdoptionWrite,
  ControlSlot,
  ControlSnapshot,
  ControlStore,
  EpochIdentity,
  GroupKey,
  Operation,
} from '../../src/control/types.js'
import { GroupControlUnsettledError, StorageOutcomeUnknownError } from '../../src/errors.js'

type GroupRecord = {
  version: number
  state: Uint8Array | null
  initialState: Uint8Array | null
  anchorSlot: AnchorSlot | null
  control: ControlSnapshot
  mutationID: string | null
}

type SeedOptions = { replace?: false } | { replace: true; expectedVersion: number }

type WritePoint = 'apply' | 'save' | 'anchor' | 'seed'
type FailurePoint = 'mid-apply' | 'mid-save' | 'mid-anchor' | 'mid-seed'

export type MemoryHostDatabase = {
  control(storageID: string, key: GroupKey): ControlStore
  saveBuilt(
    storageID: string,
    key: GroupKey,
    intent: Operation & { stage: 'intent' },
    built: ControlSlot,
    expected: AdoptionExpected,
    mutationID: string,
  ): Promise<'saved' | 'moved' | 'occupied'>
  anchorStore(groupID: string): AnchorStore
  saveState(groupID: string, state: Uint8Array, write?: AdoptionWrite): Promise<void>
  seed(groupID: string, state: Uint8Array, options?: SeedOptions): Promise<void>
  loadVersion(groupID: string): Promise<number>
  loadState(groupID: string): Promise<Uint8Array | null>
  delete(groupID: string): Promise<void>
  failNext(point: FailurePoint): void
  commitThenRejectNext(point: WritePoint): void
  seam(name: string, hook: () => void | Promise<void>): void
}

function emptyRecord(): GroupRecord {
  return {
    version: 0,
    state: null,
    initialState: null,
    anchorSlot: null,
    mutationID: null,
    control: {
      commitOnce: null,
      commitOnceAcceptance: null,
      operations: [],
      rejoin: null,
      outcomes: [],
      welcomes: [],
      applied: [],
      responses: [],
      cursor: null,
    },
  }
}

export function createMemoryHostDatabase(
  options: { readIdentity?: (state: Uint8Array, key: GroupKey) => EpochIdentity | null } = {},
): MemoryHostDatabase {
  let version = 0
  const groups = new Map<string, GroupRecord>()
  const keys = new Map<string, GroupKey>()
  const seams = new Map<string, () => void | Promise<void>>()
  let failure: FailurePoint | undefined
  let ambiguous: WritePoint | undefined
  const read = (groupID: string) => groups.get(groupID) ?? emptyRecord()
  const runSeam = async (name: string) => {
    const hook = seams.get(name)
    seams.delete(name)
    await hook?.()
  }
  const transact = async (
    groupID: string,
    point: WritePoint,
    mutate: (next: GroupRecord) => void,
  ) => {
    await runSeam(`before-${point}`)
    const next = structuredClone(read(groupID))
    mutate(next)
    if (failure === `mid-${point}`) {
      failure = undefined
      throw new Error('Injected transaction failure')
    }
    if (point === 'save' || point === 'seed') next.version = ++version
    groups.set(groupID, next)
    if (ambiguous === point) {
      ambiguous = undefined
      throw new StorageOutcomeUnknownError('Committed transaction outcome unknown')
    }
    await runSeam(`after-${point}`)
  }
  return {
    control: (storageID, key) => {
      const fixedKey = { ...key }
      keys.set(storageID, fixedKey)
      return {
        get key() {
          return { ...fixedKey }
        },
        load: async () => structuredClone(read(storageID).control),
        lastMutation: async () => read(storageID).mutationID,
        apply: async (changes, mutationID) => {
          const ownedChanges = structuredClone(changes)
          await transact(storageID, 'apply', (next) => {
            const proofKey = ownedChanges.commitOnceAcceptance?.source.key
            if (
              proofKey !== undefined &&
              (proofKey.groupID !== fixedKey.groupID ||
                proofKey.incarnation !== fixedKey.incarnation)
            )
              throw new Error('Acceptance key mismatch')
            const source =
              next.state === null ? null : (options.readIdentity?.(next.state, fixedKey) ?? null)
            next.control = applyChanges(
              next.control,
              ownedChanges,
              source === null ? null : { kind: 'head', source },
            )
            next.mutationID = mutationID
          })
        },
      }
    },
    saveBuilt: async (storageID, key, intent, built, expected, mutationID) => {
      let result: 'saved' | 'moved' | 'occupied' = 'moved'
      const unchanged = new Error('Unchanged build')
      try {
        await transact(storageID, 'apply', (next) => {
          const source =
            next.state === null ? null : (options.readIdentity?.(next.state, key) ?? null)
          const identity = expected.identity
          const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
          if (
            !same(key, expected.key) ||
            identity === null ||
            !same(source, identity) ||
            next.version !== expected.stateVersion ||
            (next.control.cursor === null &&
              (next.initialState === null ||
                !same(options.readIdentity?.(next.initialState, key) ?? null, identity))) ||
            next.control.operations[0]?.id !== intent.id ||
            !same(next.control.operations[0], intent) ||
            built.searchFrom !== (next.control.cursor?.position ?? null) ||
            (next.control.cursor !== null &&
              (next.control.cursor.epoch !== identity.epoch ||
                next.control.cursor.stranded ||
                next.control.cursor.fork))
          )
            throw unchanged
          const occupied = next.control.commitOnce
          if (
            occupied !== null &&
            occupied.incarnation === key.incarnation &&
            occupied.epoch >= identity.epoch
          ) {
            result = 'occupied'
            throw unchanged
          }
          const context: CommitOnceWriteContext = {
            kind: 'build',
            source: expected,
            queueHeadID: intent.id,
            checkpoint: next.control.cursor?.position ?? null,
          }
          next.control = applyChanges(next.control, {
            putOperations: [{ ...intent, stage: 'built', built }],
          })
          next.control = applyChanges(
            next.control,
            { commitOnce: built, commitOnceAcceptance: null },
            context,
          )
          next.mutationID = mutationID
          result = 'saved'
        })
      } catch (error) {
        if (error === unchanged) return result
        if (
          error instanceof StorageOutcomeUnknownError &&
          read(storageID).mutationID === mutationID
        )
          return 'saved'
        throw error
      }
      return result
    },
    anchorStore: (groupID) => ({
      load: async () => structuredClone(read(groupID).anchorSlot),
      save: async (slot) => {
        const ownedSlot = structuredClone(slot)
        await transact(groupID, 'anchor', (next) => {
          next.anchorSlot = ownedSlot
        })
      },
    }),
    loadVersion: async (groupID) => read(groupID).version,
    loadState: async (groupID) => read(groupID).state?.slice() ?? null,
    seed: async (groupID, state, options) => {
      const ownedState = state.slice()
      const replace = options?.replace === true
      const expectedVersion = options?.replace === true ? options.expectedVersion : undefined
      await transact(groupID, 'seed', (next) => {
        if (replace && next.version !== expectedVersion)
          throw new Error('Group state version is stale')
        if (next.state != null && !replace) throw new Error('Group state already exists')
        next.initialState = ownedState.slice()
        next.state = ownedState
        if (replace) {
          next.control = applyChanges(next.control, readmissionChanges(next.control))
          next.anchorSlot = null
        }
      })
    },
    saveState: async (groupID, state, write) => {
      const ownedState = state.slice()
      const ownedWrite = structuredClone(write)
      await transact(groupID, 'save', (next) => {
        const slot = next.control.commitOnce
        const key =
          ownedWrite?.expected?.key ??
          keys.get(groupID) ??
          (slot == null ? null : { groupID, incarnation: slot.incarnation })
        const before =
          next.state === null || key === null
            ? null
            : (options.readIdentity?.(next.state, key) ?? null)
        const after = key === null ? null : (options.readIdentity?.(ownedState, key) ?? null)
        if (next.state === null) next.initialState = ownedState.slice()
        next.state = ownedState
        if (ownedWrite != null) {
          next.control = applyChanges(
            next.control,
            ownedWrite.changes,
            before === null
              ? null
              : {
                  kind: 'adoption',
                  before,
                  after,
                  retired:
                    after !== null &&
                    after.groupID === before.groupID &&
                    after.incarnation > before.incarnation,
                },
          )
          next.mutationID = ownedWrite.mutationID
          if (
            ownedWrite.anchorLanded != null &&
            next.anchorSlot?.pending?.advance === ownedWrite.anchorLanded
          ) {
            next.anchorSlot.pending.landed = true
          }
        }
      })
    },
    delete: async (groupID) => {
      if (!controlSettled(read(groupID).control)) {
        throw new GroupControlUnsettledError('Group has unsettled control records')
      }
      groups.delete(groupID)
    },
    failNext: (point) => {
      failure = point
    },
    commitThenRejectNext: (point) => {
      ambiguous = point
    },
    seam: (name, hook) => {
      seams.set(name, hook)
    },
  }
}
