import {
  commitKeyRotation,
  decodeClientState,
  encodeClientState,
  GroupHandle,
  restoreGroup,
} from '@kumiai/mls'
import {
  digestAppliedCommit,
  encodeCommitFrame,
  encodeHandshakeFrame,
  encodeLedgerEntries,
  type GroupPeerParams,
  HANDSHAKE_KIND,
  type Operation,
} from '@kumiai/rpc'
import { createGroupPeerWithControlWalk } from '@kumiai/rpc/testing'
import { expect, test, vi } from 'vitest'

import { createRegistryAppPublication } from '../src/app-publication.js'
import { createControlAdoptionPort } from '../src/control-adoption.js'
import { createControlBuildPort, createPersistenceBuildSaver } from '../src/control-build.js'
import { decodeControlJournal } from '../src/control-journal.js'
import { createControlValidationPort } from '../src/control-validation.js'
import { createGroupCrypto, deriveEntryKey, sealEntries } from '../src/crypto.js'
import { createLedgerEntrySlot } from '../src/mls.js'
import { decodeStoredValue, encodeStoredValue } from '../src/persistence-codec.js'
import { createRegistryGroupMLS } from '../src/registry-group-mls.js'
import { createRegistryHandleAccess } from '../src/registry-handle-access.js'
import { openedDeliveryContext } from './fixtures/ownership-context.js'
import { createRealGroup } from './fixtures/real-group.js'
import { createRegistryFixture } from './fixtures/registry.js'
import { registryHandle } from './fixtures/registry-welcome.js'

const { FakeHub } = (await import(
  new URL('../../rpc/test/fixtures/fake-hub.ts', import.meta.url).href
)) as { FakeHub: new () => GroupPeerParams<Record<string, never>>['hub'] }

function decodeCandidate(bytes: Uint8Array) {
  const candidate = decodeStoredValue(bytes) as {
    state: Uint8Array
    credential: GroupHandle['credential']
    ledger: Array<string>
  }
  const state = decodeClientState(candidate.state)
  if (state === undefined) throw new Error('Invalid candidate')
  return { ...candidate, state }
}

