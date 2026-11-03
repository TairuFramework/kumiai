import { createFullIdentity, randomIdentity } from '@kokuin/token'
import {
  commitKeyRotation,
  computeHead,
  decodeClientState,
  encodeClientState,
  ledgerEntryDigest,
  restoreGroup,
} from '@kumiai/mls'
import {
  asLogPosition,
  type ControlSlot,
  commitTopic,
  controlBatch,
  decodeCommitFrame,
  decodeHandshakeFrame,
  digestAppliedCommit,
  encodeCommitFrame,
  encodeHandshakeFrame,
  type GroupMLS,
  type GroupPeerParams,
  HANDSHAKE_KIND,
} from '@kumiai/rpc'
import { createGroupPeerWithControlWalk } from '@kumiai/rpc/testing'
import { sha256 } from '@noble/hashes/sha2.js'
import { toB64U } from '@sozai/codec'
import { decode, encode, mlsMessageDecoder, mlsMessageEncoder, wireformats } from 'ts-mls'
import { expect, test, vi } from 'vitest'

import { createRegistryAppPublication } from '../src/app-publication.js'
import { encodeControlJournal } from '../src/control-journal.js'
import { createControlValidationPort } from '../src/control-validation.js'
import { createGroupCrypto, deriveEntryKey, sealEntries } from '../src/crypto.js'
import { createLedgerEntrySlot } from '../src/mls.js'
import { registrySafety } from '../src/registry/safety.js'
import { recoveryTrustFor } from '../src/registry/trust.js'
import { createRegistryGroupMLS } from '../src/registry-group-mls.js'
import { openedDeliveryContext } from './fixtures/ownership-context.js'
import { createTestCompletion } from './fixtures/real-group.js'
import { createRegistryFixture } from './fixtures/registry.js'
import { createRegistryRecovery } from './fixtures/registry-recovery.js'
import {
  memoryModel,
  restoreMemoryControlHandle,
  sealedMemoryValidation,
} from './fixtures/sealed-memory-mls.js'
import { createControlCrashHarness } from './fixtures/storage-persistence.js'
import { makeStorageSeed } from './fixtures/storage-seed.js'

const { FakeHub } = (await import(
  new URL('../../rpc/test/fixtures/fake-hub.ts', import.meta.url).href
)) as { FakeHub: new () => GroupPeerParams<Record<string, never>>['hub'] }
const { createMemoryGroupMLS } = (await import(
  new URL('../../rpc/test/fixtures/memory-group-mls.ts', import.meta.url).href
)) as {
  createMemoryGroupMLS(params: {
    groupID: string
    epoch: number
    localDID: string
    members: Array<string>
    recoverySecret: Uint8Array
    entryDigest: typeof ledgerEntryDigest
    computeLedgerHead(ids: Array<string>): string
    onSafetyHold: NonNullable<GroupMLS['onSafetyHold']>
  }): GroupMLS & { restoreState(bytes: Uint8Array): void }
}

const frame = (commit: Uint8Array) =>
  encodeHandshakeFrame(HANDSHAKE_KIND.commit, encodeCommitFrame(commit, new Uint8Array()))
const { decodeMemoryCommit, tagMemoryCommit } = (await import(
  new URL('../../rpc/test/fixtures/memory-group-mls.ts', import.meta.url).href
)) as {
  decodeMemoryCommit(bytes: Uint8Array): Record<string, unknown> | null
  tagMemoryCommit(bytes: Uint8Array, authenticator: Uint8Array): Uint8Array
}

