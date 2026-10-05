import type { OwnIdentity } from '@kokuin/token'
import {
  type ControllerBinding,
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  type GroupHandle,
  processWelcome,
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
  return {
    identity,
    mls,
    responder,
    responderGroup,
    bob,
    group: () => group,
    install: (next: GroupHandle) => {
      group = next
    },
  }
}

test('the adapter judge retains own-ledger revocations when the reply offers a stale tree', async () => {
  const s = await setup()
  const mallory = fixture.agent(81)
  const bundle = await createKeyPackageBundle(mallory, {
    controller: await fixture.timedBinding({ identity: mallory, iat: 100, exp: 200 }),
  })
  const { invite } = await createInvite({
    group: s.group(),
    identity: s.identity,
    recipientDID: mallory.id,
  })
  const added = await commitInvite(s.group(), bundle.publicPackage, invite)
  const malloryGroup = (
    await processWelcome({
      identity: mallory,
      invite,
      welcome: added.welcomeMessage,
      keyPackageBundle: bundle,
    })
  ).group
  const malloryMLS = createGroupMLS({
    identity: mallory,
    entrySlot: createLedgerEntrySlot(),
    access: simpleHandleAccess({
      handle: () => malloryGroup,
      adopt: () => {
        throw new Error('Unexpected adoption')
      },
    }),
  })
  s.install(added.newGroup)
  await s.responderGroup.processMessage(added.commitMessage)
  const { createRevoke } = await import('@kokuin/controller')
  const { controllerSeed, inception } = await import(
    new URL('../../../packages/mls/test/fixtures/lifecycle-ledger.ts', import.meta.url).href
  )
  const rev = createRevoke({
    seed: controllerSeed,
    profile: 0,
    did: fixture.controllerID,
    prior: inception.event,
    target: mallory.id,
    keyPosition: { gen: 0, seq: 0 },
  })
  const removed = await revokeWithProof(s.group(), { subject: mallory.id, log: [inception, rev] })
  if (removed.status !== 'built') throw new Error('Expected revoke')
  s.install(removed.result.newGroup)
  expect(s.group().registry.devices.get(mallory.id)?.status).toBe('revoked')
  const requestID = 'known-revoked-verdict'
  const request = await s.mls.createRecoveryRequest(requestID)
  const pending = await s.mls.applyRecovery(await s.responder.sealGroupInfo(request), requestID)
  if (pending == null || 'renewalRequired' in pending) throw new Error('Expected stale candidate')
  const key = await pending.confirmationKey('position', 'digest')
  await malloryGroup.processMessage(pending.commit)
  expect(await malloryMLS.confirmationKey('position', 'digest')).toEqual({
    epoch: pending.epoch,
    key,
  })
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
  const opened = await s.mls.openRecoveryVerdict(
    await malloryMLS.sealRecoveryVerdict(request, verdict),
    requestID,
  )
  if (opened == null) throw new Error('No authenticated stale verdict')
  expect(opened.signer).toBe(mallory.id)
  expect(pending.judgeVerdict(opened)).toBe('advisory')
  const { createVerdictJudge } = await import(
    new URL('../../../packages/mls-rpc/src/recovery.ts', import.meta.url).href
  )
  const retained = pending as typeof pending & {
    group: GroupHandle
    sourceTree: GroupHandle['state']['ratchetTree']
  }
  const emptyJudge = createVerdictJudge({
    group: retained.group,
    sourceTree: retained.sourceTree,
    known: registrySeed(),
    requestID,
  })
  await emptyJudge.confirmationKey('position', 'digest')
  expect(emptyJudge.judgeVerdict(opened)).toBe('authoritative')
  expect(pending.judgeVerdict({ signer: s.bob.id, verdict })).toBe('authoritative')
  expect(s.group().registry.devices.get(mallory.id)?.status).toBe('revoked')
})
