import type { MigrationFixture } from '../../../rpc-conformance/src/control-migration.js'
import { migrateMemoryControl } from '../../../rpc-conformance/src/memory-control-migration.js'
import type { MemoryMigrationBackend } from '../../../rpc-conformance/src/memory-migration-backend.js'
import type { AnchorSlot, AnchorStore } from '../../src/anchor.js'
import { controlSafetyHeld } from '../../src/control/safety.js'
import {
  applyChanges,
  type CommitOnceWriteContext,
  controlAdoptionAllowed,
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
import { executableOperations } from '../../src/control/types.js'
import { GroupControlUnsettledError, StorageOutcomeUnknownError } from '../../src/errors.js'

const inboundStates = new WeakMap<AdoptionWrite, Uint8Array>()

/** Minted only after the memory MLS receiver authenticates the delivered commit. */
export function memoryInboundWrite(write: AdoptionWrite, state: Uint8Array): AdoptionWrite {
  const bound = { ...write }
  inboundStates.set(bound, state.slice())
  return bound
}

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
  bindIdentity(
    storageID: string,
    reader: (state: Uint8Array, key: GroupKey) => EpochIdentity | null,
  ): void
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
  snapshot(
    groupID: string,
  ): Promise<{ version: number; state: Uint8Array | null; control: ControlSnapshot }>
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
      schemaVersion: 1,
      commitOnce: null,
      spentSource: null,
      controlHold: null,
      forkHalt: null,
      recoveryUnavailable: null,
      strand: null,
      operations: [],
      rejoin: null,
      recoveryEpochFloor: null,
      forkRecoveryAttempt: null,
      settledRejoins: [],
      outcomes: [],
      welcomes: [],
      applied: [],
      responses: [],
      cursor: null,
    },
  }
}

