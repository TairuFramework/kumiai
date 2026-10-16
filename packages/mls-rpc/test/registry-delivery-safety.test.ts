import { randomIdentity } from '@kokuin/token'
import { commitKeyRotation, computeHead, encodeClientState, ledgerEntryDigest } from '@kumiai/mls'
import {
  asLogPosition,
  type ControlSlot,
  commitTopic,
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
import { expect, test, vi } from 'vitest'

import { encodeControlJournal } from '../src/control-journal.js'
import { createControlValidationPort } from '../src/control-validation.js'
import { createGroupCrypto } from '../src/crypto.js'
import { createLedgerEntrySlot } from '../src/mls.js'
import { registrySafety } from '../src/registry/safety.js'
import { recoveryTrustFor } from '../src/registry/trust.js'
import { createRegistryGroupMLS } from '../src/registry-group-mls.js'
import { createRegistryHandleAccess } from '../src/registry-handle-access.js'
import { createRegistryFixture } from './fixtures/registry.js'
import {
  memoryModel,
  restoreMemoryControlHandle,
  sealedMemoryValidation,
} from './fixtures/sealed-memory-mls.js'

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
          const crypto = createGroupCrypto({
            access: {
              ...createRegistryHandleAccess({ access }),
              open: async () => {
                throw new Error('No application frames in this witness')
              },
            },
          })
          const mls =
            mode === 'real-mls'
              ? await createRegistryGroupMLS({
                  registry: f.registry,
                  key,
                  recovery: f.environment,
                  target: { targetID: 'hub', topicID: 'commits' },
                  identity: f.identity,
                  entrySlot: createLedgerEntrySlot(),
                })
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
          const subscribe = vi.spyOn(mls, 'onSafetyHold')
          const onStrand = vi.fn()
          const onRecovery = vi.fn()
          const onSafetyEvent = vi.fn()
          running = createGroupPeerWithControlWalk({
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
              incarnation: 1,
              epoch: 0,
              authenticatorBefore: source.state.keySchedule.epochAuthenticator.slice(),
              searchFrom: asLogPosition('000000000001'),
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
                putOperations: [
                  {
                    id: saved.opID,
                    kind: 'rotation',
                    revokes: false,
                    body: new Uint8Array(),
                    seq: 1,
                    enqueuedAt: Date.now(),
                    deadline: Date.now() + 30_000,
                    stage: 'intent',
                  },
                ],
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
            let fetches = 2
            let frames = 2
            if (running === undefined) throw new Error('Missing peer')
            return running.controlWalk.walkCommits({
              through: asLogPosition(delivered.sequenceID),
              range: null,
              work: { takeFetch: () => fetches-- > 0, takeFrame: () => frames-- > 0 },
            })
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
          expect(
            after.controlHold === null || after.controlHold.reason === 'acceptance-unknown',
          ).toBe(true)
          expect(after.strand).toBeNull()
          expect(after.cursor).toEqual({
            position: delivered.sequenceID,
            epoch: Number(installed.epoch),
          })
          expect(after.commitOnce).toEqual(before.commitOnce)
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
