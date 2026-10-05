import type { OwnIdentity } from '@kokuin/token'
import {
  type ControllerBinding,
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  decodeClientState,
  encodeClientState,
  exportGroupInfo,
  type GroupHandle,
  joinGroupExternal,
  processWelcome,
  renewLeaf,
  restoreGroup,
  revokeWithProof,
} from '@kumiai/mls'
import {
  createGroupCrypto,
  createGroupMLS,
  createLedgerEntrySlot,
  simpleHandleAccess,
} from '@kumiai/mls-rpc'
import { createGroupPeer, type RecoveryEvent } from '@kumiai/rpc'
import { afterEach, expect, test, vi } from 'vitest'

import {
  chat,
  createMemoryAnchorStore,
  createMemoryAppCursorStore,
  createMemoryAppOutbox,
  createMemoryCommitJournal,
  type Protocols,
} from './app-lane-e2e.js'
import { drainUntil } from './fixtures/drain.js'
import { createWireHub } from './log-hub-over-wire.js'

const fixture = (await import(
  new URL('../../../packages/mls/test/fixtures/lifecycle-pipeline.ts', import.meta.url).href
)) as {
  agent: (byte: number) => OwnIdentity
  controllerID: string
  resetPrefix: () => ControllerBinding['prefix']
  oversizedBinding: (identity: OwnIdentity, iat: number, exp: number) => Promise<ControllerBinding>
  timedBinding: (params: {
    identity: OwnIdentity
    iat: number
    exp: number

    parent?: string
    issuer?: OwnIdentity
    prefix?: ControllerBinding['prefix']
  }) => Promise<ControllerBinding>
}

afterEach(() => vi.restoreAllMocks())

async function setup(
  host?: (request: {
    groupID: string
    controllerID: string
    current: ControllerBinding
  }) => Promise<ControllerBinding | null>,
  options: { bobIat?: number; clock?: number; aliceExp?: number } = {},
) {
  vi.spyOn(Date, 'now').mockReturnValue((options.clock ?? 150) * 1000)
  const alice = fixture.agent(41)
  const bob = fixture.agent(61)
  let aliceGroup = (
    await createGroup(alice, 'lifecycle-recovery', {
      controller: await fixture.timedBinding({
        identity: alice,
        iat: 100,
        exp: options.aliceExp ?? 200,
      }),
    })
  ).group
  const cached = await fixture.timedBinding({ identity: bob, iat: options.bobIat ?? 100, exp: 200 })
  const bundle = await createKeyPackageBundle(bob, { controller: cached })
  const { invite } = await createInvite({
    group: aliceGroup,
    identity: alice,
    recipientDID: bob.id,
  })
  const added = await commitInvite(aliceGroup, bundle.publicPackage, invite)
  aliceGroup = added.newGroup
  const slot = createLedgerEntrySlot()
  let bobGroup = (
    await processWelcome({
      identity: bob,
      invite,
      welcome: added.welcomeMessage,
      keyPackageBundle: bundle,
      options: { resolveLedgerEntries: slot.resolve },
    })
  ).group
  const access = simpleHandleAccess({
    handle: () => bobGroup,
    adopt: (next) => {
      bobGroup = next
    },
  })
  const mls = createGroupMLS({ access, identity: bob, entrySlot: slot, recoveryBinding: host })
  const responder = createGroupMLS({
    access: simpleHandleAccess({
      handle: () => aliceGroup,
      adopt: (next) => {
        aliceGroup = next
      },
    }),
    identity: alice,
    entrySlot: createLedgerEntrySlot(),
  })
  return {
    alice,
    bob,
    cached,
    mls,
    responder,
    access,
    aliceGroup: () => aliceGroup,
    bobGroup: () => bobGroup,
    installAlice: (next: GroupHandle) => {
      aliceGroup = next
    },
  }
}

function recoveryPeer(params: {
  hub: ReturnType<typeof createWireHub>
  identity: OwnIdentity
  access: ReturnType<typeof simpleHandleAccess>
  mls: ReturnType<typeof createGroupMLS>
  onRecovery?: (event: RecoveryEvent) => void
  deadlineMs?: number
}) {
  const { hub, identity, access, mls, onRecovery } = params
  return createGroupPeer<Protocols>({
    appOutbox: createMemoryAppOutbox(),
    appOutboxLimit: 128,
    hub: hub.connect(identity),
    crypto: createGroupCrypto({ access }),
    mls,
    localDID: identity.id,
    journal: createMemoryCommitJournal(),
    anchorStore: createMemoryAnchorStore(),
    appCursorStore: createMemoryAppCursorStore(),
    protocols: { chat },
    handlers: {
      chat: { 'chat/changed': () => {}, 'chat/posted': () => {}, 'chat/double': () => ({}) },
    },
    adoptJournalled: async () => {},
    onRecovery,
    recovery: { timeoutMs: 100, deadlineMs: params.deadlineMs ?? 1000, getDelayMs: () => 0 },
  })
}