for (const mode of ['real-mls', 'double'] as const) {
  test(`registry bound signed past divergence preserves the current saved build (${mode})`, async () => {
    const seed = await makeStorageSeed({ mode, id: 'control-crash', incarnation: 1, epoch: 0 })
    if (seed.state.state === null) throw new Error('Missing source')
    const state = decodeClientState(seed.state.state)
    if (state === undefined) throw new Error('Invalid source')
    const restore = mode === 'double' ? restoreMemoryControlHandle : restoreGroup
    const source = await restore({
      state,
      credential: seed.state.credential,
      ledgerEntries: seed.state.ledger,
    })
    const copy = await restore({
      state,
      credential: seed.state.credential,
      ledgerEntries: seed.state.ledger,
    })
    let winner: Uint8Array
    let loser: Uint8Array
    let candidate = source
    if (mode === 'double') {
      winner = memoryModel(source).buildCommit([])
      loser = memoryModel(copy).buildCommit([], { adds: [randomIdentity().id] })
      await memoryModel(source).adopt(winner)
    } else {
      const result = await commitKeyRotation(source)
      winner = result.commitMessage
      candidate = result.newGroup
      loser = (await commitKeyRotation(copy)).commitMessage
    }
    seed.state = {
      ...seed.state,
      state: encodeClientState(candidate.state),
      epoch: Number(candidate.epoch),
      epochAuthenticator: candidate.state.keySchedule.epochAuthenticator,
    }
    seed.confirmedTranscriptHash = candidate.state.groupContext.confirmedTranscriptHash.slice()
    seed.trust = recoveryTrustFor(candidate, seed.key, null)
    const h = await createControlCrashHarness(mode, seed, undefined, true, true)
    try {
      await h.peer.replay()
      const built = await h.build()
      await h.saveBuilt(built.intent, built.slot, built.expected, 'current-build')
      await h.control.apply(
        {
          putApplied: [
            {
              epoch: 0,
              digest: digestAppliedCommit(winner),
              payloadDigest: toB64U(sha256(frame(winner))),
              sequenceID: '000000000000',
              removed: false,
              opID: null,
            },
          ],
        },
        'past-winner',
      )
      const before = await h.control.load()
      const bridge = vi.spyOn(controlBatch(h.mls)!, 'run')
      await h.hub.publish({
        topicID: await h.topic(),
        payload: frame(loser),
        senderDID: randomIdentity().id,
        retain: 'log',
      })
      await vi.waitFor(() => expect(bridge).toHaveBeenCalled())
      await Promise.all(bridge.mock.results.map((result) => result.value))
      const after = await h.control.load()
      expect(after.controlHold).toEqual(before.controlHold)
      expect(after.commitOnce).toEqual(before.commitOnce)
      expect(after.outcomes).toEqual(before.outcomes)
      expect(after.applied).toEqual(before.applied)
      expect(after.forkHalt).toEqual(before.forkHalt)
      expect(after.strand).toEqual(before.strand)
    } finally {
      await h.fixture.close()
    }
  })
  test.each(['pending-rejoin', 'authenticated-hold'] as const)(
    `registry bound faults preserve a pre-existing gate without admission (${mode}, %s)`,
    async (gate) => {
      const h = await createControlCrashHarness(mode, undefined, undefined, true, true)
      try {
        h.hooks.beforeWelcome = async () => {
          throw new Error('Recipient offline')
        }
        const built = await h.build()
        await h.saveBuilt(built.intent, built.slot, built.expected, 'gated-copy')
        const registry = h.registry
        if (registry === undefined) throw new Error('Missing registry')
        if (gate === 'authenticated-hold') registrySafety(registry)!.latch(h.key, 'fork-halted')
        else {
          const source = await h.registryAccess!.read((value) => value)
          const recovery = await createRegistryRecovery({
            format: 'captured',
            mode,
            source,
            sourceKey: h.key,
            recoverySource: await registry.recoverySource(h.key.groupID),
            options: {},
            identity: {
              ...createFullIdentity(source.state.signaturePrivateKey),
              privateKey: source.state.signaturePrivateKey,
            },
          })
          await h.control.apply(
            { putRejoin: { ...recovery.record, stage: 'published' } },
            'pending-rejoin-gate',
          )
        }
        const before = await h.control.load()
        const bridge = vi.spyOn(controlBatch(h.mls)!, 'run')
        await h.peer.replay()
        const topicID = await h.topic()
        for (const byte of [0, 1, 255])
          await h.hub.publish({
            topicID,
            senderDID: randomIdentity().id,
            payload: new Uint8Array([byte]),
            retain: 'log',
          })
        for (let index = 0; index < 100; index++) await Promise.resolve()
        expect(bridge).not.toHaveBeenCalled()
        expect(await h.control.load()).toEqual(before)
      } finally {
        await h.fixture.close()
      }
    },
  )
  test.each([
    'handshake',
    'commit',
    'sealed-outer',
    'sealed-inner',
    'tamper',
    'signature',
    'unrecognised',
    'gap',
    'ahead',
  ] as const)(
    `registry bound delivery faults preserve saved work and future progress (${mode}, %s)`,
    async (fault) => {
      const h = await createControlCrashHarness(mode, undefined, undefined, true, true)
      try {
        h.hooks.beforeWelcome = async () => {
          throw new Error('Recipient offline')
        }
        await h.peer.replay()
        const binding = controlBatch(h.mls)
        expect(binding).toBeDefined()
        if (binding === undefined) throw new Error('Missing original MLS binding')
        const bridge = vi.spyOn(binding, 'run')
        const built = await h.build()
        await h.saveBuilt(built.intent, built.slot, built.expected, 'saved-bound')
        const owed = {
          opID: 'independent-welcome',
          welcome: new Uint8Array([1, 3, 5]),
          recipients: ['independent-recipient'],
        }
        await h.control.apply(
          {
            putWelcomes: [owed],
            putOutcomes: [{ id: 'independent-outcome', opID: null, at: 1, kind: 'unknown' }],
          },
          'owed-bound',
        )
        const before = await h.control.load()
        const state = await h.groups.loadState(h.key)
        let payload: Uint8Array = built.slot.payload.slice()
        const decoded = decodeCommitFrame(decodeHandshakeFrame(payload).payload)
        if (fault === 'handshake') payload[2] = 255
        if (fault === 'commit') payload[4] = 255
        if (fault === 'sealed-outer' || fault === 'tamper' || fault === 'sealed-inner') {
          let sealed: Uint8Array = decoded.sealedEntries.slice()
          if (fault === 'sealed-outer') sealed[0] = 255
          if (fault === 'tamper') sealed[sealed.length - 1]! ^= 1
          if (fault === 'sealed-inner') {
            const handle = await h.registryAccess!.read((value) => value)
            const key = await deriveEntryKey(handle)
            try {
              sealed = sealEntries(key, new Uint8Array([255, 0, 0]))
            } finally {
              key.fill(0)
            }
          }
          payload = encodeHandshakeFrame(
            HANDSHAKE_KIND.commit,
            encodeCommitFrame(decoded.commit, sealed),
          )
        }
        if (fault === 'signature') {
          const commit = decoded.commit.slice()
          commit[commit.length - 1]! ^= 1
          payload = frame(commit)
        }
        if (fault === 'gap') {
          h.setControlGap(true)
          payload[2] = 255
        }
        if (fault === 'unrecognised') {
          const source = await h.registryAccess!.read((value) => value)
          const state = decodeClientState(encodeClientState(source.state))
          if (state === undefined) throw new Error('Missing source')
          const commit =
            mode === 'double'
              ? memoryModel(source).buildCommit([], { adds: [randomIdentity().id] })
              : (
                  await commitKeyRotation(
                    await restoreGroup({
                      state,
                      credential: source.credential,
                      ledgerEntries: source.ledgerTokens,
                    }),
                  )
                ).commitMessage
          payload = frame(commit)
        }
        if (fault === 'ahead') {
          if (mode === 'double') {
            const parsed = decodeMemoryCommit(decoded.commit)
            if (parsed === null) throw new Error('Missing model commit')
            payload = frame(
              tagMemoryCommit(
                new TextEncoder().encode(
                  JSON.stringify({ ...parsed, epoch: built.slot.epoch + 3 }),
                ),
                built.slot.authenticatorBefore,
              ),
            )
          } else {
            const parsed = decode(mlsMessageDecoder, decoded.commit)
            if (parsed?.wireformat !== wireformats.mls_private_message)
              throw new Error('Missing private commit')
            parsed.privateMessage.epoch += 3n
            payload = frame(encode(mlsMessageEncoder, parsed))
          }
        }
        const delivered = await h.hub.publish({
          topicID: await h.topic(),
          senderDID: randomIdentity().id,
          payload,
          retain: 'log',
        })
        await vi.waitFor(() => expect(bridge).toHaveBeenCalled())
        await Promise.all(bridge.mock.results.map((result) => result.value))
        const after = await h.control.load()
        expect(after.controlHold).toEqual(before.controlHold)
        expect(after.forkHalt).toEqual(before.forkHalt)
        expect(after.recoveryUnavailable).toEqual(before.recoveryUnavailable)
        expect(after.strand).toEqual(before.strand)
        expect(after.welcomes).toEqual(before.welcomes)
        expect(after.operations).toEqual(before.operations)
        expect(after.outcomes).toEqual(before.outcomes)
        expect(after.commitOnce).toEqual({
          ...before.commitOnce,
          skipped: true,
          retryForbidden: false,
        })
        const afterState = await h.groups.loadState(h.key)
        expect(afterState).toEqual({ ...state, version: afterState?.version })
        expect(after.cursor?.position).toBe(delivered.sequenceID)
        h.setControlGap(false)
        const reopened = await h.reopen()
        reopened.hooks.beforeWelcome = async () => {
          throw new Error('Recipient offline')
        }
        expect((await reopened.control.load()).commitOnce).toEqual(after.commitOnce)
        expect((await reopened.control.load()).welcomes).toEqual(before.welcomes)
        expect(controlBatch(reopened.mls)).toBeDefined()
        const resumed = vi.spyOn(controlBatch(reopened.mls)!, 'run')
        await reopened.peer.replay()
        await h.hub.publish({
          topicID: await reopened.topic(),
          senderDID: randomIdentity().id,
          payload: built.slot.payload,
          retain: 'log',
        })
        await vi.waitFor(() => expect(resumed).toHaveBeenCalled())
        const proven = await Promise.all(resumed.mock.results.map((result) => result.value))
        expect(proven.at(-1)?.value).toMatchObject({ consumed: true, advanced: true })
        expect(await reopened.groups.loadState(h.key)).toMatchObject({
          epoch: built.slot.epoch + 1,
        })
        expect((await reopened.control.load()).welcomes).toContainEqual(owed)
      } finally {
        await h.fixture.close()
      }
    },
  )
}

