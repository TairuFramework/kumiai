import type { LogPosition } from '../cursor.js'
import { controlSafetyHeld, type GroupForkEvidence, type SafetyHold } from './safety.js'
import type { ControlEvidenceSnapshot, ControlLogFrame } from './search.js'
import { applyResolved, deleteOperationChanges, pruneWindow } from './store.js'
import { decideSuperseded, supersededChanges } from './superseded.js'
import type {
  BuiltCommit,
  ControlAdoptionPort,
  ControlBuildRef,
  ControlChanges,
  ControlSearchPort,
  ControlSlot,
  ControlStore,
  Outcome,
} from './types.js'

export function controlBuildRef(built: BuiltCommit): ControlBuildRef {
  return {
    incarnation: built.incarnation,
    epoch: built.epoch,
    publishID: built.publishID,
    payloadDigest: built.payloadDigest,
  }
}

export type ControlSlotDeps = {
  control: ControlStore
  signal?: AbortSignal
  haltFork(evidence: GroupForkEvidence): Promise<void>
  safetyHold(): SafetyHold
  search: ControlSearchPort
  adoption: ControlAdoptionPort
  readEvidence(): Promise<ControlEvidenceSnapshot>
  readHead?(): Promise<LogPosition | null>
  now(): number
  newID(): string
  emit(outcome: Outcome): void
}

