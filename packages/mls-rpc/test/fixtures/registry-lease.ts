import { encodeEventFrame } from '@kumiai/broadcast'
import {
  createGroup,
  encodeClientState,
  exportGroupInfo,
  joinGroupExternal,
  ownApplicationGeneration,
  restoreGroup,
} from '@kumiai/mls'
import { serializeHandle } from '@kumiai/mls/testing'
import {
  asLogPosition,
  digestAppliedCommit,
  encodeAppAAD,
  forkEventID,
  frameID,
  recoveryUnavailableEventID,
} from '@kumiai/rpc'
import {
  type AppOutboxAcceptance,
  createAppOutboxAcceptance,
  createLogDelivery,
} from '@kumiai/rpc/testing'
import type { RegistryLeaseConformanceFixture } from '@kumiai/rpc-conformance'
import { expect, vi } from 'vitest'

import { entryCapability } from '../../src/entry-capability.js'
import type { OwnershipContextPort } from '../../src/persistence-types.js'
import { registryReceiveSlots } from '../../src/registry/live-receive.js'
import { registryLiveSend } from '../../src/registry/live-send.js'
import {
  type Reservation,
  reservationEnvelope,
  reserveFromBytes,
} from '../../src/registry/reserve.js'
import { registrySafety } from '../../src/registry/safety.js'
import type {
  ReadableGroupState,
  ReceiveInput,
  RegistryHandleAccess,
} from '../../src/registry/types.js'
import { createRegistryGroupMLS } from '../../src/registry-group-mls.js'
import * as testing from '../../src/testing.js'
import { loadLifecyclePipelineFixture } from './real-group.js'
import {
  createRegistryFixture,
  registryFixtureCapturedRecovery,
  registryFixtureObserveDecrypts,
  registryFixtureRestore,
} from './registry.js'
import { createRegistryCryptoGroup } from './registry-crypto.js'
import { createRegistryWelcomeHistory, registryHandle } from './registry-welcome.js'
import { restoreMemoryControlHandle } from './sealed-memory-mls.js'

