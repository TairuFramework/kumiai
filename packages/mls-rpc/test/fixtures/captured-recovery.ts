import { normalizeDID, type OwnIdentity, randomIdentity } from '@kokuin/token'
import {
  type ControllerBinding,
  checkpointSignatureInput,
  commitInvite,
  commitKeyRotation,
  commitSelfRemovals,
  confirmationTag,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  decodeClientState,
  decodeEpochRosterFact,
  encodeClientState,
  encodeEpochCheckpoint,
  parseMLSCredentialIdentity,
  processWelcome,
  proposeSelfRemoval,
  restoreGroup,
  sealCapturedGroupInfo,
  verifyRecoveryRequest,
} from '@kumiai/mls'
import {
  type CapturedPendingRecovery,
  type CapturedRejoinRecord,
  digestAppliedCommit,
  encodeCommitFrame,
  encodeHandshakeFrame,
  HANDSHAKE_KIND,
} from '@kumiai/rpc'
import type { RosterAbsenceFixture, RosterAbsenceScenario } from '@kumiai/rpc-conformance'
import { ed25519 } from '@noble/curves/ed25519.js'
import { vi } from 'vitest'

import { createCheckpointPort } from '../../src/checkpoint.js'
import { prepareCheckpointInstallation } from '../../src/checkpoint-capture.js'
import { entryCapability } from '../../src/entry-capability.js'
import { createGroupMLS, createLedgerEntrySlot } from '../../src/mls.js'
import { recoveryTrustDigest } from '../../src/recovery-trust-digest.js'
import { recoveryTrustFor } from '../../src/registry/trust.js'
import { createRegistryGroupMLS } from '../../src/registry-group-mls.js'
import { createAsyncLocalOwnershipContext } from './ownership-context.js'
import { persistedTestAccess, type RealMember, testGroupMLSDependencies } from './real-group.js'
import { createRegistryFixture } from './registry.js'
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
    genesis: source,
    members: [
      { identity, handle: added.newGroup, slot: createLedgerEntrySlot() },
      { identity: responder, handle: joined.group, slot: createLedgerEntrySlot() },
    ],
  }
}

export async function createCapturedFormerMember(present = false) {
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
  const earlierGroup = responder.handle
  const index = responder.handle.findMemberLeafIndex(requester.identity.id)
  if (index === undefined) throw new Error('Missing requester')
  if (present) {
    const rotation = await commitKeyRotation(requester.handle)
    const state = decodeClientState(encodeClientState(responder.handle.state))
    if (state == null) throw new Error('Missing prior state')
    responder.handle = await restoreGroup({
      state,
      credential: responder.handle.credential,
      ledgerEntries: responder.handle.ledgerTokens,
    })
    await responder.handle.processMessage(rotation.commitMessage)
  } else {
    const removal = await proposeSelfRemoval(requester.handle)
    await responder.handle.processMessage(removal.frame)
    const removed = await commitSelfRemovals(responder.handle)
    if (removed === null) throw new Error('Missing authenticated self-removal')
    responder.handle = removed.newGroup
  }
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
  return {
    requester,
    responder,
    trust,
    earlierGroup,
    genesis: real.genesis,
    retainedRosterFacts,
    lineage,
  }
}