test('peer recovery and restore retain authenticated revocations, reset history and time floors without ledger replies', async () => {
  const { controlRecoveryClock } = await import(
    new URL('../../../packages/rpc/test/fixtures/recovery-clock.ts', import.meta.url).href
  )
  controlRecoveryClock()
  let fresh: ControllerBinding
  const s = await setup(async () => fresh)
  const pipeline = await import(
    new URL('../../../packages/mls/test/fixtures/lifecycle-pipeline.ts', import.meta.url).href
  )
  const ledger = await import(
    new URL('../../../packages/mls/test/fixtures/lifecycle-ledger.ts', import.meta.url).href
  )
  const { createRevoke } = await import('@kokuin/controller')
  const revoked = fixture.agent(81)
  const rev = createRevoke({
    seed: ledger.controllerSeed,
    profile: 0,
    did: fixture.controllerID,
    prior: ledger.inception.event,
    target: revoked.id,
    keyPosition: { gen: 0, seq: 0 },
  })
  const revoke = await revokeWithProof(s.aliceGroup(), {
    subject: revoked.id,
    log: [ledger.inception, rev],
  })
  if (revoke.status !== 'built') throw new Error('Expected revoke')
  s.installAlice(revoke.result.newGroup)
  const prefix = fixture.resetPrefix()
  const replacement = await joinGroupExternal({
    identity: s.bob,
    groupInfo: (await exportGroupInfo({ group: s.aliceGroup() })).groupInfo,
    credential: s.bobGroup().credential,
    resync: true,
    controller: await fixture.timedBinding({ identity: s.bob, iat: 100, exp: 200, prefix }),
    ledgerEntries: s.aliceGroup().ledgerTokens,
  })
  await s.aliceGroup().processMessage(replacement.commitMessage)
  s.installAlice(
    (
      await renewLeaf(
        s.aliceGroup(),
        await fixture.timedBinding({ identity: s.alice, iat: 100, exp: 200, prefix }),
      )
    ).newGroup,
  )
  const reset = await revokeWithProof(s.aliceGroup(), { reset: true, log: prefix })
  if (reset.status !== 'built') throw new Error('Expected reset')
  s.installAlice(reset.result.newGroup)
  vi.spyOn(Date, 'now').mockReturnValue(180_000)
  s.installAlice(
    (
      await renewLeaf(
        s.aliceGroup(),
        await fixture.timedBinding({ identity: s.alice, iat: 180, exp: 280, prefix }),
      )
    ).newGroup,
  )
  const trusted = fixture.agent(65)
  const parent = await fixture.timedBinding({ identity: trusted, iat: 100, exp: 300, prefix })
  s.installAlice(
    (
      await renewLeaf(
        s.aliceGroup(),
        await fixture.timedBinding({
          identity: s.alice,
          iat: 180,
          exp: 280,
          prefix,
          issuer: trusted,
          parent: parent.capability,
        }),
      )
    ).newGroup,
  )
  fresh = await fixture.timedBinding({ identity: s.bob, iat: 180, exp: 280, prefix })
  const expected = s.aliceGroup().ledgerTokens
  expect(expected).toHaveLength(3)
  const hub = createWireHub()
  const alice = recoveryPeer({
    hub,
    identity: s.alice,
    access: simpleHandleAccess({ handle: s.aliceGroup, adopt: s.installAlice }),
    mls: s.responder,
  })
  const bob = recoveryPeer({ hub, identity: s.bob, access: s.access, mls: s.mls })
  const sealLedger = vi
    .spyOn(s.responder, 'sealLedger')
    .mockRejectedValue(new Error('Ledger replies withheld'))
  let recovery: Promise<unknown> | undefined
  try {
    await Promise.all([alice.resync(), bob.resync()])
    recovery = bob.recover()
    await drainUntil(() => s.bobGroup().epoch === s.aliceGroup().epoch, 'recovered handle')
    const adopted = s.bobGroup()
    expect(adopted.ledgerTokens).toEqual(expected)
    expect(await adopted.isLedgerComplete()).toBe(true)
    const state = decodeClientState(encodeClientState(adopted.state))
    if (state == null) throw new Error('Missing restored state')
    const restored = await restoreGroup({
      state,
      credential: adopted.credential,
      ledgerEntries: adopted.ledgerTokens,
    })
    for (const handle of [adopted, restored]) {
      expect(handle.registry.controllers.get(fixture.controllerID)).toMatchObject({
        genFloor: 1,
        timeFloor: 180,
        recordedLog: prefix,
      })
      expect(handle.registry.devices.get(revoked.id)?.status).toBe('revoked')
      expect(await handle.isLedgerComplete()).toBe(true)
      for (const [identity, binding] of [
        [revoked, await fixture.timedBinding({ identity: revoked, iat: 180, exp: 280, prefix })],
        [
          fixture.agent(82),
          await fixture.timedBinding({ identity: fixture.agent(82), iat: 180, exp: 280 }),
        ],
      ] as const) {
        const hostile = await pipeline.rawAdd(s.aliceGroup(), identity, binding)
        await expect(handle.processMessage(hostile.message)).rejects.toMatchObject({
          name: 'CommitRejectedError',
        })
      }
    }
    const preResetUpdate = await pipeline.lowLevelExternal({
      group: s.aliceGroup(),
      identity: s.alice,
      binding: await fixture.timedBinding({ identity: s.alice, iat: 180, exp: 280 }),
    })
    for (const handle of [adopted, restored]) {
      await expect(handle.processMessage(preResetUpdate)).rejects.toMatchObject({
        name: 'CommitRejectedError',
      })
    }
    const admitted = fixture.agent(83)
    const valid = await pipeline.rawAdd(
      s.aliceGroup(),
      admitted,
      await fixture.timedBinding({ identity: admitted, iat: 180, exp: 280, prefix }),
    )
    for (const handle of [adopted, restored]) await handle.processMessage(valid.message)
    expect(await recovery).toMatchObject({ advanced: true })
    expect(sealLedger).not.toHaveBeenCalled()
  } finally {
    await Promise.all([alice.dispose(), bob.dispose()])
    await recovery?.catch(() => {})
    await hub.dispose()
  }
})
