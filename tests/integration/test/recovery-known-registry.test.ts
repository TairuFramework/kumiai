import type { OwnIdentity } from '@kokuin/token'
import {
  type ControllerBinding,
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  type GroupHandle,
  processWelcome,
} from '@kumiai/mls'
import { createGroupMLS, createLedgerEntrySlot } from '@kumiai/mls-rpc'
import { afterEach, expect, test, vi } from 'vitest'

import { createDurableHandleAccess, groupMLSDependencies } from './app-lane-e2e.js'

const fixture = (await import(
  new URL('../../../packages/mls/test/fixtures/lifecycle-pipeline.ts', import.meta.url).href
)) as {
  inception: ControllerBinding['prefix'][number]
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
        : {
            controller: await fixture.timedBinding({ identity: identity, iat: 100, exp: 200 }),
            controllerLog: { chain: [fixture.inception], events: [] },
          }),
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
    ...groupMLSDependencies(
      await createDurableHandleAccess({
        handle: () => responderGroup,
        adopt: () => {
          throw new Error('Unexpected adoption')
        },
      }),
    ),
  })
  const mls = createGroupMLS({
    identity,
    entrySlot: createLedgerEntrySlot(),
    ...groupMLSDependencies(
      await createDurableHandleAccess({
        handle: () => group,
        adopt: (next: GroupHandle) => {
          group = next
        },
      }),
    ),
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

test('the adapter refuses a reply whose ledger omits an own-ledger revocation', async () => {
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
  expect(malloryGroup.findMemberLeafIndex(mallory.id)).toBeDefined()
  const requestID = 'known-revoked-verdict'
  const { request, requestKey } = await s.mls.createRecoveryRequest(requestID)
  const pending = await s.mls.applyRecovery(
    await s.responder.sealGroupInfo(request),
    requestID,
    requestKey,
  )
  expect(pending).toBeNull()
})
