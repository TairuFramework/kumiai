import { normalizeDID, type OwnIdentity, randomIdentity } from '@kokuin/token'
import {
  type ControllerBinding,
  checkpointSignatureInput,
  commitInvite,
  commitSelfRemovals,
  confirmationTag,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  decodeClientState,
  decodeEpochRosterFact,
  encodeEpochCheckpoint,
  parseMLSCredentialIdentity,
  processWelcome,
  proposeSelfRemoval,
  restoreGroup,
} from '@kumiai/mls'
import {
  type CapturedPendingRecovery,
  type CapturedRejoinRecord,
  digestAppliedCommit,
  encodeCommitFrame,
  encodeHandshakeFrame,
  HANDSHAKE_KIND,
} from '@kumiai/rpc'
import { ed25519 } from '@noble/curves/ed25519.js'

import { prepareCheckpointInstallation } from '../../src/checkpoint-capture.js'
import { createGroupMLS, createLedgerEntrySlot } from '../../src/mls.js'
import { recoveryTrustDigest } from '../../src/recovery-trust-digest.js'
import { recoveryTrustFor } from '../../src/registry/trust.js'
import { persistedTestAccess, type RealMember, testGroupMLSDependencies } from './real-group.js'
import {
  createTransactionalAccess,
  createTransactionalStore,
  type TransactionalStore,
} from './transactional-access.js'

export function capturedRecord(
  pending: CapturedPendingRecovery,
  request: Uint8Array,
  requestKey: Uint8Array,
  requestID: string,
): CapturedRejoinRecord {
  const payload = encodeHandshakeFrame(
    HANDSHAKE_KIND.commit,
    encodeCommitFrame(pending.commit, new Uint8Array()),
  )
  return {
    format: 2,
    id: requestID,
    publishID: requestID,
    stage: 'built',
    source: pending.source,
    target: pending.target,
    captureHead: pending.target.captureHead,
    searchFrom: pending.target.captureHead,
    expectedHead: pending.target.captureHead,
    trigger: 'automatic',
    authorisationID: null,
    switchMutationID: null,
    destinationKey: null,
    payload,
    payloadDigest: digestAppliedCommit(payload),
    digest: digestAppliedCommit(pending.commit),
    requestID,
    request,
    requestKey,
    candidate: pending.serialize(),
    epochAfter: pending.epoch,
    ledgerBefore: [],
  }
}

export async function createCapturedRealRecovery(transactional = false) {
  const real = await boundCapturedGroup()
  const requester = real.members[0]
  const responder = real.members[1]
  if (requester === undefined || responder === undefined)
    throw new Error('Missing captured members')
  const trust = recoveryTrustFor(
    requester.handle,
    { groupID: requester.handle.groupID, incarnation: 1 },
    null,
  )
  const source = {
    key: { groupID: trust.groupID, incarnation: 1 },
    stateVersion: 1,
    lifetimeRevision: 1,
    identity: null,
    trust,
    trustDigest: recoveryTrustDigest(trust),
  }
  let accepted = 0
  const make = async (member: RealMember, store: TransactionalStore, recovery: boolean) => {
    const access = transactional
      ? (await createTransactionalAccess(member, store)).access
      : persistedTestAccess(
          {
            handle: () => member.handle,
            adopt: (next) => {
              member.handle = next
            },
          },
          store,
        )
    return createGroupMLS({
      ...testGroupMLSDependencies(access, store.control),
      identity: member.identity,
      entrySlot: member.slot,
      ...(recovery
        ? {
            recoveryAdoption: {
              target: { targetID: 'hub', topicID: 'commits' },
              environment: { identity: member.identity, options: {} },
              readRecoverySource: async () => source,
              accept: async () => {
                accepted++
              },
            },
          }
        : {}),
    })
  }
  const responderStore = createTransactionalStore(responder.handle)
  return {
    invalidateRetainedSigner(kind: 'missing' | 'wrong-controller' | 'revoked') {
      if (kind === 'missing' || kind === 'wrong-controller') {
        trust.signerTree = trust.signerTree.map((node) => {
          if (
            node?.nodeType !== 1 ||
            !node.leaf.signaturePublicKey.every(
              (value, index) => value === responder.identity.publicKey[index],
            )
          )
            return node
          if (kind === 'missing') return undefined
          const credential = node.leaf.credential
          if (!('identity' in credential)) throw new Error('Missing signer credential')
          const parsed = parseMLSCredentialIdentity(credential.identity)
          if (parsed.controller === undefined) throw new Error('Missing signer controller')
          return {
            ...node,
            leaf: {
              ...node.leaf,
              credential: {
                ...credential,
                identity: new TextEncoder().encode(
                  JSON.stringify({
                    ...parsed,
                    controller: { ...parsed.controller, id: randomIdentity().id },
                  }),
                ),
              },
            },
          }
        })
      } else
        trust.registry.devices = new Map(trust.registry.devices).set(
          normalizeDID(responder.identity.id),
          {
            controller: responder.handle.anchor.controller ?? responder.identity.id,
            status: 'revoked',
          },
        )
      source.trustDigest = recoveryTrustDigest(trust)
    },
    requester: await make(requester, createTransactionalStore(requester.handle), true),
    responder: await make(responder, responderStore, false),
    async restartResponder() {
      const store = await responderStore.fork()
      const row = store.snapshot()
      const state = decodeClientState(row.state)
      if (state == null) throw new Error('Missing responder state')
      const member = {
        ...responder,
        handle: await restoreGroup({
          state,
          credential: responder.handle.credential,
          ledgerEntries: row.ledger,
          options: { resolveLedgerEntries: responder.slot.resolve },
        }),
      }
      return await make(member, store, false)
    },
    record: capturedRecord,
    confirmationTag,
    accepted: () => accepted,
  }
}

