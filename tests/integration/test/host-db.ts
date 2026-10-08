import {
  type AdoptionWrite,
  type AnchorSlot,
  type AnchorStore,
  applyChanges,
  type ControlSnapshot,
  type ControlStore,
  controlSettled,
  GroupControlUnsettledError,
  StorageOutcomeUnknownError,
} from '@kumiai/rpc'

type GroupRecord = {
  state: Uint8Array | null
  anchorSlot: AnchorSlot | null
  control: ControlSnapshot
  mutationID: string | null
}

type WritePoint = 'apply' | 'save' | 'anchor'
type FailurePoint = 'mid-apply' | 'mid-save' | 'mid-anchor'

export type MemoryHostDatabase = {
  control(groupID: string): ControlStore
  anchorStore(groupID: string): AnchorStore
  saveState(groupID: string, state: Uint8Array, write?: AdoptionWrite): Promise<void>
  loadState(groupID: string): Promise<Uint8Array | null>
  delete(groupID: string): Promise<void>
  failNext(point: FailurePoint): void
  commitThenRejectNext(point: WritePoint): void
  seam(name: string, hook: () => void | Promise<void>): void
}

function emptyRecord(): GroupRecord {
  return {
    state: null,
    anchorSlot: null,
    mutationID: null,
    control: {
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
    groups.set(groupID, next)
    if (ambiguous === point) {
      ambiguous = undefined
      throw new StorageOutcomeUnknownError('Committed transaction outcome unknown')
    }
    await runSeam(`after-${point}`)
  }
  return {
    control: (groupID) => ({
      load: async () => structuredClone(read(groupID).control),
      lastMutation: async () => read(groupID).mutationID,
      apply: async (changes, mutationID) => {
        const ownedChanges = structuredClone(changes)
        await transact(groupID, 'apply', (next) => {
          next.control = applyChanges(next.control, ownedChanges)
          next.mutationID = mutationID
        })
      },
    }),
    anchorStore: (groupID) => ({
      load: async () => structuredClone(read(groupID).anchorSlot),
      save: async (slot) => {
        const ownedSlot = structuredClone(slot)
        await transact(groupID, 'anchor', (next) => {
          next.anchorSlot = ownedSlot
        })
      },
    }),
    loadState: async (groupID) => read(groupID).state?.slice() ?? null,
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
