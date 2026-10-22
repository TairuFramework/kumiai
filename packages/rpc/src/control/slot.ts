import { throwIfAborted } from '../abort.js'
import { closeControlBuild } from './closure.js'

export { type BuildClosure, closeControlBuild } from './closure.js'

import { controlSafetyHeld } from './safety.js'
import type {
  ControlFrameValidation,
  ControlLogFrame,
  ControlValidation,
  ControlValidationPort,
} from './search.js'
import { controlOccurrenceCoverage, pruneWindow, resolveControlMutation } from './store.js'
import type {
  BuiltCommit,
  ControlAdoptionPort,
  ControlBuildRef,
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
  signal?: AbortSignal
  control: ControlStore
  validation: ControlValidationPort
  adoption: ControlAdoptionPort
  now(): number
  newID(): string
  emit(outcome: Outcome): void
}

/** Called only for the occurrence currently being consumed by the ordinary walker. */
export async function consumeOwnOccurrence(
  deps: ControlSlotDeps,
  frame: ControlLogFrame,
): Promise<'installed' | 'noop' | 'moved' | 'invalid' | 'unavailable'> {
  throwIfAborted(deps.signal)
  const snapshot = await deps.control.load()
  const built = snapshot.commitOnce
  if (
    built === null ||
    snapshot.strand !== null ||
    snapshot.cursor?.stranded ||
    controlSafetyHeld(snapshot) !== null
  )
    return 'moved'
  let validation: ControlValidation | null
  let checked: ControlFrameValidation
  try {
    validation = await deps.validation.restoreValidation(built)
    if (validation === null) return 'unavailable'
    checked = await validation.validateFrame(frame, built)
  } catch {
    throwIfAborted(deps.signal)
    return 'unavailable'
  }
  if (checked.kind !== 'valid')
    return checked.kind === 'invalid' ||
      checked.reason === 'unexplained-own' ||
      checked.reason === 'unsupported-version'
      ? 'invalid'
      : 'unavailable'
  if (!checked.own) return 'invalid'
  const coverage = controlOccurrenceCoverage(snapshot, built, frame.position)
  const changes = closeControlBuild(
    snapshot,
    coverage === 'complete' ? { kind: 'landed', position: frame.position } : { kind: 'unknown' },
    deps.now(),
    deps.newID(),
  )
  const mutationID = deps.newID()
  let result: 'installed' | 'noop' | 'moved'
  try {
    result = await deps.adoption.adopt(
      built.journal,
      {
        ...validation.source,
        occurrence: {
          source: validation.source,
          position: frame.position,
          payloadDigest: built.payloadDigest,
          coverage,
        },
      },
      {
        mutationID,
        changes: {
          ...pruneWindow(snapshot, built.epoch),
          ...changes,
          spentSource: null,
          putApplied: [
            {
              epoch: built.epoch,
              digest: built.digest,
              payloadDigest: built.payloadDigest,
              sequenceID: frame.position,
              opID: built.opID,
              removed: false,
            },
          ],
          strand: null,
          cursor: { position: frame.position, epoch: built.epoch + 1 },
        },
      },
    )
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'StorageOutcomeUnknownError') throw error
    await resolveControlMutation(deps.control, mutationID, undefined, deps.signal)
    result = 'installed'
  }
  if (result === 'installed') for (const outcome of changes.putOutcomes ?? []) deps.emit(outcome)
  return result
}
