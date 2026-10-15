import type { OwnIdentity } from '@kokuin/token'
import * as Mls from '@kumiai/mls'
import {
  type ControllerBinding,
  createGroup,
  type GroupHandle,
  sealCapturedGroupInfo,
  sealRecoveryVerdict,
  verifyRecoveryRequest,
} from '@kumiai/mls'
import { expect, test, vi } from 'vitest'

import * as recovery from '../src/recovery.js'
import { recoveryTrustFor } from '../src/registry/trust.js'

const lifecycle = (await import(
  new URL('../../mls/test/fixtures/lifecycle-ledger.ts', import.meta.url).href
)) as {
  agent(byte: number): OwnIdentity
  bindingFor(identity: OwnIdentity): Promise<ControllerBinding>
}

async function fixture() {
  const identity = lifecycle.agent(43)
  const { group } = await createGroup(identity, 'retained-recovery', {
    controller: await lifecycle.bindingFor(identity),
  })
  const trust = recoveryTrustFor(group, { groupID: group.groupID, incarnation: 1 }, null)
  return { identity, group, trust }
}

test('retained trust requests are UTF-8 and captured replies authenticate without private state', async () => {
  const { identity, group, trust } = await fixture()
  const held = await recovery.createRecoveryRequestFromTrust({
    trust,
    identity,
    requestID: 'retained',
  })
  expect(held.request).toBeInstanceOf(Uint8Array)
  const request = new TextDecoder().decode(held.request)
  expect((await verifyRecoveryRequest(request)).requestID).toBe('retained')
  const sealed = await sealCapturedGroupInfo({ group, identity, request, captureHead: 'captured' })
  const params = { trust, sealed, requestID: 'retained', requestKey: held.requestKey, options: {} }
  const reply = await recovery.authenticateRecoveryReply(params)
  expect(reply?.captureHead).toBe('captured')
  expect(reply?.groupInfoAuthenticator).toEqual(group.state.keySchedule.epochAuthenticator)
  const verdict = {
    groupID: group.groupID,
    requestID: 'retained',
    position: 'position',
    commitDigest: 'commit',
    verdict: 'refused' as const,
    reason: 'policy' as const,
  }
  expect(
    await recovery.openRecoveryVerdictFromTrust({
      ...params,
      sealed: await sealRecoveryVerdict({ group, identity, request, verdict }),
    }),
  ).toEqual({ signer: identity.id, verdict })
  expect(
    await recovery.openRecoveryVerdictFromTrust({ ...params, sealed: new Uint8Array([0]) }),
  ).toBeNull()
})

for (const fault of ['provider', 'trusted-reader'] as const) {
  test(`retained verdict authentication preserves ${fault} errors`, async () => {
    const { identity, group, trust } = await fixture()
    const held = await recovery.createRecoveryRequestFromTrust({
      trust,
      identity,
      requestID: 'errors',
    })
    const sealed = await sealRecoveryVerdict({
      group,
      identity,
      request: new TextDecoder().decode(held.request),
      verdict: {
        groupID: group.groupID,
        requestID: 'errors',
        position: 'position',
        commitDigest: 'digest',
        verdict: 'superseded',
      },
    })
    const failure = new Error(`Retained ${fault} unavailable`)
    const params = { trust, sealed, requestID: 'errors', requestKey: held.requestKey, options: {} }
    if (fault === 'provider') {
      await expect(
        recovery.openRecoveryVerdictFromTrust({
          ...params,
          options: {
            cryptoProvider: {
              async getCiphersuiteImpl() {
                throw failure
              },
            },
          },
        }),
      ).rejects.toBe(failure)
    } else {
      await expect(
        recovery.openRecoveryVerdictFromTrust({
          ...params,
          trust: {
            ...trust,
            get registry(): typeof trust.registry {
              throw failure
            },
          },
        }),
      ).rejects.toBe(failure)
    }
  })
}

