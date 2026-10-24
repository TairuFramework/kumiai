import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OwnIdentity } from '@kokuin/token'
import * as mls from '@kumiai/mls'
import {
  type ControllerBinding,
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  decodeClientState,
  encodeClientState,
  type GroupHandle,
  processWelcome,
  restoreGroup,
} from '@kumiai/mls'
import { nodeTypes } from 'ts-mls'
import { expect, test, vi } from 'vitest'

import { simpleHandleAccess } from '../src/access.js'
import { createGroupMLS, createLedgerEntrySlot } from '../src/mls.js'
import {
  createRecoveryBindingState,
  type RecoveryBinding,
  type RecoveryBindingRequest,
} from '../src/recovery.js'

// Imported at collection, not inside the first test: transforming the cross-package fixture under
// load overran that test's 5s timeout.
const fixture = (await import(
  new URL('../../mls/test/fixtures/lifecycle-ledger.ts', import.meta.url).href
)) as {
  agent: (byte: number) => OwnIdentity
  bindingFor: (
    identity: OwnIdentity,
    prefix?: ControllerBinding['prefix'],
    issuer?: { identity: OwnIdentity; parent: string },
  ) => Promise<ControllerBinding>
  trustedGrant: (identity: OwnIdentity) => Promise<string>
}

async function chainedRecovery() {
  const alice = fixture.agent(41)
  const bob = fixture.agent(61)
  const now = Date.now()
  let holderGrant: string
  let refreshedGrant: string
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(now - 20_000)
    holderGrant = await fixture.trustedGrant(bob)
    vi.setSystemTime(now - 10_000)
    refreshedGrant = await fixture.trustedGrant(bob)
  } finally {
    vi.useRealTimers()
  }
  const parent = await fixture.trustedGrant(alice)
  const binding = {
    ...(await fixture.bindingFor(bob, undefined, { identity: alice, parent })),
    holderGrant,
  }
  let source = (
    await createGroup(alice, 'recovery-holder-evidence', {
      controller: await fixture.bindingFor(alice),
      controllerLog: { chain: binding.prefix, events: [] },
      leafLifetime: 604_800,
      trustedGrantLifetime: 31_536_000,
    })
  ).group
  const bundle = await createKeyPackageBundle(bob, { controller: binding })
  const { invite } = await createInvite({ group: source, identity: alice, recipientDID: bob.id })
  const added = await commitInvite(source, bundle.publicPackage, invite)
  source = added.newGroup
  let member = (
    await processWelcome({
      identity: bob,
      invite,
      welcome: added.welcomeMessage,
      keyPackageBundle: bundle,
    })
  ).group
  const newcomer = fixture.agent(81)
  const nextBundle = await createKeyPackageBundle(newcomer, {
    controller: await fixture.bindingFor(newcomer),
  })
  const nextInvite = await createInvite({
    group: source,
    identity: alice,
    recipientDID: newcomer.id,
  })
  source = (await commitInvite(source, nextBundle.publicPackage, nextInvite.invite)).newGroup
  const requester = (recoveryBinding?: RecoveryBinding) =>
    createGroupMLS({
      identity: bob,
      access: simpleHandleAccess({
        handle: () => member,
        adopt: (next) => {
          member = next
        },
      }),
      entrySlot: createLedgerEntrySlot(),
      recoveryBinding,
    })
  const responder = createGroupMLS({
    identity: alice,
    access: simpleHandleAccess({
      handle: () => source,
      adopt: (next) => {
        source = next
      },
    }),
    entrySlot: createLedgerEntrySlot(),
  })
  return {
    bob,
    binding,
    refreshed: { ...binding, holderGrant: refreshedGrant },
    member: () => member,
    reload: (next: GroupHandle) => {
      member = next
    },
    requester,
    responder,
    source: () => source,
  }
}

async function recover(
  fixture: Awaited<ReturnType<typeof chainedRecovery>>,
  requester: ReturnType<typeof createGroupMLS>,
  requestID: string,
) {
  const request = await requester.createRecoveryRequest(requestID)
  const reply = await fixture.responder.sealGroupInfo(request)
  const pending = await requester.applyRecovery(reply, requestID)
  expect(pending).not.toBeNull()
  expect(pending).not.toHaveProperty('renewalRequired')
  if (pending == null || 'renewalRequired' in pending)
    throw new Error('Expected recovery candidate')
  return pending
}

async function acceptRecovery(
  fixture: Awaited<ReturnType<typeof chainedRecovery>>,
  requester: ReturnType<typeof createGroupMLS>,
) {
  const pending = await recover(fixture, requester, 'chained-recovery')
  await expect(
    fixture.responder.processCommit(pending.commit, { senderDID: fixture.bob.id }),
  ).resolves.toMatchObject({ advanced: true })
  await pending.onAccepted()
  expect(fixture.member().bindingOfDID(fixture.bob.id)?.holderGrant).toBe(
    fixture.binding.holderGrant,
  )
  expect(fixture.source().bindingOfDID(fixture.bob.id)?.holderGrant).toBe(
    fixture.binding.holderGrant,
  )
  const plaintext = new TextEncoder().encode('recovered chained member')
  const sealed = await fixture.member().encrypt(plaintext)
  await expect(fixture.source().decrypt(sealed)).resolves.toMatchObject({
    payload: plaintext,
    senderDID: fixture.bob.id,
  })
}

