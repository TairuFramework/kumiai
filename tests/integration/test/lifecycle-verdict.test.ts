import type { OwnIdentity } from '@kokuin/token'
import {
  type ControllerBinding,
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  type DeviceRegistry,
  GroupHandle,
  processWelcome,
  recoverySignerEligible,
  registrySeed,
  revokeWithProof,
} from '@kumiai/mls'
import { createGroupMLS, createLedgerEntrySlot, simpleHandleAccess } from '@kumiai/mls-rpc'
import { afterEach, expect, test, vi } from 'vitest'

const fixture = (await import(
  new URL('../../../packages/mls/test/fixtures/lifecycle-pipeline.ts', import.meta.url).href
)) as {
  agent: (byte: number) => OwnIdentity
  controllerID: string
  lowLevelExternal: (params: {
    group: GroupHandle
    identity: OwnIdentity
    binding?: ControllerBinding
    resync?: boolean
  }) => Promise<Uint8Array>
  timedBinding: (params: {
    identity: OwnIdentity
    iat: number
    exp: number

    parent?: string
    issuer?: OwnIdentity
  }) => Promise<ControllerBinding>
}
afterEach(() => vi.restoreAllMocks())

async function setup(
  options: { parent?: string; issuer?: OwnIdentity; standard?: boolean; policy?: boolean } = {},
) {
  vi.spyOn(Date, 'now').mockReturnValue(150_000)
  const identity = fixture.agent(41)
  let group = (
    await createGroup(identity, 'lifecycle-verdict', {
      ...(options.standard
        ? {}
        : { controller: await fixture.timedBinding({ identity: identity, iat: 100, exp: 200 }) }),
    })
  ).group
  const bob = fixture.agent(61)
  const bundle = await createKeyPackageBundle(bob, {
    controller: await fixture.timedBinding({ identity: bob, iat: 100, exp: 200, ...options }),
  })
  const { invite } = await createInvite({
    group,
    identity,
    recipientDID: bob.id,
    ...(options.standard ? { permission: 'member' } : {}),
  })
  const added = await commitInvite(group, bundle.publicPackage, invite)
  group = added.newGroup
  const responderGroup = (
    await processWelcome({
      identity: bob,
      invite,
      welcome: added.welcomeMessage,
      keyPackageBundle: bundle,
    })
  ).group
  const responder = createGroupMLS({
    identity: bob,
    entrySlot: createLedgerEntrySlot(),
    access: simpleHandleAccess({
      handle: () => responderGroup,
      adopt: () => {
        throw new Error('Unexpected adoption')
      },
    }),
  })
  const mls = createGroupMLS({
    identity,
    entrySlot: createLedgerEntrySlot(),
    access: simpleHandleAccess({
      handle: () => group,
      adopt: (next: GroupHandle) => {
        group = next
      },
    }),
  })
  return { identity, mls, responder, responderGroup, bob, group: () => group }
}

test('known revocations, floors, lapse and absent pending leaves cannot authorise verdicts', async () => {
  const s = await setup()
  const known = {
    devices: new Map(registrySeed().devices),
    controllers: new Map(registrySeed().controllers),
  }
  expect(
    recoverySignerEligible({ group: s.group(), known: known, signer: s.identity.id, now: 500 }),
  ).toBe(true)
  expect(
    recoverySignerEligible({ group: s.group(), known: known, signer: s.identity.id, now: 500.001 }),
  ).toBe(false)
  expect(
    recoverySignerEligible({
      group: s.group(),
      known: known,
      signer: fixture.agent(81).id,
      now: 150,
    }),
  ).toBe(false)
  known.controllers.set(fixture.controllerID, { recordedLog: [], genFloor: 1, timeFloor: 0 })
  expect(
    recoverySignerEligible({ group: s.group(), known: known, signer: s.identity.id, now: 150 }),
  ).toBe(false)
  known.controllers.set(fixture.controllerID, { recordedLog: [], genFloor: 0, timeFloor: 201 })
  expect(
    recoverySignerEligible({ group: s.group(), known: known, signer: s.identity.id, now: 150 }),
  ).toBe(false)
  known.devices.set(s.identity.id, {
    controller: fixture.controllerID,
    status: 'revoked',
    logPosition: 1,
  })
  expect(
    recoverySignerEligible({ group: s.group(), known: known, signer: s.identity.id, now: 150 }),
  ).toBe(false)
})

