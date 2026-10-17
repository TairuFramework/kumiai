import { type ClientState, decodeClientState, encodeClientState } from '@kumiai/mls'
import type { EpochReceiverData } from 'ts-mls'

import { GroupStateConflictError } from './persistence-errors.js'
import type { GroupRecoveryTrust, GroupStateRecord } from './persistence-types.js'

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new GroupStateConflictError(message)
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index])
}

function validCounter(value: number, minimum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum
}

export function readState(record: GroupStateRecord & { deleted: false }): ClientState | null {
  if (record.state === null) return null
  let client: ClientState | undefined
  let groupID: string | undefined
  try {
    client = decodeClientState(record.state)
    if (client !== undefined) {
      groupID = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        client.groupContext.groupId,
      )
    }
  } catch (cause) {
    throw new GroupStateConflictError('Unreadable client state', { cause })
  }
  requireCondition(client !== undefined, 'Malformed client state')
  requireCondition(
    groupID === record.groupID &&
      client.groupContext.epoch === BigInt(record.epoch) &&
      sameBytes(client.keySchedule.epochAuthenticator, record.epochAuthenticator),
    'Client state identity mismatch',
  )
  return client
}

type SecretTree = ClientState['secretTree']

function isDescendant(node: number, ancestor: number): boolean {
  // MLS in-order node indices span 2^level - 1 positions on either side of a parent.
  let radius = 1
  for (let index = ancestor; index % 2 === 1; index = Math.floor(index / 2)) radius *= 2
  return node !== ancestor && Math.abs(node - ancestor) < radius
}

function assertSkippedKeyIndices(tree: SecretTree): void {
  for (const node of Object.values(tree.leafNodes)) {
    for (const kind of ['handshake', 'application'] as const) {
      const ratchet = node[kind]
      for (const key of Object.keys(ratchet.unusedGenerations)) {
        const index = Number(key)
        requireCondition(
          Number.isSafeInteger(index) && index >= 0 && index < ratchet.generation,
          'Invalid skipped-key index',
        )
      }
    }
  }
}

function assertTreeProgress(previous: SecretTree | undefined, next: SecretTree): void {
  if (previous === undefined) return
  requireCondition(next.leafWidth === previous.leafWidth, 'Secret tree width changed')
  const expanded = Object.keys(previous.intermediateNodes)
    .filter((key) => !Object.hasOwn(next.intermediateNodes, key))
    .map(Number)
  for (const key of Object.keys(next.intermediateNodes)) {
    requireCondition(
      Object.hasOwn(previous.intermediateNodes, key) ||
        expanded.some((ancestor) => isDescendant(Number(key), ancestor)),
      'Consumed tree secret resurrected',
    )
  }
  for (const [leaf, previousNode] of Object.entries(previous.leafNodes)) {
    const nextNode = next.leafNodes[Number(leaf)]
    requireCondition(nextNode !== undefined, 'Consumed leaf ratchet discarded')
    for (const kind of ['handshake', 'application'] as const) {
      const before = previousNode[kind]
      const after = nextNode[kind]
      requireCondition(after.generation >= before.generation, 'Ratchet generation regressed')
      for (const key of Object.keys(after.unusedGenerations)) {
        requireCondition(
          Number(key) >= before.generation || Object.hasOwn(before.unusedGenerations, key),
          'Consumed ratchet key resurrected',
        )
      }
    }
  }
}

function assertRetainedTuple(
  template: ClientState,
  previous: EpochReceiverData,
  next: EpochReceiverData,
): void {
  // ts-mls exposes the combined encoder, but not its public tree/context encoders.
  const publicTuple = (receiver: EpochReceiverData) => {
    return encodeClientState({
      ...template,
      groupContext: receiver.groupContext,
      ratchetTree: receiver.ratchetTree,
    })
  }
  requireCondition(
    sameBytes(previous.resumptionPsk, next.resumptionPsk) &&
      sameBytes(previous.senderDataSecret, next.senderDataSecret) &&
      sameBytes(publicTuple(previous), publicTuple(next)),
    'Retained epoch tuple changed',
  )
}

function assertReceiveProgress(previous: ClientState, next: ClientState): void {
  const previousEpoch = previous.groupContext.epoch
  assertTreeProgress(
    next.groupContext.epoch === previousEpoch ? previous.secretTree : undefined,
    next.secretTree,
  )
  for (const [epoch, receiver] of next.historicalReceiverData) {
    requireCondition(epoch < next.groupContext.epoch, 'Invalid retained epoch')
    if (epoch > previousEpoch) continue
    if (epoch === previousEpoch) {
      assertRetainedTuple(
        previous,
        {
          ...previous.keySchedule,
          secretTree: previous.secretTree,
          ratchetTree: previous.ratchetTree,
          groupContext: previous.groupContext,
        },
        receiver,
      )
      assertTreeProgress(previous.secretTree, receiver.secretTree)
    } else {
      const before = previous.historicalReceiverData.get(epoch)
      requireCondition(before !== undefined, 'Evicted epoch resurrected')
      assertRetainedTuple(previous, before, receiver)
      assertTreeProgress(before.secretTree, receiver.secretTree)
    }
  }
}

