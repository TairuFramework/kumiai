import type { OwnIdentity } from '@kokuin/token'
import {
  type ClientState,
  type ControllerBinding,
  commitInvite,
  commitLedgerEntries,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  type DeviceRegistry,
  exportGroupInfo,
  GroupHandle,
  joinGroupExternal,
  parseMLSCredentialIdentity,
  processWelcome,
  renewLeaf,
  revokeWithProof,
  signLedgerEntry,
} from '@kumiai/mls'
import {
  createGroupCrypto,
  createGroupMLS,
  createLedgerEntrySlot,
  simpleHandleAccess,
} from '@kumiai/mls-rpc'
import {
  commitTopic,
  createGroupPeer,
  encodeCommitFrame,
  encodeHandshakeFrame,
  HANDSHAKE_KIND,
  type RecoveryEvent,
} from '@kumiai/rpc'
import { afterEach, expect, test, vi } from 'vitest'

import {
  chat,
  createMemoryAnchorStore,
  createMemoryAppCursorStore,
  createMemoryAppOutbox,
  createMemoryCommitJournal,
  type Protocols,
} from './app-lane-e2e.js'
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

async function installFloor(
  s: Awaited<ReturnType<typeof setup>>,
  time: number,
): Promise<GroupHandle> {
  const elevated = await renewLeaf(
    s.aliceGroup(),
    await fixture.timedBinding({ identity: s.alice, iat: time, exp: time + 100 }),
  )
  const trusted = fixture.agent(65)
  const parent = await fixture.timedBinding({ identity: trusted, iat: 90, exp: time + 200 })
  const delegated = await fixture.timedBinding({
    identity: s.alice,
    iat: time,
    exp: time + 100,
    parent: parent.capability,
    issuer: trusted,
  })
  const lowered = await renewLeaf(elevated.newGroup, delegated)
  expect(lowered.newGroup.registry.controllers.get(fixture.controllerID)?.timeFloor).toBe(time)
  return lowered.newGroup
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

async function buildRecovery(s: Awaited<ReturnType<typeof setup>>) {
  const request = await s.mls.createRecoveryRequest('bound-recovery')
  return s.mls.applyRecovery(await s.responder.sealGroupInfo(request), 'bound-recovery')
}

test('recovery reuses a valid cached binding without consulting the host', async () => {
  const host = vi.fn(async () => null)
  const s = await setup(host)
  expect(await s.mls.prepareRecovery()).toBe('ready')
  const pending = await buildRecovery(s)
  expect(pending).not.toBeNull()
  if (pending == null || 'renewalRequired' in pending) throw new Error('Expected pending recovery')
  expect(s.bobGroup().epoch).toBe(1n)
  await s.aliceGroup().processMessage(pending.commit)
  await pending.onAccepted()
  expect(s.bobGroup().epoch).toBe(s.aliceGroup().epoch)
  expect(host).toHaveBeenCalledTimes(0)
})

test('binding invalidation remembers the replacement leaf rather than a subsequently mutated host object', async () => {
  let offered: ControllerBinding
  const host = vi.fn(async () => offered)
  const s = await setup(host, { aliceExp: 500 })
  vi.spyOn(Date, 'now').mockReturnValue(250_000)
  offered = await fixture.timedBinding({ identity: s.bob, iat: 250, exp: 350 })
  expect(await s.mls.prepareRecovery()).toBe('ready')
  const pending = await buildRecovery(s)
  if (pending == null || 'renewalRequired' in pending) throw new Error('No bound candidate')
  vi.spyOn(Date, 'now').mockReturnValue(270_000)
  offered.capability = (
    await fixture.timedBinding({ identity: s.bob, iat: 260, exp: 360 })
  ).capability
  pending.markBindingUnusable()
  expect(await s.mls.prepareRecovery()).toBe('ready')
  expect(host).toHaveBeenCalledTimes(2)
})

test('recovery replaces an expired cached binding with one host call', async () => {
  let fresh: ControllerBinding
  const host = vi.fn(async () => fresh)
  const s = await setup(host)
  vi.spyOn(Date, 'now').mockReturnValue(250_000)
  fresh = await fixture.timedBinding({ identity: s.bob, iat: 250, exp: 350 })
  expect(await s.mls.prepareRecovery()).toBe('ready')
  s.installAlice(await installFloor(s, 250))
  const pending = await buildRecovery(s)
  if (pending == null || 'renewalRequired' in pending) throw new Error('Expected pending recovery')
  const retained = pending as typeof pending & {
    sourceTree: ClientState['ratchetTree']
    group: GroupHandle
    groupInfo: Uint8Array
    knownRegistry: DeviceRegistry
    replyLedger: Array<string>
    signer: string
  }
  const source = retained.sourceTree[2]
  if (source == null || !('leaf' in source) || !('identity' in source.leaf.credential))
    throw new Error('Missing source leaf')
  expect(parseMLSCredentialIdentity(source.leaf.credential.identity).controller?.capability).toBe(
    s.cached.capability,
  )
  expect(retained.groupInfo).toBeInstanceOf(Uint8Array)
  expect(retained.group).not.toBe(s.bobGroup())
  expect(retained.knownRegistry.controllers.get(fixture.controllerID)?.timeFloor).toBe(250)
  expect(retained.replyLedger).toHaveLength(1)
  expect(retained.signer).toBe(s.alice.id)
  await s.aliceGroup().processMessage(pending.commit)
  await pending.onAccepted()
  expect(host).toHaveBeenCalledTimes(1)
  expect(host).toHaveBeenCalledWith({
    groupID: 'lifecycle-recovery',
    controllerID: fixture.controllerID,
    current: s.cached,
  })
  expect(await s.mls.prepareRecovery()).toBe('ready')
  expect(host).toHaveBeenCalledTimes(1)
})

test.each(['absent', 'null', 'expired', 'foreign', 'lower-time', 'horizon'] as const)(
  'unusable %s recovery binding requires renewal before requesting GroupInfo',
  async (kind) => {
    let replacement: ControllerBinding | null = null
    const host = vi.fn(async () => replacement)
    const s = await setup(kind === 'absent' ? undefined : host)
    vi.spyOn(Date, 'now').mockReturnValue(250_000)
    replacement = await fixture.timedBinding({ identity: s.bob, iat: 250, exp: 350 })
    if (kind === 'null') replacement = null
    if (kind === 'expired') replacement = s.cached
    if (kind === 'foreign') replacement = { ...s.cached, id: 'did:kokuin:foreign' }
    if (kind === 'lower-time')
      replacement = await fixture.timedBinding({ identity: s.bob, iat: 90, exp: 350 })
    if (kind === 'horizon') replacement = await fixture.oversizedBinding(s.bob, 250, 350)
    const requests = vi.spyOn(s.mls, 'createRecoveryRequest')
    expect(await s.mls.prepareRecovery()).toBe('renewal-required')
    expect(requests).toHaveBeenCalledTimes(0)
    expect(host).toHaveBeenCalledTimes(kind === 'absent' ? 0 : 1)
  },
)

test('a tree-lapsed present leaf can external-renew with a fresh binding', async () => {
  let fresh: ControllerBinding
  const host = vi.fn(async () => fresh)
  const s = await setup(host)
  vi.spyOn(Date, 'now').mockReturnValue(250_000)
  const renewed = await renewLeaf(
    s.aliceGroup(),
    await fixture.timedBinding({ identity: s.alice, iat: 250, exp: 350 }),
  )
  s.installAlice(renewed.newGroup)
  await s.bobGroup().processMessage(renewed.commitMessage)
  expect(s.bobGroup().sendAdmission()).toMatchObject({ admissible: false, reason: 'lapsed' })
  fresh = await fixture.timedBinding({ identity: s.bob, iat: 250, exp: 350 })
  await expect(
    commitLedgerEntries(s.bobGroup(), [
      await signLedgerEntry(s.bob, {
        groupID: 'lifecycle-recovery',
        type: 'note',
        subject: s.bob.id,
        value: 'lapsed',
      }),
    ]),
  ).rejects.toThrow()
  expect(await s.mls.prepareRecovery()).toBe('ready')
  const pending = await buildRecovery(s)
  if (pending == null || 'renewalRequired' in pending) throw new Error('Expected pending recovery')
  await s.aliceGroup().processMessage(pending.commit)
  await pending.onAccepted()
  expect(s.bobGroup().sendAdmission().admissible).toBe(true)
})

test('a reply time floor prevents an external commit and asks the host at most once', async () => {
  const host = vi.fn(async () => null)
  const s = await setup(host)
  expect(await s.mls.prepareRecovery()).toBe('ready')
  vi.spyOn(Date, 'now').mockReturnValue(250_000)
  s.installAlice(await installFloor(s, 250))
  vi.spyOn(Date, 'now').mockReturnValue(150_000)
  const before = s.bobGroup()
  expect(await buildRecovery(s)).toEqual({ renewalRequired: true })
  expect(s.bobGroup()).toBe(before)
  expect(host).toHaveBeenCalledTimes(1)
})

test('a responder floor refusal discards the candidate, requires renewal and invalidates the refused binding', async () => {
  let offered: ControllerBinding | null = null
  const host = vi.fn(async () => offered)
  const s = await setup(host)
  const hub = createWireHub()
  const events: Array<RecoveryEvent> = []
  const aliceAccess = simpleHandleAccess({ handle: s.aliceGroup, adopt: s.installAlice })
  const alice = recoveryPeer({ hub, identity: s.alice, access: aliceAccess, mls: s.responder })
  const bob = recoveryPeer({
    hub,
    identity: s.bob,
    access: s.access,
    mls: s.mls,
    onRecovery: (event) => {
      events.push(event)
    },
  })
  const before = s.bobGroup()
  vi.spyOn(s.responder, 'processCommit').mockResolvedValue({
    advanced: false,
    epochBefore: 1,
    epochAfter: 1,
    refusal: 'floor',
  })
  try {
    await Promise.all([alice.resync(), bob.resync()])
    expect((await bob.recover()).advanced).toBe(false)
    expect(events).toContainEqual(
      expect.objectContaining({ phase: 'failed', reason: 'renewal-required' }),
    )
    expect(s.bobGroup()).toBe(before)
    offered = s.cached
    expect(await s.mls.prepareRecovery()).toBe('renewal-required')
    expect(host).toHaveBeenCalledTimes(1)
    offered = await fixture.timedBinding({ identity: s.bob, iat: 150, exp: 250 })
    expect(await s.mls.prepareRecovery()).toBe('ready')
    expect(host).toHaveBeenCalledTimes(2)
  } finally {
    await Promise.all([alice.dispose(), bob.dispose()])
    await hub.dispose()
  }
})

test('an authoritative invalid refusal holds automatic recovery until explicit recover', async () => {
  const s = await setup()
  const hub = createWireHub()
  const events: Array<RecoveryEvent> = []
  const alice = recoveryPeer({
    hub,
    identity: s.alice,
    access: simpleHandleAccess({ handle: s.aliceGroup, adopt: s.installAlice }),
    mls: s.responder,
  })
  const bob = recoveryPeer({
    hub,
    identity: s.bob,
    access: s.access,
    mls: s.mls,
    onRecovery: (event) => {
      events.push(event)
    },
  })
  const process = vi
    .spyOn(s.responder, 'processCommit')
    .mockResolvedValue({ advanced: false, epochBefore: 1, epochAfter: 1, refusal: 'invalid' })
  const requests = vi.spyOn(s.mls, 'createRecoveryRequest')
  try {
    await Promise.all([alice.resync(), bob.resync()])
    expect((await bob.recover()).advanced).toBe(false)
    expect(events).toContainEqual(
      expect.objectContaining({ phase: 'failed', reason: 'refused', refusal: 'invalid' }),
    )
    const count = requests.mock.calls.length
    await bob.resync()
    expect(requests).toHaveBeenCalledTimes(count)
    process.mockRestore()
    expect((await bob.recover()).advanced).toBe(true)
  } finally {
    await Promise.all([alice.dispose(), bob.dispose()])
    await hub.dispose()
  }
})

test('renewal-required suppresses subsequent automatic triggers and explicit recover reopens one attempt', async () => {
  let fresh: ControllerBinding | null = null
  const host = vi.fn(async () => fresh)
  const s = await setup(host, { aliceExp: 350 })
  const hub = createWireHub()
  const events: Array<RecoveryEvent> = []
  const aliceAccess = simpleHandleAccess({ handle: s.aliceGroup, adopt: s.installAlice })
  const aliceMLS = createGroupMLS({
    access: aliceAccess,
    identity: s.alice,
    entrySlot: createLedgerEntrySlot(),
  })
  const firstToken = await signLedgerEntry(s.alice, {
    groupID: 'lifecycle-recovery',
    type: 'note',
    subject: s.alice.id,
    value: 'first',
  })
  const first = await commitLedgerEntries(s.aliceGroup(), [firstToken])
  const second = await commitLedgerEntries(first.newGroup, [
    await signLedgerEntry(s.alice, {
      groupID: 'lifecycle-recovery',
      type: 'note',
      subject: s.alice.id,
      value: 'second',
    }),
  ])
  s.installAlice(second.newGroup)
  vi.spyOn(Date, 'now').mockReturnValue(250_000)
  const alicePeer = recoveryPeer({ hub, identity: s.alice, access: aliceAccess, mls: aliceMLS })
  const connection = hub.connect(fixture.agent(75))
  const topicID = commitTopic(await s.mls.exportRecoverySecret())
  await connection.publish({
    senderDID: fixture.agent(75).id,
    topicID,
    payload: encodeHandshakeFrame(
      HANDSHAKE_KIND.commit,
      encodeCommitFrame(second.commitMessage, new Uint8Array()),
    ),
    retain: 'log',
  })
  const requests = vi.spyOn(s.mls, 'createRecoveryRequest')
  const bobPeer = recoveryPeer({
    hub,
    identity: s.bob,
    access: s.access,
    mls: s.mls,
    onRecovery: (event) => events.push(event),
  })
  try {
    await alicePeer.resync()
    await bobPeer.resync()
    await vi.waitFor(() =>
      expect(
        events.some((event) => event.phase === 'failed' && event.reason === 'renewal-required'),
      ).toBe(true),
    )
    expect(requests).toHaveBeenCalledTimes(0)
    expect(host).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 3; i++) await bobPeer.resync()
    expect(host).toHaveBeenCalledTimes(1)
    expect(requests).toHaveBeenCalledTimes(0)
    expect(
      (
        await s.mls.processCommit(first.commitMessage, {
          resolveLedgerEntries: async () => [firstToken],
        })
      ).advanced,
    ).toBe(true)
    const third = await commitLedgerEntries(s.aliceGroup(), [
      await signLedgerEntry(s.alice, {
        groupID: 'lifecycle-recovery',
        type: 'note',
        subject: s.alice.id,
        value: 'third',
      }),
    ])
    await aliceAccess.replace(third.newGroup)
    await connection.publish({
      senderDID: fixture.agent(75).id,
      topicID,
      payload: encodeHandshakeFrame(
        HANDSHAKE_KIND.commit,
        encodeCommitFrame(third.commitMessage, new Uint8Array()),
      ),
      retain: 'log',
    })
    await bobPeer.resync()
    await vi.waitFor(() => expect(host).toHaveBeenCalledTimes(2))
    expect(requests).toHaveBeenCalledTimes(0)
    fresh = await fixture.timedBinding({ identity: s.bob, iat: 250, exp: 350 })
    expect(await bobPeer.recover()).toMatchObject({ advanced: true })
    expect(host).toHaveBeenCalledTimes(3)
    expect(
      events.filter((event) => event.phase === 'started' && event.trigger === 'consumer'),
    ).toHaveLength(1)
    expect(
      s
        .bobGroup()
        .listMembers()
        .filter((leaf) => leaf.id === s.bob.id),
    ).toHaveLength(1)
  } finally {
    await bobPeer.dispose()
    await alicePeer.dispose()
    await hub.dispose()
  }
}, 10_000)

