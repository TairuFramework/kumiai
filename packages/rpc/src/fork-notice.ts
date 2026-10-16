import { copyCheckpointValue } from './checkpoint.js'
import type { CheckpointRecord } from './checkpoint-types.js'
import type { GroupKey } from './control/types.js'

export type OwnBranchMessage = { id: string; epoch: number; authHash: string }
export type CoverageGapReason =
  | 'pre-journal-history'
  | 'retention-gap'
  | 'unknown-ancestry'
  | 'ephemeral-uncovered'
export type ReportCoverage =
  | { kind: 'complete' }
  | { kind: 'partial'; reasons: Array<CoverageGapReason> }
export type ForkBranch = {
  authHash: string
  signers: Array<{ signerDID: string; keyHash: string }>
  firstSeenAt: number
  lastCheckpointAt: number
}
export type ForkNotice = {
  id: string
  groupID: string
  splitEpoch: number
  branches: Array<ForkBranch>
  deviceAuthHash: string
  detectedAt: number
  lastEvidenceAt: number
  atRisk: Array<OwnBranchMessage>
  revision: number
  acknowledgedRevision: number
  acknowledgedAt: number | null
  coverage: { evidence: ReportCoverage; ownMessages: ReportCoverage; ephemeral: ReportCoverage }
  closedAt: number | null
  closeReason?: 'merged'
  mergedInto?: string
  equivocations: Array<{ signerDID: string; keyHash: string }>
}
export type ForkNoticeEvent = {
  id: string
  kind: 'fork-detected' | 'fork-updated'
  mergedFrom?: Array<string>
  notice: ForkNotice
}

/** @internal Preserve replay history while notifying once per notice and saved deadline. */
export function forkNoticeEmissions(
  records: Array<CheckpointRecord>,
  now: number,
): Array<ForkNoticeEvent> {
  const latest = new Map<string, Extract<CheckpointRecord, { kind: 'notice-event' }>>()
  for (const row of records) {
    if (row.kind !== 'notice-event' || row.acknowledged || row.emitAt > now) continue
    const deadline = JSON.stringify([row.event.notice.id, row.emitAt])
    const previous = latest.get(deadline)
    if (previous === undefined || previous.event.notice.revision < row.event.notice.revision)
      latest.set(deadline, row)
  }
  return [...latest.values()].map((row) => row.event)
}

// Only authenticated observations enter the fold; it has no group mutation capability.
export type CheckpointStatement = {
  epoch: number
  authHash: string
  parentAuthHash: string | null
  localAuthHash: string
  signerDID: string
  keyHash: string
  frameID: string
}
type Link = Pick<CheckpointStatement, 'epoch' | 'authHash' | 'parentAuthHash'>

