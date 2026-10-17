import {
  checkpointAuthHash,
  decodeEpochCheckpoint,
  decodeEpochRosterFact,
  encodeEpochRosterFact,
  nobleCryptoProvider,
  verifyCheckpointPair,
  verifyRecoveryLineage,
  verifyRecoveryPublicGroupInfo,
} from '@kumiai/mls'
import {
  type AcceptedRejoinSettlement,
  type BranchAbandonedEvent,
  type CapturedRecapture,
  type CapturedRejoinRecord,
  type CheckpointRecord,
  type ControlChanges,
  type ControlSnapshot,
  controlSafetyHeld,
  type ForkRecoveryAttempt,
  type ForkRecoveryAuthorisation,
  type GroupKey,
  isHardControlHold,
  type RecoveryReconciliation,
  type StoredRejoinRecord,
} from '@kumiai/rpc'
import { toB64U } from '@sozai/codec'
import {
  type CiphersuiteName,
  decode,
  getCiphersuiteImpl,
  mlsMessageDecoder,
  wireformats,
} from 'ts-mls'

import { branchAbandonmentPreparer } from '../branch-history.js'
import { provenCheckpointFacts } from '../checkpoint-store.js'
import type { EntryCapability, EntryReads } from '../entry-capability.js'
import { copyStoredValue, sameStoredValue } from '../memory-incarnation-stores.js'
import { encodeStoredValue } from '../persistence-codec.js'
import { GroupStateConflictError, GroupStateUncertainError } from '../persistence-errors.js'
import type { GroupPersistence, GroupTransaction } from '../persistence-types.js'
import { authenticateRecoveryReply, reconcileRecoveryCapture } from '../recovery.js'
import { decodeCapturedRecoveryCandidate } from '../recovery-codec.js'
import { recoveryCompletionContexts } from '../recovery-completion-context.js'
import { readRetainedTrust } from './safety.js'
import { readRecoverySource } from './source.js'
import { recoveryTrustInputs } from './trust.js'
import type { GroupHandleRegistry } from './types.js'
import type { RecoveryEnvironment } from './validation.js'

export type RecoverySwitchResolution =
  | { kind: 'committed'; destination: GroupKey }
  | { kind: 'rolled-back' | 'pending' }
