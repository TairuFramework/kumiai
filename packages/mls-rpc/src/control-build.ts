import { decodeClientState, encodeClientState, type GroupHandle } from '@kumiai/mls'
import {
  type ControlBuildPort,
  type ControlSlot,
  type ControlStore,
  ControlStoreInvariantError,
  ControlWriteNotCommittedError,
  controlBuildRef,
  controlSafetyHeld,
  GroupSafetyHeldError,
  type HostBuilt,
  type Operation,
  OperationRejectedError,
  type SaveControlBuild,
  StorageOutcomeUnknownError,
} from '@kumiai/rpc'
import { sha256 } from '@noble/hashes/sha2.js'
import { toB64U } from '@sozai/codec'
import type { Runtime } from '@sozai/runtime'

import type { ControlHandleAccess } from './access.js'
import { controlCompatible } from './control-compat.js'
import { decodeControlJournal, encodeControlJournal } from './control-journal.js'
import { controlBuildContexts } from './control-write-context.js'
import { deriveEntryKey, sealEntries } from './crypto.js'
import { sameStoredValue } from './memory-incarnation-stores.js'
import {
  DisplacedGroupHandleError,
  GroupStateConflictError,
  PersistencePhaseError,
  ReentrantOwnershipError,
} from './persistence-errors.js'
import type { GroupKey, GroupPersistence, GroupTransaction } from './persistence-types.js'

export type { SaveControlBuild } from '@kumiai/rpc'

class PreparationMoved extends Error {}
class SlotOccupied extends Error {}

