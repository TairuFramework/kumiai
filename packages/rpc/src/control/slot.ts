import type { LogPosition } from '../cursor.js'
import { controlSafetyHeld } from './safety.js'
import type { ControlLogFrame, ControlValidationPort } from './search.js'
import { controlOccurrenceCoverage, pruneWindow } from './store.js'
import type {
  BuiltCommit,
  ControlAdoptionPort,
  ControlBuildRef,
  ControlChanges,
  ControlSnapshot,
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

export type BuildClosure = { kind: 'landed'; position: LogPosition } | { kind: 'lost' | 'unknown' }

/** Executable material dies here. Independent obligations never share its lifetime. */
export function closeControlBuild(
  snapshot: ControlSnapshot,
  result: BuildClosure,
  at: number,
  outcomeID: string,
): ControlChanges {
  const built = snapshot.commitOnce
  if (built === null) return {}
  return {
    commitOnce: null,
    deleteOutcomes: snapshot.outcomes.filter((row) => row.opID === built.opID).map((row) => row.id),
    putOutcomes: [{ id: outcomeID, opID: built.opID, at, ...result }],
    ...(result.kind === 'landed' && built.welcome !== null
      ? {
          putWelcomes: [
            {
              opID: built.opID,
              welcome: built.welcome.bytes,
              recipients: built.welcome.recipients,
              committed: true,
            },
          ],
        }
      : {}),
  }
}

export type ControlSlotDeps = {
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
  const snapshot = await deps.control.load()
  const built = snapshot.commitOnce
  if (
    built === null ||
    snapshot.strand !== null ||
    snapshot.cursor?.stranded ||
    controlSafetyHeld(snapshot) !== null
  )
    return 'moved'
  const validation = await deps.validation.restoreValidation(built)
  if (validation === null) return 'unavailable'
  const checked = await validation.validateFrame(frame, built)
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
  const result = await deps.adoption.adopt(
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
      mutationID: deps.newID(),
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
  if (result === 'installed') for (const outcome of changes.putOutcomes ?? []) deps.emit(outcome)
  return result
}