async function boundCapturedGroup() {
  const lifecycle = (await import(
    new URL('../../../mls/test/fixtures/lifecycle-ledger.ts', import.meta.url).href
  )) as {
    bindingFor(
      identity: OwnIdentity,
      prefix?: ControllerBinding['prefix'],
      issuer?: { identity: OwnIdentity; parent: string },
    ): Promise<ControllerBinding>
    trustedGrant(identity: OwnIdentity): Promise<string>
  }
  const identity = randomIdentity()
  const responder = randomIdentity()
  const controller = await lifecycle.bindingFor(identity)
  const source = (
    await createGroup(identity, `captured-contract-${crypto.randomUUID()}`, { controller })
  ).group
  const binding = await lifecycle.bindingFor(responder, undefined, {
    identity,
    parent: await lifecycle.trustedGrant(identity),
  })
  const bundle = await createKeyPackageBundle(responder, { controller: binding })
  const { invite } = await createInvite({ group: source, identity, recipientDID: responder.id })
  const added = await commitInvite(source, bundle.publicPackage, invite)
  const joined = await processWelcome({
    identity: responder,
    invite,
    welcome: added.welcomeMessage,
    keyPackageBundle: bundle,
  })
  return {
    members: [
      { identity, handle: added.newGroup, slot: createLedgerEntrySlot() },
      { identity: responder, handle: joined.group, slot: createLedgerEntrySlot() },
    ],
  }
}

export async function createCapturedFormerMember() {
  const real = await boundCapturedGroup()
  const responder = real.members[0]
  const requester = real.members[1]
  if (responder === undefined || requester === undefined) throw new Error('Missing bound members')
  const key = { groupID: responder.handle.groupID, incarnation: 1 }
  const trust = recoveryTrustFor(requester.handle, key, null)
  const earlier = await prepareCheckpointInstallation({
    key,
    handle: responder.handle,
    mutationID: 'former-member',
    stateVersion: 1,
    previousFact: null,
  })
  const index = responder.handle.findMemberLeafIndex(requester.identity.id)
  if (index === undefined) throw new Error('Missing requester')
  const removal = await proposeSelfRemoval(requester.handle)
  await responder.handle.processMessage(removal.frame)
  const removed = await commitSelfRemovals(responder.handle)
  if (removed === null) throw new Error('Missing authenticated self-removal')
  responder.handle = removed.newGroup
  const current = await prepareCheckpointInstallation({
    key,
    handle: responder.handle,
    mutationID: 'removed-member',
    stateVersion: 2,
    previousFact: earlier.canonical,
  })
  const retainedRosterFacts = [earlier.canonical, current.canonical]
  const lineage = retainedRosterFacts.map((bytes) => {
    const fact = decodeEpochRosterFact(bytes)
    const own = fact.members.find((member) => member.signerDID === responder.identity.id)
    if (own === undefined) throw new Error('Missing responder')
    const body = {
      v: 1 as const,
      type: 'kumiai/checkpoint/v1' as const,
      groupID: key.groupID,
      genesisHash: fact.genesisHash,
      ciphersuite: fact.ciphersuite,
      epoch: fact.epoch,
      authHash: fact.authHash,
      parentAuthHash: fact.parentAuthHash,
      keyHash: own.keyHash,
      leafIndex: own.leafIndex,
    }
    return encodeEpochCheckpoint(
      body,
      ed25519.sign(checkpointSignatureInput(body), responder.identity.privateKey),
    )
  })
  return { requester, responder, trust, retainedRosterFacts, lineage }
}
