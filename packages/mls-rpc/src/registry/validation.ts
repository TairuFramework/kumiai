import { normalizeDID, type OwnIdentity } from '@kokuin/token'
import {
  encodeClientState,
  type GroupHandle,
  type GroupOptions,
  parseMLSCredentialIdentity,
  readGroupAnchorExtension,
} from '@kumiai/mls'
import { RETAINED_EPOCHS_DEFAULT, RETAINED_EPOCHS_MAX } from '@kumiai/rpc'
import { ciphersuites, defaultKeyRetentionConfig } from 'ts-mls'

import { GroupStateConflictError, KeyRetentionRangeError } from '../persistence-errors.js'
import type { GroupKey, GroupRecoveryTrust, GroupStateRecord } from '../persistence-types.js'
import type { RecoveryBinding } from '../recovery.js'
import { recoveryTrustFor } from './trust.js'

export type RecoveryEnvironment = {
  identity: OwnIdentity
  options: GroupOptions
  recoveryBinding?: RecoveryBinding
}

export function registryOptions(options: GroupOptions): GroupOptions {
  const keyRetention = { ...options.keyRetention }
  const epochs =
    keyRetention.retainKeysForEpochs === undefined
      ? RETAINED_EPOCHS_DEFAULT
      : keyRetention.retainKeysForEpochs
  if (!Number.isInteger(epochs) || epochs < 1 || epochs > RETAINED_EPOCHS_MAX)
    throw new KeyRetentionRangeError(
      `Registry retainKeysForEpochs must be an integer in 1..${RETAINED_EPOCHS_MAX}`,
    )
  keyRetention.retainKeysForEpochs = epochs
  for (const field of ['retainKeysForGenerations', 'maximumForwardRatchetSteps'] as const) {
    const value = keyRetention[field] === undefined ? 1000 : keyRetention[field]
    if (!Number.isSafeInteger(value) || value < 1000)
      throw new GroupStateConflictError(`Registry ${field} must be an integer >= 1000`)
    keyRetention[field] = value
  }
  return { ...options, keyRetention }
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new GroupStateConflictError(message)
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index])
}

function sameLedger(left: Array<string>, right: Array<string>): boolean {
  return left.length === right.length && left.every((token, index) => token === right[index])
}

