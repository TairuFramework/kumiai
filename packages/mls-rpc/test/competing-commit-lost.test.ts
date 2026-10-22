import { randomIdentity } from '@kokuin/token'
import {
  commitInvite,
  commitKeyRotation,
  createInvite,
  createKeyPackageBundle,
  decodeClientState,
  encodeClientState,
  exportGroupInfo,
  type GroupHandle,
  joinGroupExternal,
  removeMember,
  restoreGroup,
} from '@kumiai/mls'
import {
  asLogPosition,
  type ControlChanges,
  type ControlSnapshot,
  createGroupPeer,
  digestAppliedCommit,
  encodeCommitFrame,
  encodeHandshakeFrame,
  encodeLedgerEntries,
  type GroupPeer,
  HANDSHAKE_KIND,
  type HostBuilt,
  type LogHub,
  type Operation,
  type Outcome,
} from '@kumiai/rpc'
import { describe, expect, test, vi } from 'vitest'

import type { ControlHandleAccess, PersistContext } from '../src/access.js'
import { createControlAdoptionPort } from '../src/control-adoption.js'
import { createControlBuildPort, createPersistenceBuildSaver } from '../src/control-build.js'
import { decodeControlJournal } from '../src/control-journal.js'
import { createControlValidationPort } from '../src/control-validation.js'
import { createGroupCrypto, deriveEntryKey, sealEntries } from '../src/crypto.js'
import { entryCapability } from '../src/entry-capability.js'
import { consumesInboundCommit, inboundCommitContext } from '../src/inbound-commit.js'
import { createGroupMLS, createLedgerEntrySlot } from '../src/mls.js'
import { encodeStoredValue } from '../src/persistence-codec.js'
import { createRegistryGroupMLS } from '../src/registry-group-mls.js'
import { createRegistryHandleAccess } from '../src/registry-handle-access.js'
import { createRealGroup } from './fixtures/real-group.js'
import { createRegistryFixture } from './fixtures/registry.js'
import { registryHandle } from './fixtures/registry-welcome.js'
import {
  buildSealedMemoryOperation,
  memoryModel,
  restoreMemoryControlHandle,
  restoreMemoryControlSource,
  sealedMemoryValidation,
} from './fixtures/sealed-memory-mls.js'

const { FakeHub } = (await import(
  new URL('../../rpc/test/fixtures/fake-hub.ts', import.meta.url).href
)) as { FakeHub: new () => LogHub & { hideFrom(readerDID: string, sequenceID: string): void } }

const { encodeMemoryCommit } = (await import(
  new URL('../../rpc/test/fixtures/memory-group-mls.ts', import.meta.url).href
)) as {
  encodeMemoryCommit(
    epoch: number,
    did: string,
    entries: Array<string>,
    options: {
      external: boolean
      authenticator: Uint8Array
    },
  ): Uint8Array
}

type Mode = 'real-mls' | 'double'