export function createMemoryHostDatabase(
  options: {
    legacy?: MigrationFixture
    migration?: MemoryMigrationBackend
    readIdentity?: (state: Uint8Array, key: GroupKey) => EpochIdentity | null
    isTerminal?: (state: Uint8Array) => boolean
  } = {},
): MemoryHostDatabase {
  let version = 0
  const readers = new Map<string, (state: Uint8Array, key: GroupKey) => EpochIdentity | null>()
  const readIdentity = (storageID: string, state: Uint8Array, key: GroupKey) =>
    (readers.get(storageID) ?? options.readIdentity)?.(state, key) ?? null
  const groups = new Map<string, GroupRecord>()
  let legacy = options.legacy === undefined ? undefined : structuredClone(options.legacy)
  let migration = options.migration
  async function activate(storageID: string): Promise<void> {
    if (migration !== undefined && migration.key.groupID === storageID) {
      const next = groups.get(storageID) ?? emptyRecord()
      next.control = structuredClone(await migration.activate()) as unknown as ControlSnapshot
      groups.set(storageID, next)
      migration = undefined
    }
    if (legacy === undefined || legacy.source.key.groupID !== storageID) return
    const next = groups.get(storageID) ?? emptyRecord()
    next.control = structuredClone(migrateMemoryControl(legacy)) as unknown as ControlSnapshot
    groups.set(storageID, next)
    legacy = undefined
  }
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
    bindIdentity: (storageID, reader) => {
      readers.set(storageID, reader)
    },
    control: (storageID, key) => {
      const legacyKey = options.legacy?.source.key ?? options.migration?.key
      if (
        legacyKey?.groupID === storageID &&
        (legacyKey.groupID !== key.groupID || legacyKey.incarnation !== key.incarnation)
      )
        throw new TypeError('Migration source does not bind this control store')
      const fixedKey = { ...key }
      keys.set(storageID, fixedKey)
      return {
        get key() {
          return { ...fixedKey }
        },
        load: async () => {
          await activate(storageID)
          return {
            ...structuredClone(read(storageID).control),
            forkRecoveryAttempt: structuredClone(
              read(storageID).control.forkRecoveryAttempt ?? null,
            ),
          }
        },
        lastMutation: async () => {
          await activate(storageID)
          return read(storageID).mutationID
        },
        apply: async (changes, mutationID) => {
          await activate(storageID)
          if ('clearAppHold' in changes)
            throw new TypeError('App hold release requires coordinator authority')
          const { forkHalt, recoveryUnavailable, ...ordinary } = changes
          // Materialize safety before an own-property clone can erase supplied fields.
          const safety = applyChanges(
            emptyRecord().control,
            {
              ...('forkHalt' in changes ? { forkHalt } : {}),
              ...('recoveryUnavailable' in changes ? { recoveryUnavailable } : {}),
            },
            null,
            fixedKey,
          )
          const ownedChanges = {
            ...structuredClone(ordinary),
            ...(safety.forkHalt === null ? {} : { forkHalt: safety.forkHalt }),
            ...(safety.recoveryUnavailable === null
              ? {}
              : { recoveryUnavailable: safety.recoveryUnavailable }),
          }
          await transact(storageID, 'apply', (next) => {
            const source =
              next.state === null ? null : readIdentity(storageID, next.state, fixedKey)
            next.control = applyChanges(
              next.control,
              ownedChanges,
              source === null
                ? null
                : {
                    kind:
                      ownedChanges.commitOnce === null && ownedChanges.spentSource != null
                        ? 'abandon'
                        : ownedChanges.cursor !== undefined
                          ? 'cursor'
                          : ownedChanges.commitOnce?.reported === true &&
                              next.control.commitOnce?.reported !== true
                            ? 'report'
                            : ownedChanges.commitOnce?.acceptedAs !== undefined &&
                                next.control.commitOnce?.acceptedAs === undefined
                              ? 'ack'
                              : 'head',
                    source,
                  },
              fixedKey,
            )
            next.mutationID = mutationID
          })
        },
      }
    },
    saveBuilt: async (storageID, key, intent, built, expected, mutationID) => {
      await activate(storageID)
      let result: 'saved' | 'moved' | 'occupied' = 'moved'
      const unchanged = new Error('Unchanged build')
      try {
        await transact(storageID, 'apply', (next) => {
          const source = next.state === null ? null : readIdentity(storageID, next.state, key)
          const identity = expected.identity
          const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
          if (
            built.opID !== intent.id ||
            !(['kind', 'revokes', 'enqueuedAt', 'deadline'] as const).every(
              (field) => built[field] === intent[field],
            ) ||
            controlSafetyHeld(next.control) !== null ||
            next.control.controlHold !== null ||
            !same(key, expected.key) ||
            identity === null ||
            !same(source, identity) ||
            next.version !== expected.stateVersion ||
            (next.control.cursor === null &&
              (next.initialState === null ||
                !same(readIdentity(storageID, next.initialState, key), identity))) ||
            executableOperations(next.control)[0]?.id !== intent.id ||
            !same(executableOperations(next.control)[0], intent) ||
            built.head !== (next.control.cursor?.position ?? null) ||
            (next.control.cursor !== null &&
              (next.control.cursor.epoch !== identity.epoch ||
                next.control.cursor.stranded ||
                next.control.cursor.incomplete))
          )
            throw unchanged
          const occupied = next.control.commitOnce
          if (occupied !== null || next.control.spentSource?.epoch === identity.epoch) {
            result = 'occupied'
            throw unchanged
          }
          const context: CommitOnceWriteContext = {
            kind: 'build',
            source: expected,
            queueHeadID: intent.id,
            checkpoint: next.control.cursor?.position ?? null,
          }
          next.control = applyChanges(next.control, { deleteOperations: [intent.id] }, null, key)
          next.control = applyChanges(next.control, { commitOnce: built }, context, key)
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
      load: async () => {
        await activate(groupID)
        return structuredClone(read(groupID).anchorSlot)
      },
      save: async (slot) => {
        await activate(groupID)
        const ownedSlot = structuredClone(slot)
        await transact(groupID, 'anchor', (next) => {
          next.anchorSlot = ownedSlot
        })
      },
    }),
    loadVersion: async (groupID) => {
      await activate(groupID)
      return read(groupID).version
    },
    loadState: async (groupID) => {
      await activate(groupID)
      return read(groupID).state?.slice() ?? null
    },
    snapshot: async (groupID) => {
      await activate(groupID)
      const row = read(groupID)
      return {
        version: row.version,
        state: row.state?.slice() ?? null,
        control: structuredClone(row.control),
      }
    },
    seed: async (groupID, state, options) => {
      await activate(groupID)
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
          const key = keys.get(groupID)
          next.control = applyChanges(
            next.control,
            readmissionChanges(next.control),
            key === undefined ? null : { kind: 'retirement', key },
            key,
          )
          next.anchorSlot = null
        }
      })
    },
    saveState: async (groupID, state, write) => {
      await activate(groupID)
      const ownedState = state.slice()
      const proof = write === undefined ? undefined : inboundStates.get(write)
      if (write !== undefined) inboundStates.delete(write)
      const authenticated =
        proof !== undefined &&
        proof.length === state.length &&
        proof.every((byte, index) => byte === state[index])
      const terminal = (() => {
        if (options.isTerminal !== undefined) return options.isTerminal(state)
        try {
          return (
            (JSON.parse(new TextDecoder().decode(state)) as { terminal?: boolean }).terminal ===
            true
          )
        } catch {
          return false
        }
      })()
      const ownedWrite = structuredClone(write)
      await transact(groupID, 'save', (next) => {
        const slot = next.control.commitOnce
        const key =
          keys.get(groupID) ?? (slot == null ? null : { groupID, incarnation: slot.incarnation })
        const before =
          next.state === null || key === null ? null : readIdentity(groupID, next.state, key)
        const expected = ownedWrite?.expected
        if (
          controlSafetyHeld(next.control) !== null ||
          (ownedWrite !== undefined && next.control.controlHold !== null)
        ) {
          throw Object.assign(new Error('Adoption is held'), { name: 'ControlAdoptionMovedError' })
        }
        if (
          expected !== undefined &&
          (key === null ||
            !controlAdoptionAllowed(
              next.control,
              { key, identity: before, stateVersion: next.version },
              expected,
              undefined,
              ownedWrite?.changes,
            ))
        ) {
          const error = new Error('Adoption source or control proof moved')
          error.name = 'ControlAdoptionMovedError'
          throw error
        }
        const after = key === null ? null : readIdentity(groupID, ownedState, key)
        if (next.state === null) next.initialState = ownedState.slice()
        next.state = ownedState
        if (ownedWrite != null) {
          next.control = applyChanges(
            next.control,
            ownedWrite.changes,
            before === null
              ? null
              : after !== null &&
                  after.groupID === before.groupID &&
                  after.incarnation > before.incarnation
                ? {
                    kind: 'retirement',
                    key: { groupID: before.groupID, incarnation: before.incarnation },
                  }
                : {
                    kind: 'adoption',
                    before,
                    after,
                    ...(terminal && (authenticated || options.isTerminal !== undefined)
                      ? { removed: true as const }
                      : {}),
                  },
            key,
          )
          next.mutationID = ownedWrite.mutationID
          if (
            ownedWrite.anchorLanded != null &&
            next.anchorSlot?.pending?.advance === ownedWrite.anchorLanded
          ) {
            next.anchorSlot.pending.landed = true
          }
        }
        if (
          before !== null &&
          (((terminal ||
            (after !== null &&
              (after.incarnation !== before.incarnation || after.epoch > before.epoch))) &&
            next.control.commitOnce !== null) ||
            (terminal && (next.control.operations.length !== 0 || next.control.rejoin !== null)))
        )
          throw new Error('Source consumption requires atomic control closure')
      })
    },
    delete: async (groupID) => {
      await activate(groupID)
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
