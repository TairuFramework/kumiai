import { normalizeDID, type OwnIdentity } from '@kokuin/token'
import {
  checkpointKeyHash,
  checkpointSignatureInput,
  decodeEpochCheckpoint,
  decodeEpochRosterFact,
  encodeEpochCheckpoint,
  encodeEpochRosterFact,
  nobleCryptoProvider,
  verifyCheckpointPair,
} from '@kumiai/mls'
import type {
  CheckpointComparison,
  CheckpointFactRecord,
  CheckpointPort,
  CheckpointRecord,
  CheckpointService,
  CheckpointStatement,
  ForkNoticeEvent,
} from '@kumiai/rpc'
import { foldForkNotices, forkNoticeEmissions, retainForkEvidence } from '@kumiai/rpc'
import { sha256 } from '@noble/hashes/sha2.js'
import { toB64U } from '@sozai/codec'

import { readCheckpointCoverage } from './checkpoint-store.js'
import type { EntryCapability } from './entry-capability.js'
import { copyStoredValue, sameStoredValue } from './memory-incarnation-stores.js'
import { GroupStateConflictError } from './persistence-errors.js'
import type { GroupKey, GroupTransaction } from './persistence-types.js'
import type { GroupHandleRegistry } from './registry/types.js'

type Binding = {
  identity: OwnIdentity
  entry: EntryCapability<GroupTransaction>
  assertOpen(): void
  track<T>(pending: Promise<T>): Promise<T>
}
const bindings = new WeakMap<GroupHandleRegistry, Binding>()

export function bindRegistryCheckpoint<TTx extends GroupTransaction>(params: {
  registry: GroupHandleRegistry
  identity: OwnIdentity
  entry: EntryCapability<TTx>
  assertOpen(): void
  track<T>(pending: Promise<T>): Promise<T>
}): void {
  bindings.set(params.registry, params)
}

function proven(records: Array<CheckpointRecord>, groupID: string): Array<CheckpointFactRecord> {
  const coverage = readCheckpointCoverage(groupID, records)
  const metadata = records.find((row) => row.kind === 'coverage' && row.id === 'coverage')
  const ids = new Set(
    metadata?.kind === 'coverage' ? metadata.installations.map((row) => row.id) : [],
  )
  return records.filter(
    (row): row is CheckpointFactRecord =>
      row.kind === 'fact' &&
      row.key.groupID === groupID &&
      ids.has(row.id) &&
      coverage.retained.some(
        (range) =>
          range.key.incarnation === row.key.incarnation &&
          range.from <= row.epoch &&
          range.through >= row.epoch,
      ),
  )
}

function retainedFactAt(records: Array<CheckpointRecord>, requestedKey: GroupKey, epoch: number) {
  return proven(records, requestedKey.groupID).find(
    (row) => row.key.incarnation === requestedKey.incarnation && row.epoch === epoch,
  )
}

async function compareRecords(
  records: Array<CheckpointRecord>,
  requestedKey: GroupKey,
  frame: Uint8Array,
): Promise<CheckpointComparison> {
  try {
    const { body } = decodeEpochCheckpoint(frame)
    const record = retainedFactAt(records, requestedKey, body.epoch)
    if (record === undefined) return { kind: 'coverage-gap' }
    const fact = decodeEpochRosterFact(record.canonical)
    const prior = retainedFactAt(records, requestedKey, body.epoch - 1)
    if (
      body.groupID !== fact.key.groupID ||
      body.genesisHash !== fact.genesisHash ||
      body.ciphersuite !== fact.ciphersuite
    )
      return { kind: 'invalid' }
    // Validate testimony without signing. The installed hash below supplies the comparison.
    const verified = await verifyCheckpointPair({
      first: frame,
      second: frame,
      localRosterFact: encodeEpochRosterFact({ ...fact, authHash: body.authHash }),
      ...(prior === undefined ? {} : { eligibilityRosterFact: prior.canonical }),
    })
    if (verified.kind !== 'agreement') return verified
    const signer = {
      epoch: body.epoch,
      signerDID: verified.signerDID,
      keyHash: verified.keyHash,
    }
    return body.authHash === fact.authHash
      ? { kind: 'agreement', ...signer }
      : {
          kind: 'conflict',
          ...signer,
          localAuthHash: fact.authHash,
          remoteAuthHash: body.authHash,
          parentAuthHash: body.parentAuthHash,
        }
  } catch {
    return { kind: 'invalid' }
  }
}