async function setup(mode: Mode, kind: 'rotation' | 'invite' = 'rotation') {
  const group = await createRealGroup(1, `competing-${crypto.randomUUID()}`)
  const local = group.committer
  const remote = group.members[0]
  if (remote === undefined) throw new Error('Missing competitor')
  let fixture = await createRegistryFixture({
    mode,
    setup: 'empty',
    groupID: local.handle.groupID,
    identity: local.identity,
    backgroundMaintenance: 'gated',
    options: { resolveLedgerEntries: local.slot.resolve },
  })
  for (const member of [local, remote])
    member.handle = await registryHandle({
      mode,
      handle: member.handle,
      options: { ...fixture.environment.options, resolveLedgerEntries: member.slot.resolve },
    })
  const key = await fixture.registry.seed(local.handle, {
    packageUse: { sourceID: 'competing-test', ref: 'joined', kind: 'ordinary' },
  })
  const sourceEpoch = Number(local.handle.epoch)
  const hub = new FakeHub()
  const publish = hub.publish.bind(hub)
  const attempts: Array<Uint8Array> = []
  hub.publish = async (params) => {
    if (params.senderDID === local.identity.id) {
      attempts.push(params.payload)
      throw new Error('Local commit withheld')
    }
    return publish(params)
  }
  const target = { targetID: 'competing', topicID: 'competing-commits' }
  const emitted: Array<Outcome> = []
  const delivered = vi.fn()
  let peer: GroupPeer<Record<string, never>> | undefined
  let builds = 0
  const restoreCandidate = async (bytes: Uint8Array): Promise<GroupHandle> => {
    const state = decodeClientState(bytes)
    if (state === undefined) throw new Error('Invalid candidate')
    const saved = await fixture.device.groups.loadState(key)
    if (saved === null || saved.deleted) throw new Error('Missing state')
    return (mode === 'double' ? restoreMemoryControlHandle : restoreGroup)({
      state,
      credential: saved.credential,
      ledgerEntries: saved.ledger,
      options: fixture.environment.options,
    })
  }
  const access = createRegistryHandleAccess({ access: await fixture.registry.access(key.groupID) })
  const ports = fixture.device.groups.ports(key)
  const build = createControlBuildPort({
    access,
    control: ports.control,
    restoreCandidate,
    ...(mode === 'double'
      ? {
          restoreSource: async ({ state, credential, ledgerEntries }) => {
            const decoded = decodeClientState(state)
            if (decoded === undefined) throw new Error('Invalid source')
            return restoreMemoryControlSource({ state: decoded, credential, ledgerEntries })
          },
        }
      : {}),
    build: async (op, handle): Promise<HostBuilt> => {
      builds++
      if (mode === 'double') return buildSealedMemoryOperation(op, handle)
      if (kind === 'rotation') {
        const result = await commitKeyRotation(handle)
        return {
          commit: result.commitMessage,
          digest: digestAppliedCommit(result.commitMessage),
          incarnation: key.incarnation,
          epoch: Number(handle.epoch),
          authenticatorBefore: handle.state.keySchedule.epochAuthenticator.slice(),
          bodies: [],
          welcome: null,
          journal: encodeClientState(result.newGroup.state),
        }
      }
      const invitee = randomIdentity()
      const bundle = await createKeyPackageBundle(invitee)
      const { invite } = await createInvite({
        group: handle,
        identity: local.identity,
        recipientDID: invitee.id,
        permission: 'member',
      })
      const result = await commitInvite(handle, bundle.publicPackage, invite)
      return {
        commit: result.commitMessage,
        digest: digestAppliedCommit(result.commitMessage),
        incarnation: key.incarnation,
        epoch: Number(handle.epoch),
        authenticatorBefore: handle.state.keySchedule.epochAuthenticator.slice(),
        bodies: invite.ledgerEntries,
        welcome: { bytes: result.welcomeMessage, recipients: [invitee.id] },
        journal: encodeClientState(result.newGroup.state),
      }
    },
    saveBuilt: createPersistenceBuildSaver({ persistence: fixture.device.groups, key }),
    now: Date.now,
    newID: () => crypto.randomUUID(),
  })
  const op: Operation & { stage: 'intent' } = {
    id: 'local-work',
    kind,
    revokes: false,
    body: encodeStoredValue({ target: randomIdentity().id }),
    seq: 1,
    enqueuedAt: Date.now(),
    deadline: Date.now() + 60_000,
    stage: 'intent',
  }
  await ports.control.apply({ putOperations: [op] }, crypto.randomUUID())
  expect(
    (
      await build.prepareBuild(op, async (built, seal) => {
        const { sealed } = await seal(encodeLedgerEntries(built.bodies))
        return {
          payload: encodeHandshakeFrame(
            HANDSHAKE_KIND.commit,
            encodeCommitFrame(built.commit, sealed),
          ),
          publishID: crypto.randomUUID(),
          expectedHead: null,
        }
      })
    ).kind,
  ).toBe('saved')
  const slot = (await ports.control.load()).commitOnce
  if (slot === null) throw new Error('Missing built slot')
  const candidate = decodeControlJournal(slot.journal).candidate
  const source = await fixture.device.groups.loadState(key)
  if (source === null || source.deleted) throw new Error('Missing source')
  const inbound = await (async () => {
    let commit: Uint8Array
    if (mode === 'double') commit = memoryModel(remote.handle).buildCommit()
    else commit = (await commitKeyRotation(remote.handle)).commitMessage
    const entryKey = await deriveEntryKey(remote.handle)
    const payload = encodeHandshakeFrame(
      HANDSHAKE_KIND.commit,
      encodeCommitFrame(commit, sealEntries(entryKey, encodeLedgerEntries([]))),
    )
    entryKey.fill(0)
    return { commit, payload }
  })()
  const inboundDigest = digestAppliedCommit(inbound.commit)
  const makeMLS = () =>
    createRegistryGroupMLS({
      registry: fixture.registry,
      key,
      recovery: fixture.environment,
      target,
      identity: local.identity,
      entrySlot: createLedgerEntrySlot(),
    })
  let appliedControl: ControlSnapshot | undefined
  let afterApply: (() => Promise<void>) | undefined
  const start = async () => {
    const current = fixture.device.groups.ports(key)
    const registryAccess = await fixture.registry.access(key.groupID)
    const controlAccess = createRegistryHandleAccess({ access: registryAccess })
    const mls = await makeMLS()
    const process = mls.processCommit.bind(mls)
    mls.processCommit = async (commit, context) => {
      const result = await process(commit, context)
      if (result.applied) {
        appliedControl = await current.control.load()
        await afterApply?.()
      }
      return result
    }
    peer = createGroupPeer({
      hub,
      recoveryTarget: target,
      mls,
      crypto: createGroupCrypto({ access: registryAccess }),
      localDID: local.identity.id,
      protocols: {},
      handlers: {},
      control: current.control,
      anchorStore: current.anchor,
      appCursorStore: current.cursor,
      appOutbox: current.outbox,
      appOutboxLimit: 16,
      prepareBuild: build.prepareBuild,
      validation:
        mode === 'double'
          ? sealedMemoryValidation()
          : createControlValidationPort({
              identity: local.identity,
              options: fixture.environment.options,
              restoreCandidate,
            }),
      readEvidence: () => fixture.device.groups.readEvidence(key),
      adopt: createControlAdoptionPort({
        access: controlAccess,
        control: current.control,
        restoreCandidate,
      }).adopt,
      deliverWelcome: delivered,
      onOutcome: (outcome) => {
        emitted.push(outcome)
      },
    })
    return peer
  }
  const append = async (own: boolean) => {
    await publish({
      senderDID: remote.identity.id,
      topicID: target.topicID,
      payload: inbound.payload,
      retain: 'log',
      publishID: crypto.randomUUID(),
    })
    if (own)
      await publish({
        senderDID: local.identity.id,
        topicID: target.topicID,
        payload: slot.payload,
        retain: 'log',
        publishID: slot.publishID,
      })
  }
  const stop = async () => {
    await peer?.dispose()
    await peer?.drained()
    peer = undefined
  }
  return {
    key,
    local,
    remote,
    makeInbound: (access: ControlHandleAccess) =>
      createGroupMLS({
        access,
        identity: local.identity,
        entrySlot: createLedgerEntrySlot(),
        control: ports.control,
        readRecoverySource: async () => (await fixture.device.groups.readEvidence(key)).source,
      }),
    async accept(proven: boolean) {
      const snapshot = await ports.control.load()
      const op = snapshot.operations[0]
      if (op === undefined || op.stage === 'intent') throw new Error('Missing built operation')
      const ack = await publish({
        senderDID: local.identity.id,
        topicID: target.topicID,
        payload: slot.payload,
        retain: 'log',
        publishID: slot.publishID,
      })
      hub.hideFrom(local.identity.id, ack.sequenceID)
      const acceptance = {
        source: (await fixture.device.groups.readEvidence(key)).source,
        from: slot.searchFrom,
        position: asLogPosition(ack.sequenceID),
        payloadDigest: slot.payloadDigest,
      }
      await ports.control.apply(
        proven
          ? { commitOnceAcceptance: acceptance }
          : {
              putOperations: [
                { ...op, stage: 'accepted', acceptedAs: acceptance.position, acceptance },
              ],
            },
        crypto.randomUUID(),
      )
    },
    resolveAhead() {
      // The hub replaces its ahead hint with an earlier copy of the authenticated winner.
      // Both encodings still undergo the real retained-source MLS validation path.
      const fetch = hub.fetchTopic.bind(hub)
      vi.spyOn(hub, 'fetchTopic').mockImplementation(async (params) => {
        const page = await fetch(params)
        return {
          ...page,
          messages: page.messages.map((row) =>
            row.sequenceID === '000000000001' ? { ...row, payload: inbound.payload } : row,
          ),
        }
      })
    },
    async appendAhead() {
      const next =
        mode === 'double'
          ? await fixture.advance(remote.handle)
          : (await commitKeyRotation(remote.handle)).newGroup
      const commit =
        mode === 'double'
          ? memoryModel(next).buildCommit()
          : (await commitKeyRotation(next)).commitMessage
      await publish({
        senderDID: remote.identity.id,
        topicID: target.topicID,
        payload: encodeHandshakeFrame(
          HANDSHAKE_KIND.commit,
          encodeCommitFrame(commit, new Uint8Array()),
        ),
        retain: 'log',
        publishID: crypto.randomUUID(),
      })
    },
    sourceEpoch,
    slot,
    candidate,
    source,
    inbound,
    emitted,
    delivered,
    attempts,
    access,
    fixture: () => fixture,
    start,
    append,
    stop,
    builds: () => builds,
    appliedControl: () => appliedControl,
    afterApply: (fn: () => Promise<void>) => {
      afterApply = fn
    },
    applyInbound: async (overrides: ControlChanges = {}) =>
      (await makeMLS()).processCommit(inbound.commit, {
        senderDID: remote.identity.id,
        adoption: (staged) => ({
          mutationID: crypto.randomUUID(),
          changes: {
            commitOnce: null,
            deleteOperations: [op.id],
            putOutcomes: [{ id: op.id, opID: op.id, at: Date.now(), kind: 'lost' }],
            putApplied: [
              {
                epoch: sourceEpoch,
                digest: inboundDigest,
                payloadDigest: digestAppliedCommit(inbound.payload),
                sequenceID: asLogPosition('000000000001'),
                opID: null,
                removed: staged.removed,
              },
            ],
            cursor: { epoch: staged.epochAfter, position: asLogPosition('000000000001') },
            ...overrides,
          },
        }),
      }),
    control: () => fixture.device.groups.ports(key).control.load(),
    async restart() {
      await stop()
      fixture = await fixture.reopen()
      return start()
    },
    async close() {
      await stop()
      await fixture.close()
    },
  }
}