test('a correctly signed reply with a ledger that misses the GroupInfo head returns null', async () => {
  const s = await setup()
  const entry = await signLedgerEntry(s.alice, {
    groupID: 'lifecycle-recovery',
    type: 'note',
    subject: s.alice.id,
    value: 'authenticated-ledger',
  })
  s.installAlice((await commitLedgerEntries(s.aliceGroup(), [entry])).newGroup)
  expect(await s.mls.prepareRecovery()).toBe('ready')
  vi.spyOn(s.aliceGroup(), 'getLedger').mockResolvedValue([])
  expect(await buildRecovery(s)).toBeNull()
  expect(s.bobGroup().epoch).toBe(1n)
})

test('standard group preparation never calls the lifecycle binding host', async () => {
  const identity = fixture.agent(44)
  const group = (await createGroup(identity, 'standard-recovery')).group
  const host = vi.fn(async () => null)
  const mls = createGroupMLS({
    access: simpleHandleAccess({ handle: () => group, adopt: () => {} }),
    identity,
    entrySlot: createLedgerEntrySlot(),
    recoveryBinding: host,
  })
  expect(await mls.prepareRecovery()).toBe('ready')
  expect(host).toHaveBeenCalledTimes(0)
  expect(group.epoch).toBe(0n)
})