test('pending verdicts bind the epoch, position, digest and tag, and adoption is idempotent', async () => {
  const s = await setup()
  const requestID = 'verdict-request'
  const request = await s.mls.createRecoveryRequest(requestID)
  const pending = await s.mls.applyRecovery(await s.responder.sealGroupInfo(request), requestID)
  if (pending == null || 'renewalRequired' in pending) throw new Error('No pending recovery')
  const before = await s.mls.readEpoch()
  const key = await pending.confirmationKey('position', 'digest')
  expect(await s.mls.readEpoch()).toBe(before)
  expect(pending.epoch).toBe(before + 1)
  const { confirmationTag } = await import('@kumiai/mls')
  const verdict = {
    groupID: s.group().groupID,
    requestID,
    position: 'position',
    commitDigest: 'digest',
    verdict: 'confirmed' as const,
    epoch: pending.epoch,
    tag: confirmationTag(key, requestID),
  }
  const sealed = await s.responder.sealRecoveryVerdict(request, verdict)
  const opened = await s.mls.openRecoveryVerdict(sealed, requestID)
  if (opened == null) throw new Error('No opened verdict')
  expect(pending.judgeVerdict(opened)).toBe('authoritative')
  for (const change of [
    { epoch: before },
    { position: 'other' },
    { commitDigest: 'other' },
    { tag: confirmationTag(new Uint8Array(32), requestID) },
    { groupID: 'other' },
    { requestID: 'other' },
  ]) {
    expect(pending.judgeVerdict({ ...opened, verdict: { ...verdict, ...change } })).toBe('advisory')
  }
  expect(pending.judgeVerdict({ ...opened, signer: fixture.agent(81).id })).toBe('advisory')
  await pending.onAccepted()
  await pending.onAccepted()
  expect(await s.mls.readEpoch()).toBe(pending.epoch)
})

test('revocation in either registry is permanent in the union and stale refusals are advisory', async () => {
  const s = await setup()
  const request = await s.mls.createRecoveryRequest('stale')
  const candidate = await s.mls.applyRecovery(await s.responder.sealGroupInfo(request), 'stale')
  if (candidate == null || 'renewalRequired' in candidate) throw new Error('No pending recovery')
  await candidate.confirmationKey('position', 'digest')
  const { knownRecoveryRegistry, createVerdictJudge } = await import(
    new URL('../../../packages/mls-rpc/src/recovery.ts', import.meta.url).href
  )
  const known = {
    devices: new Map([
      [s.bob.id, { controller: fixture.controllerID, status: 'revoked' as const, logPosition: 1 }],
    ]),
    controllers: new Map(),
  }
  const current = candidate as typeof candidate & {
    group: GroupHandle
    sourceTree: GroupHandle['state']['ratchetTree']
    knownRegistry: DeviceRegistry
  }
  for (const union of [
    knownRecoveryRegistry(known, registrySeed()),
    knownRecoveryRegistry(registrySeed(), known),
  ]) {
    const judge = createVerdictJudge({
      group: current.group,
      sourceTree: current.sourceTree,
      known: union,
      requestID: 'stale',
    })
    const key = await judge.confirmationKey('position', 'digest')
    const { confirmationTag } = await import('@kumiai/mls')
    const binding = {
      groupID: s.group().groupID,
      requestID: 'stale',
      position: 'position',
      commitDigest: 'digest',
    }
    expect(
      judge.judgeVerdict({
        signer: s.bob.id,
        verdict: { ...binding, verdict: 'refused', reason: 'policy' },
      }),
    ).toBe('advisory')
    expect(
      judge.judgeVerdict({
        signer: s.bob.id,
        verdict: {
          ...binding,
          verdict: 'confirmed',
          epoch: candidate.epoch,
          tag: confirmationTag(key, 'stale'),
        },
      }),
    ).toBe('advisory')
    expect(
      judge.judgeVerdict({
        signer: s.identity.id,
        verdict: {
          ...binding,
          verdict: 'confirmed',
          epoch: candidate.epoch,
          tag: confirmationTag(key, 'stale'),
        },
      }),
    ).toBe('advisory')
  }
})