function fatalPersistenceFailure(error: unknown): boolean {
  return (
    error instanceof GroupStateConflictError ||
    error instanceof DisplacedGroupHandleError ||
    error instanceof ReentrantOwnershipError ||
    error instanceof PersistencePhaseError ||
    (error instanceof Error &&
      [
        'GroupStateConflictError',
        'DisplacedGroupHandleError',
        'ReentrantOwnershipError',
        'PersistencePhaseError',
      ].includes(error.name))
  )
}
function unknownStorageOutcome(error: unknown): boolean {
  return (
    error instanceof StorageOutcomeUnknownError ||
    (error instanceof Error && error.name === 'StorageOutcomeUnknownError')
  )
}

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
            controlSafetyHeld(snapshot) !== null ||
            snapshot.controlHold !== null ||
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
              (snapshot.cursor.epoch !== identity.epoch || snapshot.cursor.stranded)) ||
            snapshot.operations[0]?.id !== intent.id ||
            !sameStoredValue(snapshot.operations[0], intent)
          )
            throw new PreparationMoved()
          if (snapshot.cursor === null) {
            const initialIdentity = await rows.state.loadInitialIdentity()
            if (!sameStoredValue(initialIdentity, identity)) throw new PreparationMoved()
          }
          if (
            snapshot.commitOnce !== null &&
            snapshot.commitOnce.incarnation === key.incarnation &&
            snapshot.commitOnce.epoch >= identity.epoch
          )
            throw new SlotOccupied()
          controlBuildContexts.set(stores.tx, {
            kind: 'build',
            source: expected,
            queueHeadID: intent.id,
            checkpoint: journal.checkpoint,
          })
          try {
            await rows.control.apply(
              { putOperations: [{ ...intent, stage: 'built', built: controlBuildRef(built) }] },
              mutationID,
            )
            await rows.control.apply({ commitOnce: built, commitOnceAcceptance: null }, mutationID)
          } finally {
            controlBuildContexts.delete(stores.tx)
          }
          return 'saved' as const
        },
      )
    } catch (error) {
      if (error instanceof PreparationMoved) return 'moved'
      if (error instanceof SlotOccupied) return 'occupied'
      if (fatalPersistenceFailure(error)) throw error
      if (!entered) throw error
      if (
        error instanceof ControlStoreInvariantError ||
        error instanceof TypeError ||
        error instanceof RangeError ||
        (error instanceof Error && error.name === 'ControlStoreInvariantError')
      )
        throw error
      if (outcome === 'committed') return 'saved'
      if (outcome === 'rolled-back')
        throw new ControlWriteNotCommittedError('Prepared build save rolled back', { cause: error })
      if (!unknownStorageOutcome(error)) throw error
      let delay = 100
      for (;;) {
        let resolution: 'committed' | 'rolled-back'
        try {
          resolution = await persistence.resolve(key.groupID, mutationID)
        } catch (failure) {
          if (
            fatalPersistenceFailure(failure) ||
            failure instanceof TypeError ||
            failure instanceof RangeError
          )
            throw failure
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
  access: ControlHandleAccess
  control: ControlStore
  build: (op: Operation, group: GroupHandle) => Promise<HostBuilt>
  saveBuilt: SaveControlBuild
  now: () => number
  newID: () => string
  entryLabel?: string
  runtime?: Runtime
}): ControlBuildPort {
  const read = () =>
    params.access.readControl(async (scope) => ({
      handle: scope.handle,
      source: scope.source,
      state: encodeClientState(scope.handle.state),
      snapshot: await scope.loadControl(params.control),
    }))
  const safetyHeld = async () => controlSafetyHeld((await read()).snapshot)
  return {
    async prepareBuild(op, frame) {
      const captured = await params.access.readControl(async (scope) => {
        const snapshot = await scope.loadControl(params.control)
        const saved = snapshot.operations.find((row) => row.id === op.id)
        if (
          saved === undefined ||
          saved.stage !== 'intent' ||
          snapshot.operations[0]?.id !== saved.id ||
          !sameStoredValue(params.control.key, scope.source.key) ||
          scope.source.identity === null
        )
          return { kind: 'moved' as const, operation: saved ?? op }
        if (params.now() >= saved.deadline) return { kind: 'expired' as const, operation: saved }
        if (
          controlSafetyHeld(snapshot) !== null ||
          snapshot.controlHold !== null ||
          scope.handle.state.groupActiveState.kind === 'removedFromGroup'
        )
          return { kind: 'occupied' as const, operation: saved }
        const original = scope.source
        const identity = original.identity
        if (identity === null) return { kind: 'moved' as const, operation: saved }
        if (
          snapshot.cursor !== null &&
          (snapshot.cursor.epoch !== identity.epoch || snapshot.cursor.stranded)
        )
          return { kind: 'moved' as const, operation: saved }
        if (
          snapshot.commitOnce !== null &&
          snapshot.commitOnce.incarnation === original.key.incarnation &&
          snapshot.commitOnce.epoch >= identity.epoch
        )
          return { kind: 'occupied' as const, operation: saved }
        return {
          kind: 'captured' as const,
          saved,
          original,
          identity,
          handle: scope.handle,
          checkpoint: snapshot.cursor?.position ?? null,
          sourceState: encodeClientState(scope.handle.state),
          sourceCredential: { ...scope.handle.credential },
          sourceLedger: scope.handle.ledgerTokens,
          key: await deriveEntryKey(scope.handle, params.entryLabel),
        }
      })
      if (captured.kind !== 'captured') return captured
      const {
        saved,
        original,
        identity,
        handle,
        checkpoint,
        sourceState,
        sourceCredential,
        sourceLedger,
        key,
      } = captured
      let built: ControlSlot
      try {
        const host = await params.build(saved, handle)
        if (
          host.incarnation !== original.key.incarnation ||
          host.epoch !== identity.epoch ||
          !sameStoredValue(host.authenticatorBefore, identity.authenticator)
        )
          return { kind: 'moved', operation: saved }
        if ((await safetyHeld()) !== null) return { kind: 'occupied', operation: saved }
        const framed = await frame(host, async (bytes) => {
          const held = await safetyHeld()
          if (held !== null) throw new GroupSafetyHeldError(held)
          return { sealed: sealEntries(key, bytes, params.runtime), epoch: identity.epoch }
        })
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
      } finally {
        key.fill(0)
      }
      let expected = original
      let attempts = 0
      let delay = 100
      for (;;) {
        if (params.now() >= saved.deadline) return { kind: 'expired', operation: saved }
        if ((await safetyHeld()) !== null) return { kind: 'occupied', operation: saved }
        let result: Awaited<ReturnType<SaveControlBuild>>
        try {
          attempts++
          result = await params.saveBuilt(saved, built, expected, params.newID())
        } catch (error) {
          if (
            !(error instanceof ControlWriteNotCommittedError) &&
            !(error instanceof Error && error.name === 'ControlWriteNotCommittedError')
          )
            throw error
          if (attempts >= 8) throw error
          await new Promise<void>((resolve) => setTimeout(resolve, delay))
          delay = Math.min(delay * 2, 15_000)
          continue
        }
        if (result === 'saved')
          return {
            kind: 'saved',
            operation: { ...saved, stage: 'built', built: controlBuildRef(built) },
          }
        if (result === 'occupied') return { kind: 'occupied', operation: saved }
        const fresh = await read()
        const current = fresh.snapshot
        if (
          controlSafetyHeld(current) !== null ||
          current.controlHold !== null ||
          !sameStoredValue(fresh.source.key, original.key) ||
          !sameStoredValue(fresh.source.identity, original.identity) ||
          fresh.source.stateVersion === expected.stateVersion ||
          (current.cursor?.position ?? null) !== checkpoint ||
          (current.cursor !== null &&
            (current.cursor.epoch !== identity.epoch || current.cursor.stranded)) ||
          !sameStoredValue(current.operations[0], saved)
        )
          return { kind: 'moved', operation: saved }
        const source = decodeClientState(sourceState)
        const stored = decodeClientState(fresh.state)
        if (source === undefined || stored === undefined || !controlCompatible(source, stored))
          return { kind: 'moved', operation: saved }
        if (attempts >= 8) return { kind: 'moved', operation: saved }
        expected = fresh.source
        await new Promise<void>((resolve) => setTimeout(resolve, delay))
        delay = Math.min(delay * 2, 15_000)
      }
    },
  }
}
