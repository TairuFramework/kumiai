import { type GroupHandle, relinquishSend } from '@kumiai/mls'
import {
  APP_TOPIC_LABEL,
  type CheckpointRecord,
  type ControlSnapshot,
  controlSafetyHeld,
  effectiveRecoveryEpochFloor,
  type GroupKey,
  isHardControlHold,
  RecoveryTargetBehindError,
  type SafetyHold,
  type StoredRejoinRecord,
} from '@kumiai/rpc'

import { branchAbandonmentPreparer, writeBranchAbandonment } from '../branch-history.js'
import { currentCheckpointFact, prepareCheckpointInstallation } from '../checkpoint-capture.js'
import type { EntryCapability } from '../entry-capability.js'
import {
  hasActiveManualRecovery,
  manualRecoveryAttempt,
  saveManualRecovery,
} from '../manual-recovery.js'
import { copyStoredValue, sameStoredValue } from '../memory-incarnation-stores.js'
import {
  GroupStateConflictError,
  GroupStateUncertainError,
  RegistryResyncRefusedError,
  RegistrySourceMovedError,
  StorageOutcomeUnknownError,
} from '../persistence-errors.js'
import type { GroupPersistence, GroupTransaction } from '../persistence-types.js'
import { decodeCapturedRecoveryCandidate } from '../recovery-codec.js'
import { recoveryTrustDigest } from '../recovery-trust-digest.js'
import { clearGroupCondition } from '../safety-conditions.js'
import type { ColdEnvironment } from './cold.js'
import { checkForkRecoveryCaptureInReads } from './recovery-coordinator.js'
import {
  capturedRecord,
  reservationEnvelope,
  reserveFromBytes,
  restoreCaptured,
} from './reserve.js'
import { retireIncarnation } from './retired.js'
import type { RegistryRetirement } from './retirement.js'
import { readRecoverySource } from './source.js'
import { recoveryTrustFor } from './trust.js'
import type {
  GroupHandleRegistry,
  LegacyRegistryRecoverySource,
  RegistryRecoverySource,
  RegistrySwitchWrite,
} from './types.js'
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
  exactFields(
    value.source,
    value.source.authorisationID === undefined ? ['rejoinID'] : ['rejoinID', 'authorisationID'],
  )
  exactFields(value.destination, ['control'])
  exactFields(value.destination.control, ['cursor'])
  exactFields(value.destination.control.cursor, ['position', 'epoch'])
  if (
    typeof value.mutationID !== 'string' ||
    value.mutationID.length === 0 ||
    (value.source.authorisationID !== undefined &&
      (typeof value.source.authorisationID !== 'string' ||
        value.source.authorisationID.length === 0)) ||
    typeof value.source.rejoinID !== 'string' ||
    value.source.rejoinID.length === 0 ||
    typeof value.destination.control.cursor.position !== 'string' ||
    value.destination.control.cursor.position.length === 0 ||
    !Number.isSafeInteger(value.destination.control.cursor.epoch) ||
    value.destination.control.cursor.epoch < 0
  )
    throw new TypeError('Invalid registry switch write')
}

function confirmedRecord(record: StoredRejoinRecord | null, rejoinID: string): StoredRejoinRecord {
  if (record?.id !== rejoinID || record.stage !== 'confirmed')
    throw new RegistryResyncRefusedError({ reason: 'unaccepted' })
  return record
}

function matchSource(
  actual: LegacyRegistryRecoverySource | RegistryRecoverySource,
  expected: LegacyRegistryRecoverySource | RegistryRecoverySource,
): void {
  const sameTrust =
    'trustDigest' in expected
      ? 'trustDigest' in actual &&
        actual.trustDigest === expected.trustDigest &&
        recoveryTrustDigest(expected.trust) === expected.trustDigest
      : sameStoredValue(actual.trust, expected.trust)
  if (
    !sameStoredValue(actual.key, expected.key) ||
    !sameStoredValue(actual.identity, expected.identity) ||
    !sameTrust
  )
    throw new GroupStateConflictError('Registry switch source moved')
  if (
    actual.stateVersion !== expected.stateVersion ||
    actual.lifetimeRevision !== expected.lifetimeRevision
  )
    throw new RegistrySourceMovedError('Registry switch source moved')
}

