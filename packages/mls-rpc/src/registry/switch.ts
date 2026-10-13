import { encodeClientState, type GroupHandle } from '@kumiai/mls'
import { APP_TOPIC_LABEL, type RejoinRecord } from '@kumiai/rpc'

import type { EntryCapability } from '../entry-capability.js'
import { copyStoredValue, sameStoredValue } from '../memory-incarnation-stores.js'
import {
  GroupStateConflictError,
  GroupStateUncertainError,
  RegistryResyncRefusedError,
  StorageOutcomeUnknownError,
} from '../persistence-errors.js'
import type { GroupPersistence, GroupTransaction } from '../persistence-types.js'
import { retireIncarnation } from './retired.js'
import type { RegistryRetirement } from './retirement.js'
import { readRecoverySource } from './source.js'
import { recoveryTrustFor } from './trust.js'
import type { GroupHandleRegistry, RecoverySource, RegistrySwitchWrite } from './types.js'
import { type RecoveryEnvironment, validateRegistryHandle } from './validation.js'
import { verifyRegistryResync } from './verdict.js'

function exactFields(
  value: unknown,
  fields: Array<string>,
): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== fields.length ||
    !fields.every((field) => Object.hasOwn(value, field))
  )
    throw new TypeError('Restricted registry switch write required')
}

function validateWrite(value: RegistrySwitchWrite): void {
  exactFields(value, ['mutationID', 'source', 'destination'])
  exactFields(value.source, ['rejoinID'])
  exactFields(value.destination, ['control'])
  exactFields(value.destination.control, ['cursor'])
  exactFields(value.destination.control.cursor, ['position', 'epoch'])
  if (
    typeof value.mutationID !== 'string' ||
    value.mutationID.length === 0 ||
    typeof value.source.rejoinID !== 'string' ||
    value.source.rejoinID.length === 0 ||
    typeof value.destination.control.cursor.position !== 'string' ||
    value.destination.control.cursor.position.length === 0 ||
    !Number.isSafeInteger(value.destination.control.cursor.epoch) ||
    value.destination.control.cursor.epoch < 0
  )
    throw new TypeError('Invalid registry switch write')
}

function confirmedRecord(record: RejoinRecord | null, rejoinID: string): RejoinRecord {
  if (record?.id !== rejoinID || record.stage !== 'confirmed')
    throw new RegistryResyncRefusedError({ reason: 'unaccepted' })
  return record
}

function matchSource(actual: RecoverySource, expected: RecoverySource): void {
  if (
    !sameStoredValue(actual.key, expected.key) ||
    actual.stateVersion !== expected.stateVersion ||
    actual.lifetimeRevision !== expected.lifetimeRevision ||
    !sameStoredValue(actual.identity, expected.identity) ||
    !sameStoredValue(actual.trust, expected.trust)
  )
    throw new GroupStateConflictError('Registry switch source moved')
}