test('a fresh binding supplied in preflight is not replaced a second time for a newer reply floor', async () => {
  let fresh: ControllerBinding
  const host = vi.fn(async () => fresh)
  const s = await setup(host)
  vi.spyOn(Date, 'now').mockReturnValue(250_000)
  fresh = await fixture.timedBinding({ identity: s.bob, iat: 250, exp: 350 })
  expect(await s.mls.prepareRecovery()).toBe('ready')
  vi.spyOn(Date, 'now').mockReturnValue(400_000)
  s.installAlice(await installFloor(s, 400))
  vi.spyOn(Date, 'now').mockReturnValue(250_000)
  expect(await buildRecovery(s)).toEqual({ renewalRequired: true })
  expect(host).toHaveBeenCalledTimes(1)
  expect(s.bobGroup().epoch).toBe(1n)
})

test('a delegated replacement that lowers tree time requires renewal before requesting', async () => {
  let replacement: ControllerBinding | null = null
  const host = vi.fn(async () => replacement)
  const s = await setup(host, { bobIat: 180, clock: 190 })
  const trusted = fixture.agent(65)
  const parent = await fixture.timedBinding({ identity: trusted, iat: 90, exp: 400 })
  const pipeline = (await import(
    new URL('../../../packages/mls/test/fixtures/lifecycle-pipeline.ts', import.meta.url).href
  )) as {
    timedBinding: (params: {
      identity: OwnIdentity
      iat: number
      exp: number
      parent: string
      issuer: OwnIdentity
    }) => Promise<ControllerBinding>
  }
  replacement = await pipeline.timedBinding({
    identity: s.bob,
    iat: 250,
    exp: 350,
    parent: parent.capability,
    issuer: trusted,
  })
  vi.spyOn(Date, 'now').mockReturnValue(250_000)
  expect(await s.mls.prepareRecovery()).toBe('renewal-required')
  expect(host).toHaveBeenCalledTimes(1)
})