test('retained authentication refuses wrong group, anchor, binding, signer and floors', async () => {
  const { identity, group, trust } = await fixture()
  const held = await recovery.createRecoveryRequestFromTrust({
    trust,
    identity,
    requestID: 'checks',
  })
  const sealed = await sealCapturedGroupInfo({
    group,
    identity,
    request: new TextDecoder().decode(held.request),
    captureHead: null,
  })
  const params = { trust, sealed, requestID: 'checks', requestKey: held.requestKey, options: {} }
  const binding = trust.binding
  if (binding === null) throw new Error('Missing lifecycle binding')
  for (const changed of [
    { ...trust, groupID: 'other-group' },
    { ...trust, genesisAnchor: new Uint8Array() },
    { ...trust, binding: null },
    { ...trust, signerTree: [] },
    {
      ...trust,
      registry: {
        ...trust.registry,
        controllers: new Map([[binding.id, { recordedLog: [], genFloor: 100, timeFloor: 0 }]]),
      },
    },
  ]) {
    expect(await recovery.authenticateRecoveryReply({ ...params, trust: changed })).toBeNull()
  }
  expect(await recovery.authenticateRecoveryReply({ ...params, requestID: 'other' })).toBeNull()
})

async function capturedFixture() {
  const { createRealGroup, testHandleAccess, testGroupMLSDependencies } = await import(
    './fixtures/real-group.js'
  )
  const { createGroupMLS } = await import('../src/mls.js')
  const { recoveryTrustDigest } = await import('../src/recovery-trust-digest.js')
  const real = await createRealGroup(2, 'captured-port')
  const member = real.members[0]
  const responder = real.members[1]
  if (member === undefined || responder === undefined) throw new Error('Missing members')
  const trust = recoveryTrustFor(member.handle, { groupID: 'captured-port', incarnation: 1 }, null)
  const source = {
    key: { groupID: trust.groupID, incarnation: 1 },
    stateVersion: 4,
    lifetimeRevision: 2,
    identity: null,
    trust,
    trustDigest: recoveryTrustDigest(trust),
  }
  const access = testHandleAccess({
    handle: () => member.handle,
    adopt: () => {
      throw new Error('Ordinary adoption')
    },
  })
  access.read = async () => {
    throw new Error('Old private handle opened')
  }
  access.readControl = async () => {
    throw new Error('Old private handle opened')
  }
  const accepted: Array<unknown> = []
  const target = { targetID: 'hub', topicID: 'commits' }
  const environment = {
    identity: member.identity,
    options: {},
    accept: async (...args: Array<unknown>) => {
      accepted.push(args)
    },
  }
  const dependencies = testGroupMLSDependencies(access)
  const readSource = vi.fn(async () => source)
  const port = createGroupMLS({
    ...dependencies,
    identity: member.identity,
    entrySlot: member.slot,
    recoveryAdoption: {
      target,
      environment,
      readRecoverySource: readSource,
      accept: environment.accept,
    },
  })
  const requestID = 'attempt-X'
  const held = await port.createRecoveryRequest(requestID)
  const sealed = await sealCapturedGroupInfo({
    group: responder.handle,
    identity: responder.identity,
    request: new TextDecoder().decode(held.request),
    captureHead: 'head-X',
  })
  return {
    real,
    control: dependencies.control,
    readSource,
    member,
    responder,
    source,
    port,
    target,
    environment,
    accepted,
    requestID,
    sealed,
    ...held,
  }
}

