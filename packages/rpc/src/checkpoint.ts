import type {
  CheckpointFactRecord,
  CheckpointRecord,
  CheckpointService,
} from './checkpoint-types.js'

export const checkpointServiceHostMembers = {
  signInstalled: 'host',
  compare: 'host',
  exportCheckpoints: 'host',
  checkpointFact: 'host',
  checkpointCoverage: 'host',
  importCheckpoint: 'host',
  forkNotices: 'host',
  ackForkNotice: 'host',
  events: 'host',
  readRecords: 'host',
  updateRecords: 'host',
} as const satisfies Record<keyof CheckpointService, 'host'>

/** @internal Checkpoint records contain only portable data and byte arrays. */
export function copyCheckpointValue<TValue>(value: TValue): TValue {
  if (value instanceof Uint8Array) return Uint8Array.from(value) as TValue
  if (Array.isArray(value)) return value.map(copyCheckpointValue) as TValue
  if (value instanceof Map)
    return new Map(
      [...value].map(([key, child]) => [copyCheckpointValue(key), copyCheckpointValue(child)]),
    ) as TValue
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, copyCheckpointValue(child)]),
    ) as TValue
  return value
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

export function retainForkEvidence(
  records: Array<CheckpointRecord>,
  facts: Array<CheckpointFactRecord>,
  now: number,
): Array<CheckpointRecord> {
  const result = copyCheckpointValue(records)
  for (const row of result.filter((row) => row.kind === 'notice-tombstone')) {
    row.frames = row.frames.filter((frame) =>
      facts.some((fact) => fact.id === frame.installationID),
    )
    if (row.frames.length === 0) result.splice(result.indexOf(row), 1)
  }
  for (const row of result.filter((row) => row.kind === 'evidence')) {
    const supported = [row.localRosterFact, row.eligibilityRosterFact].every(
      (bytes) => bytes === null || facts.some((fact) => equal(fact.canonical, bytes)),
    )
    if (!supported) {
      result.splice(result.indexOf(row), 1)
      for (const summary of result) {
        if (summary.kind === 'notice' && summary.id === row.noticeID)
          summary.notice.coverage.evidence = { kind: 'partial', reasons: ['retention-gap'] }
        if (summary.kind === 'notice-event' && summary.event.notice.id === row.noticeID)
          summary.event.notice.coverage.evidence = { kind: 'partial', reasons: ['retention-gap'] }
      }
    }
  }
  for (const row of result.filter((row) => row.kind === 'notice')) {
    const notice = row.notice
    if (
      notice.closedAt !== null &&
      notice.acknowledgedAt !== null &&
      now - notice.acknowledgedAt >= 604800000
    ) {
      for (let i = result.length - 1; i >= 0; i--) {
        const candidate = result[i]
        if (
          candidate?.id === row.id ||
          (candidate?.kind === 'evidence' && candidate.noticeID === row.id) ||
          (candidate?.kind === 'notice-event' && candidate.event.notice.id === row.id)
        )
          result.splice(i, 1)
      }
    }
  }
  return result
}