test('a generation floor in the reply ledger prevents publication of a cached pre-reset binding', async () => {
  const host = vi.fn(async () => null)
  const s = await setup(host)
  const prefix = fixture.resetPrefix()
  const replacement = await joinGroupExternal({
    identity: s.bob,
    groupInfo: (await exportGroupInfo({ group: s.aliceGroup() })).groupInfo,
    credential: s.bobGroup().credential,
    resync: true,
    controller: await fixture.timedBinding({ identity: s.bob, iat: 100, exp: 200, prefix }),
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
  if (reset.status !== 'built') throw new Error('Expected reset commit')
  s.installAlice(reset.result.newGroup)
  expect(s.aliceGroup().registry.controllers.get(fixture.controllerID)?.genFloor).toBe(1)
  expect(await s.mls.prepareRecovery()).toBe('ready')
  expect(await buildRecovery(s)).toEqual({ renewalRequired: true })
  expect(host).toHaveBeenCalledTimes(1)
  expect(s.bobGroup().epoch).toBe(1n)
})

test.each(['expired', 'future', 'malformed'] as const)(
  'an unusable %s host replacement after the reply requires renewal',
  async (kind) => {
    let replacement: ControllerBinding
    const host = vi.fn(async () => replacement)
    const s = await setup(host)
    replacement =
      kind === 'expired'
        ? await fixture.timedBinding({ identity: s.bob, iat: 100, exp: 140 })
        : await fixture.timedBinding({ identity: s.bob, iat: 250, exp: 350 })
    if (kind === 'malformed') replacement = { ...s.cached, capability: 'malformed' }
    expect(await s.mls.prepareRecovery()).toBe('ready')
    vi.spyOn(Date, 'now').mockReturnValue(250_000)
    s.installAlice(await installFloor(s, 250))
    vi.spyOn(Date, 'now').mockReturnValue(150_000)
    expect(await buildRecovery(s)).toEqual({ renewalRequired: true })
    expect(host).toHaveBeenCalledTimes(1)
  },
)

test('a lifecycle GroupInfo reply requires a requester leaf in the responder tree', async () => {
  const s = await setup()
  const outsider = fixture.agent(66)
  const group = (
    await createGroup(outsider, 'lifecycle-recovery', {
      controller: await fixture.timedBinding({ identity: outsider, iat: 100, exp: 200 }),
    })
  ).group
  const mls = createGroupMLS({
    access: simpleHandleAccess({ handle: () => group, adopt: () => {} }),
    identity: outsider,
    entrySlot: createLedgerEntrySlot(),
  })
  const request = await mls.createRecoveryRequest('outsider-request')
  await expect(s.responder.sealGroupInfo(request)).rejects.toMatchObject({ reason: 'not-a-member' })
})

test('a reply-ledger floor ends peer recovery without publication and holds later automatic triggers', async () => {
  let replacement: ControllerBinding | null = null
  const host = vi.fn(async () => replacement)
  const s = await setup(host)
  vi.spyOn(Date, 'now').mockReturnValue(250_000)
  s.installAlice(await installFloor(s, 250))
  const ahead = await commitLedgerEntries(s.aliceGroup(), [
    await signLedgerEntry(s.alice, {
      groupID: 'lifecycle-recovery',
      type: 'note',
      subject: s.alice.id,
      value: 'ahead',
    }),
  ])
  s.installAlice(ahead.newGroup)
  vi.spyOn(Date, 'now').mockReturnValue(150_000)
  const hub = createWireHub()
  const events: Array<RecoveryEvent> = []
  const aliceAccess = simpleHandleAccess({ handle: s.aliceGroup, adopt: s.installAlice })
  const alicePeer = recoveryPeer({
    hub,
    identity: s.alice,
    access: aliceAccess,
    mls: createGroupMLS({
      access: aliceAccess,
      identity: s.alice,
      entrySlot: createLedgerEntrySlot(),
    }),
  })
  const bobPeer = recoveryPeer({
    hub,
    identity: s.bob,
    access: s.access,
    mls: s.mls,
    onRecovery: (event) => events.push(event),
  })
  const identity = fixture.agent(75)
  const connection = hub.connect(identity)
  const topicID = commitTopic(await s.mls.exportRecoverySecret())
  await connection.subscribe(identity.id, topicID)
  const requests = vi.spyOn(s.mls, 'createRecoveryRequest')
  try {
    await alicePeer.resync()
    await bobPeer.resync()
    expect(await bobPeer.recover()).toMatchObject({ advanced: false })
    expect(
      events.some((event) => event.phase === 'failed' && event.reason === 'renewal-required'),
    ).toBe(true)
    expect(host).toHaveBeenCalledTimes(1)
    expect(requests).toHaveBeenCalledTimes(1)
    expect(
      (await connection.fetchTopic({ subscriberDID: identity.id, topicID })).messages,
    ).toHaveLength(0)
    await connection.publish({
      senderDID: identity.id,
      topicID,
      payload: encodeHandshakeFrame(
        HANDSHAKE_KIND.commit,
        encodeCommitFrame(ahead.commitMessage, new Uint8Array()),
      ),
      retain: 'log',
    })
    for (let i = 0; i < 3; i++) await bobPeer.resync()
    expect(host).toHaveBeenCalledTimes(1)
    expect(requests).toHaveBeenCalledTimes(1)
    expect(s.bobGroup().epoch).toBe(1n)
    replacement = await fixture.timedBinding({ identity: s.bob, iat: 150, exp: 350 })
    expect(await bobPeer.recover()).toMatchObject({ advanced: true })
    expect(host).toHaveBeenCalledTimes(2)
  } finally {
    await bobPeer.dispose()
    await alicePeer.dispose()
    await hub.dispose()
  }
}, 10_000)

async function ineligibleReply(
  s: Awaited<ReturnType<typeof setup>>,
  kind: 'leafless' | 'revoked' | 'issuer',
) {
  vi.spyOn(Date, 'now').mockReturnValue(250_000)
  s.installAlice(await installFloor(s, 250))
  vi.spyOn(Date, 'now').mockReturnValue(150_000)
  const identity = kind === 'leafless' ? fixture.agent(81) : s.alice
  if (kind !== 'leafless') {
    const devices = s.bobGroup().registry.devices as Map<
      string,
      { controller: string; status: 'revoked' }
    >
    devices.set(kind === 'issuer' ? fixture.agent(65).id : s.alice.id, {
      controller: fixture.controllerID,
      status: 'revoked',
    })
  }
  const handle = new GroupHandle({
    state: s.aliceGroup().state,
    context: s.aliceGroup().context,
    credential: { id: identity.id, groupID: s.aliceGroup().groupID },
  })
  await handle.bootstrapLedger(s.aliceGroup().ledgerTokens)
  return createGroupMLS({
    identity,
    entrySlot: createLedgerEntrySlot(),
    access: simpleHandleAccess({
      handle: () => handle,
      adopt: () => {
        throw new Error('Unexpected adoption')
      },
    }),
  })
}

test.each(['leafless', 'revoked', 'issuer'] as const)(
  'an ineligible %s attestation cannot request binding remediation from a failing reply',
  async (kind) => {
    const host = vi.fn(async () => null)
    const s = await setup(host)
    expect(await s.mls.prepareRecovery()).toBe('ready')
    const responder = await ineligibleReply(s, kind)
    const request = await s.mls.createRecoveryRequest('ineligible-binding')
    const result = await s.mls.applyRecovery(
      await responder.sealGroupInfo(request),
      'ineligible-binding',
    )
    expect({ result, hostCalls: host.mock.calls.length }).toEqual({ result: null, hostCalls: 0 })
    expect(s.bobGroup().epoch).toBe(1n)
  },
)

test('an ineligible attestation cannot impose a renewal-required peer hold', async () => {
  const wallClock = Date.now.bind(Date)
  const host = vi.fn(async () => null)
  const s = await setup(host)
  const responder = await ineligibleReply(s, 'leafless')
  const ahead = await commitLedgerEntries(s.aliceGroup(), [
    await signLedgerEntry(s.alice, {
      groupID: s.aliceGroup().groupID,
      type: 'note',
      subject: s.alice.id,
      value: 'ahead',
    }),
  ])
  s.installAlice(ahead.newGroup)
  const started = wallClock()
  vi.spyOn(Date, 'now').mockImplementation(() => 150_000 + wallClock() - started)
  const hub = createWireHub()
  const events: Array<RecoveryEvent> = []
  const alicePeer = recoveryPeer({
    hub,
    identity: s.alice,
    mls: responder,
    deadlineMs: 100,
    access: simpleHandleAccess({ handle: s.aliceGroup, adopt: s.installAlice }),
  })
  const bobPeer = recoveryPeer({
    hub,
    identity: s.bob,
    access: s.access,
    mls: s.mls,
    deadlineMs: 100,
    onRecovery: (event) => events.push(event),
  })
  const requests = vi.spyOn(s.mls, 'createRecoveryRequest')
  try {
    await alicePeer.resync()
    await bobPeer.resync()
    expect(await bobPeer.recover()).toMatchObject({ advanced: false })
    expect(
      events.filter((event) => event.phase === 'failed').map((event) => event.reason),
    ).not.toContain('renewal-required')
    expect(host).not.toHaveBeenCalled()
    const previous = requests.mock.calls.length
    const connection = hub.connect(fixture.agent(75))
    await connection.publish({
      senderDID: fixture.agent(75).id,
      topicID: commitTopic(await s.mls.exportRecoverySecret()),
      payload: encodeHandshakeFrame(
        HANDSHAKE_KIND.commit,
        encodeCommitFrame(ahead.commitMessage, new Uint8Array()),
      ),
      retain: 'log',
    })
    await bobPeer.resync()
    await vi.waitFor(() => expect(requests.mock.calls.length).toBeGreaterThan(previous))
    await vi.waitFor(() =>
      expect(
        events.some((event) => event.phase === 'failed' && event.trigger === 'automatic'),
      ).toBe(true),
    )
    expect(
      events.filter((event) => event.phase === 'failed').map((event) => event.reason),
    ).not.toContain('renewal-required')
    expect(host).not.toHaveBeenCalled()
    expect(s.bobGroup().epoch).toBe(1n)
  } finally {
    await bobPeer.dispose()
    await alicePeer.dispose()
    await hub.dispose()
  }
})
