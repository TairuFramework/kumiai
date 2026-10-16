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
  decodeEpochCheckpoint,
  decodeEpochRosterFact,
  encodeClientState,
  encodeEpochCheckpoint,
  type GroupHandle,
  parseMLSCredentialIdentity,
  processWelcome,
  proposeSelfRemoval,
  restoreGroup,
  sealCapturedGroupInfo,
  sealRecoveryVerdict,
  verifyRecoveryRequest,
} from '@kumiai/mls'
import {
  asLogPosition,
  type CapturedPendingRecovery,
  type CapturedRejoinRecord,
  type CheckpointRecord,
  commitTopic,
  digestAppliedCommit,
  encodeCommitFrame,
  encodeHandshakeFrame,
  type ForkNotice,
  type ForkRecoveryAuthorisation,
  HANDSHAKE_KIND,
} from '@kumiai/rpc'
import type { RosterAbsenceFixture, RosterAbsenceScenario } from '@kumiai/rpc-conformance'
import { ed25519 } from '@noble/curves/ed25519.js'
import { vi } from 'vitest'

import { createCheckpointPort } from '../../src/checkpoint.js'
import { prepareCheckpointInstallation } from '../../src/checkpoint-capture.js'
import { provenCheckpointFacts } from '../../src/checkpoint-store.js'
import { entryCapability } from '../../src/entry-capability.js'
import { createGroupMLS, createLedgerEntrySlot } from '../../src/mls.js'
import { recoveryTrustDigest } from '../../src/recovery-trust-digest.js'
import { recoveryTrustFor } from '../../src/registry/trust.js'
import { registryOptions } from '../../src/registry/validation.js'
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