export function createCheckpointPort(params: {
  registry: GroupHandleRegistry
  key: GroupKey
  identity: OwnIdentity
}): CheckpointPort {
  const registered = bindings.get(params.registry)
  if (registered === undefined) throw new TypeError('Registered checkpoint coordinator required')
  const binding = registered
  binding.assertOpen()
  if (
    normalizeDID(params.identity.id) !== normalizeDID(binding.identity.id) ||
    checkpointKeyHash(params.identity.publicKey) !== checkpointKeyHash(binding.identity.publicKey)
  )
    throw new GroupStateConflictError('Checkpoint owner mismatch')
  const { entry } = binding
  const identity = binding.identity
  const key = { ...params.key }
  const sameKey = (other: GroupKey) =>
    other.groupID === key.groupID && other.incarnation === key.incarnation
  async function run<T>(fn: () => Promise<T>): Promise<T> {
    binding.assertOpen()
    return binding.track(fn())
  }
  function read<T>(fn: (records: Array<CheckpointRecord>) => T | Promise<T>): Promise<T> {
    return run(() => entry.read(key.groupID, async (reads) => fn(await reads.checkpoints())))
  }
  function factAt(records: Array<CheckpointRecord>, requestedKey: GroupKey, epoch: number) {
    return proven(records, key.groupID).find(
      (row) =>
        row.key.groupID === requestedKey.groupID &&
        row.key.incarnation === requestedKey.incarnation &&
        row.epoch === epoch,
    )
  }
  return {
    signInstalled(factID) {
      return run(async () => {
        const mutationID = crypto.randomUUID()
        return entry.run(
          { groupID: key.groupID, mutationID },
          async (reads) => {
            binding.assertOpen()
            const lifetime = await reads.lifetime()
            if (lifetime?.activeIncarnation !== key.incarnation)
              throw new GroupStateConflictError('Checkpoint worker is retired')
            const records = await reads.checkpoints()
            const record = proven(records, key.groupID).find(
              (row) => row.id === factID && sameKey(row.key),
            )
            const debt = records.find(
              (row) => row.kind === 'publication' && row.factID === factID && sameKey(row.key),
            )
            if (record === undefined || debt?.kind !== 'publication')
              return { expected: lifetime, value: null }
            const fact = decodeEpochRosterFact(record.canonical)
            const member = fact.members.find(
              (member) =>
                normalizeDID(member.signerDID) === normalizeDID(identity.id) &&
                member.keyHash === checkpointKeyHash(identity.publicKey),
            )
            if (member === undefined) return { expected: lifetime, value: null }
            const body = {
              v: 1 as const,
              type: 'kumiai/checkpoint/v1' as const,
              groupID: key.groupID,
              genesisHash: fact.genesisHash,
              ciphersuite: fact.ciphersuite,
              epoch: fact.epoch,
              authHash: fact.authHash,
              parentAuthHash: fact.parentAuthHash,
              keyHash: member.keyHash,
              leafIndex: member.leafIndex,
            }
            if (debt.frame !== null) {
              const saved = decodeEpochCheckpoint(debt.frame).body
              const verified = await verifyCheckpointPair({
                first: debt.frame,
                second: debt.frame,
                localRosterFact: record.canonical,
              })
              if (
                verified.kind !== 'agreement' ||
                verified.keyHash !== member.keyHash ||
                saved.leafIndex !== member.leafIndex ||
                saved.parentAuthHash !== fact.parentAuthHash
              )
                throw new GroupStateConflictError('Saved checkpoint does not match installation')
              return { expected: lifetime, value: { debt, frame: debt.frame } }
            }
            const suite = await nobleCryptoProvider.getCiphersuiteImpl(fact.ciphersuite)
            const frame = encodeEpochCheckpoint(
              body,
              await suite.signature.sign(identity.privateKey, checkpointSignatureInput(body)),
            )
            return { expected: lifetime, value: { debt, frame } }
          },
          async (stores, prepared) => {
            if (prepared === null) return null
            await stores.checkpoints.put({
              ...prepared.debt,
              frame: prepared.frame,
              publishID: prepared.debt.publishID ?? crypto.randomUUID(),
            })
            return prepared.frame.slice()
          },
        )
      })
    },
    compare(requestedKey, input) {
      const frame = input.slice()
      return read(async (records) => {
        return compareRecords(records, requestedKey, frame)
      })
    },
    exportCheckpoints(requestedKey, epochs) {
      return read((records) => {
        const facts = proven(records, key.groupID).filter(
          (row) =>
            row.key.groupID === requestedKey.groupID &&
            row.key.incarnation === requestedKey.incarnation &&
            (epochs === undefined || epochs.includes(row.epoch)),
        )
        return facts.flatMap((fact) => {
          const debt = records.find((row) => row.kind === 'publication' && row.factID === fact.id)
          return debt?.kind === 'publication' && debt.frame !== null ? [debt.frame.slice()] : []
        })
      })
    },
    checkpointFact: (requestedKey, epoch) =>
      read((records) => factAt(records, requestedKey, epoch)?.canonical.slice() ?? null),
    checkpointCoverage: (groupID) =>
      read((records) =>
        copyStoredValue(readCheckpointCoverage(groupID, groupID === key.groupID ? records : [])),
      ),
  }
}

