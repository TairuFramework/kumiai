import {
  forkEventID,
  type GroupMLS,
  type GroupSafetyEvent,
  type LogHub,
  type MailboxHub,
  type RecoveryUnavailableEvent,
} from '@kumiai/rpc'

import { coordinatorBinding } from './entry-capability.js'
import { sameStoredValue } from './memory-incarnation-stores.js'
import {
  ForkReportRefusedError,
  GroupUnavailableError,
  ManualRecoveryUnavailableError,
} from './persistence-errors.js'
import type {
  EpochIdentity,
  GroupForkEvidence,
  GroupKey,
  GroupPersistence,
  GroupTransaction,
  PersistenceEvent,
} from './persistence-types.js'
import { registrySafety } from './registry/safety.js'
import { readRecoverySource } from './registry/source.js'
import type { GroupHandleRegistry } from './registry/types.js'

export type ManualRecovery =
  | { mode: 'resync'; targetID: string }
  | { mode: 'successor'; successor: GroupKey }
export type RecoveryTarget = { id: string; commitTopicID: string; hub: LogHub & MailboxHub }
export type GroupSafety = {
  epochAuthenticator(key: GroupKey): Promise<EpochIdentity | null>
  reportFork(key: GroupKey, evidence: GroupForkEvidence): Promise<void>
  recover(key: GroupKey, choice: ManualRecovery): Promise<GroupKey>
  events(key: GroupKey): Promise<Array<GroupSafetyEvent | RecoveryUnavailableEvent>>
  ackEvent(key: GroupKey, id: string): Promise<void>
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
): event is GroupSafetyEvent | RecoveryUnavailableEvent {
  return event.kind === 'group:fork' || event.kind === 'group:recovery-unavailable'
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
          if (error instanceof GroupUnavailableError) return null
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
            const control = await reads.control(key.incarnation)
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
            const control = await target.control.load()
            if (control.forkHalt !== null) throw new Noop()
            const lifetime = await stores.lifetime.load()
            if (lifetime?.groupID !== key.groupID || lifetime.activeIncarnation !== key.incarnation)
              throw new ForkReportRefusedError({ reason: 'key' })
            const trust = await stores.trust.load()
            if (!sameStoredValue(trust?.installed, identity))
              throw new ForkReportRefusedError({ reason: 'authenticator' })
            await target.control.apply({ forkHalt: halt }, mutationID)
          },
        )
      } catch (error) {
        if (!(error instanceof Noop)) throw error
      }
    },
    async recover() {
      throw new ManualRecoveryUnavailableError('Manual recovery is unavailable')
    },
    events(requested) {
      const key = { ...requested }
      return entry.read(key.groupID, async (reads) => {
        return (await reads.events(key.incarnation)).filter(safetyEvent)
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