for (const mode of ['real-mls', 'double'] as const) {
  for (const failsPersistence of [false, true]) {
    test.each([
      'signed-loser',
      'own-mismatch',
      'unknown-version',
      'unknown-commit-version',
    ] as const)(
      `${mode} delivered %s never pushes keyed safety, persistence fails=${failsPersistence}`,
      async (kind) => {
        const groupID = `negative-sink-${mode}-${kind}-${failsPersistence}`
        const key = { groupID, incarnation: 1 }
        const f = await createRegistryFixture({ mode, groupID, setup: 'empty' })
        let running: ReturnType<typeof createGroupPeerWithControlWalk> | undefined
        let failWrites = false
        try {
          const source = await f.makeHandle(0)
          const rotation = mode === 'real-mls' ? await commitKeyRotation(source) : null
          const winnerCommit =
            rotation !== null ? rotation.commitMessage : memoryModel(source).buildCommit([])
          const deliveredCommit =
            mode === 'real-mls'
              ? (await commitKeyRotation(source)).commitMessage
              : memoryModel(source).buildCommit([], { adds: [randomIdentity().id] })
          expect(deliveredCommit).not.toEqual(winnerCommit)
          const candidate =
            rotation?.newGroup ??
            (await restoreMemoryControlHandle({
              state: source.state,
              credential: source.credential,
              ledgerEntries: source.ledgerTokens,
            }))
          if (mode === 'double') await memoryModel(candidate).adopt(winnerCommit)
          if (mode === 'real-mls')
            expect(await source.verifyCommitSignature(deliveredCommit)).toBe(true)
          const installed = kind === 'signed-loser' ? candidate : source
          await f.installRows({
            key,
            state: {
              ...key,
              version: 1,
              deleted: false,
              terminal: false,
              epoch: Number(installed.epoch),
              epochAuthenticator: installed.state.keySchedule.epochAuthenticator.slice(),
              state: encodeClientState(installed.state),
              credential: installed.credential,
              ledger: installed.ledgerTokens,
              senderHWM: 0,
            },
            trust: recoveryTrustFor(installed, key, null),
            control: {
              cursor: { position: asLogPosition('000000000001'), epoch: Number(installed.epoch) },
              ...(kind === 'signed-loser'
                ? {
                    putApplied: [
                      {
                        epoch: 0,
                        digest: digestAppliedCommit(winnerCommit),
                        payloadDigest: toB64U(sha256(frame(winnerCommit))),
                        sequenceID: asLogPosition('000000000001'),
                        removed: false,
                        opID: null,
                      },
                    ],
                  }
                : {}),
              putOutcomes: [{ id: 'saved-outcome', opID: 'saved-op', at: 1, kind: 'unknown' }],
            },
          })
          const capability = registrySafety(f.registry)
          if (capability === null) throw new Error('Missing keyed safety capability')
          const notifications = vi.fn()
          const unsubscribe = capability.onSafetyHold(key, notifications)
          const access = await f.registry.access(groupID)
          const handle = await access.read((value) => value)
          const ports = f.device.groups.ports(key)
          const control = ports.control
          const crypto = createGroupCrypto({ access: await f.registry.access(key.groupID) })
          const mls =
            mode === 'real-mls'
              ? new Proxy(
                  await createRegistryGroupMLS({
                    registry: f.registry,
                    key,
                    recovery: f.environment,
                    target: { targetID: 'hub', topicID: 'commits' },
                    identity: f.identity,
                    entrySlot: createLedgerEntrySlot(),
                  }),
                  {},
                )
              : createMemoryGroupMLS({
                  groupID,
                  epoch: Number(handle.epoch),
                  localDID: f.identity.id,
                  members: [f.identity.id],
                  recoverySecret: handle.state.keySchedule.exporterSecret,
                  entryDigest: ledgerEntryDigest,
                  computeLedgerHead: (ids) => toB64U(computeHead(groupID, ids)),
                  onSafetyHold: (latch) => capability.onSafetyHold(key, latch),
                })
          if ('restoreState' in mls && typeof mls.restoreState === 'function')
            mls.restoreState(memoryModel(handle).serializeState())
          const validation =
            mode === 'double'
              ? sealedMemoryValidation()
              : createControlValidationPort({
                  identity: f.identity,
                  options: {},
                  restoreCandidate: async () => {
                    throw new Error('Delivery poison must not restore an adoption candidate')
                  },
                })
          const hub = new FakeHub()
          const secret = await mls.exportRecoverySecret()
          // Reserve the known prefix without delivering it to the new peer.
          await hub.publish({
            senderDID: f.identity.id,
            topicID: commitTopic(secret),
            payload: kind === 'signed-loser' ? frame(winnerCommit) : new Uint8Array(),
            retain: 'log',
          })
          const subscribe = vi.spyOn(
            mls,
            mls.onSafetyChanged === undefined ? 'onSafetyHold' : 'onSafetyChanged',
          )
          const onStrand = vi.fn()
          const onRecovery = vi.fn()
          const onSafetyEvent = vi.fn()
          running = createGroupPeerWithControlWalk({
            completion: createTestCompletion(key, crypto.pending),
            openedDeliveryContext,
            hub,
            crypto,
            mls,
            control,
            validation,
            readEvidence: () => f.device.groups.readEvidence(key),
            prepareBuild: async () => {
              throw new Error('Saved work must not rebuild')
            },
            adopt: async () => {
              throw new Error('Delivery poison must not adopt')
            },
            deliverWelcome: async () => {},
            anchorStore: ports.anchor,
            appCursorStore: ports.cursor,
            appOutbox: ports.outbox,
            appPublication: createRegistryAppPublication(await f.registry.access(key.groupID)),
            appOutboxLimit: 16,
            localDID: f.identity.id,
            protocols: {},
            handlers: {},
            onStrand,
            onRecovery,
            onSafetyEvent,
          })
          await running.peer.replay()
          expect(subscribe).toHaveBeenCalledOnce()
          if (kind !== 'signed-loser') {
            const payload = frame(winnerCommit)
            const saved: ControlSlot = {
              opID: 'unknown-op',
              kind: 'rotation',
              revokes: false,
              enqueuedAt: Date.now(),
              deadline: Date.now() + 30_000,
              incarnation: 1,
              epoch: 0,
              authenticatorBefore: source.state.keySchedule.epochAuthenticator.slice(),
              head: asLogPosition('000000000001'),
              expectedHead: asLogPosition('000000000001'),
              publishID: 'unknown-publish',
              payload,
              payloadDigest: toB64U(sha256(payload)),
              digest: digestAppliedCommit(winnerCommit),
              bodies: [],
              welcome: null,
              journal: encodeControlJournal({
                version: 1,
                source: (await f.device.groups.readEvidence(key)).source,
                checkpoint: asLogPosition('000000000001'),
                sourceState: encodeClientState(source.state),
                sourceCredential: source.credential,
                sourceLedger: source.ledgerTokens,
                candidate: encodeClientState(candidate.state),
              }),
            }
            await f.installRows({
              key,
              control: {
                commitOnce: saved,
              },
            })
          }
          const before = await control.load()
          const apply = control.apply.bind(control)
          const rejectedWrites = vi.fn()
          vi.spyOn(control, 'apply').mockImplementation(async (changes, mutationID) => {
            if (
              failWrites &&
              (changes.cursor !== undefined ||
                changes.forkHalt != null ||
                changes.controlHold != null ||
                changes.recoveryUnavailable != null)
            ) {
              rejectedWrites(changes)
              throw new Error('Delivery evidence persistence failed')
            }
            return apply(changes, mutationID)
          })
          failWrites = failsPersistence
          const payload = frame(deliveredCommit)
          if (kind === 'unknown-version') payload[2] = 99
          if (kind === 'unknown-commit-version') payload[4] = 99
          if (kind === 'signed-loser') {
            await expect(
              hub.publish({
                senderDID: f.identity.id,
                topicID: commitTopic(secret),
                payload,
                retain: 'log',
                expectedHead: null,
              }),
            ).rejects.toMatchObject({ name: 'HeadMismatchError' })
          }
          const delivered = await hub.publish({
            senderDID: f.identity.id,
            topicID: commitTopic(secret),
            payload,
            retain: 'log',
          })
          const walk = () => {
            if (running === undefined) throw new Error('Missing peer')
            return running.controlWalk.walkCommits()
          }
          const replay = walk().catch((error: unknown) => error)
          if (failsPersistence) {
            const result = await replay
            expect(notifications).not.toHaveBeenCalled()
            expect(result).toEqual(new Error('Delivery evidence persistence failed'))
            expect(rejectedWrites).toHaveBeenCalled()
            expect(await control.load()).toEqual(before)
            expect(notifications).not.toHaveBeenCalled()
            expect(capability.safetyHold(key)).toBeNull()
            expect(running.controlWalk.safetyHold()).toBeNull()
            failWrites = false
            await walk()
          } else {
            expect(await replay).toBe(false)
          }
          const after = await control.load()
          expect(notifications).not.toHaveBeenCalled()
          expect(capability.safetyHold(key)).toBeNull()
          expect(running.controlWalk.safetyHold()).toBeNull()
          expect(after.forkHalt).toBeNull()
          expect(after.recoveryUnavailable).toBeNull()
          expect(after.controlHold).toBeNull()
          expect(after.strand).toBeNull()
          expect(after.cursor).toEqual({
            position: delivered.sequenceID,
            epoch: Number(installed.epoch),
          })
          expect(after.commitOnce).toEqual(
            before.commitOnce === null
              ? null
              : {
                  ...before.commitOnce,
                  skipped: true,
                  retryForbidden: false,
                },
          )
          expect(after.operations).toEqual(before.operations)
          expect(after.outcomes).toEqual(before.outcomes)
          expect(after.applied).toEqual(before.applied)
          expect(after.welcomes).toEqual(before.welcomes)
          expect(after.responses).toEqual(before.responses)
          expect(onStrand).toHaveBeenCalledWith(
            expect.objectContaining({
              kind: {
                'signed-loser': 'past-epoch-divergence',
                'own-mismatch': 'own-unmerged',
                'unknown-version': 'unknown-version',
                'unknown-commit-version': 'unknown-version',
              }[kind],
              confidence: 'claimed',
            }),
          )
          expect(onRecovery).not.toHaveBeenCalled()
          expect(onSafetyEvent).not.toHaveBeenCalled()
          unsubscribe()
        } finally {
          failWrites = false
          await running?.peer.dispose()
          await running?.peer.drained()
          vi.restoreAllMocks()
          await f.close()
        }
      },
    )
  }
}