test('captured preparation and restoration preserve attestation, origin, tuple and portable acceptance without old state', async () => {
  const s = await capturedFixture()
  expect(s.port.capturedRecovery).toBeDefined()
  const captured = s.port.capturedRecovery
  if (captured === undefined) throw new Error('Missing captured port')
  const pending = await captured.applyRecovery(s.sealed, s.requestID, s.requestKey)
  if (pending == null || 'renewalRequired' in pending)
    throw new Error('Expected captured candidate')
  const { decodeCapturedRecoveryCandidate } = await import('../src/recovery-codec.js')
  const { asLogPosition } = await import('@kumiai/rpc')
  expect(pending.source).toEqual(s.source)
  expect(pending.target).toEqual({
    ...s.target,
    captureHead: 'head-X',
    groupInfoEpoch: pending.epoch - 1,
    groupInfoAuthenticator: s.responder.handle.state.keySchedule.epochAuthenticator,
  })
  pending.source.trustDigest = 'mutated'
  pending.target.groupInfoAuthenticator.fill(0)
  const key = await pending.confirmationKey('position-X', 'digest-X')
  const bytes = pending.serialize()
  const snapshot = decodeCapturedRecoveryCandidate(bytes, s.requestKey)
  expect(snapshot.attestedReply).toEqual(s.sealed)
  expect(snapshot.source).toEqual(s.source)
  expect(snapshot.target.groupInfoAuthenticator).toEqual(
    s.responder.handle.state.keySchedule.epochAuthenticator,
  )
  const restored = await captured.restoreRecovery(bytes, s.requestKey)
  expect(restored.commit).toEqual(pending.commit)
  expect(await restored.confirmationKey('position-X', 'digest-X')).toEqual(key)
  await expect(restored.confirmationKey('other', 'digest-X')).rejects.toThrow('bound')
  const proof = {
    ...restored.target,
    position: asLogPosition('position-X'),
    payloadDigest: 'payload',
    verdict: new Uint8Array([1]),
  }
  const write = () => ({ mutationID: 'switch', changes: {} })
  await expect(restored.onAccepted({ ...s.source, trust: {} }, proof, write)).rejects.toThrow()
  expect(s.accepted).toHaveLength(0)
  await restored.onAccepted(s.source, proof, write)
  expect(s.accepted).toHaveLength(1)
})

test('captured recapture authenticates and classifies saved X without another build or private state', async () => {
  const s = await capturedFixture()
  expect(s.port.capturedRecovery).toBeDefined()
  const captured = s.port.capturedRecovery
  if (captured === undefined) throw new Error('Missing captured port')
  const builds = vi.spyOn(Mls, 'joinGroupExternal')
  const pending = await captured.applyRecovery(s.sealed, s.requestID, s.requestKey)
  if (pending == null || 'renewalRequired' in pending)
    throw new Error('Expected captured candidate')
  const {
    asLogPosition,
    digestAppliedCommit,
    encodeCommitFrame,
    encodeHandshakeFrame,
    HANDSHAKE_KIND,
  } = await import('@kumiai/rpc')
  const payload = encodeHandshakeFrame(
    HANDSHAKE_KIND.commit,
    encodeCommitFrame(pending.commit, new Uint8Array()),
  )
  const record = {
    format: 2 as const,
    id: 'X',
    publishID: 'X',
    stage: 'built' as const,
    source: pending.source,
    target: pending.target,
    captureHead: pending.target.captureHead,
    searchFrom: pending.target.captureHead,
    expectedHead: pending.target.captureHead,
    trigger: 'automatic' as const,
    authorisationID: null,
    switchMutationID: null,
    destinationKey: null,
    payload,
    payloadDigest: digestAppliedCommit(payload),
    digest: digestAppliedCommit(pending.commit),
    requestID: s.requestID,
    request: s.request,
    requestKey: s.requestKey,
    candidate: pending.serialize(),
    epochAfter: pending.epoch,
    ledgerBefore: [],
  }
  const before = record.candidate.slice()
  const fresh = await s.port.createRecoveryRequest('fresh')
  const sealed = await sealCapturedGroupInfo({
    group: s.responder.handle,
    identity: s.responder.identity,
    request: new TextDecoder().decode(fresh.request),
    captureHead: 'lower',
  })
  const recapture = { sealed, requestID: 'fresh', requestKey: fresh.requestKey, epochFloor: null }
  expect(await captured.reconcileCapture(record, recapture)).toEqual({
    kind: 'head-only',
    head: asLogPosition('lower'),
  })
  expect(
    await captured.reconcileCapture(record, { ...recapture, epochFloor: pending.epoch }),
  ).toEqual({ kind: 'retry' })
  expect(await captured.reconcileCapture(record, { ...recapture, requestID: 'wrong' })).toEqual({
    kind: 'retry',
  })
  expect(
    await captured.reconcileCapture(
      { ...record, target: { ...record.target, topicID: 'wrong' } },
      recapture,
    ),
  ).toEqual({ kind: 'retry' })
  await s.responder.handle.processMessage(pending.commit)
  const later = await sealCapturedGroupInfo({
    group: s.responder.handle,
    identity: s.responder.identity,
    request: new TextDecoder().decode(fresh.request),
    captureHead: null,
  })
  const result = await captured.reconcileCapture(record, { ...recapture, sealed: later })
  expect(result).toMatchObject({ kind: 'accepted', epoch: pending.epoch })
  if (result.kind === 'accepted') expect(result.leafDigest).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(builds).toHaveBeenCalledTimes(1)
  builds.mockRestore()
  expect(record.candidate).toEqual(before)
  expect(record.requestKey).toEqual(s.requestKey)
})

