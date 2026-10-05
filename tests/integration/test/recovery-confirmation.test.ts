import { type OwnIdentity, randomIdentity } from '@kokuin/token'
import {
  commitInvite,
  confirmationTag,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  GroupHandle,
  ledgerEntryDigest,
  processWelcome,
  removeMember,
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
  decodeHandshakeFrame,
  decodeRecoveryConfirmRequest,
  encodeHandshakeFrame,
  encodeRecoveryConfirmRequest,
  encodeRecoveryVerdict,
  HANDSHAKE_KIND,
  type RecoveryEvent,
} from '@kumiai/rpc'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'

import {
  chat,
  createMemoryAnchorStore,
  createMemoryAppCursorStore,
  createMemoryAppOutbox,
  createMemoryCommitJournal,
  type Protocols,
} from './app-lane-e2e.js'
import { createWireHub } from './log-hub-over-wire.js'

beforeAll(async () => {
  await import(new URL('../../../packages/mls/src/recovery.ts', import.meta.url).href)
})

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()))
  vi.restoreAllMocks()
})

function gate() {
  let release = () => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

async function setup(options: { third?: boolean; deadlineMs?: number } = {}) {
  const hub = createWireHub()
  const aliceID = randomIdentity()
  const bobID = randomIdentity()
  let aliceGroup = (await createGroup(aliceID, 'confirmation')).group
  const bundle = await createKeyPackageBundle(bobID)
  const { invite } = await createInvite({
    group: aliceGroup,
    identity: aliceID,
    recipientDID: bobID.id,
    permission: 'member',
  })
  const added = await commitInvite(aliceGroup, bundle.publicPackage, invite)
  aliceGroup = added.newGroup
  const bobSlot = createLedgerEntrySlot()
  bobSlot.install(async (ids) =>
    ids.map((id) => {
      const token = aliceGroup.ledgerTokens.find((token) => ledgerEntryDigest(token) === id)
      if (token == null) throw new Error('Missing fixture ledger entry')
      return token
    }),
  )
  let bobGroup = (
    await processWelcome({
      identity: bobID,
      invite,
      welcome: added.welcomeMessage,
      keyPackageBundle: bundle,
      options: { resolveLedgerEntries: bobSlot.resolve },
    })
  ).group
  const carolID = randomIdentity()
  let carolGroup: GroupHandle | undefined
  if (options.third) {
    const material = await createKeyPackageBundle(carolID)
    const offered = await createInvite({
      group: aliceGroup,
      identity: aliceID,
      recipientDID: carolID.id,
      permission: 'member',
    })
    const commit = await commitInvite(aliceGroup, material.publicPackage, offered.invite)
    aliceGroup = commit.newGroup
    await bobGroup.processMessage(commit.commitMessage)
    carolGroup = (
      await processWelcome({
        identity: carolID,
        invite: offered.invite,
        welcome: commit.welcomeMessage,
        keyPackageBundle: material,
      })
    ).group
  }
  const initial = bobGroup
  const aliceAccess = simpleHandleAccess({
    handle: () => aliceGroup,
    adopt: (next) => {
      aliceGroup = next
    },
  })
  const bobAccess = simpleHandleAccess({
    handle: () => bobGroup,
    adopt: (next) => {
      bobGroup = next
    },
  })
  const aliceMLS = createGroupMLS({
    access: aliceAccess,
    identity: aliceID,
    entrySlot: createLedgerEntrySlot(),
  })
  const bobMLS = createGroupMLS({ access: bobAccess, identity: bobID, entrySlot: bobSlot })
  const aliceConnection = hub.connect(aliceID)
  const bobConnection = hub.connect(bobID)
  const events: Array<RecoveryEvent> = []
  const published: Array<number> = []
  const publish = bobConnection.publish.bind(bobConnection)
  bobConnection.publish = async (value) => {
    try {
      published.push(decodeHandshakeFrame(value.payload).kind)
    } catch {}
    return publish(value)
  }
  const received: Array<string> = []
  const strands: Array<unknown> = []
  function peer(
    identity: typeof aliceID,
    access: typeof aliceAccess,
    mls: typeof aliceMLS,
    connection: typeof aliceConnection,
  ) {
    return createGroupPeer<Protocols>({
      appOutbox: createMemoryAppOutbox(),
      appOutboxLimit: 128,
      hub: connection,
      crypto: createGroupCrypto({ access }),
      mls,
      localDID: identity.id,
      protocols: { chat },
      handlers: {
        chat: {
          'chat/changed': () => {},
          'chat/double': () => ({}),
          'chat/posted': ({ data }) => {
            if (typeof data.text === 'string') received.push(data.text)
          },
        },
      },
      journal: createMemoryCommitJournal(),
      anchorStore: createMemoryAnchorStore(),
      appCursorStore: createMemoryAppCursorStore(),
      adoptJournalled: async () => {},
      onRecovery: (event) => {
        events.push(event)
      },
      onStrand: (event) => {
        strands.push(event)
      },
      recovery: { timeoutMs: 60, deadlineMs: options.deadlineMs ?? 450, getDelayMs: () => 0 },
    })
  }
  const alice = peer(aliceID, aliceAccess, aliceMLS, aliceConnection)
  const bob = peer(bobID, bobAccess, bobMLS, bobConnection)
  const carolAccess =
    carolGroup == null
      ? undefined
      : simpleHandleAccess({
          handle: () => {
            if (carolGroup == null) throw new Error('No carol')
            return carolGroup
          },
          adopt: (next) => {
            carolGroup = next
          },
        })
  const carolMLS =
    carolAccess == null
      ? undefined
      : createGroupMLS({
          access: carolAccess,
          identity: carolID,
          entrySlot: createLedgerEntrySlot(),
        })
  const carol =
    carolMLS == null || carolAccess == null
      ? undefined
      : peer(carolID, carolAccess, carolMLS, hub.connect(carolID))
  cleanup.push(async () => {
    await Promise.all([alice.dispose(), bob.dispose(), carol?.dispose()])
    await hub.dispose()
  })
  await Promise.all([alice.resync(), bob.resync(), carol?.resync()])
  return {
    alice,
    bob,
    carol,
    aliceMLS,
    bobMLS,
    carolMLS,
    carolID,
    carolGroup: () => carolGroup,
    aliceAccess,
    bobAccess,
    aliceID,
    aliceConnection,
    bobConnection,
    events,
    published,
    received,
    strands,
    initial,
    aliceGroup: () => aliceGroup,
    bobGroup: () => bobGroup,
    bobID,
  }
}

test('publication keeps the old handle until a survivor confirms, then delivers at the confirmed epoch', async () => {
  const s = await setup({ deadlineMs: 10_000 })
  const pause = gate()
  cleanup.push(async () => pause.release())
  const seal = s.aliceMLS.sealRecoveryVerdict.bind(s.aliceMLS)
  const sealing = vi
    .spyOn(s.aliceMLS, 'sealRecoveryVerdict')
    .mockImplementation(async (...args) => {
      await pause.promise
      return seal(...args)
    })
  const recovery = s.bob.recover()
  void recovery.catch(() => {})
  await vi.waitFor(() => expect(s.published).toContain(HANDSHAKE_KIND.commit))
  expect(s.bobGroup()).toBe(s.initial)
  expect(s.bob.anchorEpoch()).toBe(Number(s.initial.epoch))
  await vi.waitFor(() => expect(sealing).toHaveBeenCalled())
  await s.aliceConnection.publish({
    senderDID: s.aliceID.id,
    topicID: commitTopic(await s.bobMLS.exportRecoverySecret()),
    payload: new Uint8Array([0]),
  })
  await new Promise((resolve) => setTimeout(resolve, 60))
  expect(s.strands).toHaveLength(0)
  expect(s.bobGroup()).toBe(s.initial)
  pause.release()
  expect(await recovery).toEqual({ advanced: true, reenact: [] })
  expect(s.published.filter((kind) => kind === HANDSHAKE_KIND.recoveryRequest)).toHaveLength(1)
  expect(s.published.filter((kind) => kind === HANDSHAKE_KIND.commit)).toHaveLength(1)
  expect(
    s
      .aliceGroup()
      .listMembers()
      .filter((member) => member.id === s.bobID.id),
  ).toHaveLength(1)
  await s.bob.protocol('chat').dispatch('chat/posted', { data: { text: 'confirmed delivery' } })
  await vi.waitFor(() => expect(s.received).toContain('confirmed delivery'))
})

test('lost confirmations through the deadline leave an orphan which the next rejoin collects', async () => {
  const s = await setup()
  const publish = s.aliceConnection.publish.bind(s.aliceConnection)
  let dropping = true
  s.aliceConnection.publish = async (value) =>
    publish(
      dropping && decodeHandshakeFrame(value.payload).kind === HANDSHAKE_KIND.recoveryVerdict
        ? { ...value, payload: new Uint8Array([0]) }
        : value,
    )
  expect((await s.bob.recover()).advanced).toBe(false)
  expect(s.events).toContainEqual(
    expect.objectContaining({ phase: 'failed', reason: 'unconfirmed', advisory: [] }),
  )
  expect(s.bobGroup()).toBe(s.initial)
  expect(
    s
      .aliceGroup()
      .listMembers()
      .filter((member) => member.id === s.bobID.id),
  ).toHaveLength(1)
  dropping = false
  await vi.waitFor(() => expect(s.bobGroup().epoch).toBe(s.aliceGroup().epoch), { timeout: 2500 })
  await vi.waitFor(() =>
    expect(s.events).toContainEqual(expect.objectContaining({ phase: 'succeeded' })),
  )
  expect(
    s
      .aliceGroup()
      .listMembers()
      .filter((member) => member.id === s.bobID.id),
  ).toHaveLength(1)
})

test('simultaneous recovery releases both lanes while a third member confirms', async () => {
  const s = await setup({ third: true, deadlineMs: 10_000 })
  const pause = gate()
  cleanup.push(async () => pause.release())
  const fetch = s.bobConnection.fetchTopic.bind(s.bobConnection)
  let waiting = false
  let held = false
  const topicID = commitTopic(await s.bobMLS.exportRecoverySecret())
  s.bobConnection.fetchTopic = async (params) => {
    if (!held && params.topicID === topicID && params.limit === 1) {
      held = true
      waiting = true
      await pause.promise
    }
    return fetch(params)
  }
  const recoveringBob = s.bob.recover()
  void recoveringBob.catch(() => {})
  await vi.waitFor(() => expect(waiting).toBe(true))
  const alice = await s.alice.recover()
  pause.release()
  const bob = await recoveringBob
  expect(alice.advanced).toBe(true)
  expect(bob.advanced).toBe(true)
  await s.alice.resync()
  await s.bob.resync()
  expect(s.aliceGroup().epoch).toBe(s.bobGroup().epoch)
  expect(
    s
      .aliceGroup()
      .listMembers()
      .filter((member) => member.id === s.bobID.id),
  ).toHaveLength(1)
  await s.alice.protocol('chat').dispatch('chat/posted', { data: { text: 'both confirmed' } })
  await vi.waitFor(() => expect(s.received).toContain('both confirmed'))
})

test('stale GroupInfo is superseded and retried without adopting the stale candidate', async () => {
  const s = await setup({ deadlineMs: 10_000 })
  const source = s.aliceGroup()
  const stalePort = createGroupMLS({
    access: simpleHandleAccess({ handle: () => source, adopt: () => {} }),
    identity: s.aliceID,
    entrySlot: createLedgerEntrySlot(),
  })
  const carol = randomIdentity()
  const material = await createKeyPackageBundle(carol)
  const offered = await createInvite({
    group: source,
    identity: s.aliceID,
    recipientDID: carol.id,
    permission: 'member',
  })
  const rotated = await commitInvite(source, material.publicPackage, offered.invite)
  await s.aliceAccess.replace(rotated.newGroup)
  const seal = s.aliceMLS.sealGroupInfo.bind(s.aliceMLS)
  vi.spyOn(s.aliceMLS, 'sealGroupInfo')
    .mockImplementationOnce((request) => stalePort.sealGroupInfo(request))
    .mockImplementation(seal)
  const adopted: Array<number> = []
  const replace = s.bobAccess.replace.bind(s.bobAccess)
  vi.spyOn(s.bobAccess, 'replace').mockImplementation(async (group) => {
    adopted.push(Number(group.epoch))
    await replace(group)
  })
  expect((await s.bob.recover()).advanced).toBe(true)
  expect(adopted).toEqual([3])
  expect(s.published.filter((kind) => kind === HANDSHAKE_KIND.commit)).toHaveLength(2)
  expect(
    s
      .aliceGroup()
      .listMembers()
      .filter((member) => member.id === s.bobID.id),
  ).toHaveLength(1)
})

test('an invalid verdict envelope and a copied request for another position suppress nothing', async () => {
  const s = await setup({ deadlineMs: 10_000 })
  let previous: ReturnType<typeof decodeRecoveryConfirmRequest> | undefined
  const publish = s.bobConnection.publish.bind(s.bobConnection)
  s.bobConnection.publish = async (value) => {
    const frame = decodeHandshakeFrame(value.payload)
    if (frame.kind === HANDSHAKE_KIND.recoveryConfirmRequest)
      previous = decodeRecoveryConfirmRequest(frame.payload)
    return publish(value)
  }
  expect((await s.bob.recover()).advanced).toBe(true)
  if (previous == null) throw new Error('No first confirmation request')
  const earlier = previous
  let injected = false
  s.bobConnection.publish = async (value) => {
    const frame = decodeHandshakeFrame(value.payload)
    if (frame.kind === HANDSHAKE_KIND.recoveryConfirmRequest && !injected) {
      injected = true
      const request = decodeRecoveryConfirmRequest(frame.payload)
      await s.aliceConnection.publish({
        senderDID: s.aliceID.id,
        topicID: value.topicID,
        payload: encodeHandshakeFrame(
          HANDSHAKE_KIND.recoveryVerdict,
          encodeRecoveryVerdict(request.requestID, new Uint8Array([0])),
        ),
      })
      await publish({
        ...value,
        payload: encodeHandshakeFrame(
          HANDSHAKE_KIND.recoveryConfirmRequest,
          encodeRecoveryConfirmRequest({
            ...request,
            position: earlier.position,
            commitDigest: earlier.commitDigest,
          }),
        ),
      })
      await publish({
        ...value,
        payload: encodeHandshakeFrame(
          HANDSHAKE_KIND.recoveryConfirmRequest,
          encodeRecoveryConfirmRequest({ ...request, commitDigest: 'wrong-digest' }),
        ),
      })
    }
    return publish(value)
  }
  expect((await s.bob.recover()).advanced).toBe(true)
  expect(injected).toBe(true)
  expect(s.published.filter((kind) => kind === HANDSHAKE_KIND.commit)).toHaveLength(2)
})

test('forged confirmations are ignored and an unknown signer refusal is advisory', async () => {
  const s = await setup()
  const outsider = randomIdentity()
  const { sealRealRecoveryVerdict } = (await import(
    new URL('../../../packages/mls-rpc/test/fixtures/real-group.ts', import.meta.url).href
  )) as {
    sealRealRecoveryVerdict: (
      member: { identity: OwnIdentity; handle: GroupHandle },
      request: Uint8Array,
      verdict: Record<string, unknown>,
    ) => Promise<Uint8Array>
  }
  const seal = s.aliceMLS.sealRecoveryVerdict.bind(s.aliceMLS)
  vi.spyOn(s.aliceMLS, 'sealRecoveryVerdict').mockImplementation(async (request, verdict) => {
    if (verdict.verdict !== 'confirmed') return seal(request, verdict)
    const refusal = { ...verdict, verdict: 'refused', reason: 'policy' }
    return sealRealRecoveryVerdict({ identity: outsider, handle: s.aliceGroup() }, request, refusal)
  })
  const publish = s.bobConnection.publish.bind(s.bobConnection)
  s.bobConnection.publish = async (value) => {
    const frame = decodeHandshakeFrame(value.payload)
    if (frame.kind === HANDSHAKE_KIND.recoveryConfirmRequest) {
      const request = decodeRecoveryConfirmRequest(frame.payload)
      const forged = await seal(request.request, {
        groupID: s.aliceGroup().groupID,
        requestID: request.requestID,
        position: request.position,
        commitDigest: request.commitDigest,
        verdict: 'confirmed',
        epoch: Number(s.aliceGroup().epoch),
        tag: confirmationTag(new Uint8Array(32), request.requestID),
      })
      await s.aliceConnection.publish({
        senderDID: s.aliceID.id,
        topicID: value.topicID,
        payload: encodeHandshakeFrame(
          HANDSHAKE_KIND.recoveryVerdict,
          encodeRecoveryVerdict(request.requestID, forged),
        ),
      })
    }
    return publish(value)
  }
  expect((await s.bob.recover()).advanced).toBe(false)
  const outcome = s.events.find(
    (event) => event.phase === 'failed' && event.reason === 'unconfirmed',
  )
  expect(outcome).toMatchObject({
    advisory: [
      expect.objectContaining({
        signer: outsider.id,
        verdict: expect.objectContaining({ verdict: 'refused', reason: 'policy' }),
      }),
    ],
  })
  expect(s.bobGroup()).toBe(s.initial)
  vi.restoreAllMocks()
  expect((await s.bob.recover()).advanced).toBe(true)
})

test('a ratchet of the old handle while pending invalidates adoption on revalidation', async () => {
  const s = await setup({ deadlineMs: 10_000 })
  const source = s.aliceGroup()
  const carol = randomIdentity()
  const bundle = await createKeyPackageBundle(carol)
  const offered = await createInvite({
    group: source,
    identity: s.aliceID,
    recipientDID: carol.id,
    permission: 'member',
  })
  const alternative = await commitInvite(source, bundle.publicPackage, offered.invite)
  const pause = gate()
  cleanup.push(async () => pause.release())
  const seal = s.aliceMLS.sealRecoveryVerdict.bind(s.aliceMLS)
  const sealing = vi
    .spyOn(s.aliceMLS, 'sealRecoveryVerdict')
    .mockImplementation(async (...args) => {
      await pause.promise
      return seal(...args)
    })
  const pending = s.bob.recover()
  void pending.catch(() => {})
  await vi.waitFor(() => expect(sealing).toHaveBeenCalled())
  expect(
    (
      await s.bobMLS.processCommit(alternative.commitMessage, {
        resolveLedgerEntries: async (ids) =>
          ids.map((id) => {
            const token = alternative.newGroup.ledgerTokens.find(
              (token) => ledgerEntryDigest(token) === id,
            )
            if (token == null) throw new Error('No alternative entry')
            return token
          }),
      })
    ).advanced,
  ).toBe(true)
  const oldRatchet = s.bobGroup()
  pause.release()
  expect((await pending).advanced).toBe(false)
  expect(s.bobGroup()).toBe(oldRatchet)
  expect(s.events).toContainEqual(
    expect.objectContaining({ phase: 'failed', reason: 'unconfirmed' }),
  )
})

test('confirmation requests received during another recovery preflight pull after the lane releases', async () => {
  const s = await setup({ third: true, deadlineMs: 10_000 })
  const pause = gate()
  cleanup.push(async () => pause.release())
  const prepare = s.bobMLS.prepareRecovery.bind(s.bobMLS)
  const preparing = vi.spyOn(s.bobMLS, 'prepareRecovery').mockImplementationOnce(async () => {
    await pause.promise
    return prepare()
  })
  const bob = s.bob.recover()
  void bob.catch(() => {})
  await vi.waitFor(() => expect(preparing).toHaveBeenCalled())
  expect((await s.alice.recover()).advanced).toBe(true)
  pause.release()
  await bob
  expect((await s.bob.recover()).advanced).toBe(true)
  await s.alice.resync()
  expect(s.aliceGroup().epoch).toBe(s.bobGroup().epoch)
})

test.each(['policy', 'invalid'] as const)(
  'authoritative %s refusal holds until explicit recovery',
  async (reason) => {
    const s = await setup({ deadlineMs: 10_000 })
    const process = s.aliceMLS.processCommit.bind(s.aliceMLS)
    vi.spyOn(s.aliceMLS, 'processCommit').mockImplementation(async () => {
      const epoch = await s.aliceMLS.readEpoch()
      return { advanced: false, epochBefore: epoch, epochAfter: epoch, refusal: reason }
    })
    expect(await s.bob.recover()).toEqual({ advanced: false, reenact: [] })
    expect(s.bobGroup()).toBe(s.initial)
    expect(s.events).toContainEqual(
      expect.objectContaining({ phase: 'failed', reason: 'refused', refusal: reason }),
    )
    const requests = s.published.filter((kind) => kind === HANDSHAKE_KIND.recoveryRequest).length
    await s.aliceConnection.publish({
      senderDID: s.aliceID.id,
      topicID: commitTopic(await s.bobMLS.exportRecoverySecret()),
      payload: new Uint8Array([0]),
    })
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(s.published.filter((kind) => kind === HANDSHAKE_KIND.recoveryRequest)).toHaveLength(
      requests,
    )
    vi.spyOn(s.aliceMLS, 'processCommit').mockImplementation(process)
    expect((await s.bob.recover()).advanced).toBe(true)
  },
)

test.each([false, true])(
  'a removed last-known signer is advisory with survivors silent: %s',
  async (silent) => {
    const s = await setup({ third: true, deadlineMs: silent ? 450 : 10_000 })
    const removedGroup = s.carolGroup()
    if (removedGroup == null || s.carol == null) throw new Error('Missing third member')
    await s.carol.dispose()
    const leaf = s.aliceGroup().findMemberLeafIndex(s.carolID.id)
    if (leaf == null) throw new Error('Missing removed leaf')
    const removal = await removeMember(s.aliceGroup(), leaf)
    await s.aliceAccess.replace(removal.newGroup)
    expect(s.bobGroup().findMemberLeafIndex(s.carolID.id)).toBeDefined()
    expect(s.aliceGroup().findMemberLeafIndex(s.carolID.id)).toBeUndefined()
    const { sealRealRecoveryVerdict } = await import(
      new URL('../../../packages/mls-rpc/test/fixtures/real-group.ts', import.meta.url).href
    )
    const publish = s.bobConnection.publish.bind(s.bobConnection)
    let injected = false
    s.bobConnection.publish = async (value) => {
      const frame = decodeHandshakeFrame(value.payload)
      if (frame.kind === HANDSHAKE_KIND.recoveryConfirmRequest && !injected) {
        injected = true
        const request = decodeRecoveryConfirmRequest(frame.payload)
        const sealed = await sealRealRecoveryVerdict(
          { identity: s.carolID, handle: removedGroup },
          request.request,
          {
            groupID: removedGroup.groupID,
            requestID: request.requestID,
            position: request.position,
            commitDigest: request.commitDigest,
            verdict: 'refused',
            reason: 'policy',
          },
        )
        await s.aliceConnection.publish({
          senderDID: s.aliceID.id,
          topicID: value.topicID,
          payload: encodeHandshakeFrame(
            HANDSHAKE_KIND.recoveryVerdict,
            encodeRecoveryVerdict(request.requestID, sealed),
          ),
        })
      }
      return publish(value)
    }
    if (silent) {
      const publishVerdict = s.aliceConnection.publish.bind(s.aliceConnection)
      s.aliceConnection.publish = async (value) => {
        const frame = decodeHandshakeFrame(value.payload)
        if (frame.kind === HANDSHAKE_KIND.recoveryVerdict) {
          const { sealed, requestID } = (await import('@kumiai/rpc')).decodeRecoveryVerdict(
            frame.payload,
          )
          const opened = await s.bobMLS.openRecoveryVerdict(sealed, requestID)
          if (opened?.signer === s.aliceID.id)
            return publishVerdict({ ...value, payload: new Uint8Array([0]) })
        }
        return publishVerdict(value)
      }
    }
    expect((await s.bob.recover()).advanced).toBe(!silent)
    expect(injected).toBe(true)
    if (silent) {
      expect(s.bobGroup()).toBe(s.initial)
      expect(s.events).toContainEqual(
        expect.objectContaining({
          phase: 'failed',
          reason: 'unconfirmed',
          advisory: [
            expect.objectContaining({
              signer: s.carolID.id,
              verdict: expect.objectContaining({ verdict: 'refused', reason: 'policy' }),
            }),
          ],
        }),
      )
    } else {
      expect(s.bobGroup().epoch).toBe(s.aliceGroup().epoch)
      expect(s.events.some((event) => event.phase === 'failed')).toBe(false)
    }
  },
)

test.each(['policy', 'invalid'] as const)(
  'real adapter classifies external recovery rejection as %s',
  async (reason) => {
    const s = await setup({ deadlineMs: 10_000 })
    const original = s.aliceGroup()
    if (reason === 'policy') {
      const rejector = new GroupHandle({
        state: original.state,
        context: original.context,
        credential: original.credential,
        commitPolicy: () => 'reject',
      })
      await rejector.bootstrapLedger(original.ledgerTokens)
      await s.aliceAccess.replace(rejector)
    } else {
      const { lowLevelExternal } = await import(
        new URL('../../../packages/mls/test/fixtures/lifecycle-pipeline.ts', import.meta.url).href
      )
      const malformed = await lowLevelExternal(original, s.bobID, undefined, { resync: false })
      const apply = s.bobMLS.applyRecovery.bind(s.bobMLS)
      vi.spyOn(s.bobMLS, 'applyRecovery').mockImplementation(async (...args) => {
        const pending = await apply(...args)
        if (pending == null || 'renewalRequired' in pending) return pending
        return { ...pending, commit: malformed }
      })
    }
    const process = vi.spyOn(s.aliceMLS, 'processCommit')
    expect((await s.bob.recover()).advanced).toBe(false)
    expect(process).toHaveReturned()
    expect(await process.mock.results[0]?.value).toMatchObject({ advanced: false, refusal: reason })
    expect(s.events).toContainEqual(
      expect.objectContaining({
        phase: 'failed',
        reason: 'refused',
        refusal: reason,
        responder: s.aliceID.id,
      }),
    )
    expect(s.bobGroup()).toBe(s.initial)
    expect(s.aliceGroup().epoch).toBe(original.epoch)
  },
)

test('a lost verdict is retransmitted using the cached seal', async () => {
  const s = await setup({ deadlineMs: 10_000 })
  const publish = s.aliceConnection.publish.bind(s.aliceConnection)
  let lost = false
  const verdicts: Array<Uint8Array> = []
  s.aliceConnection.publish = async (value) => {
    if (decodeHandshakeFrame(value.payload).kind === HANDSHAKE_KIND.recoveryVerdict) {
      verdicts.push(value.payload)
      if (!lost) {
        lost = true
        return publish({ ...value, payload: new Uint8Array([0]) })
      }
    }
    return publish(value)
  }
  expect((await s.bob.recover()).advanced).toBe(true)
  expect(verdicts.length).toBeGreaterThanOrEqual(2)
  expect(verdicts[1]).toEqual(verdicts[0])
  expect(s.published.filter((kind) => kind === HANDSHAKE_KIND.commit)).toHaveLength(1)
})