export async function createRosterAbsenceRealFixture(
  scenario: RosterAbsenceScenario = 'absent',
  transactional = false,
  ownership: 'supplied' | 'absent' = 'absent',
): Promise<RosterAbsenceFixture> {
  const s = await createCapturedFormerMember(scenario === 'present')
  const groupID = s.responder.handle.groupID
  const fixture = await createRegistryFixture({
    mode: 'real-mls',
    setup: 'empty',
    groupID,
    identity: s.responder.identity,
    ownershipContext: ownership === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
  })
  try {
    const restore = async (handle: typeof s.responder.handle) => {
      const state = decodeClientState(encodeClientState(handle.state))
      if (state == null) throw new Error('Missing roster state')
      return await restoreGroup({
        state,
        credential: handle.credential,
        ledgerEntries: handle.ledgerTokens,
        options: fixture.environment.options,
      })
    }
    const earlier = await restore(s.earlierGroup)
    if (scenario === 'wrong-key') {
      const index = earlier.findMemberLeafIndex(s.requester.identity.id)
      const leaf = index === undefined ? undefined : earlier.state.ratchetTree[index * 2]
      if (leaf?.nodeType !== 1) throw new Error('Missing historical requester leaf')
      leaf.leaf.signaturePublicKey = randomIdentity().publicKey
    }
    const current = await restore(s.responder.handle)
    const key = await fixture.registry.seed(await restore(s.genesis), { packageUse: null })
    async function install(handle: typeof current) {
      const previous = await fixture.device.groups.loadState(key)
      if (previous === null || previous.deleted) throw new Error('Missing installed source')
      const trust = recoveryTrustFor(
        handle,
        key,
        (await fixture.registry.recoverySource(groupID)).trust,
      )
      await fixture.installRows({
        key,
        trust,
        state: {
          ...previous,
          version: previous.version + 1,
          state: encodeClientState(handle.state),
          epoch: Number(handle.epoch),
          epochAuthenticator: handle.state.keySchedule.epochAuthenticator.slice(),
          credential: handle.credential,
          ledger: handle.ledgerTokens,
        },
      })
    }
    if (scenario !== 'imported') await install(earlier)
    await install(current)
    const entry = entryCapability(fixture.device.groups)
    if (entry === null) throw new Error('Missing roster coordinator')
    if (scenario === 'imported') {
      const { nextChange } = await import('./storage-seed.js')
      await fixture.device.groups.transition(
        await nextChange(fixture.device.groups, groupID, crypto.randomUUID()),
        async (stores) => {
          const canonical = s.retainedRosterFacts[0]
          if (canonical === undefined) throw new Error('Missing imported fact')
          await stores.checkpoints.put({
            kind: 'fact',
            id: 'imported-history',
            key,
            epoch: 0,
            canonical,
            supersededAt: null,
          })
        },
      )
    }
    const checkpoints = createCheckpointPort({
      registry: fixture.registry,
      key,
      identity: s.responder.identity,
    })
    const records = await entry.read(groupID, (reads) => reads.checkpoints())
    for (const record of records)
      if (record.kind === 'fact' && record.id !== 'imported-history')
        await checkpoints.signInstalled(record.id)
    const responder = await createRegistryGroupMLS({
      registry: fixture.registry,
      key,
      identity: s.responder.identity,
      entrySlot: createLedgerEntrySlot(),
      recovery: fixture.environment,
      target: { targetID: 'hub', topicID: 'commits' },
    })
    if (scenario === 'expired') {
      const captured = responder.capturedRecovery
      const seal = captured?.sealRosterAbsence
      if (captured === undefined || seal === undefined)
        throw new Error('Missing registry roster sealer')
      captured.sealRosterAbsence = async (...args) => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 604800001)
        try {
          return await seal(...args)
        } finally {
          clock.mockRestore()
        }
      }
    }
    const store = createTransactionalStore(s.requester.handle)
    const access = transactional
      ? (await createTransactionalAccess(s.requester, store)).access
      : persistedTestAccess(
          {
            handle: () => s.requester.handle,
            adopt: (next) => {
              s.requester.handle = next
            },
          },
          store,
        )
    const source = {
      key: { groupID, incarnation: 1 },
      stateVersion: 1,
      identity: null,
      lifetimeRevision: 1,
      trust: s.trust,
      trustDigest: recoveryTrustDigest(s.trust),
    }
    const requester = createGroupMLS({
      ...testGroupMLSDependencies(access, store.control),
      identity: s.requester.identity,
      entrySlot: s.requester.slot,
      recoveryAdoption: {
        target: { targetID: 'hub', topicID: 'commits' },
        environment: { identity: s.requester.identity, options: {} },
        readRecoverySource: async () => source,
        accept: async () => {
          throw new Error('Absence verification cannot adopt')
        },
      },
    })
    const saved = await requester.createRecoveryRequest('saved-rejoin')
    const captured = requester.capturedRecovery
    if (captured === undefined) throw new Error('Missing captured requester')
    const pending = await captured.applyRecovery(
      await sealCapturedGroupInfo({
        group: s.earlierGroup,
        identity: s.responder.identity,
        request: new TextDecoder().decode(saved.request),
        captureHead: null,
      }),
      'saved-rejoin',
      saved.requestKey,
    )
    if (pending === null || 'renewalRequired' in pending) throw new Error('Missing saved rejoin')
    await store.control.apply(
      { putRejoin: capturedRecord(pending, saved.request, saved.requestKey, 'saved-rejoin') },
      'save-rejoin',
    )
    return {
      requester,
      responder,
      epoch: Number(current.epoch),
      requesterDID: s.requester.identity.id,
      responderDID: s.responder.identity.id,
      async refuseResponder(reason) {
        await fixture.installRows({
          key,
          control:
            reason === 'fork-halted'
              ? {
                  forkHalt: {
                    eventID: JSON.stringify(['group:fork', groupID, 1]),
                    detectedAt: 1,
                    evidence: {
                      kind: 'unexplained-own-commit',
                      epoch: 2,
                      position: 'head',
                      digest: 'conflict',
                    },
                  },
                }
              : {
                  cursor: {
                    position: null,
                    epoch: reason === 'epoch-mismatch' ? 1 : 2,
                    ...(reason === 'stranded' ? { stranded: true as const } : {}),
                    ...(reason === 'incomplete' ? { incomplete: true as const } : {}),
                  },
                },
        })
      },
      comparisonEpoch: async (request) =>
        (await verifyRecoveryRequest(new TextDecoder().decode(request))).comparisonEpoch,
      invalidateSigner() {
        s.trust.signerTree = s.trust.signerTree.map((node) =>
          node?.nodeType === 1 &&
          node.leaf.signaturePublicKey.every(
            (byte, index) => byte === s.responder.identity.publicKey[index],
          )
            ? undefined
            : node,
        )
        source.trustDigest = recoveryTrustDigest(s.trust)
      },
      snapshot: async () => ({
        attempt: store.snapshot().control.rejoin,
        state: { row: store.snapshot(), source: structuredClone(source) },
      }),
      close: () => fixture.close(),
    }
  } catch (error) {
    await fixture.close()
    throw error
  }
}