test('factories bind source, owner and attested bytes before restoring and reject a forged tuple', async () => {
  const s = await capturedFixture()
  const { buildRecoveryCandidate, restoreRecoveryCandidate } = recovery
  const { decodeCapturedRecoveryCandidate, encodeCapturedRecoveryCandidate } = await import(
    '../src/recovery-codec.js'
  )
  const pending = await buildRecoveryCandidate({ ...s, environment: s.environment })
  if (pending === null || 'renewalRequired' in pending) throw new Error('Expected candidate')
  const bytes = pending.serialize()
  const snapshot = decodeCapturedRecoveryCandidate(bytes, s.requestKey)
  const restore = (candidate: Uint8Array) =>
    restoreRecoveryCandidate({
      source: s.source,
      candidate,
      requestKey: s.requestKey,
      environment: s.environment,
    })
  await expect(
    restore(
      encodeCapturedRecoveryCandidate(
        { ...snapshot, attestedReply: new Uint8Array([1]) },
        s.requestKey,
      ),
    ),
  ).rejects.toThrow('attestation')
  await expect(
    restoreRecoveryCandidate({
      source: s.source,
      candidate: bytes,
      requestKey: s.requestKey,
      environment: { ...s.environment, identity: s.responder.identity },
    }),
  ).rejects.toThrow('environment')
  await expect(
    restore(
      encodeCapturedRecoveryCandidate(
        { ...snapshot, boundCommit: { position: 'p', commitDigest: 'd', tag: 'forged' } },
        s.requestKey,
      ),
    ),
  ).rejects.toThrow('tag')
})