export type RegistryRecoveryCoordinator = {
  prepareBranchAbandonment(params: {
    source: GroupKey
    destination: GroupKey
    mutationID: string
  }): Promise<BranchAbandonedEvent | null>
  settleForkRecoveryCapture(
    params: { record: CapturedRejoinRecord; reply: CapturedRecapture },
    environment: RecoveryEnvironment,
  ): Promise<RecoveryReconciliation>
  authoriseForkRecovery(
    key: GroupKey,
    reply: CapturedRecapture,
    noticeID: string,
    environment: RecoveryEnvironment,
  ): Promise<ForkRecoveryAuthorisation | null>
  checkForkRecoveryCapture(
    params: { attempt: ForkRecoveryAttempt; reply: CapturedRecapture },
    environment: RecoveryEnvironment,
  ): Promise<boolean>
  readRecoveryRecord(key: GroupKey): Promise<StoredRejoinRecord | null>
  assignSwitchID(record: CapturedRejoinRecord): Promise<void>
  resolveRecoverySwitch(record: CapturedRejoinRecord): Promise<RecoverySwitchResolution>
}
const coordinators = new WeakMap<GroupHandleRegistry, RegistryRecoveryCoordinator>()
export function registryRecoveryCoordinator(
  registry: GroupHandleRegistry,
): RegistryRecoveryCoordinator {
  const capability = coordinators.get(registry)
  if (capability === undefined) throw new TypeError('Registered recovery coordinator required')
  return capability
}
export function bindRegistryRecoveryCoordinator<TTx extends GroupTransaction>(params: {
  registry: GroupHandleRegistry
  entry: EntryCapability<TTx>
  persistence: GroupPersistence<TTx>
}): void {
  const { entry, persistence } = params
  const coordinator: RegistryRecoveryCoordinator = {
    prepareBranchAbandonment(params) {
      return entry.read(params.source.groupID, (reads) => branchAbandonmentPreparer(reads)(params))
    },
    async settleForkRecoveryCapture({ record, reply }, environment) {
      const key = record.source.key
      const mutationID = crypto.randomUUID()
      return entry.run<
        { result: RecoveryReconciliation; changes: ControlChanges | null },
        RecoveryReconciliation
      >(
        { groupID: key.groupID, mutationID },
        async (reads) => {
          const snapshot = await reads.control(key.incarnation)
          const attempt = snapshot.forkRecoveryAttempt
          if (
            record.forkRecovery === undefined ||
            !sameStoredValue(snapshot.rejoin, record) ||
            attempt == null ||
            attempt.id !== record.id ||
            !sameStoredValue(attempt.forkRecovery, record.forkRecovery) ||
            !(await checkForkRecoveryCaptureInReads(reads, attempt, reply, environment))
          )
            return {
              expected: await reads.lifetime(),
              value: { result: { kind: 'retry', reason: 'target-behind' }, changes: null },
            }
          const result = await reconcileRecoveryCapture({
            source: await readRecoverySource(reads, key.groupID),
            target: record.target,
            record,
            reply: { ...reply, epochFloor: attempt.forkRecovery.splitEpoch },
            environment: {
              ...environment,
              accept: async () => {
                throw new Error('Capture settlement cannot install')
              },
            },
          })
          if (result.kind !== 'accepted' && result.kind !== 'unapplied-later')
            return { expected: await reads.lifetime(), value: { result, changes: null } }
          const accepted =
            result.kind === 'accepted' || record.stage === 'confirmed' || record.stage === 'adopted'
          const common = {
            id: record.id,
            origin: { sourceKey: key, target: record.target, searchFrom: record.searchFrom },
            ledgerBefore: record.ledgerBefore,
          }
          const settlement: AcceptedRejoinSettlement = accepted
            ? {
                ...common,
                kind: 'accepted-unadoptable',
                digest: record.digest,
                payloadDigest: record.payloadDigest,
                epochAfter: record.epochAfter,
                acceptedEpoch: result.kind === 'unapplied-later' ? record.epochAfter : result.epoch,
                leafDigest: result.leafDigest,
              }
            : { ...common, kind: 'not-accepted', epoch: result.epoch }
          return {
            expected: await reads.lifetime(),
            value: { result, changes: { deleteRejoin: true, putSettledRejoins: [settlement] } },
          }
        },
        async (stores, { result, changes }) => {
          if (changes === null) return result
          const control = stores.incarnation(key.incarnation).control
          if (!sameStoredValue((await control.load()).rejoin, record))
            throw new GroupStateConflictError('Fork recovery moved during settlement')
          recoveryCompletionContexts.set(stores.tx, {
            key,
            changes,
            forkRecovery: { attempt: null },
          })
          try {
            await control.apply(changes, mutationID)
          } finally {
            recoveryCompletionContexts.delete(stores.tx)
          }
          return result
        },
      )
    },
    checkForkRecoveryCapture: ({ attempt, reply }, environment) =>
      entry.read(attempt.source.groupID, async (reads) => {
        const control = await reads.control(attempt.source.incarnation)
        return (
          sameStoredValue(control.forkRecoveryAttempt, attempt) &&
          (await checkForkRecoveryCaptureInReads(reads, attempt, reply, environment))
        )
      }),
    async authoriseForkRecovery(key, input, noticeID, environment) {
      const reply = copyStoredValue(input)
      const mutationID = crypto.randomUUID()
      try {
        const saved = await entry.read(key.groupID, async (reads) => {
          const current = (await reads.control(key.incarnation)).rejoin
          return (
            current ??
            (key.incarnation > 1 ? (await reads.control(key.incarnation - 1)).rejoin : null)
          )
        })
        if (
          saved !== null &&
          'format' in saved &&
          (saved.stage === 'confirmed' || saved.stage === 'adopted') &&
          saved.switchMutationID !== null
        ) {
          const resolved = await coordinator.resolveRecoverySwitch(saved)
          if (
            resolved.kind === 'pending' ||
            (resolved.kind === 'committed' && !sameStoredValue(resolved.destination, key))
          )
            return null
        }
        return await entry.run<
          {
            attempt: ForkRecoveryAttempt
            record: CapturedRejoinRecord | null
            snapshot: ControlSnapshot
            sourceSnapshot: ControlSnapshot
            existing: boolean
          },
          ForkRecoveryAuthorisation
        >(
          { groupID: key.groupID, mutationID },
          async (reads) => {
            const lifetime = await reads.lifetime()
            if (lifetime?.activeIncarnation !== key.incarnation) throw new ForkRecoveryRefused()
            const control = await reads.control(key.incarnation)
            if (controlSafetyHeld(control) !== null || isHardControlHold(control.controlHold))
              throw new ForkRecoveryRefused()
            if (control.forkRecoveryAttempt != null) {
              if (
                !(await checkForkRecoveryCaptureInReads(
                  reads,
                  control.forkRecoveryAttempt,
                  reply,
                  environment,
                ))
              )
                throw new ForkRecoveryRefused()
              return {
                expected: lifetime,
                value: {
                  attempt: control.forkRecoveryAttempt,
                  record: null,
                  snapshot: control,
                  sourceSnapshot: control,
                  existing: true,
                },
              }
            }
            const source = await readRecoverySource(reads, key.groupID)
            const verified = await authenticateRecoveryReply({
              ...reply,
              trust: source.trust,
              options: environment.options,
            })
            if (
              verified?.version !== 3 ||
              verified.responderKeyHash === undefined ||
              verified.lineage === undefined
            )
              throw new ForkRecoveryRefused()
            const records = await reads.checkpoints()
            const notice = records.find((row) => row.kind === 'notice' && row.id === noticeID)
            if (notice?.kind !== 'notice' || notice.notice.closedAt !== null)
              throw new ForkRecoveryRefused()
            const frame = verified.lineage
              .map(decodeEpochCheckpoint)
              .find(({ body }) => body.epoch === notice.notice.splitEpoch)
            if (frame === undefined) throw new ForkRecoveryRefused()
            const id = crypto.randomUUID()
            const authorisation: ForkRecoveryAuthorisation = {
              attemptID: id,
              noticeID,
              splitEpoch: notice.notice.splitEpoch,
              otherAuthHash: frame.body.authHash,
              responderKeyHash: verified.responderKeyHash,
              source: { ...key },
              evidence: encodeStoredValue({
                sealed: reply.sealed,
                requestID: reply.requestID,
                requestKey: reply.requestKey,
              }),
            }
            const attempt = { id, source: { ...key }, forkRecovery: authorisation }
            if (!(await checkForkRecoveryCaptureInReads(reads, attempt, reply, environment)))
              throw new ForkRecoveryRefused()
            let record = control.rejoin
            let sourceSnapshot = control
            if (record === null && key.incarnation > 1) {
              const previous = await reads.control(key.incarnation - 1)
              if (
                previous.rejoin?.stage === 'adopted' &&
                'format' in previous.rejoin &&
                sameStoredValue(previous.rejoin.destinationKey, key)
              ) {
                record = previous.rejoin
                sourceSnapshot = previous
              }
            }
            if (
              record !== null &&
              (!('format' in record) ||
                record.forkRecovery !== undefined ||
                record.trigger !== 'automatic')
            )
              throw new ForkRecoveryRefused()
            if (record !== null && 'format' in record && record.stage === 'adopted') {
              const destination = record.destinationKey
              const metadata =
                destination === null ? null : await reads.metadata(destination.incarnation)
              const saved = decodeCapturedRecoveryCandidate(record.candidate, record.requestKey)
              if (
                record.switchMutationID === null ||
                destination === null ||
                !sameStoredValue(destination, key) ||
                !sameStoredValue(metadata?.initialIdentity, {
                  ...destination,
                  epoch: record.epochAfter,
                  authenticator: saved.state.keySchedule.epochAuthenticator,
                }) ||
                !source.trust.spentEpochAuthenticators.some((value) =>
                  sameStoredValue(value, saved.state.keySchedule.epochAuthenticator),
                )
              )
                throw new ForkRecoveryRefused()
            }
            return {
              expected: lifetime,
              value: {
                attempt,
                record: record as CapturedRejoinRecord | null,
                snapshot: control,
                sourceSnapshot,
                existing: false,
              },
            }
          },
          async (stores, prepared) => {
            if (prepared.existing) return copyStoredValue(prepared.attempt.forkRecovery)
            const control = stores.incarnation(key.incarnation).control
            if (!sameStoredValue(await control.load(), prepared.snapshot))
              throw new GroupStateConflictError('Fork recovery source moved')
            const { record, attempt, sourceSnapshot } = prepared
            const writeID = mutationID
            const settlement: AcceptedRejoinSettlement | null =
              record === null
                ? null
                : {
                    id: record.id,
                    kind: 'superseded-branch',
                    epoch: attempt.forkRecovery.splitEpoch,
                    origin: {
                      sourceKey: record.source.key,
                      target: record.target,
                      searchFrom: record.searchFrom,
                    },
                    ledgerBefore: [
                      ...new Set([
                        ...sourceSnapshot.settledRejoins.flatMap((row) => row.ledgerBefore),
                        ...prepared.snapshot.settledRejoins.flatMap((row) => row.ledgerBefore),
                        ...record.ledgerBefore,
                      ]),
                    ],
                  }
            if (record !== null) {
              const history: Extract<CheckpointRecord, { kind: 'superseded-rejoin' }> = {
                kind: 'superseded-rejoin',
                id: `superseded-rejoin:${record.source.key.incarnation}:${record.id}`,
                key: record.source.key,
                record: copyStoredValue(record),
                authorisation: copyStoredValue(attempt.forkRecovery),
              }
              archives.add(history)
              await stores.checkpoints.put(history)
            }
            const changes = {
              ...(record !== null && sameStoredValue(record.source.key, key)
                ? { deleteRejoin: true as const }
                : {}),
              ...(settlement === null ? {} : { putSettledRejoins: [settlement] }),
            }
            recoveryCompletionContexts.set(stores.tx, {
              key,
              changes,
              forkRecovery: { attempt, ...(record === null ? {} : { supersededID: record.id }) },
            })
            try {
              await control.apply(changes, writeID)
            } finally {
              recoveryCompletionContexts.delete(stores.tx)
            }
            if (record !== null && !sameStoredValue(record.source.key, key)) {
              const accepted = sourceSnapshot.operations.filter(
                (operation) => operation.stage === 'accepted',
              )
              const changes: ControlChanges = {
                deleteRejoin: true,
                putSettledRejoins: settlement === null ? [] : [settlement],
                deleteOperations: accepted.map(({ id }) => id),
                putOutcomes: accepted
                  .filter(({ id }) => !sourceSnapshot.outcomes.some((row) => row.id === id))
                  .map(({ id }) => ({ id, opID: id, kind: 'unknown', at: Date.now() })),
              }
              recoveryCompletionContexts.set(stores.tx, {
                key: record.source.key,
                changes,
                forkRecovery: { attempt: null, supersededID: record.id },
              })
              try {
                await stores
                  .incarnation(record.source.key.incarnation)
                  .control.apply(changes, writeID)
              } finally {
                recoveryCompletionContexts.delete(stores.tx)
              }
            }
            return copyStoredValue(attempt.forkRecovery)
          },
        )
      } catch (error) {
        if (error instanceof ForkRecoveryRefused) return null
        throw error
      } finally {
        reply.requestKey.fill(0)
      }
    },
    readRecoveryRecord: (key) =>
      entry.read(key.groupID, async (reads) =>
        copyStoredValue((await reads.control(key.incarnation)).rejoin),
      ),
    async assignSwitchID(record) {
      const mutationID = crypto.randomUUID()
      const switchMutationID = crypto.randomUUID()
      await entry.run(
        { groupID: record.source.key.groupID, mutationID },
        async (reads) => {
          if (
            record.stage !== 'confirmed' ||
            record.trigger !== 'automatic' ||
            record.authorisationID !== null ||
            record.switchMutationID !== null ||
            !sameStoredValue((await reads.control(record.source.key.incarnation)).rejoin, record)
          )
            throw new GroupStateConflictError(
              'Confirmed recovery moved before switch ID assignment',
            )
          const control = await reads.control(record.source.key.incarnation)
          if (controlSafetyHeld(control) !== null || isHardControlHold(control.controlHold))
            throw new GroupStateConflictError('Recovery source is held')
          return { expected: await reads.lifetime(), value: null }
        },
        async (stores) => {
          const control = stores.incarnation(record.source.key.incarnation).control
          const snapshot = await control.load()
          if (controlSafetyHeld(snapshot) !== null || isHardControlHold(snapshot.controlHold))
            throw new GroupStateConflictError('Recovery source is held')
          if (!sameStoredValue(snapshot.rejoin, record))
            throw new GroupStateConflictError(
              'Confirmed recovery moved before switch ID assignment',
            )
          await control.apply({ putRejoin: { ...record, switchMutationID } }, mutationID)
        },
      )
    },
    async resolveRecoverySwitch(record) {
      if (record.switchMutationID === null) return { kind: 'pending' }
      const key = record.source.key
      let proof: 'committed' | 'rolled-back' | undefined
      try {
        proof = await persistence.resolve(key.groupID, record.switchMutationID)
      } catch (error) {
        if (!(error instanceof GroupStateUncertainError)) throw error
      }
      // Read crosses the completion fence even when a later marker hid the saved ID.
      return await entry.read(key.groupID, async (reads) => {
        const saved = (await reads.control(key.incarnation)).rejoin
        const destination = { groupID: key.groupID, incarnation: key.incarnation + 1 }
        const metadata = await reads.metadata(destination.incarnation)
        const initial = metadata?.initialIdentity ?? null
        const trust =
          saved?.stage === 'confirmed' ? await readRetainedTrust(reads, key) : await reads.trust()
        const snapshot = decodeCapturedRecoveryCandidate(record.candidate, record.requestKey)
        const authenticator = snapshot.state.keySchedule.epochAuthenticator
        const spent =
          trust?.spentEpochAuthenticators.some((value) => sameStoredValue(value, authenticator)) ??
          false
        const installed = sameStoredValue(initial, {
          ...destination,
          epoch: record.epochAfter,
          authenticator,
        })
        if (
          saved !== null &&
          'format' in saved &&
          sameStoredValue(saved, { ...record, stage: 'adopted', destinationKey: destination }) &&
          installed &&
          spent
        )
          return { kind: 'committed', destination }
        if (
          proof !== 'committed' &&
          record.stage === 'confirmed' &&
          sameStoredValue(saved, record) &&
          metadata === null &&
          initial === null &&
          trust !== null &&
          !spent
        )
          return { kind: 'rolled-back' }
        return { kind: 'pending' }
      })
    },
  }
  coordinators.set(params.registry, coordinator)
}

