import type { LogPosition } from '../cursor.js'
import type { ControlChanges, ControlSnapshot } from './types.js'

export type BuildClosure =
  | { kind: 'landed'; position: LogPosition }
  | { kind: 'lost' | 'unknown' }
  | { kind: 'abandon' }

/** Executable material dies here. Independent obligations never share its lifetime. */
export function closeControlBuild(
  snapshot: ControlSnapshot,
  result: BuildClosure,
  at: number,
  outcomeID: string,
): ControlChanges {
  const built = snapshot.commitOnce
  if (built === null) return result.kind === 'abandon' ? {} : { spentSource: null }
  return {
    commitOnce: null,
    spentSource: result.kind === 'abandon' ? { epoch: built.epoch } : null,
    deleteOutcomes: snapshot.outcomes.filter((row) => row.opID === built.opID).map((row) => row.id),
    putOutcomes: [
      {
        id: outcomeID,
        opID: built.opID,
        at,
        ...(result.kind === 'abandon' ? { kind: 'unknown' as const } : result),
      },
    ],
    ...(result.kind === 'landed' && built.welcome !== null
      ? {
          putWelcomes: [
            {
              opID: built.opID,
              welcome: built.welcome.bytes,
              recipients: built.welcome.recipients,
              committed: true as const,
            },
          ],
        }
      : {}),
  }
}