export function foldForkNotices(params: {
  key: GroupKey
  records: Array<CheckpointRecord>
  statements: Array<CheckpointStatement>
  lineage?: Array<Link>
  now: number
}): {
  records: Array<CheckpointRecord>
  notices: Array<ForkNotice>
  events: Array<ForkNoticeEvent>
  assignments: Map<string, string>
} {
  const { key, now, statements } = params
  const assignments = new Map<string, string>()
  const records = copyCheckpointValue(params.records)
  const noticeRows = records.filter((row) => row.kind === 'notice')
  const lineage = [...(params.lineage ?? []), ...statements]
  function ancestor(initialHash: string, initialEpoch: number, through: number): string | null {
    let authHash = initialHash
    let epoch = initialEpoch
    while (epoch > through) {
      const links = lineage.filter((link) => link.epoch === epoch && link.authHash === authHash)
      const parent = links[0]?.parentAuthHash
      if (parent == null || links.some((link) => link.parentAuthHash !== parent)) return null
      authHash = parent
      epoch--
    }
    return epoch === through ? authHash : null
  }
  const original = new Map(noticeRows.map((row) => [row.id, copyCheckpointValue(row.notice)]))
  for (const statement of statements) {
    let row = noticeRows.find(({ notice }) => {
      if (notice.mergedInto !== undefined) return false
      if (statement.epoch >= notice.splitEpoch) {
        const local = ancestor(statement.localAuthHash, statement.epoch, notice.splitEpoch)
        const remote = ancestor(statement.authHash, statement.epoch, notice.splitEpoch)
        return (
          local !== null &&
          remote !== null &&
          (statement.authHash === statement.localAuthHash || local !== remote) &&
          notice.branches.some((b) => b.authHash === local)
        )
      }
      const roots = notice.branches.map((branch) =>
        ancestor(branch.authHash, notice.splitEpoch, statement.epoch),
      )
      return (
        roots.every((root) => root !== null) &&
        roots.includes(statement.localAuthHash) &&
        roots.includes(statement.authHash)
      )
    })
    if (row === undefined) {
      if (statement.authHash === statement.localAuthHash) continue
      const id = `fork:${crypto.randomUUID()}`
      row = {
        kind: 'notice',
        id,
        key: { ...key },
        notice: {
          id,
          groupID: key.groupID,
          splitEpoch: statement.epoch,
          branches: [],
          deviceAuthHash: statement.localAuthHash,
          detectedAt: now,
          lastEvidenceAt: now,
          atRisk: [],
          revision: 0,
          acknowledgedRevision: 0,
          acknowledgedAt: null,
          coverage: {
            evidence: { kind: 'complete' },
            ownMessages: { kind: 'partial', reasons: ['pre-journal-history'] },
            ephemeral: { kind: 'partial', reasons: ['ephemeral-uncovered'] },
          },
          closedAt: null,
          equivocations: [],
        },
      }
      records.push(row)
      noticeRows.push(row)
    }
    const notice = row.notice
    assignments.set(statement.frameID, notice.id)
    if (statement.epoch < notice.splitEpoch) {
      for (const branch of notice.branches) {
        const root = ancestor(branch.authHash, notice.splitEpoch, statement.epoch)
        if (root !== null) branch.authHash = root
      }
      notice.splitEpoch = statement.epoch
    }
    const local = ancestor(statement.localAuthHash, statement.epoch, notice.splitEpoch)
    const remote = ancestor(statement.authHash, statement.epoch, notice.splitEpoch)
    if (local === null || remote === null) continue
    notice.deviceAuthHash = local
    notice.lastEvidenceAt = now
    for (const hash of [local, remote]) {
      let branch = notice.branches.find((branch) => branch.authHash === hash)
      if (branch === undefined) {
        branch = { authHash: hash, signers: [], firstSeenAt: now, lastCheckpointAt: now }
        notice.branches.push(branch)
      }
      if (hash === remote) {
        branch.lastCheckpointAt = now
        if (
          !branch.signers.some(
            (signer) =>
              signer.signerDID === statement.signerDID && signer.keyHash === statement.keyHash,
          )
        )
          branch.signers.push({ signerDID: statement.signerDID, keyHash: statement.keyHash })
      }
    }
    const equivocating = notice.branches.flatMap((branch, index) =>
      branch.signers.filter((signer) =>
        notice.branches
          .slice(index + 1)
          .some((other) =>
            other.signers.some(
              (s) => s.signerDID === signer.signerDID && s.keyHash === signer.keyHash,
            ),
          ),
      ),
    )
    notice.equivocations = [
      ...new Map(
        equivocating.map((signer) => [JSON.stringify([signer.signerDID, signer.keyHash]), signer]),
      ).values(),
    ]
  }
  const mergedFrom = new Map<string, Array<string>>()
  const ordered = [...noticeRows].sort(
    (a, b) => a.notice.detectedAt - b.notice.detectedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
  for (const survivor of ordered) {
    if (survivor.notice.mergedInto !== undefined) continue
    for (const loser of ordered) {
      if (loser === survivor || loser.notice.mergedInto !== undefined) continue
      // Both conflicts must remain divergent at the earlier split and share retained ancestry.
      const splitEpoch = Math.min(survivor.notice.splitEpoch, loser.notice.splitEpoch)
      const roots = (notice: ForkNotice) =>
        notice.branches.map((branch) => ancestor(branch.authHash, notice.splitEpoch, splitEpoch))
      const survivorRoots = roots(survivor.notice)
      const loserRoots = roots(loser.notice)
      if (survivorRoots.includes(null) || loserRoots.includes(null)) continue
      if (new Set(survivorRoots).size < 2 || new Set(loserRoots).size < 2) continue
      if (!survivorRoots.some((root) => loserRoots.includes(root))) continue
      const branches = new Map<string, ForkBranch>()
      for (const notice of [survivor.notice, loser.notice]) {
        for (const branch of notice.branches) {
          const authHash = ancestor(branch.authHash, notice.splitEpoch, splitEpoch)
          if (authHash === null) continue
          const existing = branches.get(authHash)
          if (existing === undefined)
            branches.set(authHash, { ...copyCheckpointValue(branch), authHash })
          else {
            existing.firstSeenAt = Math.min(existing.firstSeenAt, branch.firstSeenAt)
            existing.lastCheckpointAt = Math.max(existing.lastCheckpointAt, branch.lastCheckpointAt)
            for (const signer of branch.signers)
              if (
                !existing.signers.some(
                  (other) =>
                    other.signerDID === signer.signerDID && other.keyHash === signer.keyHash,
                )
              )
                existing.signers.push({ ...signer })
          }
        }
      }
      const deviceAuthHash = ancestor(
        survivor.notice.deviceAuthHash,
        survivor.notice.splitEpoch,
        splitEpoch,
      )
      if (deviceAuthHash === null) continue
      survivor.notice.branches = [...branches.values()]
      survivor.notice.deviceAuthHash = deviceAuthHash
      survivor.notice.splitEpoch = splitEpoch
      survivor.notice.detectedAt = Math.min(survivor.notice.detectedAt, loser.notice.detectedAt)
      survivor.notice.lastEvidenceAt = Math.max(
        survivor.notice.lastEvidenceAt,
        loser.notice.lastEvidenceAt,
      )
      for (const message of loser.notice.atRisk)
        if (!survivor.notice.atRisk.some((other) => other.id === message.id))
          survivor.notice.atRisk.push({ ...message })
      for (const field of ['evidence', 'ownMessages', 'ephemeral'] as const) {
        const first = survivor.notice.coverage[field]
        const second = loser.notice.coverage[field]
        if (second.kind === 'partial')
          survivor.notice.coverage[field] = {
            kind: 'partial',
            reasons: [
              ...new Set([...(first.kind === 'partial' ? first.reasons : []), ...second.reasons]),
            ],
          }
      }
      survivor.notice.equivocations = [
        ...new Map(
          survivor.notice.branches.flatMap((branch) =>
            branch.signers
              .filter((signer) =>
                survivor.notice.branches.some(
                  (other) =>
                    other !== branch &&
                    other.signers.some(
                      (entry) =>
                        entry.signerDID === signer.signerDID && entry.keyHash === signer.keyHash,
                    ),
                ),
              )
              .map(
                (signer) => [JSON.stringify([signer.signerDID, signer.keyHash]), signer] as const,
              ),
          ),
        ).values(),
      ]
      mergedFrom.set(survivor.id, [...(mergedFrom.get(survivor.id) ?? []), loser.id])
      loser.notice.closedAt = now
      loser.notice.closeReason = 'merged'
      loser.notice.mergedInto = survivor.id
      for (const [frameID, noticeID] of assignments)
        if (noticeID === loser.id) assignments.set(frameID, survivor.id)
      // Keep the loser's evidence and clocks. Copies remain subject to the same installation bounds.
      for (const evidence of records.filter((row) => row.kind === 'evidence')) {
        if (evidence.noticeID !== loser.id) continue
        const id = `${evidence.id}:notice:${survivor.id}`
        if (!records.some((row) => row.id === id))
          records.push({ ...copyCheckpointValue(evidence), id, noticeID: survivor.id })
      }
    }
  }
  function material(notice: ForkNotice) {
    return JSON.stringify({
      splitEpoch: notice.splitEpoch,
      deviceAuthHash: notice.deviceAuthHash,
      branches: notice.branches.map((branch) => ({
        authHash: branch.authHash,
        signers: branch.signers,
      })),
    })
  }
  for (const row of noticeRows) {
    const notice = row.notice
    const before = original.get(row.id)
    const merged =
      mergedFrom.has(row.id) ||
      (notice.mergedInto !== undefined && before?.mergedInto === undefined)
    if (merged || before === undefined || material(before) !== material(notice)) {
      notice.revision++
      notice.acknowledgedAt = null
      if (notice.mergedInto === undefined) {
        const previousHash =
          before === undefined
            ? null
            : ancestor(before.deviceAuthHash, before.splitEpoch, notice.splitEpoch)
        const switched = previousHash !== null && previousHash !== notice.deviceAuthHash
        notice.closedAt = switched ? now : merged ? notice.closedAt : null
      }
      const events = records.filter(
        (r): r is Extract<CheckpointRecord, { kind: 'notice-event' }> =>
          r.kind === 'notice-event' && r.event.notice.id === notice.id,
      )
      const pending = events.filter((r) => r.emitAt > now).sort((a, b) => a.emitAt - b.emitAt)[0]
      const last = Math.max(...events.map((r) => r.emitAt), now - 30000)
      const emitAt = pending?.emitAt ?? Math.max(now, last + 30000)
      const appendOnly = merged || events.some((row) => row.event.mergedFrom !== undefined)
      if (pending !== undefined && !appendOnly) records.splice(records.indexOf(pending), 1)
      const id = `${notice.id}:${notice.revision}`
      records.push({
        kind: 'notice-event',
        id,
        key: { ...key },
        event: {
          id,
          kind: before === undefined ? 'fork-detected' : 'fork-updated',
          ...(mergedFrom.has(row.id) ? { mergedFrom: mergedFrom.get(row.id) } : {}),
          notice: copyCheckpointValue(notice),
        },
        emitAt,
        acknowledged: false,
      })
    }
    const active = notice.branches.filter((branch) => now - branch.lastCheckpointAt < 86400000)
    if (
      notice.closedAt === null &&
      active.length === 1 &&
      notice.branches.some((branch) => now - branch.lastCheckpointAt >= 86400000)
    )
      notice.closedAt = now
  }
  return {
    records,
    assignments,
    notices: noticeRows.map((row) => row.notice),
    events: forkNoticeEmissions(records, now),
  }
}