type CheckpointServiceParams = {
  registry: GroupHandleRegistry
  key: GroupKey
  identity: OwnIdentity
  onForkNotice?: (event: ForkNoticeEvent) => void
}

export const checkpointServiceParameterMembers = {
  registry: 'core',
  key: 'data',
  identity: 'data',
  onForkNotice: 'host',
} as const satisfies Record<keyof CheckpointServiceParams, 'core' | 'data' | 'host'>

export function createRegistryCheckpointService(
  registry: GroupHandleRegistry,
  key: GroupKey,
): CheckpointService {
  const binding = bindings.get(registry)
  if (binding === undefined) throw new TypeError('Registered checkpoint coordinator required')
  return createCheckpointService({ registry, key, identity: binding.identity })
}

export function createCheckpointService(params: CheckpointServiceParams): CheckpointService {
  const port = createCheckpointPort(params)
  const registered = bindings.get(params.registry)
  if (registered === undefined) throw new TypeError('Registered checkpoint coordinator required')
  const binding = registered
  const { entry } = binding
  const key = { ...params.key }
  const delivered = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let retryDelay = 30000
  const sameKey = (other: GroupKey) =>
    other.groupID === key.groupID && other.incarnation === key.incarnation
  type Action =
    | { kind: 'refresh' }
    | { kind: 'import'; key: GroupKey; frame: Uint8Array }
    | { kind: 'ack'; id: string; revision: number }
    | { kind: 'update'; put: Array<CheckpointRecord>; remove: Array<string> }
  async function act(action: Action) {
    binding.assertOpen()
    const result = await binding.track(
      entry.run(
        { groupID: key.groupID, mutationID: crypto.randomUUID() },
        async (reads) => {
          binding.assertOpen()
          const now = Date.now()
          const lifetime = await reads.lifetime()
          const before = await reads.checkpoints()
          const facts = proven(before, key.groupID)
          let records = retainForkEvidence(before, facts, now)
          const statements: Array<CheckpointStatement> = []
          const lineage = facts.map((row) => decodeEpochRosterFact(row.canonical))
          const links = lineage.map(({ epoch, authHash, parentAuthHash }) => ({
            epoch,
            authHash,
            parentAuthHash,
          }))
          for (const row of records) {
            if (row.kind === 'evidence') {
              const { body } = decodeEpochCheckpoint(row.first)
              links.push(body)
            }
          }
          if (action.kind === 'import') {
            if (action.key.groupID !== key.groupID)
              throw new GroupStateConflictError('Checkpoint import binding mismatch')
            const hash = toB64U(sha256(action.frame))
            const tombstoned = records.some(
              (row) =>
                row.kind === 'notice-tombstone' &&
                !records.some((notice) => notice.kind === 'notice' && notice.id === row.noticeID) &&
                row.frames.some((frame) => frame.hash === hash),
            )
            const comparison = tombstoned
              ? { kind: 'invalid' as const }
              : await compareRecords(records, action.key, action.frame)
            if (comparison.kind === 'agreement' || comparison.kind === 'conflict') {
              const { body } = decodeEpochCheckpoint(action.frame)
              const fact = retainedFactAt(records, action.key, body.epoch)
              if (fact === undefined) throw new GroupStateConflictError('Missing checkpoint fact')
              const frameID = `evidence:${hash}`
              statements.push({
                ...body,
                signerDID: comparison.signerDID,
                localAuthHash: decodeEpochRosterFact(fact.canonical).authHash,
                frameID,
              })
              links.push(body)
            }
          }
          const folded = foldForkNotices({ key, records, statements, lineage: links, now })
          records = folded.records
          if (action.kind === 'import' && statements[0] !== undefined) {
            const statement = statements[0]
            const notice = folded.notices.find(
              (notice) => notice.id === folded.assignments.get(statement.frameID),
            )
            if (notice !== undefined) {
              const fact = retainedFactAt(records, action.key, statement.epoch)
              if (fact === undefined) throw new GroupStateConflictError('Missing checkpoint fact')
              let tombstone = records.find(
                (row) => row.kind === 'notice-tombstone' && row.noticeID === notice.id,
              )
              if (tombstone === undefined) {
                tombstone = {
                  kind: 'notice-tombstone',
                  id: `notice-tombstone:${notice.id}`,
                  key: { ...key },
                  noticeID: notice.id,
                  acknowledgedRevision: notice.acknowledgedRevision,
                  acknowledgedAt: notice.acknowledgedAt,
                  frames: [],
                }
                records.push(tombstone)
              }
              if (tombstone.kind !== 'notice-tombstone')
                throw new GroupStateConflictError('Invalid notice tombstone')
              const hash = toB64U(sha256(action.frame))
              if (!tombstone.frames.some((frame) => frame.hash === hash)) {
                tombstone.frames.push({ hash, installationID: fact.id })
                tombstone.frames.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))
              }
            }
            if (
              notice !== undefined &&
              (notice.coverage.evidence.kind === 'complete' ||
                before.some(
                  (row) =>
                    row.kind === 'notice' &&
                    row.id === notice.id &&
                    row.notice.revision < notice.revision,
                )) &&
              !records.some((row) => row.id === statement.frameID)
            ) {
              const fact = retainedFactAt(records, action.key, statement.epoch)
              const prior = retainedFactAt(records, action.key, statement.epoch - 1)
              if (fact === undefined) throw new GroupStateConflictError('Missing checkpoint fact')
              records.push({
                kind: 'evidence',
                id: statement.frameID,
                key: { ...action.key },
                noticeID: notice.id,
                first: action.frame.slice(),
                second:
                  records.flatMap((row) =>
                    row.kind === 'publication' && row.factID === fact.id && row.frame !== null
                      ? [row.frame.slice()]
                      : [],
                  )[0] ?? action.frame.slice(),
                localRosterFact: fact.canonical.slice(),
                eligibilityRosterFact: prior?.canonical.slice() ?? null,
              })
            }
          }
          if (action.kind === 'ack') {
            for (const row of records) {
              if (
                row.kind === 'notice' &&
                row.id === action.id &&
                row.notice.revision === action.revision &&
                row.notice.acknowledgedRevision < action.revision
              ) {
                row.notice.acknowledgedRevision = action.revision
                row.notice.acknowledgedAt = Date.now()
                for (const event of records)
                  if (
                    event.kind === 'notice-event' &&
                    event.event.notice.id === row.id &&
                    event.event.notice.revision <= action.revision
                  )
                    event.acknowledged = true
              }
            }
          }
          for (const tombstone of records) {
            if (tombstone.kind !== 'notice-tombstone') continue
            const row = records.find(
              (row) => row.kind === 'notice' && row.id === tombstone.noticeID,
            )
            if (row?.kind === 'notice') {
              tombstone.acknowledgedRevision = row.notice.acknowledgedRevision
              tombstone.acknowledgedAt = row.notice.acknowledgedAt
            }
          }
          if (action.kind === 'update') {
            if (lifetime?.activeIncarnation !== key.incarnation)
              throw new GroupStateConflictError('Checkpoint worker is retired')
            const writable = (row: CheckpointRecord) =>
              row.kind === 'cursor' || row.kind === 'publication'
            for (const row of action.put) {
              const previous = records.find((record) => record.id === row.id)
              if (
                !sameKey(row.key) ||
                !writable(row) ||
                (row.kind === 'cursor' &&
                  row.position !== null &&
                  (row.position.length === 0 || row.position.length > 64)) ||
                (previous !== undefined && !writable(previous)) ||
                (row.kind === 'publication' &&
                  (previous?.kind !== 'publication' ||
                    previous.factID !== row.factID ||
                    !sameStoredValue(previous.key, row.key) ||
                    !sameStoredValue(previous.frame, row.frame)))
              )
                throw new GroupStateConflictError(
                  'Checkpoint update requires coordinator authority',
                )
            }
            for (const id of action.remove) {
              const row = records.find((record) => record.id === id)
              if (row !== undefined && row.kind !== 'cursor')
                throw new GroupStateConflictError(
                  'Checkpoint removal requires coordinator authority',
                )
            }
            records = records.filter(
              (row) =>
                !action.remove.includes(row.id) && !action.put.some((next) => next.id === row.id),
            )
            records.push(...action.put)
          }
          return { expected: lifetime, value: { before, records } }
        },
        async (stores, { before, records }) => {
          await stores.checkpoints.remove(
            before
              .filter((row) => !records.some((next) => next.id === row.id))
              .map((row) => row.id),
          )
          for (const row of records) {
            if (
              !sameStoredValue(
                before.find((previous) => previous.id === row.id),
                row,
              )
            )
              await stores.checkpoints.put(row)
          }
          return records
        },
      ),
    )
    for (const event of forkNoticeEmissions(result, Date.now())) {
      if (!delivered.has(event.id)) {
        delivered.add(event.id)
        try {
          params.onForkNotice?.(copyStoredValue(event))
        } catch {
          /* Observers cannot change the proven result. */
        }
      }
    }
    retryDelay = 30000
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    const nextEmission = result.flatMap((row) =>
      row.kind === 'notice-event' && !row.acknowledged && row.emitAt > Date.now()
        ? [row.emitAt]
        : [],
    )
    if (params.onForkNotice !== undefined && nextEmission.length > 0) {
      schedule(Math.max(0, Math.min(...nextEmission) - Date.now()))
    }
    return result
  }
  function schedule(delay: number) {
    timer = setTimeout(() => {
      timer = undefined
      void act({ kind: 'refresh' }).catch(() => {
        // Owner fail-stop remains authoritative. Only live owners retry transient failures.
        try {
          binding.assertOpen()
        } catch {
          return
        }
        if (timer !== undefined) return
        schedule(retryDelay)
        retryDelay = Math.min(retryDelay * 2, 600000)
      })
    }, delay)
  }
  return {
    ...port,
    importCheckpoint: async (requestedKey, input) => {
      await act({ kind: 'import', key: { ...requestedKey }, frame: input.slice() })
    },
    forkNotices: async (groupID) =>
      groupID !== key.groupID
        ? []
        : (await act({ kind: 'refresh' })).flatMap((row) =>
            row.kind === 'notice' ? [row.notice] : [],
          ),
    events: async (groupID) =>
      groupID !== key.groupID
        ? []
        : (await act({ kind: 'refresh' })).flatMap((row) =>
            row.kind === 'notice-event' && !row.acknowledged && row.emitAt <= Date.now()
              ? [row.event]
              : [],
          ),
    ackForkNotice: async (groupID, id, revision) => {
      if (groupID !== key.groupID)
        throw new GroupStateConflictError('Checkpoint acknowledgement binding mismatch')
      await act({ kind: 'ack', id, revision })
    },
    readRecords: () => act({ kind: 'refresh' }),
    updateRecords: async (change) => {
      await act({
        kind: 'update',
        put: copyStoredValue(change.put ?? []),
        remove: [...(change.remove ?? [])],
      })
    },
  }
}
