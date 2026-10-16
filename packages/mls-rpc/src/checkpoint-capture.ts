import {
  checkpointAuthHash,
  checkpointGenesisHash,
  checkpointKeyHash,
  decodeEpochRosterFact,
  didFromCredential,
  encodeEpochRosterFact,
  type GroupHandle,
  readGroupAnchorExtension,
} from '@kumiai/mls'
import type { CheckpointFactRecord, CheckpointRecord } from '@kumiai/rpc'
import { sha256 } from '@noble/hashes/sha2.js'
import { toB64U } from '@sozai/codec'
import { type CiphersuiteName, ciphersuites } from 'ts-mls'

import { GroupStateConflictError } from './persistence-errors.js'
import type { GroupKey, GroupRecoveryTrust } from './persistence-types.js'

type Installation = {
  key: GroupKey
  mutationID: string
  stateVersion: number
  previousFact: Uint8Array | null
}

type PublicTrust = Pick<
  GroupRecoveryTrust,
  'groupID' | 'genesisAnchor' | 'installed' | 'signerTree' | 'ciphersuiteName'
>

const preparations = new WeakMap<CheckpointFactRecord, Uint8Array>()

export function checkpointPreparation(record: CheckpointFactRecord): Uint8Array | undefined {
  return preparations.get(record)?.slice()
}

export function currentCheckpointFact(
  records: Array<CheckpointRecord>,
): CheckpointFactRecord | null {
  const coverage = records.find((row) => row.kind === 'coverage' && row.id === 'coverage')
  const id = coverage?.kind === 'coverage' ? coverage.installations.at(-1)?.id : undefined
  const fact = records.find((row) => row.kind === 'fact' && row.id === id)
  return fact?.kind === 'fact' ? fact : null
}

async function prepare(
  params: Installation & {
    trust: PublicTrust
    confirmedTranscriptHash: Uint8Array
  },
): Promise<CheckpointFactRecord> {
  const { key, trust, mutationID, stateVersion, previousFact, confirmedTranscriptHash } = params
  if (
    key.groupID !== trust.groupID ||
    key.groupID !== trust.installed.groupID ||
    key.incarnation !== trust.installed.incarnation ||
    !Number.isSafeInteger(key.incarnation) ||
    key.incarnation < 1
  )
    throw new GroupStateConflictError('Checkpoint installation binding mismatch')
  const genesisHash = checkpointGenesisHash(trust.genesisAnchor)
  const ciphersuite = ciphersuites[trust.ciphersuiteName as CiphersuiteName]
  const previous = previousFact === null ? null : decodeEpochRosterFact(previousFact)
  const parentAuthHash =
    previous !== null &&
    previous.key.groupID === key.groupID &&
    previous.key.incarnation === key.incarnation &&
    previous.genesisHash === genesisHash &&
    previous.ciphersuite === ciphersuite &&
    previous.epoch === trust.installed.epoch - 1
      ? previous.authHash
      : null
  const canonical = encodeEpochRosterFact({
    v: 1,
    key: { ...key },
    genesisHash,
    ciphersuite,
    epoch: trust.installed.epoch,
    authHash: checkpointAuthHash({
      groupID: key.groupID,
      genesisHash,
      epoch: trust.installed.epoch,
      epochAuthenticator: trust.installed.authenticator,
    }),
    parentAuthHash,
    confirmedTranscriptHash: toB64U(confirmedTranscriptHash),
    members: trust.signerTree.flatMap((node, index) => {
      if (node?.nodeType !== 1) return []
      const signerDID = didFromCredential(node.leaf.credential)
      if (signerDID === null) throw new GroupStateConflictError('Invalid checkpoint member')
      return [
        {
          signerDID,
          keyHash: checkpointKeyHash(node.leaf.signaturePublicKey),
          leafIndex: index / 2,
          signaturePublicKey: toB64U(node.leaf.signaturePublicKey),
        },
      ]
    }),
    installation: { mutationID, stateVersion },
  })
  const record: CheckpointFactRecord = {
    kind: 'fact',
    id: toB64U(sha256(canonical)),
    key: { ...key },
    epoch: trust.installed.epoch,
    canonical,
    supersededAt: null,
  }
  preparations.set(record, canonical.slice())
  return record
}

export async function prepareCheckpointInstallation(
  params: Installation & {
    handle: GroupHandle
  },
): Promise<CheckpointFactRecord> {
  const { handle, key } = params
  const anchor = readGroupAnchorExtension(handle)?.extensionData
  const suite = Object.entries(ciphersuites).find(
    ([, id]) => id === handle.state.groupContext.cipherSuite,
  )
  if (!(anchor instanceof Uint8Array) || suite === undefined)
    throw new GroupStateConflictError('Missing checkpoint group context')
  return prepare({
    ...params,
    confirmedTranscriptHash: handle.state.groupContext.confirmedTranscriptHash,
    trust: {
      groupID: handle.groupID,
      genesisAnchor: anchor,
      installed: {
        ...key,
        epoch: Number(handle.epoch),
        authenticator: handle.state.keySchedule.epochAuthenticator,
      },
      signerTree: handle.state.ratchetTree,
      ciphersuiteName: suite[0],
    },
  })
}

export async function prepareCheckpointInstallationFromTrust(
  params: Installation & {
    trust: GroupRecoveryTrust
    confirmedTranscriptHash: Uint8Array
  },
): Promise<CheckpointFactRecord> {
  return prepare(params)
}
