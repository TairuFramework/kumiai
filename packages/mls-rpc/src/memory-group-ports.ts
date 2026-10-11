import type { ControlChanges } from '@kumiai/rpc'

import { copyStoredValue, sameStoredValue, statusEventID } from './memory-incarnation-stores.js'
import { GroupStateConflictError, NonRootProviderError } from './persistence-errors.js'
import type {
  AppOutboxEntry,
  AppSettlementResult,
  AppStatusEvent,
  GroupKey,
  GroupPersistence,
  GroupPersistencePorts,
  GroupStores,
  MemoryTransaction,
} from './persistence-types.js'

export type MemoryGroupAccess = {
  read<TValue>(
    key: GroupKey,
    work: (stores: GroupStores<MemoryTransaction>) => Promise<TValue>,
  ): Promise<TValue>
  write<TValue>(
    key: GroupKey,
    work: (stores: GroupStores<MemoryTransaction>, mutationID: string) => Promise<TValue>,
    options?: {
      active?: boolean
      mutationID?: string
      check?(stores: GroupStores<MemoryTransaction>): Promise<void>
    },
  ): Promise<TValue>
  lastControlMutation(key: GroupKey): Promise<string | null>
}

const accesses = new WeakMap<GroupPersistence<MemoryTransaction>, MemoryGroupAccess>()

export function bindMemoryGroupPorts(
  groups: GroupPersistence<MemoryTransaction>,
  access: MemoryGroupAccess,
): void {
  accesses.set(groups, access)
}

export class UnchangedGroupResult {
  value: unknown
  constructor(value: unknown) {
    this.value = value
  }
}

export function unchangedGroupResult<TValue>(value: TValue): never {
  throw new UnchangedGroupResult(value)
}

function owedChanges(changes: ControlChanges): boolean {
  return Object.keys(changes).every((key) => key === 'deleteOutcomes' || key === 'deleteWelcomes')
}