test.each([
  'authenticator',
  'other fresh leaf',
  'later absent',
  'applied then removed',
  'group',
  'origin',
  'held',
  'missing trust',
  'transient',
  'control transient',
] as const)('recapture classifies authenticated state without building: %s', async (row) => {
  const s = await capturedFixture()
  const captured = s.port.capturedRecovery
  if (captured === undefined) throw new Error('Missing captured port')
  const pending = await captured.applyRecovery(s.sealed, s.requestID, s.requestKey)
  if (pending === null || 'renewalRequired' in pending) throw new Error('Missing candidate')
  const { capturedRecord } = await import('./fixtures/captured-recovery.js')
  const record = capturedRecord(pending, s.request, s.requestKey, s.requestID)
  const before = record.candidate.slice()
  let responder = s.responder.handle
  let requestTrust = s.source.trust
  let expected: { kind: string; epoch?: number } = { kind: 'retry' }
  if (row === 'authenticator') {
    responder = await Mls.restoreGroup({
      state: Mls.decodeClientState(Mls.encodeClientState(responder.state)) ?? responder.state,
      credential: responder.credential,
      ledgerEntries: responder.ledgerTokens,
    })
    responder.state.keySchedule.epochAuthenticator.fill(0)
  }
  if (row === 'other fresh leaf') {
    const other = await captured.applyRecovery(s.sealed, s.requestID, s.requestKey)
    if (other === null || 'renewalRequired' in other) throw new Error('Missing other candidate')
    expect(other.commit).not.toEqual(pending.commit)
    await responder.processMessage(other.commit)
    expected = { kind: 'unapplied-later', epoch: pending.epoch }
  }
  if (row === 'later absent') {
    responder = (await Mls.commitKeyRotation(responder)).newGroup
    expected = { kind: 'unapplied-later', epoch: pending.epoch }
  }
  if (row === 'applied then removed') {
    await responder.processMessage(pending.commit)
    await s.real.committer.handle.processMessage(pending.commit)
    const index = s.real.committer.handle.findMemberLeafIndex(s.member.identity.id)
    if (index === undefined) throw new Error('Missing recovered member')
    const removed = await Mls.removeMember(s.real.committer.handle, index)
    await responder.processMessage(removed.commitMessage)
    expected = { kind: 'unapplied-later', epoch: pending.epoch + 1 }
  }
  if (row === 'group') {
    const { createRealGroup } = await import('./fixtures/real-group.js')
    const other = await createRealGroup(2, 'different-capture-group', [
      s.member.identity,
      s.responder.identity,
    ])
    const member = other.members[1]
    const requester = other.members[0]
    if (member === undefined || requester === undefined) throw new Error('Missing other responder')
    responder = member.handle
    requestTrust = recoveryTrustFor(
      requester.handle,
      { groupID: responder.groupID, incarnation: 1 },
      null,
    )
  }
  const fresh = await recovery.createRecoveryRequestFromTrust({
    trust: requestTrust,
    identity: s.member.identity,
    requestID: 'recapture',
  })
  // A member can attest post-removal public state despite the normal responder's membership policy.
  const originalFind = responder.findMemberLeafIndex
  if (row === 'applied then removed')
    responder.findMemberLeafIndex = (did) => (did === s.member.identity.id ? 0 : originalFind(did))
  let sealed: Uint8Array
  try {
    sealed = await sealCapturedGroupInfo({
      group: responder,
      identity: s.responder.identity,
      request: new TextDecoder().decode(fresh.request),
      captureHead: null,
    })
  } finally {
    responder.findMemberLeafIndex = originalFind
  }
  if (row === 'origin')
    record.source = { ...record.source, stateVersion: record.source.stateVersion + 1 }
  if (row === 'held') {
    const { recoveryUnavailableEventID } = await import('@kumiai/rpc')
    await s.control.apply(
      {
        recoveryUnavailable: {
          ...s.control.key,
          id: recoveryUnavailableEventID(s.control.key),
          kind: 'group:recovery-unavailable',
          reason: 'trust-unreadable',
        },
      },
      'held-capture',
    )
    expected = { kind: 'held' }
  }
  if (row === 'missing trust') {
    const { GroupUnavailableError } = await import('../src/persistence-errors.js')
    s.readSource.mockRejectedValue(new GroupUnavailableError({ reason: 'recovery-unavailable' }))
    expected = { kind: 'held' }
  }
  if (row === 'transient')
    s.readSource.mockRejectedValue(new Error('Provider temporarily unavailable'))
  if (row === 'control transient')
    vi.spyOn(s.control, 'load').mockRejectedValue(new Error('Control temporarily unavailable'))
  const builds = vi.spyOn(Mls, 'joinGroupExternal')
  try {
    expect(
      await captured.reconcileCapture(record, {
        sealed,
        requestID: 'recapture',
        requestKey: fresh.requestKey,
        epochFloor: null,
      }),
    ).toEqual(expected)
    expect(builds).not.toHaveBeenCalled()
    expect(record.candidate).toEqual(before)
    expect(record.requestKey).toEqual(s.requestKey)
  } finally {
    builds.mockRestore()
  }
})