const archives = new WeakSet<CheckpointRecord>()
export function supersededRejoinPrepared(record: CheckpointRecord): boolean {
  return archives.has(record)
}
class ForkRecoveryRefused extends Error {}

export async function checkForkRecoveryCaptureInReads(
  reads: EntryReads,
  attempt: ForkRecoveryAttempt,
  reply: CapturedRecapture,
  environment: RecoveryEnvironment,
): Promise<boolean> {
  const authority = attempt.forkRecovery
  if (attempt.id !== authority.attemptID || !sameStoredValue(attempt.source, authority.source))
    return false
  const lifetime = await reads.lifetime()
  if (lifetime?.activeIncarnation !== attempt.source.incarnation) return false
  const control = await reads.control(attempt.source.incarnation)
  if (controlSafetyHeld(control) !== null || isHardControlHold(control.controlHold)) return false
  const source = await readRecoverySource(reads, attempt.source.groupID)
  const captured = await authenticateRecoveryReply({
    ...reply,
    trust: source.trust,
    options: environment.options,
  })
  if (
    captured?.version !== 3 ||
    captured.lineage === undefined ||
    captured.responderKeyHash !== authority.responderKeyHash
  )
    return false
  const info = decode(mlsMessageDecoder, captured.groupInfo)
  if (info?.wireformat !== wireformats.mls_group_info) return false
  const suite = await getCiphersuiteImpl(
    source.trust.ciphersuiteName as CiphersuiteName,
    environment.options.cryptoProvider ?? nobleCryptoProvider,
  )
  if (!(await verifyRecoveryPublicGroupInfo(info, suite))) return false
  const epoch = Number(info.groupInfo.groupContext.epoch)
  if (!Number.isSafeInteger(epoch) || epoch < authority.splitEpoch) return false
  const records = await reads.checkpoints()
  const facts = provenCheckpointFacts(records, attempt.source.groupID)
    .sort((a, b) => b.key.incarnation - a.key.incarnation)
    .map((row) => ({ row, fact: decodeEpochRosterFact(row.canonical) }))
  const local = facts.find(({ fact }) => fact.epoch === authority.splitEpoch)
  const prior = facts.find(({ fact }) => fact.epoch === authority.splitEpoch - 1)
  if (
    local === undefined ||
    prior === undefined ||
    local.fact.authHash === authority.otherAuthHash ||
    !prior.fact.members.some(
      (member) =>
        member.keyHash === authority.responderKeyHash && member.signerDID === captured.signer,
    )
  )
    return false
  const notice = records.find((row) => row.kind === 'notice' && row.id === authority.noticeID)
  if (
    notice?.kind !== 'notice' ||
    notice.key.groupID !== attempt.source.groupID ||
    notice.notice.closedAt !== null ||
    notice.notice.splitEpoch !== authority.splitEpoch
  )
    return false
  const branch = notice.notice.branches.find(
    (branch) => branch.authHash === authority.otherAuthHash,
  )
  if (branch === undefined) return false
  const knownFrames = records.flatMap((row) =>
    row.kind === 'evidence'
      ? [row.first, row.second]
      : row.kind === 'publication' && row.frame !== null
        ? [row.frame]
        : [],
  )
  let witnessed = false
  for (const signer of branch.signers) {
    let equivocating = notice.notice.equivocations.some(
      (equivocator) => equivocator.keyHash === signer.keyHash,
    )
    for (const frame of knownFrames) {
      let body: ReturnType<typeof decodeEpochCheckpoint>['body']
      try {
        body = decodeEpochCheckpoint(frame).body
      } catch {
        continue
      }
      if (
        body.epoch !== authority.splitEpoch ||
        body.keyHash !== signer.keyHash ||
        body.authHash === authority.otherAuthHash
      )
        continue
      const checked = await verifyCheckpointPair({
        first: frame,
        second: frame,
        localRosterFact: encodeEpochRosterFact({ ...local.fact, authHash: body.authHash }),
        eligibilityRosterFact: prior.row.canonical,
      })
      if (checked.kind === 'agreement' && checked.signerDID === signer.signerDID) {
        equivocating = true
        break
      }
    }
    if (equivocating) continue
    for (const evidence of records) {
      if (evidence.kind !== 'evidence' || evidence.noticeID !== authority.noticeID) continue
      for (const frame of [evidence.first, evidence.second]) {
        const body = decodeEpochCheckpoint(frame).body
        if (
          body.epoch !== authority.splitEpoch ||
          body.authHash !== authority.otherAuthHash ||
          body.keyHash !== signer.keyHash
        )
          continue
        const result = await verifyCheckpointPair({
          first: frame,
          second: frame,
          localRosterFact: encodeEpochRosterFact({
            ...local.fact,
            authHash: authority.otherAuthHash,
          }),
          eligibilityRosterFact: prior.row.canonical,
        })
        if (result.kind === 'agreement' && result.signerDID === signer.signerDID) witnessed = true
      }
    }
  }
  if (!witnessed) return false
  const lineage = await verifyRecoveryLineage({
    trust: recoveryTrustInputs(source.trust),
    frames: captured.lineage,
    signerKeyHash: authority.responderKeyHash,
    epoch,
    authHash: checkpointAuthHash({
      groupID: source.key.groupID,
      genesisHash: local.fact.genesisHash,
      epoch,
      epochAuthenticator: captured.groupInfoAuthenticator,
    }),
  })
  if (
    !lineage?.some(
      (frame) => frame.epoch === authority.splitEpoch && frame.authHash === authority.otherAuthHash,
    )
  )
    return false
  return forkCaptureTranscriptPermitted({
    splitEpoch: authority.splitEpoch,
    epoch,
    confirmedTranscriptHash: toB64U(info.groupInfo.groupContext.confirmedTranscriptHash),
    facts: facts.map(({ fact }) => fact),
  })
}

export function forkCaptureTranscriptPermitted(params: {
  splitEpoch: number
  epoch: number
  confirmedTranscriptHash: string
  facts: Array<{ epoch: number; confirmedTranscriptHash: string }>
}): boolean {
  if (params.epoch < params.splitEpoch || params.facts.length === 0) return false
  const offered = params.facts.find((fact) => fact.epoch === params.epoch)
  const oldest = Math.min(...params.facts.map((fact) => fact.epoch))
  const newest = Math.max(...params.facts.map((fact) => fact.epoch))
  return (
    params.epoch > newest ||
    (params.epoch >= oldest &&
      offered !== undefined &&
      offered.confirmedTranscriptHash !== params.confirmedTranscriptHash)
  )
}