export function createMemoryGroupPorts(params: {
  groups: GroupPersistence<MemoryTransaction>
  key: GroupKey
}): GroupPersistencePorts {
  const access = accesses.get(params.groups)
  if (access === undefined)
    throw new NonRootProviderError('Memory group ports require a root persistence factory')
  const key = { ...params.key }
  return {
    get key() {
      return { ...key }
    },
    control: {
      get key() {
        return { ...key }
      },
      load: () => access.read(key, (stores) => stores.incarnation(key.incarnation).control.load()),
      async apply(changes, mutationID) {
        const owned = copyStoredValue(changes)
        await access.write(
          key,
          (stores) => stores.incarnation(key.incarnation).control.apply(owned, mutationID),
          { active: !owedChanges(owned), mutationID },
        )
      },
      lastMutation: () => access.lastControlMutation(key),
    },
    anchor: {
      load: () => access.read(key, (stores) => stores.incarnation(key.incarnation).anchor.load()),
      async save(slot) {
        const owned = copyStoredValue(slot)
        await access.write(
          key,
          (stores) => stores.incarnation(key.incarnation).anchor.save(owned),
          { active: true },
        )
      },
    },
    cursor: {
      load: (topicID) =>
        access.read(key, (stores) => stores.incarnation(key.incarnation).cursor.load(topicID)),
      save: (topicID, position) =>
        access.write(
          key,
          (stores) => stores.incarnation(key.incarnation).cursor.save(topicID, position),
          { active: true },
        ),
    },
    outbox: {
      async put(entry) {
        const owned = copyStoredValue(entry)
        let isNew = false
        await access.write(
          key,
          async (stores, mutationID) => {
            const rows = stores.incarnation(key.incarnation)
            await rows.outbox.put([owned])
            if (isNew)
              await rows.meta.putEvents([
                {
                  ...key,
                  id: statusEventID(mutationID, owned.seq, 'accepted'),
                  kind: 'accepted',
                  entry: owned,
                },
              ])
          },
          {
            active: true,
            async check(stores) {
              const previous = (await stores.incarnation(key.incarnation).outbox.list()).find(
                (value) => value.seq === owned.seq,
              )
              if (sameStoredValue(previous, owned)) unchangedGroupResult(undefined)
              isNew = previous === undefined
            },
          },
        )
      },
      list: () => access.read(key, (stores) => stores.incarnation(key.incarnation).outbox.list()),
      loadSettlement: (seq) =>
        access.read(key, (stores) => stores.incarnation(key.incarnation).meta.loadSettlement(seq)),
      async recordSettlement(seq, obligation, expected) {
        const owned = copyStoredValue({ obligation, expected })
        return await access.write(
          key,
          async (stores): Promise<AppSettlementResult> => {
            await stores.incarnation(key.incarnation).meta.putSettlement(seq, owned.obligation)
            return { recorded: true }
          },
          {
            async check(stores) {
              const rows = stores.incarnation(key.incarnation)
              const life = await stores.lifetime.load()
              const state = await rows.state.load()
              const identity = owned.expected.identity
              if (
                life?.activeIncarnation !== key.incarnation ||
                state === null ||
                state.deleted ||
                identity.groupID !== key.groupID ||
                identity.incarnation !== key.incarnation ||
                state.epoch !== identity.epoch ||
                !sameStoredValue(state.epochAuthenticator, identity.authenticator)
              )
                unchangedGroupResult({ recorded: false, reason: 'identity-changed' })
              if (state.version !== owned.expected.stateVersion)
                unchangedGroupResult({ recorded: false, reason: 'state-version-changed' })
              const entry = (await rows.outbox.list()).find((value) => value.seq === seq)
              if (entry === undefined)
                unchangedGroupResult({ recorded: false, reason: 'entry-missing' })
              if (
                entry.lastAttempt?.publishID !== owned.expected.attemptID ||
                owned.obligation.attemptID !== owned.expected.attemptID ||
                entry.lastAttempt.topicID !== owned.obligation.topicID ||
                entry.lastAttempt.incarnation !== identity.incarnation ||
                entry.lastAttempt.epoch !== identity.epoch
              )
                unchangedGroupResult({ recorded: false, reason: 'attempt-changed' })
              const previous = await rows.meta.loadSettlement(seq)
              if (sameStoredValue(previous, owned.obligation))
                unchangedGroupResult({ recorded: true })
            },
          },
        )
      },
      async remove(seq, outcome) {
        const owned = copyStoredValue(outcome)
        let entry!: AppOutboxEntry
        await access.write(
          key,
          async (stores, mutationID) => {
            const rows = stores.incarnation(key.incarnation)
            if (owned !== undefined) {
              if (
                owned.incarnation !== key.incarnation ||
                entry.lastAttempt === null ||
                entry.lastAttempt.segment !== owned.segment ||
                entry.lastAttempt.topicID !== owned.topicID
              )
                throw new GroupStateConflictError('Publication occurrence mismatch')
              const status: AppStatusEvent = {
                ...key,
                id: statusEventID(mutationID, seq, 'published'),
                entry,
                kind: 'published',
                occurrence: owned,
              }
              await rows.meta.putEvents([status])
            }
            await rows.outbox.remove([seq])
          },
          {
            async check(stores) {
              const stored = (await stores.incarnation(key.incarnation).outbox.list()).find(
                (value) => value.seq === seq,
              )
              if (stored === undefined) unchangedGroupResult(undefined)
              entry = stored
            },
          },
        )
      },
      async clear() {
        await access.write(key, (stores) => stores.incarnation(key.incarnation).outbox.clear(), {
          async check(stores) {
            if ((await stores.incarnation(key.incarnation).outbox.list()).length === 0)
              unchangedGroupResult(undefined)
          },
        })
      },
      async events() {
        return await access.read(key, async (stores) =>
          (await stores.incarnation(key.incarnation).meta.events()).filter(
            (event): event is AppStatusEvent =>
              event.kind === 'accepted' || event.kind === 'published' || event.kind === 'failed',
          ),
        )
      },
      async ackEvent(id) {
        await access.write(key, (stores) => stores.incarnation(key.incarnation).meta.ackEvent(id), {
          async check(stores) {
            if (
              !(await stores.incarnation(key.incarnation).meta.events()).some(
                (event) => event.id === id,
              )
            )
              unchangedGroupResult(undefined)
          },
        })
      },
    },
  }
}
