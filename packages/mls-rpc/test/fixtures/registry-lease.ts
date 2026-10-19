import { encodeEventFrame } from '@kumiai/broadcast'
import { createGroup, encodeClientState, ownApplicationGeneration } from '@kumiai/mls'
import { encodeAppAAD, forkEventID, frameID, recoveryUnavailableEventID } from '@kumiai/rpc'
import type { RegistryLeaseFixture } from '@kumiai/rpc-conformance'

import { entryCapability } from '../../src/entry-capability.js'
import { registryLiveSend } from '../../src/registry/live-send.js'
import { reservationEnvelope, reserveFromBytes } from '../../src/registry/reserve.js'
import { registrySafety } from '../../src/registry/safety.js'
import type { ReadableGroupState } from '../../src/registry/types.js'
import * as testing from '../../src/testing.js'
import { createRegistryFixture, registryFixtureRestore } from './registry.js'
import { createRegistryCryptoGroup } from './registry-crypto.js'

export async function createRegistryLeaseFixture(
  mode: 'real-mls' | 'double',
  source: 'seed' | 'welcome' = 'seed',
  initialGeneration = 0,
) {
  const id = `lease-${mode}-${crypto.randomUUID()}`
  const group = source === 'welcome' ? await createRegistryCryptoGroup(mode, id, 1) : null
  let fixture =
    group?.fixture() ?? (await createRegistryFixture({ mode, setup: 'empty', groupID: id }))
  const input = group === null ? await fixture.makeHandle(0) : null
  if (input !== null && initialGeneration !== 0) {
    await input.encryptApplication(new Uint8Array([0]))
    const node = input.state.secretTree.leafNodes[input.state.privatePath.leafIndex * 2]
    if (node === undefined) throw new Error('Missing sender ratchet')
    node.application.generation = initialGeneration
  }
  const key =
    group?.key ??
    (input === null
      ? (() => {
          throw new Error('Missing input')
        })()
      : await fixture.registry.seed(input, { packageUse: null }))
  let access = await fixture.registry.access(key.groupID)
  let transactions = 0
  const trackTransactions = () => {
    const capability = entryCapability(fixture.device.groups)
    if (capability === null) throw new Error('Missing entry capability')
    const original = capability.run.bind(capability)
    capability.run = (request, prepare, work) => {
      transactions++
      return original(request, prepare, work)
    }
    return () => {
      capability.run = original
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
    key,
    group,
    fixture: () => fixture,
    access: () => access,
    aad: (intent: 'ephemeral' | 'log') => encodeAppAAD({ topicID: 'lease-app', intent }),
    sealEphemeral: (plaintext = new Uint8Array([1])) =>
      access.seal(plaintext, { aad: result.aad('ephemeral'), intent: 'ephemeral' }),
    sealDurable: (plaintext = new Uint8Array([1])) =>
      access.seal(plaintext, { aad: result.aad('log'), intent: 'log' }),
    lease: () => testing.registryLeaseSnapshot(access),
    transactions: () => transactions,
    restores: () => fixture.restores(),
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
    },
    async reopen() {
      unsubscribe()
      if (group === null) fixture = await fixture.reopen()
      else {
        await group.reopen()
        fixture = group.fixture()
      }
      unsubscribe = trackTransactions()
      access = await fixture.registry.access(key.groupID)
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
    async openDurable() {
      if (group === null) throw new Error('Durable receive requires a peer')
      const ciphertext = await group.sender.handle.encrypt(
        encodeEventFrame('posted', { text: 'hello' }),
        { aad: result.aad('log') },
      )
      const topicID = 'lease-app'
      return access.openBatch([
        {
          ciphertext,
          expectedAAD: result.aad('log'),
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
      await fixture.close()
    },
  }
  return result satisfies RegistryLeaseFixture
}
