import {
  type ControlSnapshot,
  controlSafetyHeld,
  forkEventID,
  type GroupCondition,
  type GroupConditionEvent,
  type GroupMLS,
  type GroupSafetyEvent,
  GroupSafetyHeldError,
  type LogHub,
  type MailboxHub,
  type ManualRecoveryStatus,
  type NotMemberEvidence,
  type RecoveryUnavailableEvent,
  type SafetyHold,
} from '@kumiai/rpc'

import { coordinatorBinding } from './entry-capability.js'
import {
  createManualRecoveryStore,
  manualRecoveryStatus,
  rememberManualRecoveryTarget,
  validCallTimeTarget,
} from './manual-recovery.js'
import { sameStoredValue } from './memory-incarnation-stores.js'
import { isStoredOpenFailure } from './persistence-codec.js'
import {
  ForkReportRefusedError,
  GroupStateConflictError,
  GroupUnavailableError,
} from './persistence-errors.js'
import type {
  EpochIdentity,
  GroupForkEvidence,
  GroupKey,
  GroupPersistence,
  GroupTransaction,
  PersistenceEvent,
} from './persistence-types.js'
import { registryRecoveryCoordinator } from './registry/recovery-coordinator.js'
import {
  RetainedTrustUnavailableError,
  readRetainedTrust,
  registrySafety,
} from './registry/safety.js'
import { readRecoverySource } from './registry/source.js'
import type { GroupHandleRegistry } from './registry/types.js'
import { flushConditionEvents, groupCondition } from './safety-conditions.js'
import { clearSuccessorTombstone, retireToSuccessor } from './successor.js'

export type ManualRecovery =
  | { mode: 'resync'; targetID: string; allowOpenFork?: boolean }
  | {
      mode: 'resync'
      target: { targetID: string; hub: LogHub & MailboxHub; commitTopicID: string }
      allowOpenFork?: boolean
    }
  | { mode: 'successor'; successor: GroupKey }
export type RecoveryTarget = { id: string; commitTopicID: string; hub: LogHub & MailboxHub }
export type GroupSafety = {
  status(key: GroupKey): Promise<{
    hold: SafetyHold
    condition: GroupCondition | null
    evidence: NotMemberEvidence | null
    manualRecovery: ManualRecoveryStatus | null
  }>
  epochAuthenticator(key: GroupKey): Promise<EpochIdentity | null>
  reportFork(key: GroupKey, evidence: GroupForkEvidence): Promise<void>
  /** Resync returns the installed key; successor returns the successor after source retirement. */
  recover(key: GroupKey, choice: ManualRecovery): Promise<GroupKey>
  events(
    key: GroupKey,
  ): Promise<Array<GroupSafetyEvent | RecoveryUnavailableEvent | GroupConditionEvent>>
  ackEvent(key: GroupKey, id: string): Promise<void>
  /** Releases only the successor readmission block; spent checks and safety latches stay. */
  clearTombstone(groupID: string): Promise<void>
}

class Noop extends Error {}

function validKey(key: GroupKey): boolean {
  return (
    typeof key.groupID === 'string' &&
    key.groupID.length > 0 &&
    Number.isSafeInteger(key.incarnation) &&
    key.incarnation > 0
  )
}

function safetyEvent(
  event: PersistenceEvent,
): event is GroupSafetyEvent | RecoveryUnavailableEvent | GroupConditionEvent {
  return (
    event.kind === 'group:fork' ||
    event.kind === 'group:recovery-unavailable' ||
    event.kind === 'not-member' ||
    event.kind === 'spent-set-corrupt'
  )
}

async function readReportControl(read: () => Promise<ControlSnapshot>): Promise<ControlSnapshot> {
  try {
    return await read()
  } catch (cause) {
    if (!isStoredOpenFailure(cause) && !(cause instanceof GroupStateConflictError)) throw cause
    // biome-ignore lint/style/useErrorCause: The constructor forwards cause.
    throw new GroupUnavailableError({ reason: 'invalid', cause })
  }
}