export function validateRegistryHandle(params: {
  handle: GroupHandle
  key: GroupKey
  record?: GroupStateRecord
  trust: GroupRecoveryTrust | null
  environment: RecoveryEnvironment
  ownerDID: string
}): void {
  const { handle, key, record, trust, environment, ownerDID } = params
  const options = registryOptions(environment.options)
  const owner = normalizeDID(environment.identity.id)
  requireCondition(
    owner === normalizeDID(ownerDID) && owner === normalizeDID(handle.credential.id),
    'Registry owner mismatch',
  )
  requireCondition(
    handle.groupID === key.groupID &&
      new TextDecoder('utf-8', { fatal: true }).decode(handle.state.groupContext.groupId) ===
        key.groupID &&
      Number.isSafeInteger(Number(handle.epoch)) &&
      handle.epoch >= 0n,
    'Registry group identity mismatch',
  )
  const suiteName = options.ciphersuiteName ?? 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'
  requireCondition(
    Object.entries(ciphersuites).some(
      ([name, id]) => name === suiteName && id === handle.context.cipherSuite.id,
    ) && handle.state.groupContext.cipherSuite === handle.context.cipherSuite.id,
    'Registry cipher suite mismatch',
  )
  requireCondition(
    handle.commitPolicy === options.commitPolicy &&
      handle.resolveLedgerEntries === options.resolveLedgerEntries &&
      handle.onLedgerEntries === options.onLedgerEntries,
    'Registry callback references mismatch',
  )
  const retention = handle.context.clientConfig?.keyRetentionConfig ?? defaultKeyRetentionConfig
  const expectedRetention = { ...defaultKeyRetentionConfig, ...options.keyRetention }
  requireCondition(
    Object.keys(defaultKeyRetentionConfig).every((field) => {
      const name = field as keyof typeof defaultKeyRetentionConfig
      return retention[name] === expectedRetention[name]
    }),
    'Registry key retention mismatch',
  )
  requireCondition(
    handle.state.historicalReceiverData.size <= expectedRetention.retainKeysForEpochs,
    'Registry retained epoch limit exceeded',
  )
  for (const tree of [
    handle.state.secretTree,
    ...Array.from(handle.state.historicalReceiverData.values(), (receiver) => receiver.secretTree),
  ]) {
    for (const node of Object.values(tree.leafNodes)) {
      for (const kind of ['handshake', 'application'] as const) {
        requireCondition(
          Object.keys(node[kind].unusedGenerations).length <=
            expectedRetention.retainKeysForGenerations,
          'Registry skipped-key limit exceeded',
        )
      }
    }
  }
  if (handle.state.groupActiveState.kind !== 'removedFromGroup') {
    const leaf = handle.state.ratchetTree[handle.state.privatePath.leafIndex * 2]
    requireCondition(
      leaf?.nodeType === 1 && 'identity' in leaf.leaf.credential,
      'Registry own leaf missing',
    )
    requireCondition(
      normalizeDID(parseMLSCredentialIdentity(leaf.leaf.credential.identity).id) === owner &&
        sameBytes(leaf.leaf.signaturePublicKey, environment.identity.publicKey),
      'Registry own leaf credential mismatch',
    )
  }
  // Candidate installation uses retained immutable trust, not the source's installed identity.
  recoveryTrustFor(handle, key, trust)
  if (record === undefined) return
  requireCondition(!record.deleted && record.state !== null, 'Registry private state unavailable')
  requireCondition(trust !== null, 'Registry surviving recovery trust unavailable')
  requireCondition(
    record.groupID === key.groupID &&
      record.incarnation === key.incarnation &&
      record.epoch === Number(handle.epoch) &&
      sameBytes(record.epochAuthenticator, handle.state.keySchedule.epochAuthenticator) &&
      record.credential.groupID === key.groupID &&
      normalizeDID(record.credential.id) === owner &&
      sameLedger(record.ledger, handle.ledgerTokens),
    'Registry state record mismatch',
  )
  requireCondition(
    trust.installed.groupID === key.groupID &&
      trust.installed.incarnation === key.incarnation &&
      trust.installed.epoch === record.epoch &&
      sameBytes(trust.installed.authenticator, record.epochAuthenticator) &&
      sameLedger(trust.ledger, record.ledger),
    'Registry current recovery trust mismatch',
  )
}

/** Compare the accepted host destination before importing any committed progress. */
export function ordinaryCandidateMatches(
  next: GroupHandle,
  destination: GroupHandle,
  key: GroupKey,
): boolean {
  try {
    const leaf = destination.state.ratchetTree[destination.state.privatePath.leafIndex * 2]
    const anchor = readGroupAnchorExtension(next)?.extensionData
    const acceptedAnchor = readGroupAnchorExtension(destination)?.extensionData
    return (
      next.groupID === key.groupID &&
      destination.groupID === key.groupID &&
      next.epoch === destination.epoch &&
      sameBytes(
        next.state.keySchedule.epochAuthenticator,
        destination.state.keySchedule.epochAuthenticator,
      ) &&
      next.credential.groupID === key.groupID &&
      destination.credential.groupID === key.groupID &&
      normalizeDID(next.credential.id) === normalizeDID(destination.credential.id) &&
      leaf?.nodeType === 1 &&
      'identity' in leaf.leaf.credential &&
      normalizeDID(destination.credential.id) ===
        normalizeDID(parseMLSCredentialIdentity(leaf.leaf.credential.identity).id) &&
      anchor instanceof Uint8Array &&
      acceptedAnchor instanceof Uint8Array &&
      sameBytes(anchor, acceptedAnchor) &&
      sameBytes(encodeClientState(next.state), encodeClientState(destination.state))
    )
  } catch {
    return false
  }
}