test('a revoked trusted issuer makes its child advisory and unknown revocation respects the expiry boundary', async () => {
  const issuer = fixture.agent(81)
  const parent = (await fixture.timedBinding({ identity: issuer, iat: 100, exp: 200 })).capability
  const s = await setup({ issuer, parent })
  const known = {
    devices: new Map([
      [issuer.id, { controller: fixture.controllerID, status: 'revoked' as const }],
    ]),
    controllers: new Map(),
  }
  expect(
    recoverySignerEligible({ group: s.group(), known: known, signer: s.bob.id, now: 150 }),
  ).toBe(false)
  expect(
    recoverySignerEligible({ group: s.group(), known: registrySeed(), signer: s.bob.id, now: 500 }),
  ).toBe(true)
  expect(
    recoverySignerEligible({
      group: s.group(),
      known: registrySeed(),
      signer: s.bob.id,
      now: 500.001,
    }),
  ).toBe(false)
})

test('a lifecycle GroupInfo signer revoked in the known ledger is refused', async () => {
  const s = await setup()
  const { createRevoke } = await import('@kokuin/controller')
  const { controllerSeed, inception } = await import(
    new URL('../../../packages/mls/test/fixtures/lifecycle-ledger.ts', import.meta.url).href
  )
  const rev = createRevoke({
    seed: controllerSeed,
    profile: 0,
    did: fixture.controllerID,
    prior: inception.event,
    target: s.bob.id,
    keyPosition: { gen: 0, seq: 0 },
  })
  const removed = await revokeWithProof(s.group(), { subject: s.bob.id, log: [inception, rev] })
  if (removed.status !== 'built') throw new Error('Expected proof commit')
  // Keep the responder's old tree while installing the accepted proof on the requester.
  const access = simpleHandleAccess({
    handle: () => removed.result.newGroup,
    adopt: () => {
      throw new Error('Unexpected adoption')
    },
  })
  const mls = createGroupMLS({ identity: s.identity, access, entrySlot: createLedgerEntrySlot() })
  const request = await mls.createRecoveryRequest('revoked-attestation')
  expect(
    await mls.applyRecovery(await s.responder.sealGroupInfo(request), 'revoked-attestation'),
  ).toBeNull()
})

test('a chained GroupInfo signer with a denied issuer is refused', async () => {
  const issuer = fixture.agent(81)
  const parent = (await fixture.timedBinding({ identity: issuer, iat: 100, exp: 200 })).capability
  const s = await setup({ issuer, parent })
  const request = await s.mls.createRecoveryRequest('issuer-attestation')
  const reply = await s.responder.sealGroupInfo(request)
  // A folded registry is the sole input to signer trust.
  const known = s.group().registry.devices as Map<string, { controller: string; status: 'revoked' }>
  known.set(issuer.id, { controller: fixture.controllerID, status: 'revoked' })
  expect(await s.mls.applyRecovery(reply, 'issuer-attestation')).toBeNull()
})

test('a GroupInfo attestation re-signed by a DID absent from the pending tree is refused', async () => {
  const s = await setup()
  const outsider = fixture.agent(81)
  const impostor = new GroupHandle({
    state: s.responderGroup.state,
    context: s.responderGroup.context,
    credential: { id: outsider.id, groupID: s.responderGroup.groupID },
  })
  await impostor.bootstrapLedger(s.responderGroup.ledgerTokens)
  const { sealGroupInfo } = await import('@kumiai/mls')
  const request = await s.mls.createRecoveryRequest('leafless-attestation')
  const sealed = await sealGroupInfo({
    group: impostor,
    identity: outsider,
    request: new TextDecoder().decode(request),
  })
  expect(await s.mls.applyRecovery(sealed, 'leafless-attestation')).toBeNull()
})

