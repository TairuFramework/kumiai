import { encodeClientState, type GroupHandle } from '@kumiai/mls'
import {
  type AdoptionExpected,
  type CommitOnceWriteContext,
  type ControlBuildPort,
  type ControlSlot,
  type ControlStore,
  ControlWriteNotCommittedError,
  type HostBuilt,
  type Operation,
  OperationRejectedError,
  StorageOutcomeUnknownError,
} from '@kumiai/rpc'
import { sha256 } from '@noble/hashes/sha2.js'
import { toB64U } from '@sozai/codec'
import type { Runtime } from '@sozai/runtime'

import type { HandleAccess } from './access.js'
import { decodeControlJournal, encodeControlJournal } from './control-journal.js'
import { deriveEntryKey, sealEntries } from './crypto.js'
import { sameStoredValue } from './memory-incarnation-stores.js'
import { GroupStateConflictError } from './persistence-errors.js'
import type { GroupKey, GroupPersistence, GroupTransaction } from './persistence-types.js'

export type SaveControlBuild = (
  intent: Operation & { stage: 'intent' },
  built: ControlSlot,
  expected: AdoptionExpected,
  mutationID: string,
) => Promise<'saved' | 'moved' | 'occupied'>

// Authority stays with the owned transaction, never in caller changes.
const builds = new WeakMap<object, CommitOnceWriteContext>()
export function controlBuildContext(tx: GroupTransaction): CommitOnceWriteContext | null {
  return builds.get(tx) ?? null
}

class PreparationMoved extends Error {}
class SlotOccupied extends Error {}

export function createPersistenceBuildSaver<TTx extends GroupTransaction>(params: {
  persistence: GroupPersistence<TTx>
  key: GroupKey
}): SaveControlBuild {
  const key = { ...params.key }
  const persistence = params.persistence
  return async (intent, built, expected, mutationID) => {
    if (!sameStoredValue(key, expected.key)) return 'moved'
    const journal = decodeControlJournal(built.journal)
    const lifetime = await persistence.load(key.groupID)
    if (lifetime?.activeIncarnation !== key.incarnation) return 'moved'
    let entered = false
    let outcome: 'committed' | 'rolled-back' | undefined
    try {
      return await persistence.transition(
        {
          groupID: key.groupID,
          mutationID,
          expected: {
            revision: lifetime.revision,
            activeIncarnation: lifetime.activeIncarnation,
          },
        },
        async (stores) => {
          entered = true
          stores.tx.onCommit(() => {
            outcome = 'committed'
          })
          stores.tx.onRollback(() => {
            outcome = 'rolled-back'
          })
          const rows = stores.incarnation(key.incarnation)
          const state = await rows.state.load()
          const snapshot = await rows.control.load()
          const identity = expected.identity
          if (
            identity === null ||
            state === null ||
            state.deleted ||
            !sameStoredValue(key, {
              groupID: identity.groupID,
              incarnation: identity.incarnation,
            }) ||
            state.epoch !== identity.epoch ||
            !sameStoredValue(state.epochAuthenticator, identity.authenticator) ||
            state.version !== expected.stateVersion ||
            built.epoch !== identity.epoch ||
            built.incarnation !== key.incarnation ||
            !sameStoredValue(built.authenticatorBefore, identity.authenticator) ||
            !sameStoredValue(journal.source.key, key) ||
            !sameStoredValue(journal.source.identity, identity) ||
            journal.checkpoint !== built.searchFrom ||
            built.searchFrom !== (snapshot.cursor?.position ?? null) ||
            (snapshot.cursor !== null &&
              (snapshot.cursor.epoch !== identity.epoch ||
                snapshot.cursor.stranded ||
                snapshot.cursor.fork)) ||
            snapshot.operations[0]?.id !== intent.id ||
            !sameStoredValue(snapshot.operations[0], intent)
          )
            throw new PreparationMoved()
          if (snapshot.cursor === null) {
            const trust = await stores.trust.load()
            if (!sameStoredValue(trust?.installed, identity)) throw new PreparationMoved()
          }
          if (
            snapshot.commitOnce !== null &&
            snapshot.commitOnce.incarnation === key.incarnation &&
            snapshot.commitOnce.epoch >= identity.epoch
          )
            throw new SlotOccupied()
          builds.set(stores.tx, {
            kind: 'build',
            source: expected,
            queueHeadID: intent.id,
            checkpoint: journal.checkpoint,
          })
          try {
            await rows.control.apply(
              { putOperations: [{ ...intent, stage: 'built', built }] },
              mutationID,
            )
            await rows.control.apply({ commitOnce: built, commitOnceAcceptance: null }, mutationID)
          } finally {
            builds.delete(stores.tx)
          }
          return 'saved' as const
        },
      )
    } catch (error) {
      if (error instanceof PreparationMoved) return 'moved'
      if (error instanceof SlotOccupied) return 'occupied'
      if (
        error instanceof GroupStateConflictError ||
        (error instanceof Error &&
          [
            'GroupStateConflictError',
            'DisplacedGroupHandleError',
            'ReentrantOwnershipError',
            'PersistencePhaseError',
          ].includes(error.name))
      )
        throw error
      if (!entered) throw error
      if (outcome === 'committed') return 'saved'
      if (outcome === 'rolled-back' || !(error instanceof StorageOutcomeUnknownError))
        throw new ControlWriteNotCommittedError('Prepared build save rolled back', { cause: error })
      let delay = 100
      for (;;) {
        let resolution: 'committed' | 'rolled-back'
        try {
          resolution = await persistence.resolve(key.groupID, mutationID)
        } catch (failure) {
          if (failure instanceof GroupStateConflictError) throw failure
          await new Promise<void>((resolve) => setTimeout(resolve, delay))
          delay = Math.min(delay * 2, 15_000)
          continue
        }
        if (resolution === 'committed') return 'saved'
        throw new ControlWriteNotCommittedError('Prepared build save rolled back', { cause: error })
      }
    }
  }
}