for (const mode of ['real-mls', 'double'] as const) {
  describe(`competing commits (${mode})`, () => {
    for (const kind of ['rotation', 'invite'] as const) {
      test.each([false, true])(`built ${kind} loses when own occurrence is %s`, async (own) => {
        const h = await setup(mode, kind)
        try {
          await h.append(own)
          await (await h.start()).replay()
          await vi.waitFor(async () =>
            expect((await h.control()).outcomes).toEqual([
              expect.objectContaining({ opID: 'local-work', kind: 'lost' }),
            ]),
          )
          expect(h.appliedControl()?.outcomes).toEqual([
            expect.objectContaining({ opID: 'local-work', kind: 'lost' }),
          ])
          const saved = await h.fixture().device.groups.loadState(h.key)
          expect(saved).toMatchObject({ epoch: h.sourceEpoch + 1 })
          expect(saved !== null && !saved.deleted && saved.epochAuthenticator).not.toEqual(
            decodeClientState(h.candidate)?.keySchedule.epochAuthenticator,
          )
          const control = await h.control()
          expect(control.operations).toEqual([])
          expect(control.commitOnce).toBeNull()
          expect(control.welcomes).toEqual([])
          expect(control.applied).toEqual([
            expect.objectContaining({
              epoch: h.sourceEpoch,
              digest: digestAppliedCommit(h.inbound.commit),
            }),
          ])
          expect(control.cursor?.position).not.toBeNull()
          await vi.waitFor(() => expect(h.emitted).toHaveLength(1))
          expect(h.emitted[0]?.kind).toBe('lost')
          expect(h.attempts).toEqual([])
          expect(h.delivered).not.toHaveBeenCalled()
          expect(h.builds()).toBe(1)
        } finally {
          await h.close()
        }
      })
    }

    test.each([false, true])(
      'accepted but unvalidated work is not lost (slot proof: %s)',
      async (proven) => {
        const h = await setup(mode, 'invite')
        try {
          await h.accept(proven)
          const before = await h.control()
          await h.append(false)
          await (await h.start()).replay()
          expect(h.appliedControl()?.applied).toHaveLength(1)
          expect(h.appliedControl()?.outcomes).toEqual([])
          expect(h.appliedControl()?.welcomes).toEqual(before.welcomes)
          expect(h.delivered).not.toHaveBeenCalled()
        } finally {
          await h.close()
        }
      },
    )

    test('stranded cursor survives ahead uncertainty and later validated supersession', async () => {
      const h = await setup(mode, 'invite')
      try {
        await h
          .fixture()
          .device.groups.ports(h.key)
          .control.apply(
            {
              cursor: { epoch: h.sourceEpoch, position: asLogPosition('000000000000') },
              putWelcomes:
                h.slot.welcome === null
                  ? []
                  : [
                      {
                        opID: 'local-work',
                        welcome: h.slot.welcome.bytes,
                        recipients: h.slot.welcome.recipients,
                      },
                    ],
            },
            crypto.randomUUID(),
          )
        await h.appendAhead()
        await h.append(true)
        const peer = await h.start()
        await peer.replay()
        const pending = h.appliedControl()
        expect(pending?.outcomes).toEqual([])
        expect(pending?.commitOnce).toBeNull()
        expect(pending?.operations).toMatchObject([
          {
            id: 'local-work',
            reconciliation: {
              acceptance: null,
              uncertainty: { cause: 'ahead', at: asLogPosition('000000000001') },
            },
          },
        ])
        expect(h.appliedControl()?.cursor).toEqual({
          epoch: h.sourceEpoch + 1,
          position: asLogPosition('000000000000'),
          stranded: true,
        })
        expect(h.appliedControl()?.applied[0]?.sequenceID).toBe(asLogPosition('000000000002'))
        const operation = pending?.operations[0]
        if (operation === undefined) throw new Error('Missing unresolved operation')
        const clock = vi.spyOn(Date, 'now').mockReturnValue(operation.deadline)
        try {
          await peer.replay()
          const expired = await h.control()
          expect(expired.outcomes).toMatchObject([{ opID: operation.id, kind: 'unknown' }])
          expect(expired.operations).toMatchObject([{ id: operation.id, unknownReported: true }])
          expect(expired.cursor).toEqual(pending?.cursor)
          expect(expired.welcomes).toHaveLength(1)
          h.resolveAhead()
          await peer.replay()
          const resolved = await h.control()
          expect(resolved.outcomes).toMatchObject([{ opID: operation.id, kind: 'lost' }])
          expect(resolved.operations).toEqual([])
          expect(resolved.welcomes).toEqual([])
          expect(resolved.cursor).toEqual(pending?.cursor)
          expect(h.delivered).not.toHaveBeenCalled()
        } finally {
          clock.mockRestore()
        }
      } finally {
        await h.close()
      }
    })

    test('only a local member commit authenticates as own', async () => {
      const h = await setup(mode)
      try {
        const own =
          mode === 'double'
            ? memoryModel(h.local.handle).buildCommit()
            : (await commitKeyRotation(h.local.handle)).commitMessage
        expect(await h.local.handle.verifyCommitSignature(own)).toBe(true)
        expect(await h.local.handle.verifyCommitSignature(h.inbound.commit)).toBe(false)
        const external =
          mode === 'double'
            ? encodeMemoryCommit(h.sourceEpoch, h.local.identity.id, [], {
                external: true,
                authenticator: memoryModel(h.local.handle).authenticator(),
              })
            : (
                await joinGroupExternal({
                  identity: h.local.identity,
                  groupInfo: (await exportGroupInfo({ group: h.local.handle })).groupInfo,
                  credential: h.local.handle.credential,
                  resync: true,
                })
              ).commitMessage
        expect(await h.local.handle.verifyCommitSignature(external)).toBe(false)
      } finally {
        await h.close()
      }
    })

    test.each(['rotation', 'invite'] as const)(
      'restart after durable apply replays one %s loss without rebuilding',
      async (kind) => {
        const h = await setup(mode, kind)
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        try {
          h.afterApply(async () => {
            entered.resolve()
            await release.promise
          })
          await h.append(false)
          const peer = await h.start()
          const replay = peer.replay().catch((error: unknown) => error)
          await entered.promise
          expect((await h.control()).outcomes).toEqual([expect.objectContaining({ kind: 'lost' })])
          expect(h.emitted).toEqual([])
          await peer.dispose()
          release.resolve()
          await replay
          h.afterApply(async () => {})
          const restarted = await h.restart()
          await restarted.replay()
          await vi.waitFor(() => expect(h.emitted).toHaveLength(1))
          await restarted.replay()
          expect(h.emitted).toHaveLength(1)
          expect(h.builds()).toBe(1)
          expect((await h.control()).operations).toEqual([])
          expect(h.delivered).not.toHaveBeenCalled()
        } finally {
          release.resolve()
          await h.close()
        }
      },
    )

    test.each(['rotation', 'invite'] as const)(
      'atomic %s write failure rolls back state, trust, slot, applied rows and cursor; retry succeeds',
      async (kind) => {
        const h = await setup(mode, kind)
        try {
          const before = await h.fixture().inspectRows()
          const capability = entryCapability(h.fixture().device.groups)
          if (capability === null) throw new Error('Missing entry capability')
          const run = capability.run.bind(capability)
          let fail = true
          capability.run = (request, prepare, work) =>
            run(request, prepare, async (stores, prepared) => {
              return work(
                {
                  ...stores,
                  incarnation(incarnation) {
                    const rows = stores.incarnation(incarnation)
                    return {
                      ...rows,
                      control: {
                        ...rows.control,
                        async apply(changes, mutationID) {
                          await rows.control.apply(changes, mutationID)
                          if (fail) {
                            fail = false
                            throw new Error('Injected inbound control write failure')
                          }
                        },
                      },
                    }
                  },
                },
                prepared,
              )
            })
          await expect(h.applyInbound()).rejects.toThrow('Injected inbound control write failure')
          capability.run = run
          expect(await h.fixture().inspectRows()).toEqual(before)
          expect(h.emitted).toEqual([])
          expect(await h.applyInbound()).toMatchObject({ applied: true, advanced: true })
          await vi.waitFor(async () =>
            expect((await h.control()).outcomes).toEqual([
              expect.objectContaining({ kind: 'lost' }),
            ]),
          )
          expect(h.delivered).not.toHaveBeenCalled()
        } finally {
          await h.close()
        }
      },
    )

    test('inbound provenance binds the processed bytes when the caller mutates its input', async () => {
      const h = await setup(mode)
      try {
        const digest = digestAppliedCommit(h.inbound.commit)
        const fixture = h.fixture()
        let changed = false
        fixture.overrideRestore(async (record) => {
          const state = decodeClientState(record.state)
          if (state === undefined) throw new Error('Invalid state')
          const handle = await (mode === 'double' ? restoreMemoryControlHandle : restoreGroup)({
            state,
            credential: record.credential,
            ledgerEntries: record.ledger,
            options: fixture.environment.options,
          })
          const process = handle.processMessage.bind(handle)
          handle.processMessage = (message, opts) => {
            const persist = opts?.persist
            if (persist === undefined) return process(message, opts)
            return process(message, {
              ...opts,
              persist: async (candidate, context) => {
                changed = true
                h.inbound.commit.fill(0)
                await persist(candidate, context)
              },
            })
          }
          return handle
        })
        expect(await h.applyInbound()).toMatchObject({ applied: true, advanced: true })
        expect(changed).toBe(true)
        expect((await h.control()).applied).toEqual([expect.objectContaining({ digest })])
      } finally {
        await h.close()
      }
    })

    test('an access callback cannot alter the authenticated result state before persistence', async () => {
      const h = await setup(mode)
      try {
        const before = await h.fixture().inspectRows()
        let altered = false
        const mls = h.makeInbound({
          ...h.access,
          mutate: (fn, adoption) =>
            h.access.mutate(
              (source, persist) =>
                fn(source, async (result, context) => {
                  result.state.keySchedule.exporterSecret[0] =
                    (result.state.keySchedule.exporterSecret[0] ?? 0) ^ 1
                  altered = true
                  await persist(result, context)
                }),
              adoption,
            ),
        })
        await expect(
          mls.processCommit(h.inbound.commit, {
            senderDID: h.remote.identity.id,
            adoption: (staged) => ({
              mutationID: crypto.randomUUID(),
              changes: {
                commitOnce: null,
                putApplied: [
                  {
                    epoch: h.sourceEpoch,
                    digest: digestAppliedCommit(h.inbound.commit),
                    payloadDigest: digestAppliedCommit(h.inbound.payload),
                    sequenceID: asLogPosition('000000000001'),
                    opID: null,
                    removed: false,
                  },
                ],
                cursor: { epoch: staged.epochAfter, position: asLogPosition('000000000001') },
              },
            }),
          }),
        ).rejects.toMatchObject({ name: 'ControlAdoptionMovedError' })
        expect(altered).toBe(true)
        expect(await h.fixture().inspectRows()).toEqual(before)
      } finally {
        await h.close()
      }
    })

    test('a saved own commit does not authenticate after self-removal', async () => {
      const group = await createRealGroup(1, `removed-verifier-${crypto.randomUUID()}`)
      const member = group.members[0]
      if (member === undefined) throw new Error('Missing member')
      const local = await registryHandle({ mode, handle: member.handle, options: {} })
      const remote = await registryHandle({ mode, handle: group.committer.handle, options: {} })
      const own =
        mode === 'double'
          ? memoryModel(local).buildCommit()
          : (await commitKeyRotation(local)).commitMessage
      expect(await local.verifyCommitSignature(own)).toBe(true)
      const removal =
        mode === 'double'
          ? memoryModel(remote).buildCommit([], { removes: [member.identity.id] })
          : (await removeMember(remote, local.state.privatePath.leafIndex)).commitMessage
      const epoch = local.epoch
      await local.processMessage(removal)
      expect(local.epoch).toBe(epoch)
      expect(local.listMembers().some((member) => member.id === local.credential.id)).toBe(false)
      expect(await local.verifyCommitSignature(own)).toBe(false)
    })

    test('minting inbound provenance does not encode slot-free result state', async () => {
      const h = await setup(mode)
      try {
        const read = vi.spyOn(h.local.handle, 'state', 'get')
        inboundCommitContext(
          h.local.handle,
          {
            epoch: h.sourceEpoch,
            authenticator: h.source.epochAuthenticator,
          },
          h.local.handle,
          h.inbound.commit,
        )
        expect(read).not.toHaveBeenCalled()
        read.mockRestore()
      } finally {
        await h.close()
      }
    })

    test.each(['different-commit', 'wrong-epoch'] as const)(
      'genuine inbound proof refuses a %s write without changing rows',
      async (reason) => {
        const h = await setup(mode)
        try {
          const other =
            mode === 'double'
              ? memoryModel(h.local.handle).buildCommit()
              : (await commitKeyRotation(h.local.handle)).commitMessage
          const before = await h.fixture().inspectRows()
          await expect(
            h.applyInbound({
              putApplied: [
                {
                  epoch: reason === 'wrong-epoch' ? h.sourceEpoch + 1 : h.sourceEpoch,
                  digest:
                    reason === 'different-commit'
                      ? digestAppliedCommit(other)
                      : digestAppliedCommit(h.inbound.commit),
                  payloadDigest: digestAppliedCommit(h.inbound.payload),
                  sequenceID: asLogPosition('000000000001'),
                  opID: null,
                  removed: false,
                },
              ],
            }),
          ).rejects.toMatchObject({ name: 'ControlAdoptionMovedError' })
          expect(await h.fixture().inspectRows()).toEqual(before)
        } finally {
          await h.close()
        }
      },
    )

    test('a consumed genuine inbound proof cannot authorize persistence and rows stay unchanged', async () => {
      const h = await setup(mode)
      try {
        const before = await h.fixture().inspectRows()
        let consumed = false
        const cursorBefore = (await h.control()).cursor
        const mls = h.makeInbound({
          ...h.access,
          mutate: (fn, adoption) =>
            h.access.mutate(
              (source, persist) =>
                fn(source, async (result, context) => {
                  if (adoption === undefined) throw new Error('Missing write')
                  const write = adoption({
                    incarnation: h.key.incarnation,
                    epochAfter: Number(result.epoch),
                    epochAuthenticator: result.state.keySchedule.epochAuthenticator,
                    removed: false,
                  })
                  consumed = consumesInboundCommit({
                    context,
                    source,
                    result,
                    capturedState: encodeClientState(result.state),
                    record: { ...h.source, state: encodeClientState(source.state) },
                    write,
                    cursorBefore,
                  })
                  expect(consumed).toBe(true)
                  await persist(result, context)
                }),
              adoption,
            ),
        })
        await expect(
          mls.processCommit(h.inbound.commit, {
            senderDID: h.remote.identity.id,
            adoption: (staged) => ({
              mutationID: crypto.randomUUID(),
              changes: {
                commitOnce: null,
                putApplied: [
                  {
                    epoch: h.sourceEpoch,
                    digest: digestAppliedCommit(h.inbound.commit),
                    payloadDigest: digestAppliedCommit(h.inbound.payload),
                    sequenceID: asLogPosition('000000000001'),
                    opID: null,
                    removed: false,
                  },
                ],
                cursor: { epoch: staged.epochAfter, position: asLogPosition('000000000001') },
              },
            }),
          }),
        ).rejects.toMatchObject({ name: 'ControlAdoptionMovedError' })
        expect(consumed).toBe(true)
        expect(await h.fixture().inspectRows()).toEqual(before)
      } finally {
        await h.close()
      }
    })

    test.each([
      { commitOnce: undefined },
      { putApplied: [] },
      { cursor: null },
    ] satisfies Array<ControlChanges>)(
      'inbound proof requires its matching control cleanup: %j',
      async (changes) => {
        const h = await setup(mode)
        try {
          const before = await h.fixture().inspectRows()
          await expect(h.applyInbound(changes)).rejects.toMatchObject({
            name: 'ControlAdoptionMovedError',
          })
          expect(await h.fixture().inspectRows()).toEqual(before)
        } finally {
          await h.close()
        }
      },
    )

    test('caller constructed provenance and slot cleanup cannot authorize an arbitrary candidate', async () => {
      const h = await setup(mode)
      try {
        const candidate = await h
          .fixture()
          .advance(await h.fixture().restoreCommittedSender(h.key.groupID))
        const before = await h.fixture().inspectRows()
        const forged = {
          inbound: { source: h.source, result: candidate, commit: h.inbound.commit },
        }
        await expect(
          h.access.mutate(
            async (_handle, persist) => {
              await persist(candidate, forged as PersistContext)
            },
            () => ({
              mutationID: crypto.randomUUID(),
              changes: {
                commitOnce: null,
                cursor: { epoch: h.sourceEpoch + 1, position: null },
                putApplied: [
                  {
                    epoch: h.sourceEpoch,
                    digest: digestAppliedCommit(h.inbound.commit),
                    payloadDigest: h.slot.payloadDigest,
                    sequenceID: asLogPosition('000000000001'),
                    opID: null,
                    removed: false,
                  },
                ],
              },
            }),
          ),
        ).rejects.toMatchObject({ name: 'ControlAdoptionMovedError' })
        expect(await h.fixture().inspectRows()).toEqual(before)
      } finally {
        await h.close()
      }
    })
  })
}