export function assertStateTransition(
  previous: GroupStateRecord | null,
  next: GroupStateRecord,
  trust: GroupRecoveryTrust | null,
  bootstrapTrust = false,
): void {
  requireCondition(
    validCounter(next.incarnation, 1) && validCounter(next.version, 1),
    'Invalid state counters',
  )
  requireCondition(previous === null || previous.groupID === next.groupID, 'State group changed')
  const sameIncarnation = previous !== null && previous.incarnation === next.incarnation
  requireCondition(
    next.version === (sameIncarnation ? previous.version + 1 : 1),
    'State version conflict',
  )
  requireCondition(
    previous === null || next.incarnation >= previous.incarnation,
    'Incarnation regressed',
  )
  if (next.deleted) return
  requireCondition(
    validCounter(next.epoch, 0) && validCounter(next.senderHWM, 0),
    'Invalid state metadata',
  )
  requireCondition(next.credential.groupID === next.groupID, 'Credential group mismatch')
  const client = readState(next)
  if (client !== null) {
    assertSkippedKeyIndices(client.secretTree)
    for (const receiver of client.historicalReceiverData.values())
      assertSkippedKeyIndices(receiver.secretTree)
  }
  if (sameIncarnation) {
    requireCondition(!previous.deleted, 'Deleted incarnation resurrected')
    requireCondition(
      previous.state !== null || next.state === null,
      'Lost private state requires a new incarnation',
    )
    requireCondition(next.epoch >= previous.epoch, 'Epoch regressed')
    requireCondition(!previous.terminal || next.terminal, 'Terminal incarnation resurrected')
    if (next.epoch === previous.epoch) {
      requireCondition(
        sameBytes(next.epochAuthenticator, previous.epochAuthenticator),
        'Same-epoch authenticator changed',
      )
      requireCondition(next.senderHWM >= previous.senderHWM, 'Sender high-water mark regressed')
      const before = readState(previous)
      if (before !== null && client !== null) assertReceiveProgress(before, client)
      return
    }
    const before = readState(previous)
    if (before !== null && client !== null) assertReceiveProgress(before, client)
  }
  // Only trust first proposed in this transaction can describe bootstrap installation.
  const firstCreation = previous === null && next.incarnation === 1
  if (trust === null) {
    requireCondition(firstCreation, 'Recovery trust required for identity change')
    return
  }
  assertTrustTransition(null, trust)
  requireCondition(trust.groupID === next.groupID, 'Recovery trust group mismatch')
  const matchingFirstTrust =
    bootstrapTrust &&
    firstCreation &&
    trust.installed.incarnation === next.incarnation &&
    trust.installed.epoch === next.epoch &&
    sameBytes(trust.installed.authenticator, next.epochAuthenticator)
  requireCondition(
    matchingFirstTrust ||
      !trust.spentEpochAuthenticators.some((spent) => sameBytes(spent, next.epochAuthenticator)),
    'Epoch authenticator already spent',
  )
}

function assertPublicValue(value: unknown): void {
  if (value === null || typeof value !== 'object' || value instanceof Uint8Array) return
  for (const [key, entry] of Object.entries(value)) {
    requireCondition(
      !/private|secret|unusedGenerations|^generation$/i.test(key),
      'Private signer node forbidden',
    )
    assertPublicValue(entry)
  }
}

// Prospective trust may be empty until installation appends its authenticator; stored trust may not.
export function assertPersistedSpentSet(trust: GroupRecoveryTrust): void {
  requireCondition(
    Array.isArray(trust.spentEpochAuthenticators) &&
      trust.spentEpochAuthenticators.length > 0 &&
      trust.spentEpochAuthenticators.every(
        (bytes) => bytes instanceof Uint8Array && bytes.length > 0,
      ),
    'Persisted spent authenticator set is empty or malformed',
  )
}

export function assertTrustTransition(
  previous: GroupRecoveryTrust | null,
  next: GroupRecoveryTrust,
): void {
  requireCondition(
    typeof next.groupID === 'string' &&
      next.genesisAnchor instanceof Uint8Array &&
      next.installed !== null &&
      typeof next.installed === 'object' &&
      next.installed.groupID === next.groupID &&
      validCounter(next.installed.incarnation, 1) &&
      validCounter(next.installed.epoch, 0) &&
      next.installed.authenticator instanceof Uint8Array &&
      Array.isArray(next.spentEpochAuthenticators) &&
      next.spentEpochAuthenticators.every((bytes) => bytes instanceof Uint8Array) &&
      Array.isArray(next.signerTree) &&
      next.registry?.devices instanceof Map &&
      next.registry.controllers instanceof Map &&
      next.credential?.groupID === next.groupID &&
      Array.isArray(next.ledger) &&
      typeof next.ciphersuiteName === 'string',
    'Malformed recovery trust',
  )
  for (const node of next.signerTree) {
    if (node === undefined) continue
    requireCondition(
      (node.nodeType === 1 &&
        Object.keys(node).every((key) => key === 'nodeType' || key === 'leaf')) ||
        (node.nodeType === 2 &&
          Object.keys(node).every((key) => key === 'nodeType' || key === 'parent')),
      'Private signer node forbidden',
    )
    assertPublicValue(node)
  }
  if (previous === null) return
  requireCondition(next.groupID === previous.groupID, 'Recovery trust group changed')
  requireCondition(sameBytes(next.genesisAnchor, previous.genesisAnchor), 'Genesis anchor changed')
  requireCondition(
    previous.spentEpochAuthenticators.every((spent) =>
      next.spentEpochAuthenticators.some((bytes) => sameBytes(spent, bytes)),
    ),
    'Spent authenticator set shrank',
  )
}