test('outside lifecycle groups a valid confirmed tag needs no known leaf, while refusals require the source tree', async () => {
  const s = await setup({ standard: true })
  const requestID = 'standard-verdict'
  const request = await s.mls.createRecoveryRequest(requestID)
  const candidate = await s.mls.applyRecovery(await s.responder.sealGroupInfo(request), requestID)
  if (candidate == null || 'renewalRequired' in candidate) throw new Error('No pending recovery')
  const key = await candidate.confirmationKey('position', 'digest')
  const { confirmationTag } = await import('@kumiai/mls')
  const outsider = fixture.agent(81)
  const binding = {
    groupID: s.group().groupID,
    requestID,
    position: 'position',
    commitDigest: 'digest',
  }
  const verdict = {
    ...binding,
    verdict: 'confirmed' as const,
    epoch: candidate.epoch,
    tag: confirmationTag(key, requestID),
  }
  const opened = { signer: outsider.id, verdict }
  expect(candidate.judgeVerdict(opened)).toBe('authoritative')
  expect(
    candidate.judgeVerdict({
      ...opened,
      verdict: { ...binding, verdict: 'refused', reason: 'policy' },
    }),
  ).toBe('advisory')
  expect(
    candidate.judgeVerdict({
      signer: s.bob.id,
      verdict: { ...binding, verdict: 'refused', reason: 'policy' },
    }),
  ).toBe('authoritative')
})

test('the real commit port propagates binding and lapse refusals without advancing', async () => {
  const s = await setup()
  const before = await s.mls.readEpoch()
  for (const [binding, refusal] of [
    [undefined, 'binding'],
    [await fixture.timedBinding({ identity: s.bob, iat: 50, exp: 90 }), 'lapse'],
  ] as const) {
    const commit = await fixture.lowLevelExternal({
      group: s.group(),
      identity: s.bob,
      binding,
    })
    expect(await s.mls.processCommit(commit, {})).toEqual({
      advanced: false,
      epochBefore: before,
      epochAfter: before,
      refusal,
    })
    expect(await s.mls.readEpoch()).toBe(before)
  }
})

test('caller rejection and a replacement without a prior leaf propagate policy and invalid', async () => {
  const s = await setup()
  const rejector = new GroupHandle({
    state: s.group().state,
    context: s.group().context,
    credential: s.group().credential,
    commitPolicy: () => 'reject',
  })
  await rejector.bootstrapLedger(s.group().ledgerTokens)
  const mls = createGroupMLS({
    identity: s.identity,
    entrySlot: createLedgerEntrySlot(),
    access: simpleHandleAccess({
      handle: () => rejector,
      adopt: () => {
        throw new Error('Unexpected adoption')
      },
    }),
  })
  const valid = await fixture.lowLevelExternal({
    group: s.group(),
    identity: s.bob,
    binding: await fixture.timedBinding({ identity: s.bob, iat: 100, exp: 200 }),
  })
  expect(await mls.processCommit(valid, {})).toMatchObject({ advanced: false, refusal: 'policy' })
  const outsider = fixture.agent(81)
  const invalid = await fixture.lowLevelExternal({
    group: s.group(),
    identity: outsider,
    binding: await fixture.timedBinding({ identity: outsider, iat: 100, exp: 200 }),
    resync: false,
  })
  expect(await s.mls.processCommit(invalid, {})).toMatchObject({
    advanced: false,
    refusal: 'invalid',
  })
})

test('the rejoiner cannot count its own signed confirmation', async () => {
  const s = await setup()
  const requestID = 'self-verdict'
  const request = await s.mls.createRecoveryRequest(requestID)
  const pending = await s.mls.applyRecovery(await s.responder.sealGroupInfo(request), requestID)
  if (pending == null || 'renewalRequired' in pending) throw new Error('Expected candidate')
  const key = await pending.confirmationKey('position', 'digest')
  const { confirmationTag } = await import('@kumiai/mls')
  expect(
    pending.judgeVerdict({
      signer: s.identity.id,
      verdict: {
        groupID: s.group().groupID,
        requestID,
        position: 'position',
        commitDigest: 'digest',
        verdict: 'confirmed',
        epoch: pending.epoch,
        tag: confirmationTag(key, requestID),
      },
    }),
  ).toBe('advisory')
})
