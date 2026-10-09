import { sha256 } from '@noble/hashes/sha2.js'
import { toB64U } from '@sozai/codec'

import { isHeadMismatch } from '../commit.js'
import { asLogPosition, type LogPosition } from '../cursor.js'
import { OperationRejectedError } from '../errors.js'
import { applyResolved, pruneWindow } from './store.js'
import type {
  AdoptionWrite,
  AppliedCommit,
  ControlChanges,
  ControlSnapshot,
  ControlStore,
  Operation,
  OperationRequest,
  Outcome,
} from './types.js'

export function revokeHeld(snapshot: ControlSnapshot): boolean {
  return snapshot.operations.some((op) => op.revokes)
}

export type HostBuilt = {
  commit: Uint8Array
  bodies: Array<string>
  journal: Uint8Array
  welcome: { bytes: Uint8Array; recipients: Array<string> } | null
  epoch: number
  authenticatorBefore: Uint8Array
  lineage: number
  digest: string
}

/** Both a fresh acceptance and a deduplicated publish name the original log position. */
export type PublishOutcome = { sequenceID: string }

export type OperationDeps = {
  control: ControlStore
  build(op: Operation): Promise<HostBuilt>
  adopt(
    journal: Uint8Array,
    expected: { epoch: number; authenticatorBefore: Uint8Array; lineage: number },
    write: AdoptionWrite,
  ): Promise<'installed' | 'noop' | 'moved'>
  frame(
    built: HostBuilt,
  ): Promise<{ payload: Uint8Array; publishID: string; expectedHead: LogPosition | null }>
  publish(
    payload: Uint8Array,
    publishID: string,
    expectedHead: LogPosition | null,
  ): Promise<PublishOutcome>
  searchLog(
    from: LogPosition | null,
    payloadDigest: string,
  ): Promise<{ found: LogPosition } | 'absent' | 'gap'>
  appliedAt(epoch: number): Pick<AppliedCommit, 'digest' | 'payloadDigest'> | undefined
  pullToHead(): Promise<void>
  now(): number
  operationTimeoutMs: number
  newID(): string
  emit(outcome: Outcome): void
}

export async function enqueueOperation(
  deps: OperationDeps,
  request: OperationRequest,
): Promise<Operation> {
  const snapshot = await deps.control.load()
  const op: Operation = {
    ...request,
    seq: Math.max(0, ...snapshot.operations.map((row) => row.seq)) + 1,
    enqueuedAt: deps.now(),
    stage: 'intent',
  }
  await applyResolved(deps.control, { putOperations: [op] }, deps.newID())
  return op
}

/** Deterministic repair identity; the runner stamps a new outcome with its settlement time. */
export function landedChanges(
  op: Operation,
  position: LogPosition,
  applied: AppliedCommit,
): ControlChanges {
  return {
    deleteOperations: [op.id],
    putOutcomes: [{ id: op.id, opID: op.id, at: op.enqueuedAt, kind: 'landed', position }],
    putApplied: [applied],
    cursor: {
      position,
      epoch: applied.epoch + 1,
      ...(applied.removed ? { stranded: true } : {}),
    },
  }
}

async function settle(deps: OperationDeps, op: Operation, outcome: Outcome): Promise<null> {
  await applyResolved(
    deps.control,
    { deleteOperations: [op.id], putOutcomes: [outcome] },
    deps.newID(),
  )
  deps.emit(outcome)
  return null
}

async function accept(
  deps: OperationDeps,
  op: Operation & { stage: 'built' },
  position: LogPosition,
): Promise<Operation> {
  const next: Operation = { ...op, stage: 'accepted', acceptedAs: position }
  const welcome = op.built.welcome
  await applyResolved(
    deps.control,
    {
      putOperations: [next],
      ...(welcome == null
        ? {}
        : {
            putWelcomes: [{ opID: op.id, welcome: welcome.bytes, recipients: welcome.recipients }],
          }),
    },
    deps.newID(),
  )
  return next
}

