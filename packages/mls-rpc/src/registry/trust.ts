import { normalizeDID } from '@kokuin/token'
import { type GroupHandle, readGroupAnchorExtension } from '@kumiai/mls'
import { ciphersuites, leafNodeSources } from 'ts-mls'

import { decodeStoredValue, encodeStoredValue } from '../persistence-codec.js'
import { GroupStateConflictError } from '../persistence-errors.js'
import { assertTrustTransition } from '../persistence-guards.js'
import type { GroupKey, GroupRecoveryTrust } from '../persistence-types.js'
import { knownRecoveryRegistry } from '../recovery.js'

export function recoveryTrustFor(
  handle: GroupHandle,
  key: GroupKey,
  retained: GroupRecoveryTrust | null,
): GroupRecoveryTrust {
  const anchor = readGroupAnchorExtension(handle)?.extensionData
  const suite = Object.entries(ciphersuites).find(([, id]) => id === handle.context.cipherSuite.id)
  if (
    key.groupID !== handle.groupID ||
    !Number.isSafeInteger(key.incarnation) ||
    key.incarnation < 1 ||
    !(anchor instanceof Uint8Array) ||
    suite == null ||
    handle.state.groupContext.cipherSuite !== handle.context.cipherSuite.id
  )
    throw new GroupStateConflictError('Invalid recovery trust destination')

  if (retained === null) {
    // Callers must prove lifetime absence before supplying null, including at incarnation 1.
    if (key.incarnation !== 1)
      throw new GroupStateConflictError('Recovery trust required for surviving lifetime')
  } else {
    assertTrustTransition(null, retained)
    if (
      retained.spentEpochAuthenticators.length === 0 ||
      retained.groupID !== key.groupID ||
      normalizeDID(retained.credential.id) !== normalizeDID(handle.credential.id) ||
      retained.ciphersuiteName !== suite[0]
    )
      throw new GroupStateConflictError('Invalid retained recovery trust')
  }

  // Whitelist public wire fields: runtime leaf/node objects may also carry private keys.
  const signerTree = handle.state.ratchetTree.map((node) => {
    if (node == null) return undefined
    if (node.nodeType === 2) {
      return {
        nodeType: node.nodeType,
        parent: {
          hpkePublicKey: node.parent.hpkePublicKey,
          parentHash: node.parent.parentHash,
          unmergedLeaves: node.parent.unmergedLeaves,
        },
      }
    }
    const leaf = node.leaf
    return {
      nodeType: node.nodeType,
      leaf: {
        hpkePublicKey: leaf.hpkePublicKey,
        signaturePublicKey: leaf.signaturePublicKey,
        credential: leaf.credential,
        capabilities: leaf.capabilities,
        leafNodeSource: leaf.leafNodeSource,
        extensions: leaf.extensions,
        signature: leaf.signature,
        ...(leaf.leafNodeSource === leafNodeSources.key_package ? { lifetime: leaf.lifetime } : {}),
        ...(leaf.leafNodeSource === leafNodeSources.commit ? { parentHash: leaf.parentHash } : {}),
      },
    }
  })
  const held = handle.bindingOfDID(handle.credential.id)
  const binding =
    held?.controller == null || held.prefix == null || held.capability == null
      ? null
      : {
          id: held.controller,
          prefix: held.prefix,
          capability: held.capability,
          ...(held.holderGrant == null ? {} : { holderGrant: held.holderGrant }),
        }
  const value = {
    groupID: key.groupID,
    genesisAnchor: anchor,
    installed: {
      ...key,
      epoch: Number(handle.epoch),
      authenticator: handle.state.keySchedule.epochAuthenticator,
    },
    signerTree,
    registry:
      retained === null
        ? handle.registry
        : knownRecoveryRegistry(retained.registry, handle.registry),
    credential: handle.credential,
    binding,
    ledger: handle.ledgerTokens,
    ciphersuiteName: suite[0],
    // The provider appends the installed authenticator during installation finalisation.
    spentEpochAuthenticators: retained?.spentEpochAuthenticators ?? [],
  }
  const trust = decodeStoredValue(encodeStoredValue(value)) as GroupRecoveryTrust
  assertTrustTransition(retained, trust)
  return trust
}
