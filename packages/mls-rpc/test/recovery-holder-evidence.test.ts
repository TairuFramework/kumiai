import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OwnIdentity } from '@kokuin/token'
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
import { expect, test, vi } from 'vitest'

import { simpleHandleAccess } from '../src/access.js'
import { createGroupMLS, createLedgerEntrySlot } from '../src/mls.js'
import type { RecoveryBinding, RecoveryBindingRequest } from '../src/recovery.js'

async function chainedRecovery() {
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
    expect(restored).not.toBe(original)
    expect(restored.bindingOfDID(fixture.bob.id)?.holderGrant).toBe(fixture.binding.holderGrant)
    fixture.reload(restored)
    const requester = fixture.requester()
    await expect(requester.prepareRecovery()).resolves.toBe('ready')
    await acceptRecovery(fixture, requester)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