test.each(['built', 'restored'] as const)(
  'a refused captured binding is not reused by another attempt in the same environment: %s',
  async (kind) => {
    const s = await fixture()
    const { recoveryTrustDigest } = await import('../src/recovery-trust-digest.js')
    const other = lifecycle.agent(44)
    const bundle = await Mls.createKeyPackageBundle(other, {
      controller: await lifecycle.bindingFor(other),
    })
    const { invite } = await Mls.createInvite({
      group: s.group,
      identity: s.identity,
      recipientDID: other.id,
    })
    const group = (await Mls.commitInvite(s.group, bundle.publicPackage, invite)).newGroup
    const trust = recoveryTrustFor(group, { groupID: group.groupID, incarnation: 1 }, null)
    const source = {
      key: { groupID: trust.groupID, incarnation: 1 },
      stateVersion: 1,
      lifetimeRevision: 1,
      identity: trust.installed,
      trust: trust,
      trustDigest: recoveryTrustDigest(trust),
    }
    let asked = 0
    const environment = {
      identity: s.identity,
      options: {},
      accept: async () => {},
      recoveryBinding: async () => {
        asked++
        return null
      },
    }
    const held = await recovery.createRecoveryRequestFromTrust({
      trust: trust,
      identity: s.identity,
      requestID: 'binding',
    })
    const sealed = await sealCapturedGroupInfo({
      group,
      identity: s.identity,
      request: new TextDecoder().decode(held.request),
      captureHead: null,
    })
    const input = {
      source,
      sealed,
      requestID: 'binding',
      requestKey: held.requestKey,
      environment,
      target: { targetID: 'hub', topicID: 'topic' },
    }
    const first = await recovery.buildRecoveryCandidate(input)
    if (first === null || 'renewalRequired' in first) throw new Error('Expected bound candidate')
    const marked =
      kind === 'restored'
        ? await recovery.restoreRecoveryCandidate({
            source,
            candidate: first.serialize(),
            requestKey: held.requestKey,
            environment,
          })
        : first
    marked.markBindingUnusable()
    expect(await recovery.buildRecoveryCandidate(input)).toEqual({ renewalRequired: true })
    expect(asked).toBe(1)
  },
)