export async function stepOperation(deps: OperationDeps, op: Operation): Promise<Operation | null> {
  const base = { id: op.id, opID: op.id, at: deps.now() }
  if (op.stage === 'intent') {
    await deps.pullToHead()
    let built: HostBuilt
    try {
      built = await deps.build(op)
    } catch (error) {
      if (
        !(error instanceof OperationRejectedError) &&
        !(error instanceof Error && error.name === 'OperationRejectedError')
      )
        throw error
      return await settle(deps, op, { ...base, kind: 'rejected', reason: error.message })
    }
    const framed = await deps.frame(built)
    const next: Operation = {
      ...op,
      stage: 'built',
      built: {
        ...framed,
        payloadDigest: toB64U(sha256(framed.payload)),
        epoch: built.epoch,
        authenticatorBefore: built.authenticatorBefore,
        lineage: built.lineage,
        digest: built.digest,
        bodies: built.bodies,
        journal: built.journal,
        welcome: built.welcome,
      },
    }
    await applyResolved(deps.control, { putOperations: [next] }, deps.newID())
    return next
  }

  if (op.stage === 'built') {
    let position: LogPosition
    try {
      const result = await deps.publish(op.built.payload, op.built.publishID, op.built.expectedHead)
      position = asLogPosition(result.sequenceID)
    } catch (error) {
      if (!isHeadMismatch(error)) return op
      const found = await deps.searchLog(op.built.expectedHead, op.built.payloadDigest)
      if (found === 'gap') return await settle(deps, op, { ...base, kind: 'unknown' })
      if (found === 'absent') {
        if (deps.now() >= op.enqueuedAt + deps.operationTimeoutMs) {
          return await settle(deps, op, { ...base, kind: 'lost' })
        }
        const { built: _built, ...intent } = op
        const next: Operation = { ...intent, stage: 'intent' }
        await applyResolved(deps.control, { putOperations: [next] }, deps.newID())
        return next
      }
      position = found.found
    }
    return await accept(deps, op, position)
  }

  const applied: AppliedCommit = {
    epoch: op.built.epoch,
    digest: op.built.digest,
    payloadDigest: op.built.payloadDigest,
    sequenceID: op.acceptedAs,
    opID: op.id,
    removed: false,
  }
  const outcome: Outcome = { ...base, kind: 'landed', position: op.acceptedAs }
  const snapshot = await deps.control.load()
  const pruning = pruneWindow(snapshot, applied.epoch)
  const changes = landedChanges(op, op.acceptedAs, applied)
  const write: AdoptionWrite = {
    mutationID: deps.newID(),
    changes: {
      ...pruning,
      ...changes,
      putApplied: [...(pruning.putApplied ?? []), applied],
      putOutcomes: [outcome],
    },
  }
  const result = await deps.adopt(
    op.built.journal,
    {
      epoch: op.built.epoch,
      authenticatorBefore: op.built.authenticatorBefore,
      lineage: op.built.lineage,
    },
    write,
  )
  if (result === 'installed') {
    deps.emit(outcome)
    return null
  }
  if (result === 'moved') {
    await deps.pullToHead()
    const applied = deps.appliedAt(op.built.epoch)
    if (applied?.digest !== op.built.digest || applied.payloadDigest !== op.built.payloadDigest)
      return op
    const settled = await deps.control.load()
    if (
      !settled.operations.some((row) => row.id === op.id) &&
      settled.outcomes.some((row) => row.opID === op.id && row.kind === 'landed')
    )
      return null
    // Acceptance never moves this device's applied rows or cursor.
    return await settle(deps, op, outcome)
  }

  const current = await deps.control.load()
  const newestEpoch = Math.max(
    applied.epoch,
    (current.cursor?.epoch ?? 0) - 1,
    ...current.applied.map((row) => row.epoch),
  )
  const missing: ControlChanges = pruneWindow(current, newestEpoch)
  if (current.operations.some((row) => row.id === op.id)) missing.deleteOperations = [op.id]
  if (!current.outcomes.some((row) => row.opID === op.id && row.kind === 'landed')) {
    missing.putOutcomes = [outcome]
  }
  if (
    applied.epoch >= newestEpoch - 63 &&
    !current.applied.some((row) => row.epoch === applied.epoch)
  ) {
    missing.putApplied = [...(missing.putApplied ?? []), applied]
  }
  if (current.cursor?.position == null || current.cursor.position < op.acceptedAs) {
    missing.cursor = changes.cursor
  }
  if (Object.keys(missing).length !== 0) {
    await applyResolved(deps.control, missing, deps.newID())
    if (missing.putOutcomes != null) deps.emit(outcome)
  }
  return null
}