function validateEvidence(evidence: GroupForkEvidence, identity: EpochIdentity): void {
  if (
    !Number.isSafeInteger(evidence.epoch) ||
    evidence.epoch < 0 ||
    evidence.epoch > identity.epoch
  )
    throw new ForkReportRefusedError({ reason: 'epoch' })
  if (evidence.kind === 'epoch-authenticator') {
    if (evidence.epoch !== identity.epoch) throw new ForkReportRefusedError({ reason: 'epoch' })
    if (
      !(evidence.local instanceof Uint8Array) ||
      !(evidence.remote instanceof Uint8Array) ||
      !sameStoredValue(evidence.local, identity.authenticator) ||
      sameStoredValue(evidence.local, evidence.remote)
    )
      throw new ForkReportRefusedError({ reason: 'authenticator' })
  }
}

export function createGroupSafety<TTx extends GroupTransaction>(params: {
  registry: GroupHandleRegistry
  persistence: GroupPersistence<TTx>
  mls: GroupMLS
  resolveTarget: (targetID: string) => Promise<RecoveryTarget>
}): GroupSafety {
  const capability = registrySafety<TTx>(params.registry)
  if (capability === null || capability.binding !== coordinatorBinding(params.persistence))
    throw new TypeError('GroupSafety requires a registered registry with the same coordinator')
  const { entry } = capability
  return {
    async status(requested) {
      const key = { ...requested }
      return await entry.read(key.groupID, async (reads) => {
        const records = await reads.checkpoints()
        const { condition, evidence } = groupCondition(records, key)
        const control = await reads.control(key.incarnation)
        return {
          hold: capability.held(key) ?? controlSafetyHeld(control, condition),
          condition,
          evidence,
          manualRecovery: manualRecoveryStatus(records, key),
        }
      })
    },
    async epochAuthenticator(requested) {
      const key = { ...requested }
      if (!validKey(key)) return null
      return await entry.read(key.groupID, async (reads) => {
        const lifetime = await reads.lifetime()
        if (lifetime?.activeIncarnation !== key.incarnation || lifetime.groupID !== key.groupID)
          return null
        try {
          const source = await readRecoverySource(reads, key.groupID)
          return source.identity
        } catch (error) {
          if (error instanceof RetainedTrustUnavailableError) return null
          throw error
        }
      })
    },
    async reportFork(requested, supplied) {
      const key = { ...requested }
      const evidence =
        supplied.kind === 'epoch-authenticator'
          ? { ...supplied, local: supplied.local.slice(), remote: supplied.remote.slice() }
          : { ...supplied }
      const detectedAt = Date.now()
      if (!validKey(key)) throw new ForkReportRefusedError({ reason: 'key' })
      const halt = { eventID: forkEventID(key), evidence, detectedAt }
      const mutationID = crypto.randomUUID()
      try {
        await entry.run(
          { groupID: key.groupID, mutationID },
          async (reads) => {
            const control = await readReportControl(() => reads.control(key.incarnation))
            if (control.forkHalt !== null) {
              capability.latch(key, 'fork-halted')
              throw new Noop()
            }
            const lifetime = await reads.lifetime()
            if (lifetime?.groupID !== key.groupID || lifetime.activeIncarnation !== key.incarnation)
              throw new ForkReportRefusedError({ reason: 'key' })
            const source = await readRecoverySource(reads, key.groupID)
            if (source.identity === null)
              throw new ForkReportRefusedError({ reason: 'authenticator' })
            validateEvidence(evidence, source.identity)
            capability.latch(key, 'fork-halted')
            return { expected: lifetime, value: source.identity }
          },
          async (stores, identity) => {
            const target = stores.incarnation(key.incarnation)
            const control = await readReportControl(() => target.control.load())
            if (control.forkHalt !== null) throw new Noop()
            const lifetime = await stores.lifetime.load()
            if (lifetime?.groupID !== key.groupID || lifetime.activeIncarnation !== key.incarnation)
              throw new ForkReportRefusedError({ reason: 'key' })
            const trust = await readRetainedTrust({ trust: stores.trust.load }, key)
            if (!sameStoredValue(trust?.installed, identity))
              throw new ForkReportRefusedError({ reason: 'authenticator' })
            await target.control.apply({ forkHalt: halt }, mutationID)
          },
        )
      } catch (error) {
        if (error instanceof RetainedTrustUnavailableError) {
          await capability.persistTrustUnavailable(error.key)
          // biome-ignore lint/style/useErrorCause: The persisted diagnosis supplies the refusal reason.
          throw new GroupSafetyHeldError('recovery-unavailable')
        }
        if (!(error instanceof Noop)) throw error
      }
    },
    async recover(requested, choice) {
      if (choice.mode === 'successor') {
        const source = { ...requested }
        const successor = { ...choice.successor }
        if (!validKey(source) || !validKey(successor) || successor.groupID === source.groupID)
          throw new TypeError('Invalid manual recovery choice')
        return await retireToSuccessor({
          registry: params.registry,
          persistence: params.persistence,
          source,
          successor,
        })
      }
      const { allowOpenFork = false } = choice
      const supplied =
        'target' in choice
          ? {
              id: choice.target.targetID,
              hub: choice.target.hub,
              commitTopicID: choice.target.commitTopicID,
            }
          : null
      const targetID = supplied?.id ?? ('targetID' in choice ? choice.targetID : undefined)
      const key = { ...requested }
      if (
        !validKey(key) ||
        typeof targetID !== 'string' ||
        targetID.length === 0 ||
        typeof allowOpenFork !== 'boolean' ||
        (supplied !== null && !validCallTimeTarget(supplied))
      )
        throw new TypeError('Invalid manual recovery choice')
      const target = supplied ?? (await params.resolveTarget(targetID))
      if (
        target.id !== targetID ||
        typeof target.commitTopicID !== 'string' ||
        target.commitTopicID.length === 0
      )
        throw new GroupStateConflictError('Manual recovery target mismatch')
      const storage = createManualRecoveryStore({
        registry: params.registry,
        persistence: params.persistence,
        key,
      })
      const record = await storage.authoriseManualRecovery(key, {
        mode: 'resync',
        targetID: target.id,
        commitTopicID: target.commitTopicID,
        allowOpenFork,
      })
      // The live binding becomes usable only after durable authorisation is proven.
      if (supplied !== null) rememberManualRecoveryTarget(params.registry, record.id, supplied)
      return await registryRecoveryCoordinator(params.registry).runManual(record)
    },
    async events(requested) {
      const key = { ...requested }
      await flushConditionEvents(params.registry, key)
      return entry.read(key.groupID, async (reads) => {
        const records = await reads.checkpoints()
        return (await reads.events(key.incarnation))
          .filter(safetyEvent)
          .filter(
            (event) =>
              (event.kind !== 'not-member' && event.kind !== 'spent-set-corrupt') ||
              records.some(
                (row) =>
                  row.kind === 'condition' &&
                  row.event.id === event.id &&
                  sameStoredValue(row.event, event),
              ),
          )
      })
    },
    async clearTombstone(groupID) {
      await clearSuccessorTombstone({
        registry: params.registry,
        persistence: params.persistence,
        groupID,
      })
    },
    async ackEvent(requested, id) {
      const key = { ...requested }
      try {
        await entry.run(
          { groupID: key.groupID, mutationID: crypto.randomUUID() },
          async (reads) => {
            const event = (await reads.events(key.incarnation)).find((value) => value.id === id)
            if (event === undefined) throw new Noop()
            if (!safetyEvent(event))
              throw new TypeError('GroupSafety only acknowledges safety events')
            return { expected: await reads.lifetime(), value: null }
          },
          async (stores) => {
            const target = stores.incarnation(key.incarnation)
            const event = (await target.meta.events()).find((value) => value.id === id)
            if (event === undefined) throw new Noop()
            if (!safetyEvent(event))
              throw new TypeError('GroupSafety only acknowledges safety events')
            await target.meta.ackEvent(id)
          },
        )
      } catch (error) {
        if (!(error instanceof Noop)) throw error
      }
    },
  }
}