export function createRegistrySwitch<TTx extends GroupTransaction>(environment: {
  persistence: GroupPersistence<TTx>
  capability: EntryCapability<TTx>
  retirement: RegistryRetirement
  recovery: RecoveryEnvironment
  ownerDID: string
  start(): Promise<void>
}): GroupHandleRegistry['switchIncarnation'] {
  const { persistence, capability, retirement } = environment
  return async (candidate: GroupHandle, params) => {
    validateWrite(params.write)
    // Capture caller input before any await, including values used again in work.
    const { source, rejoinID, proof, write } = copyStoredValue(params)
    const cursor = { position: proof.position, epoch: Number(candidate.epoch) }
    if (
      write.source.rejoinID !== rejoinID ||
      !sameStoredValue(write.destination.control.cursor, cursor)
    )
      throw new RegistryResyncRefusedError({ reason: 'tuple' })
    const groupID = source.key.groupID
    const destination = { groupID, incarnation: source.key.incarnation + 1 }
    let resolved: 'committed' | 'rolled-back' | undefined
    try {
      resolved = await persistence.resolve(groupID, write.mutationID)
    } catch (error) {
      if (!(error instanceof GroupStateUncertainError)) throw error
    }
    const replay = await capability.read(groupID, async (reads) => {
      const record = (await reads.control(source.key.incarnation)).rejoin
      if (record?.stage === 'adopted') {
        if (record.id !== rejoinID) throw new RegistryResyncRefusedError({ reason: 'unaccepted' })
        // Durable adoption proves this semantic replay even after later markers or retirement.
        await verifyRegistryResync({
          source,
          candidate,
          record: { ...record, stage: 'confirmed' },
          proof,
        })
        return true
      }
      if (resolved === 'committed')
        throw new GroupStateConflictError('Committed switch lacks matching adopted evidence')
      confirmedRecord(record, rejoinID)
      return false
    })
    if (replay) return destination

    retirement.assertAvailable(groupID)
    await environment.start()
    // A losing attempt never obtains a settlement capable of lifting the winner's fence.
    const attempt = retirement.beginRetirement(source.key)
    let stopObservation = () => {}
    function settle(outcome: 'committed' | 'rolled-back'): void {
      attempt.settle(outcome)
      stopObservation()
    }
    try {
      await attempt.drain()
      // The registry projection runs first, retaining listener dispatch until owner release.
      stopObservation = capability.observe(groupID, (observation) => {
        if (observation.mutationID === write.mutationID) settle('committed')
      })
      return await capability.run(
        { groupID, mutationID: write.mutationID },
        async (reads) => {
          const current = await readRecoverySource(reads, groupID)
          matchSource(current, source)
          const lifetime = await reads.lifetime()
          if (lifetime === null || lifetime.latestIncarnation !== source.key.incarnation)
            throw new GroupStateConflictError('Registry switch incarnation moved')
          const record = confirmedRecord(
            (await reads.control(source.key.incarnation)).rejoin,
            rejoinID,
          )
          await verifyRegistryResync({ source: current, candidate, record, proof })
          // Spent admission is independent of provider CAS and candidate epoch ordering.
          if (
            current.trust.spentEpochAuthenticators.some((spent) =>
              sameStoredValue(spent, candidate.state.keySchedule.epochAuthenticator),
            )
          )
            throw new GroupStateConflictError('Epoch authenticator already spent')
          validateRegistryHandle({
            handle: candidate,
            key: destination,
            trust: current.trust,
            environment: environment.recovery,
            ownerDID: environment.ownerDID,
          })
          const state = {
            ...destination,
            version: 1,
            deleted: false as const,
            terminal: candidate.state.groupActiveState.kind === 'removedFromGroup',
            epoch: Number(candidate.epoch),
            epochAuthenticator: candidate.state.keySchedule.epochAuthenticator.slice(),
            state: encodeClientState(candidate.state),
            credential: { ...candidate.credential },
            ledger: [...candidate.ledgerTokens],
            senderHWM: 0,
          }
          const trust = recoveryTrustFor(candidate, destination, current.trust)
          const anchor = {
            anchor: {
              epoch: Number(candidate.epoch),
              secret: await candidate.exportSecret(APP_TOPIC_LABEL, new Uint8Array(), 32),
            },
          }
          return {
            expected: {
              revision: lifetime.revision,
              activeIncarnation: lifetime.activeIncarnation,
            },
            value: { current, lifetime, record, state, trust, anchor },
          }
        },
        async (stores, prepared) => {
          const lifetime = await stores.lifetime.load()
          const metadata = await stores.incarnation(source.key.incarnation).state.loadMetadata()
          const trust = await stores.trust.load()
          if (
            lifetime === null ||
            metadata === null ||
            metadata.deleted ||
            trust === null ||
            lifetime.activeIncarnation !== source.key.incarnation ||
            lifetime.latestIncarnation !== source.key.incarnation ||
            !sameStoredValue(lifetime, prepared.lifetime)
          )
            throw new GroupStateConflictError('Registry switch source moved in work')
          const current = {
            key: { groupID, incarnation: lifetime.activeIncarnation },
            stateVersion: metadata.version,
            identity: trust.installed,
            lifetimeRevision: lifetime.revision,
            trust,
          }
          matchSource(current, prepared.current)
          matchSource(current, source)
          const record = confirmedRecord(
            (await stores.incarnation(source.key.incarnation).control.load()).rejoin,
            rejoinID,
          )
          if (!sameStoredValue(record, prepared.record))
            throw new GroupStateConflictError('Registry switch confirmed record moved')
          stores.tx.onRollback(() => settle('rolled-back'))
          await retireIncarnation(stores, {
            source: source.key,
            nextIncarnation: destination.incarnation,
            switchedRejoinID: rejoinID,
            mutationID: write.mutationID,
            at: Date.now(),
          })
          await stores.lifetime.save({
            ...lifetime,
            latestIncarnation: destination.incarnation,
            activeIncarnation: destination.incarnation,
            revision: lifetime.revision + 1,
            mutationID: write.mutationID,
            restorePending: false,
          })
          const rows = stores.incarnation(destination.incarnation)
          await rows.state.save(prepared.state)
          await stores.trust.save(prepared.trust)
          await rows.control.apply({ cursor }, write.mutationID)
          await rows.anchor.save(prepared.anchor)
          return destination
        },
      )
    } catch (error) {
      // Outcome hooks own ambiguous settlement; a rejected host call does not prove rollback.
      if (
        !(error instanceof StorageOutcomeUnknownError) &&
        !(error instanceof GroupStateUncertainError)
      )
        settle('rolled-back')
      throw error
    }
  }
}
