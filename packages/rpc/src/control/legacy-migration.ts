import { asLogPosition } from '../cursor.js'
import { closeControlBuild } from './closure.js'
import type {
  LegacyControlOperation,
  LegacyControlSlot,
  LegacyControlSnapshot,
  LegacyMainJournal,
} from './legacy-input.js'
import type { BuiltCommit, ControlSnapshot, GroupKey, Operation, Outcome } from './types.js'

export type ControlMigrationSource = {
  key: GroupKey
  epoch: number | null
  terminal: boolean
  retired: boolean
}

function intent(row: LegacyControlOperation): Operation {
  return {
    id: row.id,
    seq: row.seq,
    kind: row.kind,
    revokes: row.revokes,
    body: row.body,
    enqueuedAt: row.enqueuedAt,
    deadline: row.deadline,
    stage: 'intent',
  }
}

function build(
  row: LegacyControlOperation,
  slot: LegacyControlSlot,
  snapshot: LegacyControlSnapshot,
): BuiltCommit {
  const head = Object.hasOwn(slot, 'searchFrom')
    ? (slot.searchFrom ?? null)
    : (snapshot.cursor?.position ?? null)
  const covered =
    Object.hasOwn(slot, 'searchFrom') &&
    head === (snapshot.cursor?.position ?? null) &&
    !snapshot.cursor?.incomplete &&
    !snapshot.cursor?.stranded &&
    snapshot.controlHold?.reason !== 'acceptance-unknown' &&
    slot.uncertainty === undefined &&
    snapshot.uncertainty === undefined &&
    row.reconciliation?.uncertainty === undefined
  const acceptedAs = row.hubAcceptedAt ?? row.acceptedAs
  return {
    opID: row.id,
    kind: row.kind,
    revokes: row.revokes,
    enqueuedAt: row.enqueuedAt,
    deadline: row.deadline,
    incarnation: slot.incarnation,
    epoch: slot.epoch,
    head,
    publishID: slot.publishID,
    expectedHead: slot.expectedHead,
    authenticatorBefore: slot.authenticatorBefore,
    payload: slot.payload,
    payloadDigest: slot.payloadDigest,
    digest: slot.digest,
    bodies: slot.bodies,
    journal: slot.journal,
    welcome: slot.welcome,
    ...(covered ? {} : { skipped: true }),
    ...(row.unknownReported ? { reported: true } : {}),
    ...(acceptedAs === undefined ? {} : { acceptedAs }),
  }
}