async function fixture() {
  const group = await createRealGroup(1, `own-walker-${crypto.randomUUID()}`)
  const local = group.committer
  const remote = group.members[0]
  if (remote === undefined) throw new Error('Missing competitor')
  const f = await createRegistryFixture({
    mode: 'real-mls',
    setup: 'empty',
    groupID: local.handle.groupID,
    identity: local.identity,
    backgroundMaintenance: 'gated',
    options: { resolveLedgerEntries: local.slot.resolve },
  })
  local.handle = await registryHandle({
    mode: 'real-mls',
    handle: local.handle,
    options: f.environment.options,
  })
  const key = await f.registry.seed(local.handle, {
    packageUse: { sourceID: 'own-walker', ref: 'joined', kind: 'ordinary' },
  })
  const ports = f.device.groups.ports(key)
  const access = createRegistryHandleAccess({ access: await f.registry.access(key.groupID) })
  const restoreCandidate = async (bytes: Uint8Array) => {
    const candidate = decodeCandidate(bytes)
    return restoreGroup({
      state: candidate.state,
      credential: candidate.credential,
      ledgerEntries: candidate.ledger,
      options: f.environment.options,
    })
  }
  const build = createControlBuildPort({
    access,
    control: ports.control,
    restoreCandidate,
    build: async (_op, handle) => {
      const result = await commitKeyRotation(handle)
      return {
        commit: result.commitMessage,
        digest: digestAppliedCommit(result.commitMessage),
        incarnation: key.incarnation,
        epoch: Number(handle.epoch),
        authenticatorBefore: handle.state.keySchedule.epochAuthenticator.slice(),
        bodies: [],
        welcome: null,
        journal: encodeStoredValue({
          state: encodeClientState(result.newGroup.state),
          credential: result.newGroup.credential,
          ledger: result.newGroup.ledgerTokens,
        }),
      }
    },
    saveBuilt: createPersistenceBuildSaver({ persistence: f.device.groups, key }),
    now: Date.now,
    newID: () => crypto.randomUUID(),
  })
  const hub = new FakeHub()
  const target = { targetID: 'own-walker', topicID: 'own-walker-commits' }
  const mls = await createRegistryGroupMLS({
    registry: f.registry,
    key,
    recovery: f.environment,
    target,
    identity: local.identity,
    entrySlot: createLedgerEntrySlot(),
  })
  const validation = createControlValidationPort({
    identity: local.identity,
    options: f.environment.options,
    restoreCandidate,
  })
  const running = createGroupPeerWithControlWalk({
    openedDeliveryContext,
    hub,
    recoveryTarget: target,
    crypto: createGroupCrypto({ access: await f.registry.access(key.groupID) }),
    mls,
    localDID: local.identity.id,
    protocols: {},
    handlers: {},
    control: ports.control,
    anchorStore: ports.anchor,
    appCursorStore: ports.cursor,
    appOutbox: ports.outbox,
    appPublication: createRegistryAppPublication(await f.registry.access(key.groupID)),
    appOutboxLimit: 16,
    prepareBuild: async () => {
      throw new Error('Saved work must not rebuild')
    },
    validation,
    readEvidence: () => f.device.groups.readEvidence(key),
    adopt: createControlAdoptionPort({ access, control: ports.control, restoreCandidate }).adopt,
    deliverWelcome: async () => {
      throw new Error('Rotation has no Welcome')
    },
  })
  const seedBuild = async () => {
    const intent: Operation & { stage: 'intent' } = {
      id: 'rotation',
      kind: 'rotation',
      revokes: false,
      body: new Uint8Array(),
      seq: 1,
      enqueuedAt: Date.now(),
      deadline: Date.now() + 60_000,
      stage: 'intent',
    }
    await ports.control.apply({ putOperations: [intent] }, crypto.randomUUID())
    expect(
      (
        await build.prepareBuild(intent, async (built, seal) => {
          const { sealed } = await seal(encodeLedgerEntries(built.bodies))
          return {
            payload: encodeHandshakeFrame(
              HANDSHAKE_KIND.commit,
              encodeCommitFrame(built.commit, sealed),
            ),
            publishID: crypto.randomUUID(),
            expectedHead: (await ports.control.load()).cursor?.position ?? null,
          }
        })
      ).kind,
    ).toBe('saved')
    const saved = (await ports.control.load()).commitOnce
    if (saved === null) throw new Error('Missing saved build')
    return saved
  }
  const appendCompetitor = async () => {
    const rotation = await commitKeyRotation(remote.handle)
    const entryKey = await deriveEntryKey(remote.handle)
    const occurrence = await hub.publish({
      senderDID: local.identity.id,
      topicID: target.topicID,
      retain: 'log',
      payload: encodeHandshakeFrame(
        HANDSHAKE_KIND.commit,
        encodeCommitFrame(rotation.commitMessage, sealEntries(entryKey, encodeLedgerEntries([]))),
      ),
    })
    remote.handle = rotation.newGroup
    return occurrence
  }
  return {
    f,
    key,
    ports,
    hub,
    target,
    mls,
    localDID: local.identity.id,
    running,
    seedBuild,
    appendCompetitor,
    async close() {
      await running.peer.dispose()
      await running.peer.drained()
      await f.close()
    },
  }
}