export async function settleControlSlot(
  deps: ControlSlotDeps,
  occurrence?: ControlLogFrame,
  retained?: ControlSlot,
): Promise<'landed' | 'superseded' | 'absent' | 'unknown' | 'empty'> {
  const snapshot = await deps.control.load()
  const slot = retained ?? snapshot.commitOnce
  if (slot === null) return 'empty'
  const operation = snapshot.operations.find((op) => op.id === slot.opID)
  const exact = snapshot.applied.find((row) => row.epoch === slot.epoch)
  const mismatch =
    operation !== undefined &&
    operation.stage !== 'intent' &&
    (operation.built.incarnation !== slot.incarnation ||
      operation.built.epoch !== slot.epoch ||
      operation.built.publishID !== slot.publishID ||
      operation.built.payloadDigest !== slot.payloadDigest)
  if (!mismatch && exact?.payloadDigest === slot.payloadDigest && exact.digest === slot.digest) {
    if (operation !== undefined)
      await applyResolved(
        deps.control,
        deleteOperationChanges(snapshot, [slot.opID]),
        deps.newID(),
        undefined,
        deps.signal,
      )
    return 'landed'
  }
  const held = () => deps.safetyHold() !== null || controlSafetyHeld(snapshot) !== null
  if (
    held() ||
    (retained === undefined && (snapshot.strand !== null || snapshot.cursor?.stranded === true)) ||
    (snapshot.controlHold !== null && snapshot.controlHold.reason !== 'acceptance-unknown')
  )
    return 'unknown'
  const evidence = await deps.readEvidence()
  if (held()) return 'unknown'
  if (mismatch && operation !== undefined) {
    await applyResolved(
      deps.control,
      operation.reconciliation === undefined
        ? { controlHold: { reason: 'acceptance-unknown', position: null, cause: 'copy-mismatch' } }
        : {
            putOperations: [
              {
                ...operation,
                reconciliation: {
                  ...operation.reconciliation,
                  uncertainty: { cause: 'copy-mismatch', at: null },
                },
              },
            ],
          },
      deps.newID(),
      undefined,
      deps.signal,
    )
    return 'unknown'
  }
  const identity = evidence.source.identity
  if (
    evidence.terminal ||
    identity === null ||
    evidence.source.key.groupID !== deps.control.key.groupID ||
    evidence.source.key.incarnation !== slot.incarnation
  )
    return 'unknown'
  if (
    identity.epoch === slot.epoch &&
    (identity.authenticator.length !== slot.authenticatorBefore.length ||
      identity.authenticator.some((byte, index) => byte !== slot.authenticatorBefore[index]))
  ) {
    await deps.haltFork({
      kind: 'epoch-authenticator',
      epoch: slot.epoch,
      local: slot.authenticatorBefore,
      remote: identity.authenticator,
    })
    return 'unknown'
  }
  const found = await deps.search.searchLog(slot, occurrence?.position)
  if (held()) return 'unknown'
  if (found.kind === 'unknown') return 'unknown'
  // Absence hints cannot discharge uncertainty. Search certifies coverage and validation explicitly.
  if (found.kind === 'superseded' || (found.kind === 'absent' && found.validated)) {
    const current = await deps.control.load()
    const op = current.operations.find((op) => op.id === slot.opID)
    const changes: ControlChanges = {}
    if (op?.reconciliation?.uncertainty !== undefined) {
      const { uncertainty: _uncertainty, ...reconciliation } = op.reconciliation
      changes.putOperations = [{ ...op, reconciliation }]
    }
    if (
      current.commitOnce?.opID === slot.opID &&
      current.controlHold?.reason === 'acceptance-unknown'
    )
      changes.controlHold = null
    if (changes.putOperations !== undefined || changes.controlHold !== undefined)
      await applyResolved(deps.control, changes, deps.newID(), undefined, deps.signal)
  }
  if (found.kind === 'absent') return 'absent'
  if (found.kind === 'superseded') {
    const current = await deps.control.load()
    const op = current.operations.find((op) => op.id === slot.opID)
    if (op === undefined) return 'superseded'
    const head = op.pendingPublish === undefined ? undefined : await deps.readHead?.()
    if (held() || controlSafetyHeld(current) !== null) return 'unknown'
    const decision = decideSuperseded({
      operation: op,
      observedHead: head,
      acceptance:
        op.reconciliation?.acceptance ??
        (current.commitOnce?.opID === op.id ? current.commitOnceAcceptance : null),
      acceptanceUnknown: current.controlHold?.reason === 'acceptance-unknown',
      evidence: found,
      now: deps.now(),
    })
    const changes = supersededChanges(current, op, decision, deps.now())
    if (Object.keys(changes).length > 0) {
      await applyResolved(deps.control, changes, deps.newID(), undefined, deps.signal)
      for (const outcome of changes.putOutcomes ?? []) deps.emit(outcome)
    }
    return decision === 'pending' ? 'unknown' : 'superseded'
  }
  const proof = found.proof
  const searched = await deps.control.load()
  if (held() || controlSafetyHeld(searched) !== null) return 'unknown'
  if (searched.strand !== null || searched.cursor?.stranded === true) return 'unknown'
  // A retained acceptance plus no obligation records a completed delivery.
  const prior = snapshot.commitOnceAcceptance
  const sameAcceptance =
    prior?.position === proof.position &&
    prior.payloadDigest === proof.payloadDigest &&
    prior.from === proof.from
  const accepted =
    operation === undefined
      ? []
      : [
          {
            ...operation,
            stage: 'accepted' as const,
            built: controlBuildRef(slot),
            acceptedAs: proof.position,
            acceptance: proof,
          },
        ]
  await applyResolved(
    deps.control,
    {
      commitOnceAcceptance: proof,
      putOperations: accepted,
      ...(slot.welcome === null || sameAcceptance
        ? {}
        : {
            putWelcomes: [
              {
                opID: slot.opID,
                welcome: slot.welcome.bytes,
                recipients: slot.welcome.recipients,
              },
            ],
          }),
    },
    deps.newID(),
    undefined,
    deps.signal,
  )
  if (held()) return 'unknown'
  const expected = (await deps.readEvidence()).source
  if (held()) return 'unknown'
  const outcome: Outcome = {
    id: JSON.stringify(['control:landed', slot.opID, slot.publishID, proof.position]),
    opID: slot.opID,
    at: deps.now(),
    kind: 'landed',
    position: proof.position,
  }
  const current = await deps.control.load()
  if (held() || controlSafetyHeld(current) !== null) return 'unknown'
  const result = await deps.adoption.adopt(
    slot.journal,
    { ...expected, acceptance: proof },
    {
      mutationID: deps.newID(),
      changes: {
        ...pruneWindow(current, slot.epoch),
        ...(current.controlHold?.reason === 'acceptance-unknown' ? { controlHold: null } : {}),
        commitOnce: null,
        ...deleteOperationChanges(current, [slot.opID]),
        deleteOutcomes: current.outcomes
          .filter((row) => row.opID === slot.opID)
          .map((row) => row.id),
        putOutcomes: [outcome],
        ...(slot.welcome === null || !current.welcomes.some((row) => row.opID === slot.opID)
          ? {}
          : {
              putWelcomes: [
                {
                  opID: slot.opID,
                  welcome: slot.welcome.bytes,
                  recipients: slot.welcome.recipients,
                  committed: true,
                },
              ],
            }),
        putApplied: [
          {
            epoch: slot.epoch,
            digest: slot.digest,
            payloadDigest: slot.payloadDigest,
            sequenceID: proof.position,
            opID: slot.opID,
            removed: false,
          },
        ],
        cursor: { position: proof.position, epoch: slot.epoch + 1 },
      },
    },
  )
  if (result === 'moved') {
    const held = (await deps.control.load()).controlHold
    if (held === null || held.reason === 'acceptance-unknown')
      await applyResolved(
        deps.control,
        {
          controlHold: {
            reason: 'acceptance-unknown',
            position: proof.position,
          },
        },
        deps.newID(),
        undefined,
        deps.signal,
      )
    return 'unknown'
  }
  if (result === 'installed') deps.emit(outcome)
  return 'landed'
}