async function boundCapturedGroup(identity = randomIdentity()) {
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

export async function createCapturedFormerMember(present = false, identity?: OwnIdentity) {
  const real = await boundCapturedGroup(identity)
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

export async function createForkRecoveryRealFixture(
  transactional = false,
  params: { holes?: Array<number>; ownership?: 'supplied' | 'absent'; noticeEpoch?: number } = {},
) {
  const real = await boundCapturedGroup()
  const own = real.members[0]
  const peer = real.members[1]
  if (own === undefined || peer === undefined) throw new Error('Missing branch members')
  const clone = async (handle: GroupHandle) => {
    const state = decodeClientState(encodeClientState(handle.state))
    if (state === undefined) throw new Error('Missing branch state')
    return restoreGroup({
      state,
      credential: handle.credential,
      ledgerEntries: handle.ledgerTokens,
      options: registryOptions({}),
    })
  }
  while (Number(peer.handle.epoch) < 9) {
    const rotation = await commitKeyRotation(peer.handle)
    peer.handle = rotation.newGroup
    await own.handle.processMessage(rotation.commitMessage)
  }
  const groupID = own.handle.groupID
  const ownerDID = own.identity.id
  const ownerIdentity = own.identity
  const signerIdentity = peer.identity
  const responderSlot = peer.slot
  const makeRegistry = (identity: OwnIdentity) =>
    createRegistryFixture({
      mode: 'real-mls',
      setup: 'empty',
      groupID,
      identity,
      ownershipContext:
        params.ownership === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
    })
  let local = await makeRegistry(own.identity)
  const remote = await makeRegistry(peer.identity)
  const original = await makeRegistry(peer.identity)
  let key = await local.registry.seed(await clone(own.handle), {
    packageUse: { sourceID: 'fork', ref: 'local', kind: 'ordinary' },
  })
  const remoteKey = await remote.registry.seed(await clone(peer.handle), {
    packageUse: { sourceID: 'fork', ref: 'remote', kind: 'ordinary' },
  })
  const originalKey = await original.registry.seed(await clone(peer.handle), {
    packageUse: { sourceID: 'fork', ref: 'original', kind: 'ordinary' },
  })
  async function install(fixture: typeof local, key: typeof remoteKey, handle: GroupHandle) {
    const previous = await fixture.device.groups.loadState(key)
    if (previous === null || previous.deleted) throw new Error('Missing branch installation')
    await fixture.installRows({
      key,
      state: {
        ...previous,
        version: previous.version + 1,
        state: encodeClientState(handle.state),
        credential: handle.credential,
        ledger: handle.ledgerTokens,
        epoch: Number(handle.epoch),
        epochAuthenticator: handle.state.keySchedule.epochAuthenticator.slice(),
      },
      trust: recoveryTrustFor(handle, key, await fixture.device.groups.loadTrust(key.groupID)),
    })
  }
  const ownResponder = await clone(peer.handle)
  const ownHeads = new Map<number, GroupHandle>([[9, await clone(ownResponder)]])
  const otherHeads = new Map<number, GroupHandle>([[9, await clone(peer.handle)]])
  while (Number(own.handle.epoch) < 20) {
    const rotation = await commitKeyRotation(own.handle)
    own.handle = rotation.newGroup
    await ownResponder.processMessage(rotation.commitMessage)
    ownHeads.set(Number(ownResponder.epoch), await clone(ownResponder))
    if (!params.holes?.includes(Number(own.handle.epoch))) await install(local, key, own.handle)
    await install(original, originalKey, ownResponder)
  }
  while (Number(peer.handle.epoch) < 21) {
    peer.handle = (await commitKeyRotation(peer.handle)).newGroup
    otherHeads.set(Number(peer.handle.epoch), await clone(peer.handle))
    if (Number(peer.handle.epoch) <= 12) await install(remote, remoteKey, peer.handle)
  }
  const { createCheckpointService } = await import('../../src/checkpoint.js')
  const serviceFor = (fixture: typeof local, installedKey: typeof key) =>
    createCheckpointService({
      registry: fixture.registry,
      key: installedKey,
      identity: fixture.identity,
    })
  for (const [fixture, installedKey] of [
    [local, key],
    [remote, remoteKey],
    [original, originalKey],
  ] as const) {
    const service = serviceFor(fixture, installedKey)
    for (const row of await service.readRecords())
      if (row.kind === 'fact') await service.signInstalled(row.id)
  }
  const { deriveRecoverySecretFromTrust } = await import('../../src/recovery.js')
  const target = {
    targetID: 'repaired-hub',
    topicID: commitTopic(
      await deriveRecoverySecretFromTrust((await local.registry.recoverySource(groupID)).trust),
    ),
  }
  let builds = 0
  const makeMLS = async () => {
    if (transactional)
      return createRegistryGroupMLS({
        registry: local.registry,
        key,
        identity: own.identity,
        entrySlot: own.slot,
        recovery: local.environment,
        target,
      })
    const { createRegistryHandleAccess } = await import('../../src/registry-handle-access.js')
    const { registryRecoveryCoordinator } = await import(
      '../../src/registry/recovery-coordinator.js'
    )
    const { toRegistrySwitchWrite } = await import('../../src/registry/switch-write.js')
    const coordinator = registryRecoveryCoordinator(local.registry)
    const entry = entryCapability(local.device.groups)
    if (entry === null) throw new Error('Missing branch coordinator')
    const underlying = createRegistryHandleAccess({
      access: await local.registry.access(key.groupID),
    })
    let reading: Array<CheckpointRecord> = []
    const access = {
      ...underlying,
      readControl: <T>(fn: Parameters<typeof underlying.readControl<T>>[0]) =>
        underlying.readControl(async (scope) => {
          reading = (await scope.loadCheckpoints?.()) ?? []
          try {
            return await fn(scope)
          } finally {
            reading = []
          }
        }),
    }
    return createGroupMLS({
      access,
      readInstalledRecoveryLineage: async ({ comparisonEpoch, throughEpoch }) => {
        const facts = provenCheckpointFacts(reading, groupID)
          .filter(
            (fact) =>
              fact.key.incarnation === key.incarnation &&
              fact.epoch >= comparisonEpoch &&
              fact.epoch <= throughEpoch,
          )
          .sort((a, b) => a.epoch - b.epoch)
        return facts.flatMap((fact) =>
          reading.flatMap((row) =>
            row.kind === 'publication' && row.factID === fact.id && row.frame !== null
              ? [row.frame]
              : [],
          ),
        )
      },
      control: local.device.groups.ports(key).control,
      readRecoverySource: () => local.registry.recoverySource(key.groupID),
      identity: own.identity,
      entrySlot: own.slot,
      settleForkRecoveryCapture: (input) =>
        coordinator.settleForkRecoveryCapture(input, local.environment),
      authoriseForkRecovery: (reply, noticeID) =>
        coordinator.authoriseForkRecovery(key, reply, noticeID, local.environment),
      checkForkRecoveryCapture: (input) =>
        coordinator.checkForkRecoveryCapture(input, local.environment),
      recoveryAdoption: {
        target,
        environment: local.environment,
        readRecoverySource: () => local.registry.recoverySource(key.groupID),
        async accept(candidate, { source, proof, write }) {
          const record = (await local.device.groups.ports(key).control.load()).rejoin
          if (record === null || !('format' in record)) throw new Error('Missing branch record')
          const staged = {
            incarnation: key.incarnation + 1,
            epochAfter: Number(candidate.epoch),
            removed: false,
            epochAuthenticator: candidate.state.keySchedule.epochAuthenticator,
          }
          await local.registry.switchIncarnation(candidate, {
            source,
            proof,
            rejoinID: record.id,
            write: toRegistrySwitchWrite({ record, staged, write: write(staged) }),
          })
        },
      },
    })
  }
  let requester = await makeMLS()
  let service = serviceFor(local, key)
  const otherFrame = (
    await serviceFor(remote, remoteKey).exportCheckpoints(remoteKey, [params.noticeEpoch ?? 10])
  )[0]
  if (otherFrame === undefined) throw new Error('Missing other branch frame')
  await service.importCheckpoint(key, otherFrame)
  const notices = await service.forkNotices(key.groupID)
  const notice = notices.find((value) => value.closedAt === null)
  if (notice === undefined) throw new Error('Missing open branch notice')
  async function reply(epoch = 12, branch: 'own' | 'other' = 'other', legacy = false) {
    const requestID = crypto.randomUUID()
    const held = await requester.createRecoveryRequest(requestID, undefined, 10)
    const fixture = branch === 'other' ? remote : original
    const installedKey = branch === 'other' ? remoteKey : originalKey
    const handle = (branch === 'other' ? otherHeads : ownHeads).get(epoch)
    if (handle === undefined) throw new Error('Missing reply head')
    const state = await clone(handle)
    if (branch === 'other' || !legacy) {
      const current = await remote.device.groups.loadState(remoteKey)
      if (current === null || current.deleted) throw new Error('Missing responder')
      for (let next = current.epoch + 1; next <= epoch; next++) {
        const head = otherHeads.get(next)
        if (head === undefined) throw new Error('Missing continuation head')
        await install(remote, remoteKey, await clone(head))
      }
      const signing = serviceFor(remote, remoteKey)
      for (const row of await signing.readRecords())
        if (row.kind === 'fact') await signing.signInstalled(row.id)
    }
    const records = await serviceFor(fixture, installedKey).readRecords()
    let lineage = records
      .flatMap((row) => (row.kind === 'publication' && row.frame !== null ? [row.frame] : []))
      .filter((frame) => {
        const body = decodeEpochCheckpoint(frame).body
        return body.epoch >= 10 && body.epoch <= epoch
      })
      .sort((a, b) => decodeEpochCheckpoint(a).body.epoch - decodeEpochCheckpoint(b).body.epoch)
    if (branch === 'own' && !legacy) {
      const ownEnd = lineage.map(decodeEpochCheckpoint).find(({ body }) => body.epoch === epoch)
      const otherFrames = await serviceFor(remote, remoteKey).exportCheckpoints(remoteKey)
      lineage = otherFrames
        .filter((frame) => {
          const body = decodeEpochCheckpoint(frame).body
          return body.epoch >= 10 && body.epoch <= epoch
        })
        .sort((a, b) => decodeEpochCheckpoint(a).body.epoch - decodeEpochCheckpoint(b).body.epoch)
      const last = lineage.at(-1)
      if (ownEnd !== undefined && last !== undefined) {
        const body = { ...decodeEpochCheckpoint(last).body, authHash: ownEnd.body.authHash }
        lineage[lineage.length - 1] = encodeEpochCheckpoint(
          body,
          ed25519.sign(checkpointSignatureInput(body), signerIdentity.privateKey),
        )
      }
    }
    const installedRemote = await remote.device.groups.loadState(remoteKey)
    let sealed: Uint8Array
    if (
      !legacy &&
      branch === 'other' &&
      installedRemote !== null &&
      !installedRemote.deleted &&
      installedRemote.epoch === epoch
    ) {
      const responder = await createRegistryGroupMLS({
        registry: remote.registry,
        key: remoteKey,
        identity: signerIdentity,
        entrySlot: responderSlot,
        recovery: remote.environment,
        target,
      })
      const captured = responder.capturedRecovery
      if (captured === undefined) throw new Error('Missing real responder')
      sealed = await captured.sealGroupInfo(held.request, null)
    } else
      sealed = await sealCapturedGroupInfo({
        group: state,
        identity: signerIdentity,
        request: new TextDecoder().decode(held.request),
        captureHead: null,
        ...(legacy ? {} : { lineage }),
      })
    return { sealed, requestID, requestKey: held.requestKey, request: held.request, epochFloor: 20 }
  }
  return {
    get key() {
      return { ...key }
    },
    noticeID: notice.id,
    target,
    remote: () => remote,
    ownerIdentity: own.identity,
    responderIdentity: signerIdentity,
    requester: () => requester,
    local: () => local,
    service: () => service,
    builds: () => builds,
    reply,
    async inspect(capture: Awaited<ReturnType<typeof reply>>) {
      const { authenticateRecoveryReply } = await import('../../src/recovery.js')
      return authenticateRecoveryReply({
        ...capture,
        trust: (await local.registry.recoverySource(key.groupID)).trust,
        options: local.environment.options,
      })
    },
    async rewriteNotice(update: (notice: ForkNotice) => void) {
      const entry = entryCapability(local.device.groups)
      if (entry === null) throw new Error('Missing notice entry')
      const mutationID = crypto.randomUUID()
      await entry.run(
        { groupID, mutationID },
        async (reads) => {
          const row = (await reads.checkpoints()).find(
            (row) => row.kind === 'notice' && row.id === notice.id,
          )
          if (row?.kind !== 'notice') throw new Error('Missing notice')
          update(row.notice)
          return { expected: await reads.lifetime(), value: row }
        },
        async (stores, row) => {
          await stores.checkpoints.put(row)
        },
      )
    },
    async equivocationOnly() {
      const remoteFrame = (
        await serviceFor(remote, remoteKey).exportCheckpoints(remoteKey, [10])
      )[0]
      const localFact = await service.checkpointFact(key, 10)
      if (remoteFrame === undefined || localFact === null)
        throw new Error('Missing equivocation inputs')
      const member = decodeEpochRosterFact(localFact).members.find(
        (member) => member.signerDID === ownerDID,
      )
      if (member === undefined) throw new Error('Missing installed owner')
      const body = {
        ...decodeEpochCheckpoint(remoteFrame).body,
        keyHash: member.keyHash,
        leafIndex: member.leafIndex,
      }
      await service.importCheckpoint(
        key,
        encodeEpochCheckpoint(
          body,
          ed25519.sign(checkpointSignatureInput(body), ownerIdentity.privateKey),
        ),
      )
      const entry = entryCapability(local.device.groups)
      if (entry === null) throw new Error('Missing notice entry')
      const mutationID = crypto.randomUUID()
      await entry.run(
        { groupID, mutationID },
        async (reads) => {
          const row = (await reads.checkpoints()).find(
            (row) => row.kind === 'notice' && row.id === notice.id,
          )
          if (row?.kind !== 'notice') throw new Error('Missing notice')
          for (const branch of row.notice.branches)
            branch.signers = branch.signers.filter((signer) => signer.signerDID === ownerDID)
          row.notice.equivocations = []
          return { expected: await reads.lifetime(), value: row }
        },
        async (stores, row) => {
          await stores.checkpoints.put(row)
        },
      )
    },
    async moveNoticeEarlier() {
      const frame = (await serviceFor(remote, remoteKey).exportCheckpoints(remoteKey, [10]))[0]
      const fact = await service.checkpointFact(key, 10)
      const prior = await service.checkpointFact(key, 9)
      if (frame === undefined || fact === null || prior === null)
        throw new Error('Missing earlier split inputs')
      const remoteHash = decodeEpochCheckpoint(frame).body.authHash
      const localHash = decodeEpochRosterFact(fact).authHash
      const entry = entryCapability(local.device.groups)
      if (entry === null) throw new Error('Missing notice entry')
      const mutationID = crypto.randomUUID()
      await entry.run(
        { groupID, mutationID },
        async (reads) => {
          const row = (await reads.checkpoints()).find(
            (row) => row.kind === 'notice' && row.id === notice.id,
          )
          if (row?.kind !== 'notice') throw new Error('Missing notice')
          row.notice.splitEpoch = 10
          row.notice.deviceAuthHash = localHash
          for (const branch of row.notice.branches)
            branch.authHash = branch.signers.some(
              (member) => member.signerDID === signerIdentity.id,
            )
              ? remoteHash
              : localHash
          return { expected: await reads.lifetime(), value: row }
        },
        async (stores, row) => {
          await stores.checkpoints.put(row)
          await stores.checkpoints.put({
            kind: 'evidence',
            id: 'earlier-split-evidence',
            key,
            noticeID: notice.id,
            first: frame,
            second: frame,
            localRosterFact: fact,
            eligibilityRosterFact: prior,
          })
        },
      )
    },
    async importEarlier() {
      const frame = (await serviceFor(remote, remoteKey).exportCheckpoints(remoteKey, [10]))[0]
      if (frame === undefined) throw new Error('Missing earlier witness')
      await service.importCheckpoint(key, frame)
    },
    async seedOwnY(authority: ForkRecoveryAuthorisation, stage: 'built' | 'published') {
      const capture = await reply(13, 'own')
      const { buildRecoveryCandidate } = await import('../../src/recovery.js')
      const pending = await buildRecoveryCandidate({
        ...capture,
        source: await local.registry.recoverySource(groupID),
        target,
        environment: {
          ...local.environment,
          accept: async () => {
            throw new Error('Invalid branch cannot install')
          },
        },
      })
      if (pending === null || 'renewalRequired' in pending)
        throw new Error('Missing hostile saved capture')
      const record = {
        ...capturedRecord(pending, capture.request, capture.requestKey, capture.requestID),
        id: authority.attemptID,
        forkRecovery: authority,
        stage,
        ...(stage === 'published' ? { position: asLogPosition('001') } : {}),
      }
      await local.installRows({ key, control: { putRejoin: record } })
      return record
    },
    async expireEvidence() {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 604800000)
      try {
        await local.installRows({ key, control: {} })
        await service.readRecords()
      } finally {
        clock.mockRestore()
      }
    },
    snapshot: () => local.device.groups.ports(key).control.load(),
    async ordinaryWrite(kind: 'delete' | 'unrelated' | 'wrong-source') {
      const control = local.device.groups.ports(key).control
      const record = (await control.load()).rejoin
      if (record === null || !('format' in record)) throw new Error('Missing bound Y')
      await control.apply(
        kind === 'delete'
          ? { deleteRejoin: true }
          : {
              putRejoin:
                kind === 'unrelated'
                  ? { ...record, id: 'unrelated-Z', forkRecovery: undefined }
                  : {
                      ...record,
                      source: {
                        ...record.source,
                        key: {
                          ...record.source.key,
                          incarnation: record.source.key.incarnation + 1,
                        },
                      },
                    },
            },
        crypto.randomUUID(),
      )
    },

    async saveX(stage: 'built' | 'published' | 'confirmed' | 'adopted' = 'built') {
      const capture = await reply(20, 'own', true)
      const pending = await requester.capturedRecovery?.applyRecovery(
        capture.sealed,
        capture.requestID,
        capture.requestKey,
      )
      if (pending == null || 'renewalRequired' in pending) throw new Error('Missing saved X')
      const record = capturedRecord(pending, capture.request, capture.requestKey, capture.requestID)
      record.ledgerBefore = ['owed-X', 'shared']
      if (stage !== 'built') {
        record.stage = stage === 'adopted' ? 'confirmed' : stage
        record.position = '001' as typeof record.position
      }
      if (stage === 'confirmed' || stage === 'adopted') {
        await pending.confirmationKey('001', record.digest)
        record.candidate = pending.serialize()
        const ownHead = ownHeads.get(20)
        if (ownHead === undefined) throw new Error('Missing own head')
        const confirming = await clone(ownHead)
        await confirming.processMessage(pending.commit)
        const confirmation = await pending.confirmationKey('001', record.digest)
        record.verdict = await sealRecoveryVerdict({
          group: confirming,
          identity: signerIdentity,
          request: new TextDecoder().decode(capture.request),
          verdict: {
            groupID,
            requestID: capture.requestID,
            position: '001',
            commitDigest: record.digest,
            verdict: 'confirmed',
            epoch: pending.epoch,
            tag: confirmationTag(confirmation, capture.requestID),
          },
        })
        record.switchMutationID = crypto.randomUUID()
      }
      await local.installRows({ key, control: { putRejoin: record, recoveryEpochFloor: 20 } })
      const sourceKey = { ...key }
      if (stage === 'adopted') {
        if (record.verdict === undefined) throw new Error('Missing confirmed X verdict')
        const { createRecoverySwitchFactory } = await import('../../src/registry/switch-write.js')
        await pending.onAccepted(
          await local.registry.recoverySource(groupID),
          {
            ...record.target,
            position: asLogPosition('001'),
            payloadDigest: record.payloadDigest,
            verdict: record.verdict,
          },
          createRecoverySwitchFactory(record),
        )
        key = (await local.registry.recoverySource(groupID)).key
        requester = await makeMLS()
        service = serviceFor(local, key)
      }
      const saved = (await local.device.groups.ports(sourceKey).control.load()).rejoin
      if (saved === null || !('format' in saved)) throw new Error('Missing saved branch record')
      return saved
    },
    async installY(
      y: { record: CapturedRejoinRecord; pending: CapturedPendingRecovery },
      publish?: (record: CapturedRejoinRecord) => Promise<string>,
    ) {
      const { record, pending } = y
      const position = asLogPosition((await publish?.(record)) ?? 'repair-position')
      const responder = await createRegistryGroupMLS({
        registry: remote.registry,
        key: remoteKey,
        identity: signerIdentity,
        entrySlot: responderSlot,
        recovery: remote.environment,
        target,
      })
      const applied = await responder.processCommit(pending.commit, { senderDID: ownerDID })
      if (!applied.advanced) throw new Error('Repaired hub refused external commit')
      const confirmation = await pending.confirmationKey(position, record.digest)
      const verdict = await responder.sealRecoveryVerdict(record.request, {
        groupID,
        requestID: record.requestID,
        position,
        commitDigest: record.digest,
        verdict: 'confirmed',
        epoch: pending.epoch,
        tag: confirmationTag(confirmation, record.requestID),
      })
      const confirmed: CapturedRejoinRecord = {
        ...record,
        stage: 'confirmed',
        position,
        verdict,
        candidate: pending.serialize(),
        switchMutationID: crypto.randomUUID(),
      }
      await local.installRows({ key, control: { putRejoin: confirmed } })
      const { createRecoverySwitchFactory } = await import('../../src/registry/switch-write.js')
      await pending.onAccepted(
        await local.registry.recoverySource(groupID),
        { ...record.target, position, payloadDigest: record.payloadDigest, verdict },
        createRecoverySwitchFactory(confirmed),
      )
      const sourceKey = { ...key }
      key = (await local.registry.recoverySource(groupID)).key
      return {
        sourceKey,
        destination: { ...key },
        applied,
        responderEpoch: responder.sendAdmission().epoch,
        ordinaryFloor: (await local.device.groups.ports(sourceKey).control.load())
          .recoveryEpochFloor,
      }
    },
    async build(
      authorisation: ForkRecoveryAuthorisation,
      capture: Awaited<ReturnType<typeof reply>>,
    ) {
      const pending = await requester.capturedRecovery?.applyRecovery(
        capture.sealed,
        capture.requestID,
        capture.requestKey,
      )
      if (pending == null || 'renewalRequired' in pending) return null
      builds++
      const record = {
        ...capturedRecord(pending, capture.request, capture.requestKey, capture.requestID),
        id: authorisation.attemptID,
        forkRecovery: authorisation,
        ledgerBefore: (await local.device.groups.ports(key).control.load()).settledRejoins.flatMap(
          (row) => row.ledgerBefore,
        ),
      }
      await local.installRows({ key, control: { putRejoin: record } })
      return { record, pending }
    },
    async restart() {
      const reopened = await local.reopen()
      local = reopened
      requester = await makeMLS()
      service = serviceFor(local, key)
    },
    async close() {
      await local.close()
      await remote.close()
      await original.close()
    },
  }
}