/** Pure mapping; the provider owns the transaction, schema mark and completion barrier. */
export function migrateLegacyControl(params: {
  snapshot: LegacyControlSnapshot | ControlSnapshot
  source: ControlMigrationSource
  mainJournal?: LegacyMainJournal | null
  at: number
  outcomeID(): string
}): ControlSnapshot {
  const { snapshot, source, mainJournal, at } = params
  if (snapshot.schemaVersion === 1) return snapshot
  if (snapshot.schemaVersion !== undefined) throw new TypeError('Unknown control schema version')
  const legacy = snapshot as LegacyControlSnapshot
  const { commitOnceAcceptance: _proof, uncertainty: _uncertainty, ...retained } = legacy
  const next: ControlSnapshot = {
    ...retained,
    schemaVersion: 1,
    commitOnce: null,
    spentSource: legacy.spentSource ?? null,
    operations: [],
    outcomes: [...legacy.outcomes],
    // Promotion precedes every build closure, with the origin bound by this snapshot's key.
    welcomes: [
      ...new Map(
        legacy.welcomes.map(
          ({ opID, welcome, recipients }) => [opID, { opID, welcome, recipients }] as const,
        ),
      ).values(),
    ],
    controlHold:
      legacy.controlHold === null || legacy.controlHold.reason === 'acceptance-unknown'
        ? null
        : { ...legacy.controlHold, reason: 'unsupported-version' },
    recoveryEpochFloor: legacy.recoveryEpochFloor ?? null,
    settledRejoins: legacy.settledRejoins ?? [],
    forkRecoveryAttempt: legacy.forkRecoveryAttempt ?? null,
  }
  const freshID = (opID: string | null): string => {
    const id = params.outcomeID()
    if (id === opID || next.outcomes.some((row) => row.id === id))
      throw new TypeError('Migration requires a fresh outcome identity')
    return id
  }
  const slot = legacy.commitOnce
  // R2/R3 snapshots may already have the final build model but no schema mark.
  const currentBuild = slot !== null && 'head' in slot && 'kind' in slot
  if (currentBuild) next.commitOnce = slot as unknown as BuiltCommit
  let owned = currentBuild
  let slotClosed = false
  for (const row of legacy.operations) {
    const matching =
      slot !== null &&
      slot.opID === row.id &&
      row.built !== undefined &&
      (['incarnation', 'epoch', 'publishID', 'payloadDigest'] as const).every(
        (field) => row.built?.[field] === slot[field],
      )
    const candidate = row.reconciliation?.slot ?? (matching ? slot : null)
    if (matching) owned = true
    const epoch = candidate?.epoch ?? row.built?.epoch
    const closes =
      row.reconciliation !== undefined ||
      source.terminal ||
      source.retired ||
      (epoch !== undefined && source.epoch !== null && epoch < source.epoch)
    if (closes) {
      if (matching) slotClosed = true
      const evidence = candidate ?? row.built
      const applied =
        evidence === undefined || evidence === null
          ? undefined
          : legacy.applied.find(
              (proof) =>
                proof.epoch === evidence.epoch && proof.payloadDigest === evidence.payloadDigest,
            )
      const id = freshID(row.id)
      let outcome: Outcome
      if (source.terminal && row.stage === 'intent')
        outcome = { id, opID: row.id, at, kind: 'rejected', reason: 'removed' }
      else if (candidate !== null) {
        // Embedded speculative material is never promoted by migration closure.
        const changes = closeControlBuild(
          { ...next, commitOnce: { ...build(row, candidate, legacy), welcome: null } },
          applied
            ? { kind: 'landed', position: asLogPosition(applied.sequenceID) }
            : { kind: 'unknown' },
          at,
          id,
        )
        outcome = changes.putOutcomes?.[0] as Outcome
      } else
        outcome = applied
          ? { id, opID: row.id, at, kind: 'landed', position: asLogPosition(applied.sequenceID) }
          : { id, opID: row.id, at, kind: 'unknown' }
      next.outcomes = next.outcomes.filter((old) => old.opID !== row.id)
      next.outcomes.push(outcome)
    } else if (
      matching &&
      (row.stage === 'built' || row.stage === 'accepted') &&
      candidate?.epoch === source.epoch
    ) {
      next.commitOnce = build(row, candidate, legacy)
    } else next.operations.push(intent(row))
  }
  if (!owned && slot !== null && slot.epoch === source.epoch && !source.terminal && !source.retired)
    next.spentSource = { epoch: slot.epoch, opID: slot.opID }
  if (
    currentBuild &&
    next.commitOnce !== null &&
    (source.terminal ||
      source.retired ||
      (source.epoch !== null && next.commitOnce.epoch < source.epoch))
  ) {
    const built = next.commitOnce
    const proof = legacy.applied.find(
      (row) => row.epoch === built.epoch && row.payloadDigest === built.payloadDigest,
    )
    const changes = closeControlBuild(
      { ...next, commitOnce: { ...built, welcome: null } },
      proof ? { kind: 'landed', position: asLogPosition(proof.sequenceID) } : { kind: 'unknown' },
      at,
      freshID(next.commitOnce.opID),
    )
    next.outcomes = [
      ...next.outcomes.filter((row) => !changes.deleteOutcomes?.includes(row.id)),
      ...(changes.putOutcomes ?? []),
    ]
    next.commitOnce = null
    next.spentSource = null
  }
  if (source.terminal || source.retired) {
    next.commitOnce = null
    next.spentSource = null
  }
  // Closure takes precedence over the live-build source-epoch requirement.
  if (
    slot !== null &&
    !slotClosed &&
    !source.terminal &&
    !source.retired &&
    source.epoch !== null &&
    slot.epoch > source.epoch
  )
    throw new TypeError('Legacy slot is ahead of source epoch')
  if (mainJournal != null)
    next.outcomes.push({
      id: freshID(null),
      opID: null,
      at,
      kind: 'unknown',
      lostCommit:
        mainJournal.kind === 'ledger'
          ? { kind: 'ledger', journal: mainJournal.journal, tokens: mainJournal.bodies }
          : { kind: mainJournal.kind, journal: mainJournal.journal },
    })
  next.operations.sort((a, b) => a.seq - b.seq)
  return next
}