test.each(['empty', 'complete', 'partial', 'stale'] as const)(
  'controllerless captured switch accepts empty or complete ledgers and refuses others: %s',
  async (ledger) => {
    const s = await capturedFixture()
    const { createRegistryFixture, registryFixtureRestore } = await import('./fixtures/registry.js')
    const { createGroupHandleRegistry } = await import('../src/registry/registry.js')
    const fixture = await createRegistryFixture({
      identity: s.member.identity,
      mode: 'real-mls',
      setup: 'empty',
      groupID: s.source.key.groupID,
    })
    const owner = createGroupHandleRegistry({
      persistence: fixture.device,
      providerID: fixture.device.providerID,
      recovery: fixture.environment,
      restore: registryFixtureRestore(fixture),
      restoreCandidate: async () => {
        throw new Error('Unexpected candidate restoration')
      },
    })
    try {
      await fixture.installRows({
        key: s.source.key,
        trust: s.source.trust,
        state: {
          ...s.source.key,
          version: 1,
          deleted: false,
          terminal: false,
          epoch: Number(s.member.handle.epoch),
          epochAuthenticator: s.member.handle.state.keySchedule.epochAuthenticator,
          state: Mls.encodeClientState(s.member.handle.state),
          credential: s.member.handle.credential,
          ledger: s.member.handle.ledgerTokens,
          senderHWM: 0,
        },
      })
      Object.assign(s.source, await owner.recoverySource(s.source.key.groupID))
      const extra = lifecycle.agent(45)
      const bundle = await Mls.createKeyPackageBundle(extra)
      const { invite } = await Mls.createInvite({
        group: s.real.committer.handle,
        identity: s.real.committer.identity,
        recipientDID: extra.id,
        permission: 'member',
      })
      for (const token of invite.ledgerEntries)
        s.real.bodies.set(Mls.ledgerEntryDigest(token), token)
      const added = await Mls.commitInvite(s.real.committer.handle, bundle.publicPackage, invite)
      await s.responder.handle.processMessage(added.commitMessage)
      expect(s.source.trust.ledger).not.toEqual(s.responder.handle.ledgerTokens)
      const sealed = await sealCapturedGroupInfo({
        group: s.responder.handle,
        identity: s.responder.identity,
        request: new TextDecoder().decode(s.request),
        captureHead: 'advanced-head',
      })
      const captured = s.port.capturedRecovery
      if (captured === undefined) throw new Error('Missing captured port')
      const pending = await captured.applyRecovery(sealed, s.requestID, s.requestKey)
      if (pending === null || 'renewalRequired' in pending)
        throw new Error('Expected captured candidate')
      const {
        asLogPosition,
        digestAppliedCommit,
        encodeCommitFrame,
        encodeHandshakeFrame,
        HANDSHAKE_KIND,
      } = await import('@kumiai/rpc')
      const { confirmationTag } = await import('@kumiai/mls')
      const digest = digestAppliedCommit(pending.commit)
      const position = asLogPosition('accepted-X')
      const key = await pending.confirmationKey(position, digest)
      const verdict = await sealRecoveryVerdict({
        group: s.responder.handle,
        identity: s.responder.identity,
        request: new TextDecoder().decode(s.request),
        verdict: {
          groupID: s.source.key.groupID,
          requestID: s.requestID,
          position,
          commitDigest: digest,
          verdict: 'confirmed',
          epoch: pending.epoch,
          tag: confirmationTag(key, s.requestID),
        },
      })
      const payload = encodeHandshakeFrame(
        HANDSHAKE_KIND.commit,
        encodeCommitFrame(pending.commit, new Uint8Array()),
      )
      const record = {
        format: 2 as const,
        id: 'X',
        publishID: 'X',
        stage: 'confirmed' as const,
        source: pending.source,
        target: pending.target,
        captureHead: pending.target.captureHead,
        searchFrom: pending.target.captureHead,
        expectedHead: pending.target.captureHead,
        trigger: 'automatic' as const,
        authorisationID: null,
        switchMutationID: 'switch-X',
        destinationKey: null,
        payload,
        payloadDigest: digestAppliedCommit(payload),
        digest,
        requestID: s.requestID,
        request: s.request,
        requestKey: s.requestKey,
        candidate: pending.serialize(),
        epochAfter: pending.epoch,
        ledgerBefore: s.source.trust.ledger,
        position,
        verdict,
      }
      const proof = { ...pending.target, position, payloadDigest: record.payloadDigest, verdict }
      await pending.onAccepted(s.source, proof, () => ({ mutationID: 'switch-X', changes: {} }))
      const args = s.accepted[0] as [GroupHandle, unknown] | undefined
      if (args === undefined) throw new Error('Missing delegated candidate')
      expect(args[0].ledgerTokens).toEqual([])
      expect(await args[0].isLedgerComplete()).toBe(false)
      const tokens = s.responder.handle.ledgerTokens
      const selected =
        ledger === 'complete'
          ? tokens
          : ledger === 'partial'
            ? tokens.slice(1)
            : ledger === 'stale'
              ? s.source.trust.ledger
              : []
      const candidate = await Mls.restoreGroup({
        state: args[0].state,
        credential: args[0].credential,
        ledgerEntries: selected,
        options: fixture.environment.options,
      })
      await fixture.installRows({ key: s.source.key, control: { putRejoin: record } })
      const before = await fixture.inspectRows()
      let writes = 0
      fixture.onPhase('work', () => {
        writes++
      })
      const switched = owner.switchIncarnation(candidate, {
        source: await owner.recoverySource(s.source.key.groupID),
        rejoinID: record.id,
        proof,
        write: {
          mutationID: 'switch-X',
          source: { rejoinID: record.id },
          destination: { control: { cursor: { position, epoch: pending.epoch } } },
        },
      })
      if (ledger === 'partial' || ledger === 'stale') {
        await expect(switched).rejects.toMatchObject({ reason: 'candidate' })
        expect(writes).toBe(0)
        expect(await fixture.inspectRows()).toEqual(before)
        return
      }
      const destination = await switched
      expect(destination.incarnation).toBe(s.source.key.incarnation + 1)
      const access = await owner.access(s.source.key.groupID)
      expect(await access.read((handle) => handle.ledgerTokens)).toEqual(selected)
      if (ledger === 'empty') {
        const beforeBootstrap = await fixture.inspectRows()
        await expect(
          access.mutate(async (handle) => {
            await handle.bootstrapLedger(tokens.slice(1))
          }),
        ).rejects.toThrow()
        expect(await fixture.inspectRows()).toEqual(beforeBootstrap)
        await access.mutate(async (handle) => {
          await handle.bootstrapLedger(tokens)
        })
      }
      expect(await access.read((handle) => handle.isLedgerComplete())).toBe(true)
      expect(await access.read((handle) => handle.ledgerTokens)).toEqual(tokens)
      const saved = await fixture.device.groups.loadState(destination)
      if (saved === null || saved.deleted) throw new Error('Missing destination state')
      expect(saved.ledger).toEqual(tokens)
    } finally {
      await owner.dispose()
      await fixture.close()
    }
  },
)
