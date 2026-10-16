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
import type { CheckpointFactRecord, CheckpointPort, CheckpointRecord } from '@kumiai/rpc'

import { readCheckpointCoverage } from './checkpoint-store.js'
import type { EntryCapability } from './entry-capability.js'
import { copyStoredValue } from './memory-incarnation-stores.js'
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
        try {
          const { body } = decodeEpochCheckpoint(frame)
          const record = factAt(records, requestedKey, body.epoch)
          if (record === undefined) return { kind: 'coverage-gap' }
          const fact = decodeEpochRosterFact(record.canonical)
          const prior = factAt(records, requestedKey, body.epoch - 1)
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
