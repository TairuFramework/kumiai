import type { AnchorSlot, AnchorStore } from '../../src/anchor.js'
import { applyChanges, controlSettled, readmissionChanges } from '../../src/control/store.js'
import type {
  AdoptionWrite,
  ControlSnapshot,
  ControlStore,
  GroupKey,
} from '../../src/control/types.js'
import { GroupControlUnsettledError, StorageOutcomeUnknownError } from '../../src/errors.js'

type GroupRecord = {
  version: number
  state: Uint8Array | null
  anchorSlot: AnchorSlot | null
  control: ControlSnapshot
  mutationID: string | null
}

type SeedOptions = { replace?: false } | { replace: true; expectedVersion: number }

type WritePoint = 'apply' | 'save' | 'anchor' | 'seed'
type FailurePoint = 'mid-apply' | 'mid-save' | 'mid-anchor' | 'mid-seed'

export type MemoryHostDatabase = {
  control(storageID: string, key: GroupKey): ControlStore
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

export function createMemoryHostDatabase(): MemoryHostDatabase {
  let version = 0
  const groups = new Map<string, GroupRecord>()
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
      return {
        get key() {
          return { ...fixedKey }
        },
        load: async () => structuredClone(read(storageID).control),
        lastMutation: async () => read(storageID).mutationID,
        apply: async (changes, mutationID) => {
          const ownedChanges = structuredClone(changes)
          await transact(storageID, 'apply', (next) => {
            next.control = applyChanges(next.control, ownedChanges)
            next.mutationID = mutationID
          })
        },
      }
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
        next.state = ownedState
        if (ownedWrite != null) {
          next.control = applyChanges(next.control, ownedWrite.changes)
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