export async function createRegistryLeaseFixture(
  mode: 'real-mls' | 'double',
  source: 'seed' | 'welcome' = 'seed',
  initialGeneration = 0,
  ownershipContext?: OwnershipContextPort,
) {
  const id = `lease-${mode}-${crypto.randomUUID()}`
  const group =
    source === 'welcome' ? await createRegistryCryptoGroup(mode, id, 2, { ownershipContext }) : null
  let peerFixture: Awaited<ReturnType<typeof createRegistryFixture>> | null = null
  let peer: RegistryHandleAccess | null = null
  let fixture =
    group?.fixture() ??
    (await createRegistryFixture({ mode, setup: 'empty', groupID: id, ownershipContext }))
  const input = group === null ? await fixture.makeHandle(0) : null
  if (input !== null && initialGeneration !== 0) {
    await input.advanceSenderGeneration(initialGeneration)
  }
  let key =
    group?.key ??
    (input === null
      ? (() => {
          throw new Error('Missing input')
        })()
      : await fixture.registry.seed(input, { packageUse: null }))
  let access = await fixture.registry.access(key.groupID)
  testing.receiveRebuilds(access)
  const localOpens = new Map<string, number>()
  const peerOpens = new Map<string, number>()
  const trackOpens = (target: typeof fixture, counts: Map<string, number>) => {
    registryFixtureObserveDecrypts(target, (ciphertext) => {
      const id = frameID('lease-opens', ciphertext)
      counts.set(id, (counts.get(id) ?? 0) + 1)
    })
  }
  trackOpens(fixture, localOpens)
  let transactions = 0
  let readTransactions = 0
  const trackTransactions = () => {
    const capability = entryCapability(fixture.device.groups)
    if (capability === null) throw new Error('Missing entry capability')
    const original = capability.run.bind(capability)
    const read = capability.read.bind(capability)
    capability.read = (groupID, fn) => {
      readTransactions++
      return read(groupID, fn)
    }
    capability.run = (request, prepare, work) => {
      transactions++
      return original(request, prepare, work)
    }
    return () => {
      capability.run = original
      capability.read = read
    }
  }
  let unsubscribe = trackTransactions()
  async function record(): Promise<ReadableGroupState> {
    const saved = await fixture.device.groups.loadState(key)
    if (saved === null || saved.deleted || saved.state === null)
      throw new Error('Missing lease state')
    return { ...saved, state: saved.state }
  }
  const result = {
    get key() {
      return key
    },
    group,
    fixture: () => fixture,
    access: () => access,
    aad: (intent: 'ephemeral' | 'log') => encodeAppAAD({ topicID: 'lease-app', intent }),
    sealEphemeral: (
      plaintext: Uint8Array = new Uint8Array([1]),
      aad: Uint8Array = result.aad('ephemeral'),
    ) => access.seal(plaintext, { aad, intent: 'ephemeral' }),
    sealDurable: (plaintext: Uint8Array = new Uint8Array([1])) =>
      access.seal(plaintext, { aad: result.aad('log'), intent: 'log' }),
    admission: () => access.admission(),
    lease: () => testing.registryLeaseSnapshot(access),
    transactions: () => transactions,
    providerTransactions: () => transactions + readTransactions,
    restores: () => fixture.restores(),
    receiveRebuilds: () => testing.receiveRebuilds(access),
    openEphemeral: (frames: Array<ReceiveInput>) => access.receive(frames),
    opens: (ciphertext: Uint8Array, receiver: 'local' | 'peer' = 'local') =>
      (receiver === 'local' ? localOpens : peerOpens).get(frameID('lease-opens', ciphertext)) ?? 0,
    async peerAccess() {
      if (peer !== null) return peer
      if (group === null) throw new Error('Peer access requires a peer')
      const member = group.sender
      peerFixture = await createRegistryFixture({
        mode,
        setup: 'empty',
        groupID: key.groupID,
        identity: member.identity,
        ownershipContext,
        options: { ...fixture.environment.options, resolveLedgerEntries: member.slot.resolve },
      })
      trackOpens(peerFixture, peerOpens)
      const handle = await (mode === 'double' ? restoreMemoryControlHandle : restoreGroup)({
        state: structuredClone(member.handle.state),
        credential: member.handle.credential,
        ledgerEntries: member.handle.ledgerTokens,
        options: peerFixture.environment.options,
      })
      await peerFixture.registry.seed(handle, {
        packageUse: { sourceID: 'lease-peer', ref: 'joined', kind: 'ordinary' },
      })
      peer = await peerFixture.registry.access(key.groupID)
      return peer
    },
    async advanceEpoch() {
      if (group === null) throw new Error('Epoch advance requires a peer')
      await group.advance(undefined, async (commit) => {
        await peer?.mutate((handle, persist) => handle.processMessage(commit, { persist }))
      })
    },
    async jumpEpochs(count: number) {
      for (let index = 0; index < count; index++) await result.advanceEpoch()
    },
    async removePeer() {
      if (group === null) throw new Error('Removal requires a peer')
      await group.advance(1, async (commit) => {
        if (peer === null || peerFixture === null) return
        const epoch = peer.epoch()
        const position = asLogPosition(String(epoch + 1).padStart(6, '0'))
        const digest = digestAppliedCommit(commit)
        const mls = await createRegistryGroupMLS({
          registry: peerFixture.registry,
          key: peer.key,
          identity: peerFixture.identity,
          entrySlot: group.sender.slot,
          recovery: peerFixture.environment,
          target: { targetID: 'lease-hub', topicID: 'lease-commits' },
        })
        const removal = await mls.processCommit(commit, {
          adoption: (candidate) => ({
            mutationID: crypto.randomUUID(),
            changes: {
              commitOnce: null,
              putApplied: [
                {
                  epoch,
                  digest,
                  payloadDigest: digest,
                  sequenceID: position,
                  opID: null,
                  removed: true,
                },
              ],
              cursor: { position, epoch: candidate.epochAfter },
            },
          }),
        })
        if (!removal.applied) throw new Error('Peer removal was not applied')
      })
    },
    async switchIncarnation() {
      const recovery =
        group === null || mode === 'double'
          ? await fixture.confirmedRecovery(key, {
              confirm: true,
              ...(mode === 'double' ? { format: 'legacy' as const } : {}),
            })
          : await registryFixtureCapturedRecovery(fixture, key, {
              confirm: true,
              responder: {
                identity: group.group.committer.identity,
                group: group.group.committer.handle,
              },
            })
      key = await fixture.registry.switchIncarnation(recovery.candidate, {
        source: recovery.source,
        rejoinID: recovery.record.id,
        proof: recovery.proof,
        write: {
          mutationID:
            'format' in recovery.record
              ? (recovery.record.switchMutationID ?? crypto.randomUUID())
              : crypto.randomUUID(),
          source: { rejoinID: recovery.record.id },
          destination: {
            control: {
              cursor: {
                position: recovery.proof.position,
                epoch: Number(recovery.candidate.epoch),
              },
            },
          },
        },
      })
      access = await fixture.registry.access(key.groupID)
      testing.receiveRebuilds(access)
    },
    async setUnavailable() {
      const saved = await record()
      await fixture.installRows({
        key,
        state: { ...saved, terminal: true, version: saved.version + 1 },
      })
    },
    record,
    storedGeneration: async () =>
      ownApplicationGeneration((await fixture.restoreCommittedSender(key.groupID)).state),
    rawRestoreEncrypt: async () =>
      (
        await (
          await fixture.restoreCommittedSender(key.groupID)
        ).encryptApplication(new Uint8Array([2]))
      ).generation,
    inspectRows: () => fixture.inspectRows(),
    failNextEncrypt: (when: 'throw-before' | 'throw-after') =>
      testing.armLiveEncryptFault(access, when),
    blockNextEncrypt: () => testing.armLiveEncryptFault(access, 'block'),
    drainMaintenance: () => testing.drainRegistryMaintenance(access),
    blockMaintenance: () => testing.blockRegistryMaintenance(access),
    async dropOwner() {
      testing.dropRegistryOwner(access)
      access = await fixture.registry.access(key.groupID)
      testing.receiveRebuilds(access)
    },
    async reopen(open = true) {
      unsubscribe()
      if (group === null) fixture = await fixture.reopen()
      else {
        await group.reopen()
        fixture = group.fixture()
      }
      unsubscribe = trackTransactions()
      trackOpens(fixture, localOpens)
      if (open) {
        access = await fixture.registry.access(key.groupID)
        testing.receiveRebuilds(access)
      }
    },
    async writeElsewhere(kind: 'receive' | 'proposal' | 'control' | 'cursor') {
      try {
        if (kind === 'control') {
          await fixture.device.groups
            .ports(key)
            .control.apply({ cursor: null }, crypto.randomUUID())
          return
        }
        if (kind === 'cursor') {
          await fixture.device.groups.ports(key).cursor.save('lease-app', '1-0')
          return
        }
        const saved = await record()
        const handle = await fixture.restoreCommittedSender(key.groupID)
        if (kind === 'proposal') handle.state.unappliedProposals = await result.proposal()
        else {
          if (group === null) throw new Error('Foreign receive requires a peer')
          await handle.decrypt(await group.sender.handle.encrypt(new Uint8Array([8])))
        }
        await fixture.installRows({
          key,
          state: { ...saved, version: saved.version + 1, state: encodeClientState(handle.state) },
        })
      } finally {
        await registryLiveSend.get(access)?.accounting()
      }
    },
    async proposal() {
      const { group: handle } = await createGroup(fixture.identity, id, fixture.environment.options)
      await handle.proposeSelfRemoval()
      return structuredClone(handle.state.unappliedProposals)
    },
    async openDurable(input?: ReceiveInput) {
      if (group === null) throw new Error('Durable receive requires a peer')
      const ciphertext =
        input?.ciphertext ??
        (await group.sender.handle.encrypt(encodeEventFrame('posted', { text: 'hello' }), {
          aad: result.aad('log'),
        }))
      const topicID = 'lease-app'
      return access.openBatch([
        {
          ciphertext,
          expectedAAD: input?.expectedAAD ?? result.aad('log'),
          frame: {
            ...key,
            topicID,
            protocol: 'chat',
            segment: access.epoch(),
            position: `${transactions + 1}-0`,
            id: frameID(topicID, ciphertext),
          },
        },
      ])
    },
    async reserveNow(
      fault?: 'persist-pre' | 'envelope-pre' | 'no-envelope' | 'overlap' | 'pre-start',
      captured?: (reservation: Reservation) => void,
    ) {
      const live = registryLiveSend.get(access)
      if (live === undefined) throw new Error('Missing sender')
      return live.run(
        { groupID: key.groupID, mutationID: crypto.randomUUID() },
        async (reads) => {
          const source = await reads.state(key.incarnation)
          if (source === null || source.deleted || source.state === null)
            throw new Error('Missing state')
          const environment = {
            ownerDID: fixture.identity.id,
            recovery: fixture.environment,
            restore: registryFixtureRestore(fixture),
          }
          const reserved = await reserveFromBytes(
            environment,
            { ...source, state: source.state },
            source.senderHWM,
          )
          if (reserved.reservation === null) throw new Error('Reservation refused')
          const saved = {
            ...source,
            state: reserved.state,
            senderHWM: reserved.senderHWM,
            version: source.version + 1,
          }
          const reservation = { ...reserved.reservation, envelope: reservationEnvelope(saved) }
          if (fault === 'overlap') {
            const copy = result.lease()?.copy
            if (copy === undefined) throw new Error('Missing copy')
            reservation.start = ownApplicationGeneration(copy.state)
            reservation.pre = { ...reservation.pre, state: encodeClientState(copy.state) }
          }
          if (fault === 'pre-start') reservation.start++
          if (fault === 'persist-pre') saved.state = reservation.pre.state
          if (fault === 'envelope-pre')
            reservation.envelope = reservationEnvelope({ ...saved, state: reservation.pre.state })
          if (fault === 'no-envelope') Reflect.deleteProperty(reservation, 'envelope')
          captured?.(reservation)
          // Bind the envelope to the intentionally defective saved row for the proof check.
          if (fault === 'persist-pre') reservation.envelope = reservationEnvelope(saved)
          return {
            expected: await reads.lifetime(),
            value: { record: saved, reservation, eligibility: reservation.eligibility },
          }
        },
        async (stores, prepared) => {
          await stores.incarnation(key.incarnation).state.save(prepared.record)
        },
      )
    },
    async forceStoredGeneration(generation: number) {
      const saved = await record()
      const handle = await fixture.restoreCommittedSender(key.groupID)
      const ratchet = handle.state.secretTree.leafNodes[handle.state.privatePath.leafIndex * 2]
      if (ratchet === undefined) throw new Error('Missing application ratchet')
      ratchet.application.generation = generation
      await fixture.installRows({
        key,
        state: {
          ...saved,
          version: saved.version + 1,
          senderHWM: generation,
          state: encodeClientState(handle.state),
        },
      })
    },
    async holdSafety(
      reason: 'fork-halted' | 'recovery-unavailable' | 'spent-set-corrupt' = 'fork-halted',
    ) {
      if (reason === 'spent-set-corrupt') {
        const safety = registrySafety(fixture.registry)
        if (safety === null) throw new Error('Missing safety capability')
        await safety.persistGroupCondition(key, 'spent-set-corrupt', null)
        return
      }
      await fixture.installRows({
        key,
        control:
          reason === 'fork-halted'
            ? {
                forkHalt: {
                  eventID: forkEventID(key),
                  detectedAt: 1,
                  evidence: {
                    kind: 'digest-divergence',
                    epoch: access.epoch(),
                    position: '1',
                    localDigest: 'local',
                    remoteDigest: 'remote',
                  },
                },
              }
            : {
                recoveryUnavailable: {
                  ...key,
                  id: recoveryUnavailableEventID(key),
                  kind: 'group:recovery-unavailable',
                  reason: 'trust-unreadable',
                },
              },
      })
    },
    async close() {
      unsubscribe()
      await peerFixture?.close()
      await fixture.close()
    },
    async senderFrame(
      generation?: number,
      aad: Uint8Array = result.aad('ephemeral'),
    ): Promise<ReceiveInput & { expectedAAD: Uint8Array }> {
      if (group === null) throw new Error('Sender requires a peer')
      if (generation !== undefined) await group.sender.handle.advanceSenderGeneration(generation)
      const sealed = await group.sender.handle.encryptApplication(new Uint8Array([7]), { aad })
      return { ciphertext: sealed.ciphertext, expectedAAD: aad }
    },
    setReceiveCapacity: (cap: number) => testing.setReceiveCapacity(access, cap),
    consumed() {
      const slot = registryReceiveSlots.get(access)
      if (slot === undefined) throw new Error('Missing receive slot')
      return {
        count: [...slot.consumed.epochs.values()].reduce((sum, bucket) => sum + bucket.size, 0),
        closed: [...slot.consumed.closed],
      }
    },
    async defer(kind: 'removed' | 'suspended' | 'proposal') {
      const saved = await record()
      const handle = await fixture.restoreCommittedSender(key.groupID)
      if (kind === 'proposal') handle.state.unappliedProposals = await result.proposal()
      else if (kind === 'removed') handle.state.groupActiveState = { kind: 'removedFromGroup' }
      else {
        const context = handle.state.groupContext
        handle.state.groupActiveState = {
          kind: 'suspendedPendingReinit',
          reinit: {
            groupId: context.groupId,
            version: context.version,
            cipherSuite: context.cipherSuite,
            extensions: [],
          },
        }
      }
      await fixture.installRows({
        key,
        state: { ...saved, version: saved.version + 1, state: encodeClientState(handle.state) },
      })
      await registryLiveSend.get(access)?.accounting()
    },
    async controlProgress() {
      await fixture.device.groups.ports(key).control.apply({ cursor: null }, crypto.randomUUID())
    },
    async foreignEvict() {
      await result.advanceEpoch()
      const saved = await record()
      const handle = await fixture.restoreCommittedSender(key.groupID)
      handle.state.historicalReceiverData.clear()
      await fixture.installRows({
        key,
        state: { ...saved, version: saved.version + 1, state: encodeClientState(handle.state) },
      })
      await registryLiveSend.get(access)?.accounting()
    },
    async blockedCallerSend() {
      const caller = await fixture.makeHandle(0, `${id}-caller`)
      const entered = Promise.withResolvers<void>()
      const released = Promise.withResolvers<void>()
      const holder = serializeHandle(caller, async () => {
        entered.resolve()
        await released.promise
      })
      await entered.promise
      const installed = fixture.registry.seed(caller, { packageUse: null })
      const send = caller.encryptApplication(new Uint8Array([1]))
      const refused = expect(send).rejects.toThrow()
      try {
        await Promise.resolve()
        released.resolve()
        await holder
        await refused
      } finally {
        released.resolve()
        await holder
      }
      const installedKey = await installed
      const admitted = await fixture.registry.access(installedKey.groupID)
      expect(
        (
          await admitted.seal(new Uint8Array([2]), {
            aad: result.aad('ephemeral'),
            intent: 'ephemeral',
          })
        ).generation,
      ).toBe(0)
      await expect(caller.encryptApplication(new Uint8Array([3]))).rejects.toThrow()
    },
    async lapsedReservation() {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(150_000)
      try {
        const { pipelineGroup, agent, timedBinding, lowLevelWelcome } =
          await loadLifecyclePipelineFixture()
        const setup = await pipelineGroup()
        const peerIdentity = agent(61)
        const joined = await lowLevelWelcome(
          setup.group,
          peerIdentity,
          await timedBinding({ identity: peerIdentity, iat: 201, exp: 300 }),
        )
        let local = await createRegistryFixture({
          mode,
          setup: 'empty',
          groupID: joined.author.groupID,
          identity: setup.identity,
          ownershipContext,
          options: {
            commitPolicy: setup.group.commitPolicy,
            resolveLedgerEntries: setup.group.resolveLedgerEntries,
          },
        })
        try {
          const options = local.environment.options
          const author = await registryHandle({
            mode,
            handle: await restoreGroup({
              state: joined.author.state,
              credential: joined.author.credential,
              ledgerEntries: joined.author.ledgerTokens,
              options,
            }),
            options,
          })
          const sender = await registryHandle({ mode, handle: joined.joined, options })
          expect(author.ownLeafLapsed()).toBe(true)
          const sealed = await sender.encryptApplication(new Uint8Array([7]), {
            aad: result.aad('ephemeral'),
          })
          const localKey = await local.registry.seed(author, {
            packageUse: { sourceID: 'lease-lapsed', ref: 'restored', kind: 'ordinary' },
          })
          for (const restart of [false, true]) {
            if (restart) local = await local.reopen()
            const held = await local.registry.access(localKey.groupID)
            await testing.drainRegistryMaintenance(held)
            expect(testing.registryLeaseSnapshot(held)).toBeNull()
            await expect(
              held.seal(new Uint8Array([1]), { aad: result.aad('ephemeral'), intent: 'ephemeral' }),
            ).rejects.toThrow()
            await local.device.groups
              .ports(localKey)
              .control.apply({ cursor: null }, crypto.randomUUID())
            expect(
              await held.receive([
                { ciphertext: sealed.ciphertext, expectedAAD: result.aad('ephemeral') },
              ]),
            ).toMatchObject([{ kind: 'opened' }])
          }
        } finally {
          await local.close()
        }
      } finally {
        clock.mockRestore()
      }
    },
    async removedReplay() {
      const opened = await result.openDurable()
      expect(opened).toMatchObject([{ kind: 'opened' }])
      const pending = await access.pending.list()
      expect(pending).toHaveLength(1)
      const input = await result.senderFrame()
      await result.defer('removed')
      await result.drainMaintenance()
      expect(result.lease()).toBeNull()
      await expect(result.sealEphemeral()).rejects.toThrow()
      await result.controlProgress()
      expect(await access.pending.list()).toEqual(pending)
      const restored = await fixture.restoreCommittedSender(key.groupID)
      expect(
        await restored.decrypt(input.ciphertext, { expectedAAD: input.expectedAAD }),
      ).toMatchObject({ payload: new Uint8Array([7]) })
      await expect(result.openEphemeral([input])).rejects.toThrow()
    },
    replyAAD: () => encodeAppAAD({ topicID: 'directed-reply/request-42', intent: 'ephemeral' }),
    async acceptedHold() {
      const store = () => fixture.device.groups.ports(key).outbox
      const outbox = {
        list: async () => (await store().list()).map((entry) => ({ ...entry, lastAttempt: null })),
        put: async (entry: Parameters<AppOutboxAcceptance['replace']>[0]) => {
          await store().put({ ...entry, status: 'accepted', lastAttempt: null })
        },
        remove: async (seq: number) => store().remove(seq),
        clear: async () => store().clear(),
      }
      const queue = createAppOutboxAcceptance({ outbox, limit: 4, admission: result.admission })
      const entered = Promise.withResolvers<void>()
      const publish = vi.fn(async () => {})
      const delivery = createLogDelivery({
        queue,
        ready: async () => {
          entered.resolve()
        },
        floor: () => ({ epoch: access.epoch(), position: null, covered: true }),
        held: () => !result.admission().admissible,
        handoffHeld: () => false,
        probe: async () => ({ head: null, oldest: null, gap: false, messages: [] }),
        pull: async () => {},
        heal: async () => {},
        seal: async (entry) => {
          const sealed = await result.sealDurable(entry.data)
          return {
            topicID: 'lease-app',
            payload: sealed.ciphertext,
            floor: { epoch: sealed.epoch, position: null, covered: true },
          }
        },
        put: outbox.put,
        publish,
        remove: outbox.remove,
        clear: outbox.clear,
        cleared: () => {},
        deliveredWindowMs: 60_000,
        deliveredLimit: 4,
      })
      await queue.accept({
        protocol: 'chat',
        prc: 'posted',
        data: encodeEventFrame('posted', { text: 'held' }),
      })
      return {
        async check() {
          await expect(
            queue.accept({
              protocol: 'chat',
              prc: 'posted',
              data: encodeEventFrame('posted', { text: 'refused' }),
            }),
          ).rejects.toMatchObject({ reason: 'rotation-required' })
          delivery.trigger()
          await entered.promise
          await new Promise<void>((resolve) => setTimeout(resolve, 0))
          expect(publish).not.toHaveBeenCalled()
          expect(queue.entries()).toHaveLength(1)
          expect(await store().list()).toMatchObject([{ status: 'accepted', lastAttempt: null }])
        },
        close() {
          delivery.close()
          queue.close()
        },
      }
    },
    async retention(
      path: 'create' | 'restore' | 'Welcome' | 'external join' | 'derive' | 'recovery',
    ): Promise<{ retainKeysForGenerations: number; maximumForwardRatchetSteps: number }> {
      let handle = await fixture.makeHandle(0)
      if (path === 'restore') handle = await fixture.restoreCommittedSender(key.groupID)
      if (path === 'Welcome' || path === 'external join') {
        const { history } = await createRegistryWelcomeHistory({
          mode: path === 'external join' ? 'real-mls' : mode,
          groupID: id,
          identity: fixture.identity,
          options: fixture.environment.options,
          kind: 'ordinary',
        })
        handle = history.exact
        if (path === 'external join') {
          handle = (
            await joinGroupExternal({
              identity: fixture.identity,
              groupInfo: (await exportGroupInfo({ group: handle })).groupInfo,
              credential: handle.credential,
              resync: true,
              ledgerEntries: handle.ledgerTokens,
              options: fixture.environment.options,
            })
          ).group
          handle = await registryHandle({ mode, handle, options: fixture.environment.options })
        }
      }
      if (path === 'derive') handle = await fixture.advance(handle)
      if (path === 'recovery') {
        await result.switchIncarnation()
        handle = await fixture.restoreCommittedSender(key.groupID)
      }
      const config = handle.context.clientConfig?.keyRetentionConfig
      if (config === undefined) throw new Error('Missing client configuration')
      return config
    },
    async ordinaryAdoption(): Promise<void> {
      if (group === null) throw new Error('Adoption requires a peer')
      const built = await fixture.acceptedOrdinary(access)
      const builtGeneration = await result.storedGeneration()
      await result.reserveNow()
      expect(await result.storedGeneration()).toBeGreaterThan(builtGeneration)
      const input = {
        ciphertext: await group.sender.handle.encrypt(
          encodeEventFrame('posted', { text: 'history' }),
          { aad: result.aad('ephemeral') },
        ),
        expectedAAD: result.aad('ephemeral'),
      }
      const durable = await result.openDurable(input)
      expect(durable).toMatchObject([{ kind: 'opened' }])
      const before = await fixture.restoreCommittedSender(key.groupID)
      const sender = ownApplicationGeneration(before.state)
      await access.adopt(built.candidate, built.expected, built.write)
      const after = await fixture.restoreCommittedSender(key.groupID)
      const history = after.state.historicalReceiverData.get(before.epoch)
      expect(history).toBeDefined()
      expect(
        history?.secretTree.leafNodes[before.state.privatePath.leafIndex * 2]?.application
          .generation,
      ).toBeGreaterThanOrEqual(sender)
      const other = group?.sender.handle.state.privatePath.leafIndex
      if (other === undefined) throw new Error('Missing peer leaf')
      expect(history?.secretTree.leafNodes[other * 2]?.application.generation).toBe(
        before.state.secretTree.leafNodes[other * 2]?.application.generation,
      )
      expect(await result.openEphemeral([input])).toMatchObject([{ kind: 'refused' }])
      const next = await fixture.acceptedOrdinary(access)
      const evicted = await record()
      after.state.historicalReceiverData.clear()
      await fixture.installRows({
        key,
        state: { ...evicted, version: evicted.version + 1, state: encodeClientState(after.state) },
      })
      await access.adopt(next.candidate, next.expected, next.write)
      await result.reopen()
      expect(
        await access.read((current) => current.state.historicalReceiverData.has(before.epoch)),
      ).toBe(false)
    },
  }
  return result satisfies RegistryLeaseConformanceFixture
}
