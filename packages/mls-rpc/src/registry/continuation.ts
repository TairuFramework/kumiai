import type {
  ControlChanges,
  GroupKey,
  Outcome,
  RecoveryContinuationPort,
  StoredRejoinRecord,
} from '@kumiai/rpc'

import { coordinatorBinding, type EntryReads, entryCapability } from '../entry-capability.js'
import { copyStoredValue, sameStoredValue } from '../memory-incarnation-stores.js'
import { GroupStateConflictError } from '../persistence-errors.js'
import type { GroupPersistence, GroupTransaction } from '../persistence-types.js'
import { decodeCapturedRecoveryCandidate, decodeRecoveryCandidate } from '../recovery-codec.js'
import { recoveryCompletionContexts } from '../recovery-completion-context.js'
import { registrySafety } from './safety.js'
import type { GroupHandleRegistry } from './types.js'

function boundRecord(
  record: StoredRejoinRecord | null,
  destination: GroupKey,
): record is StoredRejoinRecord {
  return (
    record !== null &&
    record.stage === 'adopted' &&
    record.source.key.groupID === destination.groupID &&
    record.source.key.incarnation + 1 === destination.incarnation &&
    (!('format' in record) ||
      (record.switchMutationID !== null && sameStoredValue(record.destinationKey, destination)))
  )
}

async function installed(
  reads: EntryReads,
  destination: GroupKey,
  record: StoredRejoinRecord,
): Promise<boolean> {
  const initial = (await reads.metadata(destination.incarnation))?.initialIdentity
  if (initial == null) return false
  const snapshot =
    'format' in record
      ? decodeCapturedRecoveryCandidate(record.candidate, record.requestKey)
      : decodeRecoveryCandidate(record.candidate, record.requestKey)
  return (
    snapshot.epoch === record.epochAfter &&
    sameStoredValue(initial, {
      ...destination,
      epoch: record.epochAfter,
      authenticator: snapshot.state.keySchedule.epochAuthenticator,
    })
  )
}

class CompletionNoop extends Error {}

export function createRecoveryContinuationPort<TTx extends GroupTransaction>(params: {
  registry: GroupHandleRegistry
  persistence: GroupPersistence<TTx>
}): RecoveryContinuationPort {
  const registry = registrySafety<TTx>(params.registry)
  const capability = entryCapability(params.persistence)
  if (
    registry === null ||
    capability === null ||
    registry.binding !== coordinatorBinding(params.persistence)
  )
    throw new TypeError('Recovery continuation requires a registry with the same coordinator')
  return {
    async loadRecoveryContinuation(requested) {
      const destination = { ...requested }
      if (!Number.isSafeInteger(destination.incarnation) || destination.incarnation < 2) return null
      return await capability.read(destination.groupID, async (reads) => {
        const lifetime = await reads.lifetime()
        if (lifetime === null || destination.incarnation > lifetime.latestIncarnation) return null
        const source = { ...destination, incarnation: destination.incarnation - 1 }
        const record = (await reads.control(source.incarnation)).rejoin
        if (!boundRecord(record, destination) || !(await installed(reads, destination, record)))
          return null
        return copyStoredValue({ source, destination, record })
      })
    },
    async finishRecoveryContinuation(input) {
      const { continuation, ledger, mutationID } = copyStoredValue(input)
      const { source, destination, record } = continuation
      if (
        !mutationID ||
        !sameStoredValue(source, record.source.key) ||
        !boundRecord(record, destination)
      )
        throw new GroupStateConflictError('Invalid recovery continuation')
      try {
        await capability.run(
          { groupID: source.groupID, mutationID },
          async (reads) => {
            const snapshot = await reads.control(source.incarnation)
            if (snapshot.rejoin === null) throw new CompletionNoop()
            if (!sameStoredValue(snapshot.rejoin, record))
              throw new GroupStateConflictError('Recovery continuation moved')
            const lifetime = await reads.lifetime()
            if (
              lifetime === null ||
              lifetime.latestIncarnation < destination.incarnation ||
              !(await installed(reads, destination, record))
            )
              throw new GroupStateConflictError('Recovery installation proof missing')
            const at = Date.now()
            const accepted = snapshot.operations.filter((op) => op.stage === 'accepted')
            const outcomes: Array<Outcome> = accepted.map(({ id }) => ({
              id,
              opID: id,
              at,
              kind: 'unknown',
            }))
            const held = new Set(ledger)
            const tokens = [...new Set(record.ledgerBefore)].filter((token) => !held.has(token))
            if (tokens.length > 0)
              outcomes.push({ id: record.id, opID: null, at, kind: 'reenact', tokens })
            const changes: ControlChanges = {
              deleteRejoin: true,
              deleteOperations: accepted.map(({ id }) => id),
              putOutcomes: outcomes.filter(
                ({ id }) => !snapshot.outcomes.some((outcome) => outcome.id === id),
              ),
            }
            return {
              expected: lifetime,
              value: {
                changes,
                snapshot,
                initial: (await reads.metadata(destination.incarnation))?.initialIdentity,
              },
            }
          },
          async (stores, prepared) => {
            const rows = stores.incarnation(source.incarnation)
            if (
              !sameStoredValue(await rows.control.load(), prepared.snapshot) ||
              !sameStoredValue(
                await stores.incarnation(destination.incarnation).state.loadInitialIdentity(),
                prepared.initial,
              )
            )
              throw new GroupStateConflictError('Recovery continuation moved during completion')
            recoveryCompletionContexts.set(stores.tx, { key: source, changes: prepared.changes })
            try {
              await rows.control.apply(prepared.changes, mutationID)
            } finally {
              recoveryCompletionContexts.delete(stores.tx)
            }
          },
        )
      } catch (error) {
        if (!(error instanceof CompletionNoop)) throw error
      }
    },
  }
}
