import type { MigrationFixture, MigrationResult } from './control-migration.js'

type Row = Record<string, unknown>
const row = (value: unknown): Row => value as Row
const rows = (value: unknown): Array<Row> => value as Array<Row>

/** Independent double: literal legacy fields, with no implementation reducers or codecs. */
export function migrateMemoryControl(input: MigrationFixture): MigrationResult {
  const old = input.snapshot
  if (old.schemaVersion === 1) return old as MigrationResult
  if (old.schemaVersion !== undefined) throw new TypeError('Unsupported control schema')
  if (
    !input.source.retired &&
    input.source.deleted &&
    (old.commitOnce != null || rows(old.operations).length > 0)
  )
    throw new TypeError('Legacy migration requires source state')
  const sourceEpoch = input.source.deleted ? null : input.source.epoch
  const terminal = !input.source.deleted && input.source.terminal
  const result: MigrationResult = {
    ...old,
    schemaVersion: 1,
    commitOnce: null,
    spentSource: old.spentSource ?? null,
    operations: [],
    outcomes: [...rows(old.outcomes)],
    welcomes: [],
    recoveryEpochFloor: old.recoveryEpochFloor ?? null,
    settledRejoins: old.settledRejoins ?? [],
    forkRecoveryAttempt: old.forkRecoveryAttempt ?? null,
  }
  delete result.commitOnceAcceptance
  delete result.uncertainty
  if (row(old.controlHold)?.reason === 'acceptance-unknown') result.controlHold = null
  for (const welcome of rows(old.welcomes)) {
    const index = result.welcomes.findIndex((owed) => owed.opID === welcome.opID)
    const owed = { opID: welcome.opID, welcome: welcome.welcome, recipients: welcome.recipients }
    if (index < 0) result.welcomes.push(owed)
    else result.welcomes[index] = owed
  }
  const slot = old.commitOnce === null ? null : row(old.commitOnce)
  const freshID = (opID: unknown): string => {
    const id = crypto.randomUUID()
    if (id === opID || result.outcomes.some((outcome) => outcome.id === id))
      throw new TypeError('Migration requires a fresh outcome identity')
    return id
  }
  const modern = slot !== null && 'head' in slot && 'kind' in slot
  if (modern) result.commitOnce = slot
  let hasOwner = modern
  let slotClosed = false
  for (const operation of rows(old.operations)) {
    const ref = operation.built === undefined ? null : row(operation.built)
    const matches =
      slot !== null &&
      operation.id === slot.opID &&
      ref !== null &&
      ['epoch', 'incarnation', 'payloadDigest', 'publishID'].every(
        (name) => ref[name] === slot[name],
      )
    if (matches) hasOwner = true
    const reconcile = operation.reconciliation === undefined ? null : row(operation.reconciliation)
    const candidate = reconcile !== null ? row(reconcile.slot) : matches ? slot : null
    const epoch = candidate?.epoch ?? ref?.epoch
    if (
      reconcile !== null ||
      terminal ||
      input.source.retired ||
      (typeof epoch === 'number' && sourceEpoch !== null && epoch < sourceEpoch)
    ) {
      if (matches) slotClosed = true
      const evidence = candidate ?? ref
      const proof = rows(old.applied).find(
        (applied) =>
          evidence !== null &&
          applied.epoch === evidence.epoch &&
          applied.payloadDigest === evidence.payloadDigest,
      )
      const id = freshID(operation.id)
      result.outcomes = result.outcomes.filter((outcome) => outcome.opID !== operation.id)
      result.outcomes.push({
        id,
        opID: operation.id,
        at: 100,
        ...(terminal && operation.stage === 'intent'
          ? { kind: 'rejected', reason: 'removed' }
          : proof
            ? { kind: 'landed', position: proof.sequenceID }
            : { kind: 'unknown' }),
      })
      continue
    }
    if (
      matches &&
      candidate !== null &&
      candidate.epoch === sourceEpoch &&
      operation.stage !== 'intent'
    ) {
      const cursor = old.cursor === null ? null : row(old.cursor)
      const head = Object.hasOwn(candidate, 'searchFrom')
        ? candidate.searchFrom
        : (cursor?.position ?? null)
      const coverage =
        Object.hasOwn(candidate, 'searchFrom') &&
        head === (cursor?.position ?? null) &&
        !cursor?.incomplete &&
        !cursor?.stranded &&
        row(old.controlHold)?.reason !== 'acceptance-unknown' &&
        old.uncertainty === undefined &&
        candidate.uncertainty === undefined
      const accepted = operation.hubAcceptedAt ?? operation.acceptedAs
      result.commitOnce = {
        opID: operation.id,
        kind: operation.kind,
        revokes: operation.revokes,
        enqueuedAt: operation.enqueuedAt,
        deadline: operation.deadline,
        head,
        ...Object.fromEntries(
          [
            'incarnation',
            'epoch',
            'publishID',
            'expectedHead',
            'authenticatorBefore',
            'payload',
            'payloadDigest',
            'digest',
            'bodies',
            'journal',
            'welcome',
          ].map((name) => [name, candidate[name]]),
        ),
        ...(coverage ? {} : { skipped: true }),
        ...(operation.unknownReported ? { reported: true } : {}),
        ...(accepted === undefined ? {} : { acceptedAs: accepted }),
      }
    } else
      result.operations.push({
        ...Object.fromEntries(
          ['id', 'seq', 'kind', 'revokes', 'body', 'enqueuedAt', 'deadline'].map((name) => [
            name,
            operation[name],
          ]),
        ),
        stage: 'intent',
      })
  }
  if (
    !hasOwner &&
    slot !== null &&
    slot.epoch === sourceEpoch &&
    !terminal &&
    !input.source.retired
  )
    result.spentSource = { epoch: slot.epoch }
  if (
    modern &&
    slot !== null &&
    (terminal || input.source.retired || (sourceEpoch !== null && Number(slot.epoch) < sourceEpoch))
  ) {
    const proof = rows(old.applied).find(
      (applied) => applied.epoch === slot.epoch && applied.payloadDigest === slot.payloadDigest,
    )
    const id = freshID(slot.opID)
    result.outcomes = result.outcomes.filter((outcome) => outcome.opID !== slot.opID)
    result.outcomes.push({
      id,
      opID: slot.opID,
      at: 100,
      ...(proof ? { kind: 'landed', position: proof.sequenceID } : { kind: 'unknown' }),
    })
    result.commitOnce = null
    result.spentSource = null
  }
  if (terminal || input.source.retired) {
    result.commitOnce = null
    result.spentSource = null
  }
  if (
    slot !== null &&
    !slotClosed &&
    !terminal &&
    !input.source.retired &&
    sourceEpoch !== null &&
    Number(slot.epoch) > sourceEpoch
  )
    throw new TypeError('Legacy slot is ahead of source epoch')
  if (input.mainJournal != null) {
    const main = input.mainJournal
    result.outcomes.push({
      id: freshID(null),
      opID: null,
      at: 100,
      kind: 'unknown',
      lostCommit: {
        kind: main.kind,
        journal: main.journal,
        ...(main.kind === 'ledger' ? { tokens: main.bodies } : {}),
      },
    })
  }
  result.operations.sort((left, right) => Number(left.seq) - Number(right.seq))
  return result
}