export function createRegistrySwitch<TTx extends GroupTransaction>(environment: {
  persistence: GroupPersistence<TTx>
  capability: EntryCapability<TTx>
  retirement: RegistryRetirement
  cold: ColdEnvironment
  recovery: RecoveryEnvironment
  ownerDID: string
  start(): Promise<void>
  held(key: GroupKey): SafetyHold
}): GroupHandleRegistry['switchIncarnation'] {
  const { persistence, capability, retirement } = environment
  return async (input: GroupHandle, params) => {
    const captured = await relinquishSend(input)
    validateWrite(params.write)
    const { source, rejoinID, proof, write } = copyStoredValue(params)
    const groupID = source.key.groupID
    const destination = { groupID, incarnation: source.key.incarnation + 1 }
    const capturedState = capturedRecord(captured, destination, 1)
    const candidate = await restoreCaptured(environment.cold, capturedState)
    const cursor = { position: proof.position, epoch: Number(candidate.epoch) }
    if (
      write.source.rejoinID !== rejoinID ||
      !sameStoredValue(write.destination.control.cursor, cursor)
    )
      throw new RegistryResyncRefusedError({ reason: 'tuple' })
    const authorisationID = write.source.authorisationID
    function assertChoice(records: Array<CheckpointRecord>): void {
      if (authorisationID === undefined && hasActiveManualRecovery(records, source.key))
        throw new GroupStateConflictError('Manual recovery owns the source')
    }
    function assertSafety(control: ControlSnapshot): void {
      if (authorisationID !== undefined) return
      const pending = environment.held(source.key)
      const reason = pending === 'fork-halted' ? pending : (controlSafetyHeld(control) ?? pending)
      if (reason !== null) throw new RegistryResyncRefusedError({ reason })
      if (isHardControlHold(control.controlHold))
        throw new GroupStateConflictError('Recovery source is held')
    }
    let resolved: 'committed' | 'rolled-back' | undefined
    try {
      resolved = await persistence.resolve(groupID, write.mutationID)
    } catch (error) {
      if (!(error instanceof GroupStateUncertainError)) throw error
    }
    const replay = await capability.read(groupID, async (reads) => {
      assertChoice(await reads.checkpoints())
      const control = await reads.control(source.key.incarnation)
      const manual =
        authorisationID === undefined
          ? null
          : manualRecoveryAttempt(await reads.checkpoints(), source.key, authorisationID)
      const record = manual === null ? control.rejoin : manual.attempt
      if (record !== null && 'format' in record && record.switchMutationID !== write.mutationID)
        throw new RegistryResyncRefusedError({ reason: 'tuple' })
      if (record?.stage === 'adopted') {
        if (record.id !== rejoinID) throw new RegistryResyncRefusedError({ reason: 'unaccepted' })
        // Durable adoption proves this semantic replay even after later markers or retirement.
        await verifyRegistryResync({
          source,
          authorisationID,
          candidate,
          record: { ...record, stage: 'confirmed' },
          proof,
        })
        return true
      }
      if (resolved === 'committed')
        throw new GroupStateConflictError('Committed switch lacks matching adopted evidence')
      assertSafety(control)
      if (manual !== null && manual.stage !== 'authorised')
        throw new GroupStateConflictError('Manual recovery already completed')
      confirmedRecord(record, rejoinID)
      return false
    })
    if (replay) return destination

    retirement.assertAvailable(groupID)
    await environment.start()
    const control = await capability.read(groupID, (reads) => reads.control(source.key.incarnation))
    assertSafety(control)
    // A losing attempt never obtains a settlement capable of lifting the winner's fence.
    const attempt = retirement.beginRetirement(source.key)
    let stopObservation = () => {}
    let hooked = false
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
          assertChoice(await reads.checkpoints())
          assertSafety(await reads.control(source.key.incarnation))
          const current = await readRecoverySource(reads, groupID)
          matchSource(current, source)
          const lifetime = await reads.lifetime()
          if (lifetime === null || lifetime.latestIncarnation !== source.key.incarnation)
            throw new GroupStateConflictError('Registry switch incarnation moved')
          const manual =
            authorisationID === undefined
              ? null
              : manualRecoveryAttempt(await reads.checkpoints(), source.key, authorisationID)
          if (manual !== null && manual.stage !== 'authorised')
            throw new GroupStateConflictError('Manual recovery already completed')
          const record = confirmedRecord(
            manual === null ? (await reads.control(source.key.incarnation)).rejoin : manual.attempt,
            rejoinID,
          )
          if ('format' in record) {
            if (manual !== null && record.target.groupInfoEpoch < (manual.epochFloor ?? 0))
              throw new RecoveryTargetBehindError('Manual recovery capture is target-behind')
            const snapshot = await reads.control(source.key.incarnation)
            const floor = effectiveRecoveryEpochFloor(snapshot, {
              id: record.id,
              source: source.key,
            })
            if (record.forkRecovery !== undefined) {
              const attempt = snapshot.forkRecoveryAttempt
              const captured = decodeCapturedRecoveryCandidate(record.candidate, record.requestKey)
              if (
                attempt == null ||
                attempt.id !== record.id ||
                !sameStoredValue(attempt.forkRecovery, record.forkRecovery) ||
                !(await checkForkRecoveryCaptureInReads(
                  reads,
                  attempt,
                  {
                    sealed: captured.attestedReply,
                    requestID: captured.requestID,
                    requestKey: record.requestKey,
                    epochFloor: floor,
                  },
                  environment.recovery,
                ))
              )
                throw new RecoveryTargetBehindError('Fork recovery capture is target-behind')
            } else if (
              authorisationID === undefined &&
              record.target.groupInfoEpoch < Math.max(floor ?? 0, current.identity?.epoch ?? 0)
            )
              throw new RecoveryTargetBehindError('Recovery capture is target-behind')
          }
          if ('format' in record && record.switchMutationID !== write.mutationID)
            throw new RegistryResyncRefusedError({ reason: 'tuple' })
          await verifyRegistryResync({ source: current, candidate, record, proof, authorisationID })
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
          const reserved = await reserveFromBytes(
            { ...environment.cold, restore: async () => candidate },
            { ...capturedState, senderHWM: 0 },
            0,
          )
          const state = {
            ...destination,
            version: 1,
            deleted: false as const,
            terminal: candidate.state.groupActiveState.kind === 'removedFromGroup',
            epoch: Number(candidate.epoch),
            epochAuthenticator: candidate.state.keySchedule.epochAuthenticator.slice(),
            state: reserved.state,
            credential: captured.credential,
            ledger: captured.ledgerTokens,
            senderHWM: reserved.senderHWM,
          }
          const trust = recoveryTrustFor(candidate, destination, current.trust)
          assertSafety(await reads.control(source.key.incarnation))
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
            value: {
              current,
              abandonment: await branchAbandonmentPreparer(reads)({
                source: source.key,
                destination,
                mutationID: write.mutationID,
                record,
              }),
              branchFacts: await reads.checkpoints(),
              manual,
              recoveryEpochFloor: (await reads.control(source.key.incarnation)).recoveryEpochFloor,
              lifetime,
              record,
              state,
              reservation:
                reserved.reservation === null
                  ? null
                  : { ...reserved.reservation, envelope: reservationEnvelope(state) },
              trust,
              anchor,
              checkpoint: await prepareCheckpointInstallation({
                key: destination,
                handle: candidate,
                mutationID: write.mutationID,
                stateVersion: state.version,
                previousFact: currentCheckpointFact(await reads.checkpoints())?.canonical ?? null,
              }),
            },
          }
        },
        async (stores, prepared) => {
          assertChoice(await stores.checkpoints.list())
          assertSafety(await stores.incarnation(source.key.incarnation).control.load())
          const lifetime = await stores.lifetime.load()
          const metadata = await stores.incarnation(source.key.incarnation).state.loadMetadata()
          const trust = await stores.trust.load()
          if (
            lifetime === null ||
            metadata === null ||
            metadata.deleted ||
            trust === null ||
            lifetime.activeIncarnation !== source.key.incarnation ||
            lifetime.latestIncarnation !== source.key.incarnation
          )
            throw new GroupStateConflictError('Registry switch source moved in work')
          const current = {
            key: { groupID, incarnation: lifetime.activeIncarnation },
            stateVersion: metadata.version,
            identity: trust.installed,
            lifetimeRevision: lifetime.revision,
            trust,
            trustDigest: recoveryTrustDigest(trust),
          }
          matchSource(current, prepared.current)
          matchSource(current, source)
          if (!sameStoredValue(lifetime, prepared.lifetime))
            throw new GroupStateConflictError('Registry switch lifetime changed in work')
          const manual =
            authorisationID === undefined
              ? null
              : manualRecoveryAttempt(await stores.checkpoints.list(), source.key, authorisationID)
          if (!sameStoredValue(manual, prepared.manual))
            throw new GroupStateConflictError('Manual authorisation moved')
          const record = confirmedRecord(
            manual === null
              ? (await stores.incarnation(source.key.incarnation).control.load()).rejoin
              : manual.attempt,
            rejoinID,
          )
          if (!sameStoredValue(record, prepared.record))
            throw new GroupStateConflictError('Registry switch confirmed record moved')
          assertSafety(await stores.incarnation(source.key.incarnation).control.load())
          stores.tx.onRollback(() => settle('rolled-back'))
          hooked = true
          await retireIncarnation(stores, {
            source: source.key,
            nextIncarnation: destination.incarnation,
            ...(authorisationID === undefined
              ? { switchedRejoinID: rejoinID }
              : { manualRejoinID: rejoinID }),
            mutationID: write.mutationID,
            at: Date.now(),
          })
          if (manual !== null && 'format' in record)
            await saveManualRecovery(stores, {
              ...manual,
              stage: 'completed',
              destination,
              mutationID: write.mutationID,
              attempt: { ...record, stage: 'adopted', destinationKey: destination },
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
          await clearGroupCondition(stores.checkpoints, source.key)
          if (prepared.abandonment !== null)
            await writeBranchAbandonment(
              stores.checkpoints,
              prepared.abandonment,
              prepared.branchFacts,
            )
          await stores.checkpoints.put(prepared.checkpoint)
          if (!prepared.state.terminal)
            await stores.checkpoints.put({
              kind: 'publication',
              id: `publication:${prepared.checkpoint.id}`,
              key: destination,
              factID: prepared.checkpoint.id,
              frame: null,
              publishID: null,
              accepted: false,
              nextHeartbeatAt: null,
            })
          await rows.control.apply(
            { cursor, recoveryEpochFloor: prepared.recoveryEpochFloor },
            write.mutationID,
          )
          await rows.anchor.save(prepared.anchor)
          return destination
        },
      )
    } catch (error) {
      // Outcome hooks own ambiguous settlement; a rejected host call does not prove rollback.
      if (!(hooked && error instanceof StorageOutcomeUnknownError)) settle('rolled-back')
      throw error
    }
  }
}