export function createControlBuildPort(params: {
  access: HandleAccess
  control: ControlStore
  build: (op: Operation, group: GroupHandle) => Promise<HostBuilt>
  saveBuilt: SaveControlBuild
  now: () => number
  newID: () => string
  entryLabel?: string
  runtime?: Runtime
}): ControlBuildPort {
  return {
    prepareBuild: (op, frame) =>
      params.access.readControl(async (scope) => {
        const snapshot = await params.control.load()
        const saved = snapshot.operations.find((row) => row.id === op.id)
        if (
          saved === undefined ||
          saved.stage !== 'intent' ||
          snapshot.operations[0]?.id !== saved.id ||
          !sameStoredValue(params.control.key, scope.source.key) ||
          scope.source.identity === null
        )
          return { kind: 'moved', operation: saved ?? op }
        if (params.now() >= saved.deadline) return { kind: 'expired', operation: saved }
        const original = scope.source
        const identity = original.identity
        if (identity === null) return { kind: 'moved', operation: saved }
        if (
          snapshot.cursor !== null &&
          (snapshot.cursor.epoch !== identity.epoch ||
            snapshot.cursor.stranded ||
            snapshot.cursor.fork)
        )
          return { kind: 'moved', operation: saved }
        if (
          snapshot.commitOnce !== null &&
          snapshot.commitOnce.incarnation === original.key.incarnation &&
          snapshot.commitOnce.epoch >= identity.epoch
        )
          return { kind: 'occupied', operation: saved }
        const checkpoint = snapshot.cursor?.position ?? null
        const sourceState = encodeClientState(scope.handle.state)
        const sourceCredential = { ...scope.handle.credential }
        const sourceLedger = scope.handle.ledgerTokens
        let built: ControlSlot
        try {
          const host = await params.build(saved, scope.handle)
          if (
            host.incarnation !== original.key.incarnation ||
            host.epoch !== identity.epoch ||
            !sameStoredValue(host.authenticatorBefore, identity.authenticator)
          )
            return { kind: 'moved', operation: saved }
          const key = await deriveEntryKey(scope.handle, params.entryLabel)
          let framed: Awaited<ReturnType<typeof frame>>
          try {
            framed = await frame(host, async (bytes) => ({
              sealed: sealEntries(key, bytes, params.runtime),
              epoch: identity.epoch,
            }))
          } finally {
            key.fill(0)
          }
          const { commit: _commit, ...retained } = host
          built = {
            ...retained,
            ...framed,
            opID: saved.id,
            searchFrom: checkpoint,
            payloadDigest: toB64U(sha256(framed.payload)),
            journal: encodeControlJournal({
              version: 1,
              source: original,
              checkpoint,
              sourceState,
              sourceCredential,
              sourceLedger,
              candidate: host.journal,
            }),
          }
        } catch (error) {
          if (
            error instanceof OperationRejectedError ||
            (error instanceof Error &&
              ['OperationRejectedError', 'FrameTooLargeError', 'CommitRejectedError'].includes(
                error.name,
              ))
          )
            return { kind: 'rejected', operation: saved, reason: error.message }
          throw error
        }
        let expected = original
        for (;;) {
          if (params.now() >= saved.deadline) return { kind: 'expired', operation: saved }
          let result: Awaited<ReturnType<SaveControlBuild>>
          try {
            result = await params.saveBuilt(saved, built, expected, params.newID())
          } catch (error) {
            if (
              !(error instanceof ControlWriteNotCommittedError) &&
              !(error instanceof Error && error.name === 'ControlWriteNotCommittedError')
            )
              throw error
            continue
          }
          if (result === 'saved')
            return { kind: 'saved', operation: { ...saved, stage: 'built', built } }
          if (result === 'occupied') return { kind: 'occupied', operation: saved }
          const fresh = await scope.refresh()
          const current = await params.control.load()
          if (
            !sameStoredValue(fresh.source.key, original.key) ||
            !sameStoredValue(fresh.source.identity, original.identity) ||
            fresh.source.stateVersion === expected.stateVersion ||
            (current.cursor?.position ?? null) !== checkpoint ||
            (current.cursor !== null &&
              (current.cursor.epoch !== identity.epoch ||
                current.cursor.stranded ||
                current.cursor.fork)) ||
            !sameStoredValue(current.operations[0], saved)
          )
            return { kind: 'moved', operation: saved }
          expected = fresh.source
        }
      }),
  }
}