test('recoveryWithValidChainedBindingKeepsEvidence', async () => {
  const fixture = await chainedRecovery()
  const requester = fixture.requester()
  await expect(requester.prepareRecovery()).resolves.toBe('ready')
  await acceptRecovery(fixture, requester)
})

test('evidenceRefreshMakesNewBindingID', async () => {
  const fixture = await chainedRecovery()
  let offered = fixture.binding
  const host = vi.fn(async (_request: RecoveryBindingRequest) => offered)
  const requester = fixture.requester(host)
  const first = await recover(fixture, requester, 'unusable-binding')
  first.markBindingUnusable()
  await expect(requester.prepareRecovery()).resolves.toBe('renewal-required')
  expect(host.mock.calls.at(-1)?.[0]).toMatchObject({
    current: { holderGrant: fixture.binding.holderGrant },
  })
  offered = fixture.refreshed
  expect(offered.capability).toBe(fixture.binding.capability)
  expect(offered.holderGrant).not.toBe(fixture.binding.holderGrant)
  await expect(requester.prepareRecovery()).resolves.toBe('ready')
  const refreshed = await recover(fixture, requester, 'refreshed-evidence')
  await expect(
    fixture.responder.processCommit(refreshed.commit, { senderDID: fixture.bob.id }),
  ).resolves.toMatchObject({ advanced: true })
  await refreshed.onAccepted()
  expect(fixture.member().bindingOfDID(fixture.bob.id)?.holderGrant).toBe(offered.holderGrant)
})

test('recoveryAfterRestartKeepsEvidence', async () => {
  const fixture = await chainedRecovery()
  const directory = await mkdtemp(join(tmpdir(), 'recovery-holder-evidence-'))
  try {
    const original = fixture.member()
    await writeFile(join(directory, 'state'), encodeClientState(original.state))
    await writeFile(
      join(directory, 'metadata.json'),
      JSON.stringify({ credential: original.credential, ledgerEntries: original.ledgerTokens }),
    )
    const state = decodeClientState(await readFile(join(directory, 'state')))
    if (state == null) throw new Error('Invalid persisted MLS state')
    const metadata = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8')) as {
      credential: GroupHandle['credential']
      ledgerEntries: Array<string>
    }
    const restored = await restoreGroup({ state, ...metadata })
    expect(restored.bindingOfDID(fixture.bob.id)?.holderGrant).toBe(fixture.binding.holderGrant)
    fixture.reload(restored)
    const requester = fixture.requester()
    await expect(requester.prepareRecovery()).resolves.toBe('ready')
    await acceptRecovery(fixture, requester)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('recovery binding state carries a membership binding', async () => {
  const identity = fixture.agent(41)
  const capability = await fixture.bindingFor(identity)
  const { group } = await createGroup(identity, 'membership-binding-state', {
    controller: capability,
    controllerLog: { chain: capability.prefix, events: [] },
  })
  const binding: ControllerBinding = {
    id: capability.id,
    prefix: capability.prefix,
    member: { add: 'member-add', g: 0 },
    iat: 100,
  }
  const own = group.state.ratchetTree[0]
  if (own?.nodeType !== nodeTypes.leaf) throw new Error('Missing leaf')
  own.leaf.credential = {
    credentialType: 1,
    identity: new TextEncoder().encode(JSON.stringify({ id: identity.id, controller: binding })),
  }
  let offered = binding
  const host = vi.fn(async (_request: RecoveryBindingRequest) => offered)
  const validation = vi.spyOn(mls, 'assertRecoveryBinding').mockResolvedValue()
  const join = vi.spyOn(mls, 'joinGroupExternal').mockResolvedValue({
    group,
    commitMessage: new Uint8Array(),
    sourceTree: group.state.ratchetTree,
    sourceRegistry: group.registry,
  })
  try {
    const state = createRecoveryBindingState(identity, host)
    await expect(state.prepare(group)).resolves.toBe('ready')
    expect(validation).toHaveBeenLastCalledWith({ group, identity, controller: binding })
    const pending = await state.join(group, {
      groupInfo: new Uint8Array(),
      ledger: [],
      signer: identity.id,
    })
    if (pending == null || 'renewalRequired' in pending) throw new Error('Missing candidate')
    pending.markBindingUnusable()
    await expect(state.prepare(group)).resolves.toBe('renewal-required')
    expect(host).toHaveBeenLastCalledWith({
      groupID: group.groupID,
      controllerID: binding.id,
      current: binding,
    })
    offered = { ...binding, iat: 101 }
    await expect(state.prepare(group)).resolves.toBe('ready')
    offered = { ...binding, member: { add: 'another-add', g: 0 } }
    await expect(state.prepare(group)).resolves.toBe('ready')
  } finally {
    validation.mockRestore()
    join.mockRestore()
  }
})