test.each([false, true])(
  'real own occurrence installs the saved candidate through the walker without receive (gap=%s)',
  async (gap) => {
    const h = await fixture()
    const receive = vi.spyOn(h.mls, 'processCommit').mockImplementation(async () => {
      throw new Error('Own frame reached state-advancing receive processing')
    })
    const processMessage = vi
      .spyOn(GroupHandle.prototype, 'processMessage')
      .mockImplementation(() => {
        throw new Error('Own frame reached MLS receive processing')
      })
    try {
      await h.running.peer.replay()
      const saved = await h.seedBuild()
      const candidate = decodeCandidate(decodeControlJournal(saved.journal).candidate).state
      const fetch = h.hub.fetchTopic.bind(h.hub)
      vi.spyOn(h.hub, 'fetchTopic').mockImplementation(async (params) => {
        const page = await fetch(params)
        return params.topicID === h.target.topicID ? { ...page, gap } : page
      })
      const occurrence = await h.hub.publish({
        senderDID: h.localDID,
        topicID: h.target.topicID,
        retain: 'log',
        payload: saved.payload,
      })
      await h.running.controlWalk.walkCommits()
      expect(receive).not.toHaveBeenCalled()
      expect(processMessage).not.toHaveBeenCalled()
      const control = await h.ports.control.load()
      const state = await h.f.device.groups.loadState(h.key)
      expect(state).toMatchObject({
        epoch: saved.epoch + 1,
        epochAuthenticator: candidate.keySchedule.epochAuthenticator,
      })
      expect(control.commitOnce).toBeNull()
      expect(control.operations).toEqual([])
      expect(control.applied).toMatchObject([
        { opID: saved.opID, digest: saved.digest, sequenceID: occurrence.sequenceID },
      ])
      expect(control.cursor).toMatchObject({
        epoch: saved.epoch + 1,
        position: occurrence.sequenceID,
      })
      expect(control.outcomes).toMatchObject([
        { opID: saved.opID, kind: gap ? 'unknown' : 'landed' },
      ])
      expect(control.welcomes).toEqual([])
    } finally {
      vi.restoreAllMocks()
      await h.close()
    }
  },
)

test('real walker settles a competitor after a hub gap and unreadable frame without repeating fetches', async () => {
  const h = await fixture()
  try {
    await h.running.peer.replay()
    await h.appendCompetitor()
    await h.running.controlWalk.walkCommits()
    const saved = await h.seedBuild()
    const before = await h.ports.control.load()
    const fetch = h.hub.fetchTopic.bind(h.hub)
    const pages: Array<Array<string>> = []
    const fetched = vi.spyOn(h.hub, 'fetchTopic').mockImplementation(async (params) => {
      const page = await fetch(params)
      if (params.topicID === h.target.topicID)
        pages.push(page.messages.map((message) => message.sequenceID))
      return params.topicID === h.target.topicID ? { ...page, gap: true } : page
    })
    const unreadable = await h.hub.publish({
      senderDID: h.localDID,
      topicID: h.target.topicID,
      retain: 'log',
      payload: new Uint8Array([255]),
    })
    const winner = await h.appendCompetitor()
    await h.running.controlWalk.walkCommits()
    expect(pages).toContainEqual([unreadable.sequenceID, winner.sequenceID])
    const after = await h.ports.control.load()
    expect(after.commitOnce).toBeNull()
    expect(after.outcomes).toMatchObject([{ opID: saved.opID, kind: 'unknown' }])
    expect(after.cursor).toMatchObject({ position: winner.sequenceID, epoch: saved.epoch + 1 })
    expect(after.cursor?.stranded).not.toBe(true)
    expect(after.applied).toMatchObject([
      ...before.applied,
      { opID: null, sequenceID: winner.sequenceID },
    ])
    expect(await h.f.device.groups.loadState(h.key)).toMatchObject({ epoch: saved.epoch + 1 })
    const count = fetched.mock.calls.length
    await expect(h.running.controlWalk.walkCommits()).resolves.toBe(false)
    expect(fetched.mock.calls.length - count).toBeLessThanOrEqual(1)
    expect((await h.ports.control.load()).outcomes).toEqual(after.outcomes)
  } finally {
    vi.restoreAllMocks()
    await h.close()
  }
})
