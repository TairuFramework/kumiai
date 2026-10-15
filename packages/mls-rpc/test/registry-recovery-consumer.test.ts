import { encodeClientState, sealCapturedGroupInfo, sealRecoveryVerdict } from '@kumiai/mls'
import {
  asLogPosition,
  commitTopic,
  recoveryUnavailableEventID,
  rendezvousTopic,
} from '@kumiai/rpc'
import { expect, test, vi } from 'vitest'

import * as api from '../src/index.js'
import * as recovery from '../src/recovery.js'
import { registrySafety } from '../src/registry/safety.js'
import { recoveryTrustFor } from '../src/registry/trust.js'
import { createRegistryFixture } from './fixtures/registry.js'

for (const damage of ['null', 'unreadable', 'client-state', 'identity'] as const) {
  test(`registry requests and authentication never restore ${damage} private state`, async () => {
    const groupID = `retained-consumer-${damage}`
    const f = await createRegistryFixture({ mode: 'real-mls', setup: 'seeded', groupID })
    try {
      const key = { groupID, incarnation: 1 }
      const responder = await (await f.registry.access(groupID)).read((handle) => handle)
      const secret = await api.deriveRecoverySecret(responder)
      const target = { targetID: 'hub', topicID: commitTopic(secret) }
      if (damage !== 'null') await f.corruptState(key, damage)
      else {
        const state = await f.device.groups.loadState(key)
        if (state === null || state.deleted) throw new Error('Missing state')
        await f.installRows({ key, state: { ...state, version: state.version + 1, state: null } })
      }
      const before = await f.inspectRows()
      const restores = f.restoreCount(groupID)
      const access = vi.spyOn(f.registry, 'access')
      const mls = await api.createRegistryGroupMLS({
        registry: f.registry,
        key,
        recovery: f.environment,
        target,
        identity: f.identity,
        entrySlot: api.createLedgerEntrySlot(),
        onConfirmedRecovery: () => {},
      })
      expect(mls.sendAdmission()).toEqual({ epoch: 0, admissible: false, reason: 'stranded' })
      expect(await mls.exportRecoverySecret()).toEqual(secret)
      expect(rendezvousTopic(await mls.exportRecoverySecret())).toBe(rendezvousTopic(secret))
      const source = await mls.readRecoverySource()
      expect(source.key).toEqual(key)
      expect(Object.hasOwn(source, 'trust')).toBe(false)
      const held = await mls.createRecoveryRequest('retained')
      expect(await mls.verifyRecoveryRequest(held.request)).toEqual({
        groupID,
        requestID: 'retained',
        requesterDID: f.identity.id,
      })
      const confirmation = {
        groupID,
        requestID: 'retained',
        position: 'position',
        commitDigest: 'digest',
      }
      const signature = await mls.signRecoveryConfirmation(confirmation)
      expect(await mls.verifyRecoveryConfirmation(confirmation, signature, f.identity.id)).toBe(
        true,
      )
      expect(
        await mls.verifyRecoveryConfirmation(
          { ...confirmation, groupID: 'other-group' },
          signature,
          f.identity.id,
        ),
      ).toBe(false)
      await expect(
        mls.signRecoveryConfirmation({ ...confirmation, groupID: 'other-group' }),
      ).rejects.toThrow('Confirmation group mismatch')
      const sealed = await sealCapturedGroupInfo({
        group: responder,
        identity: f.identity,
        request: new TextDecoder().decode(held.request),
        captureHead: 'head',
      })
      const trusted = await f.registry.recoverySource(groupID)
      expect(
        (
          await recovery.authenticateRecoveryReply({
            trust: trusted.trust,
            ...held,
            sealed,
            requestID: 'retained',
            options: f.environment.options,
          })
        )?.captureHead,
      ).toBe('head')
      const verdict = {
        groupID,
        requestID: 'retained',
        position: 'position',
        commitDigest: 'digest',
        verdict: 'refused' as const,
        reason: 'policy' as const,
      }
      expect(
        await mls.openRecoveryVerdict(
          await sealRecoveryVerdict({
            group: responder,
            identity: f.identity,
            request: new TextDecoder().decode(held.request),
            verdict,
          }),
          'retained',
          held.requestKey,
        ),
      ).toEqual({ signer: f.identity.id, verdict })
      expect(
        await mls.openRecoveryVerdict(new Uint8Array([0]), 'retained', held.requestKey),
      ).toBeNull()
      expect(f.restoreCount(groupID)).toBe(restores)
      expect(access).not.toHaveBeenCalled()
      expect(await f.inspectRows()).toEqual(before)
    } finally {
      await f.close()
    }
  })
}

for (const damage of ['client-state', 'identity'] as const) {
  test(`registry admission observes ${damage} damage without restoring private state`, async () => {
    const groupID = `consumer-observed-${damage}`
    const f = await createRegistryFixture({ mode: 'real-mls', setup: 'seeded', groupID })
    try {
      const key = { groupID, incarnation: 1 }
      const restores = f.restoreCount(groupID)
      const access = vi.spyOn(f.registry, 'access')
      const mls = await api.createRegistryGroupMLS({
        registry: f.registry,
        key,
        recovery: f.environment,
        target: { targetID: 'hub', topicID: 'commit' },
        identity: f.identity,
        entrySlot: api.createLedgerEntrySlot(),
        onConfirmedRecovery: () => {},
      })
      expect(mls.sendAdmission()).toEqual({ epoch: 0, admissible: true })
      await f.corruptState(key, damage)
      await f.device.groups.ports(key).control.apply({ strand: null }, 'observe-damage')
      expect(mls.sendAdmission()).toEqual({ epoch: 0, admissible: false, reason: 'stranded' })
      expect(f.restoreCount(groupID)).toBe(restores)
      expect(access).not.toHaveBeenCalled()
    } finally {
      await f.close()
    }
  })
}

test('registry constructor requires a coordinator sink and custom trust derivation before I/O', async () => {
  const groupID = 'consumer-config'
  const f = await createRegistryFixture({ mode: 'real-mls', setup: 'seeded', groupID })
  try {
    const before = await f.inspectRows()
    const source = vi.spyOn(f.registry, 'recoverySource')
    const access = vi.spyOn(f.registry, 'access')
    const capability = registrySafety(f.registry)
    if (capability === null) throw new Error('Missing registry capability')
    const read = vi.spyOn(capability.entry, 'read')
    const params = {
      registry: f.registry,
      key: { groupID, incarnation: 1 },
      recovery: f.environment,
      target: { targetID: 'hub', topicID: 'commit' },
      identity: f.identity,
      entrySlot: api.createLedgerEntrySlot(),
      onConfirmedRecovery: () => {},
    }
    for (const sink of [undefined, null, {}]) {
      await expect(
        api.createRegistryGroupMLS({
          ...params,
          onConfirmedRecovery: sink as unknown as typeof params.onConfirmedRecovery,
        }),
      ).rejects.toThrow(TypeError)
    }
    await expect(
      api.createRegistryGroupMLS({ ...params, recoverySecret: async () => new Uint8Array(32) }),
    ).rejects.toThrow(TypeError)
    expect(source).not.toHaveBeenCalled()
    expect(access).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
    expect(await f.inspectRows()).toEqual(before)
    const custom = new Uint8Array(32).fill(7)
    const mls = await api.createRegistryGroupMLS({
      ...params,
      recoverySecret: async () => custom,
      recoverySecretFromTrust: async () => custom,
    })
    expect(await mls.exportRecoverySecret()).toEqual(custom)
  } finally {
    await f.close()
  }
})

for (const fault of ['provider', 'trusted-reader'] as const) {
  test(`registry verdict authentication preserves ${fault} errors`, async () => {
    const groupID = `consumer-verdict-${fault}`
    const f = await createRegistryFixture({ mode: 'real-mls', setup: 'seeded', groupID })
    try {
      const key = { groupID, incarnation: 1 }
      const mls = await api.createRegistryGroupMLS({
        registry: f.registry,
        key,
        recovery: f.environment,
        target: { targetID: 'hub', topicID: 'commit' },
        identity: f.identity,
        entrySlot: api.createLedgerEntrySlot(),
        onConfirmedRecovery: () => {},
      })
      const held = await mls.createRecoveryRequest('errors')
      const failure = new Error(`Registry ${fault} unavailable`)
      if (fault === 'provider') {
        f.environment.options.cryptoProvider = {
          async getCiphersuiteImpl() {
            throw failure
          },
        }
      } else f.failTrustReads(failure)
      const before = await f.inspectRows()
      await expect(
        mls.openRecoveryVerdict(new Uint8Array([0]), 'errors', held.requestKey),
      ).rejects.toBe(failure)
      expect(f.restoreCount(groupID)).toBe(0)
      expect(await f.inspectRows()).toEqual(before)
    } finally {
      await f.close()
    }
  })
}

test('registry sealing binds the actual cursor and safety subscriptions use the real key', async () => {
  const groupID = 'consumer-sealing'
  const f = await createRegistryFixture({ mode: 'real-mls', setup: 'seeded', groupID })
  try {
    const key = { groupID, incarnation: 1 }
    const control = f.device.groups.ports(key).control
    const restores = f.restoreCount(groupID)
    const mls = await api.createRegistryGroupMLS({
      registry: f.registry,
      key,
      recovery: f.environment,
      target: { targetID: 'hub', topicID: 'commit' },
      identity: f.identity,
      entrySlot: api.createLedgerEntrySlot(),
      onConfirmedRecovery: () => {},
    })
    expect(mls.sendAdmission()).toEqual({ epoch: 0, admissible: true })
    expect(f.restoreCount(groupID)).toBe(restores)
    const { request, requestKey } = await mls.createRecoveryRequest('capture')
    await control.apply({ cursor: { position: asLogPosition('actual'), epoch: 0 } }, 'cursor')
    await expect(mls.sealGroupInfo(request, asLogPosition('invented'))).rejects.toThrow()
    const sealed = await mls.sealGroupInfo(request, asLogPosition('actual'))
    const source = await f.registry.recoverySource(groupID)
    expect(
      (
        await recovery.authenticateRecoveryReply({
          trust: source.trust,
          sealed,
          requestID: 'capture',
          requestKey,
          options: f.environment.options,
        })
      )?.captureHead,
    ).toBe('actual')
    const holds: Array<string> = []
    const unsubscribe = mls.onSafetyHold?.((reason: NonNullable<api.SafetyHold>) =>
      holds.push(reason),
    )
    await f.safety().reportFork(key, {
      kind: 'unexplained-own-commit',
      epoch: 0,
      position: 'position',
      digest: 'host-report',
    })
    expect(holds).toEqual(['fork-halted'])
    expect(mls.sendAdmission()).toEqual({ epoch: 0, admissible: false, reason: 'fork-halted' })
    unsubscribe?.()
  } finally {
    await f.close()
  }
})

test('registry admission follows cold control changes, access opening and external epoch changes', async () => {
  const groupID = 'consumer-admission'
  const f = await createRegistryFixture({ mode: 'real-mls', setup: 'empty', groupID })
  try {
    const key = { groupID, incarnation: 1 }
    const next = await f.makeHandle(2)
    await f.installRows({
      key,
      state: {
        ...key,
        deleted: false,
        terminal: false,
        version: 1,
        epoch: 2,
        epochAuthenticator: next.state.keySchedule.epochAuthenticator,
        state: encodeClientState(next.state),
        credential: next.credential,
        ledger: next.ledgerTokens,
        senderHWM: 0,
      },
      trust: recoveryTrustFor(next, key, await f.device.groups.loadTrust(groupID)),
    })
    const restores = f.restoreCount(groupID)
    const mls = await api.createRegistryGroupMLS({
      registry: f.registry,
      key,
      recovery: f.environment,
      target: { targetID: 'hub', topicID: 'commit' },
      identity: f.identity,
      entrySlot: api.createLedgerEntrySlot(),
      onConfirmedRecovery: () => {},
    })
    expect(mls.sendAdmission()).toEqual({ epoch: 2, admissible: true })
    expect(f.restoreCount(groupID)).toBe(restores)
    const control = f.device.groups.ports(key).control
    await control.apply({ strand: { reason: 'lost-state' } }, 'strand')
    expect(mls.sendAdmission()).toEqual({ epoch: 2, admissible: false, reason: 'stranded' })
    await control.apply({ strand: null }, 'unstrand')
    expect(mls.sendAdmission()).toEqual({ epoch: 2, admissible: true })
    expect(await mls.readEpoch()).toBe(2)
    const opened = await f.registry.access(groupID)
    const ordinary = await f.acceptedOrdinary(opened, { accepted: true })
    expect(await opened.adopt(ordinary.candidate, ordinary.expected, ordinary.write)).toBe(
      'installed',
    )
    expect(mls.sendAdmission()).toEqual({ epoch: 3, admissible: true })
    const snapshot = mls.sendAdmission()
    snapshot.epoch = 999
    expect(mls.sendAdmission().epoch).toBe(3)
    await control.apply(
      {
        recoveryUnavailable: {
          ...key,
          id: recoveryUnavailableEventID(key),
          kind: 'group:recovery-unavailable',
          reason: 'trust-unreadable',
        },
      },
      'hold',
    )
    expect(mls.sendAdmission()).toEqual({
      epoch: 3,
      admissible: false,
      reason: 'recovery-unavailable',
    })
  } finally {
    await f.close()
  }
})

test('registry admission preserves saved safety holds when private state is unavailable', async () => {
  const groupID = 'consumer-cold-hold'
  const f = await createRegistryFixture({ mode: 'real-mls', setup: 'seeded', groupID })
  try {
    const key = { groupID, incarnation: 1 }
    await f.safety().reportFork(key, {
      kind: 'unexplained-own-commit',
      epoch: 0,
      position: 'position',
      digest: 'host-report',
    })
    await f.corruptState(key)
    const mls = await api.createRegistryGroupMLS({
      registry: f.registry,
      key,
      recovery: f.environment,
      target: { targetID: 'hub', topicID: 'commit' },
      identity: f.identity,
      entrySlot: api.createLedgerEntrySlot(),
      onConfirmedRecovery: () => {},
    })
    expect(mls.sendAdmission()).toEqual({ epoch: 0, admissible: false, reason: 'fork-halted' })
  } finally {
    await f.close()
  }
})

test('registry admission observes changes between its initial read and constructor resolution', async () => {
  const groupID = 'consumer-initial-race'
  const f = await createRegistryFixture({ mode: 'real-mls', setup: 'seeded', groupID })
  try {
    const key = { groupID, incarnation: 1 }
    const capability = registrySafety(f.registry)
    if (capability === null) throw new Error('Missing registry capability')
    const original = capability.entry.read.bind(capability.entry)
    vi.spyOn(capability.entry, 'read').mockImplementationOnce(async (groupID, fn) => {
      const result = await original(groupID, fn)
      await f.device.groups.ports(key).control.apply({ strand: { reason: 'lost-state' } }, 'raced')
      return result
    })
    const mls = await api.createRegistryGroupMLS({
      registry: f.registry,
      key,
      recovery: f.environment,
      target: { targetID: 'hub', topicID: 'commit' },
      identity: f.identity,
      entrySlot: api.createLedgerEntrySlot(),
      onConfirmedRecovery: () => {},
    })
    expect(mls.sendAdmission()).toEqual({ epoch: 0, admissible: false, reason: 'stranded' })
  } finally {
    await f.close()
  }
})

test('registry admission preserves terminal state when private bytes are null', async () => {
  const groupID = 'consumer-terminal-null'
  const f = await createRegistryFixture({ mode: 'real-mls', setup: 'seeded', groupID })
  try {
    const key = { groupID, incarnation: 1 }
    const state = await f.device.groups.loadState(key)
    if (state === null || state.deleted) throw new Error('Missing state')
    await f.installRows({
      key,
      state: { ...state, version: state.version + 1, terminal: true, state: null },
    })
    const restores = f.restoreCount(groupID)
    const mls = await api.createRegistryGroupMLS({
      registry: f.registry,
      key,
      recovery: f.environment,
      target: { targetID: 'hub', topicID: 'commit' },
      identity: f.identity,
      entrySlot: api.createLedgerEntrySlot(),
      onConfirmedRecovery: () => {},
    })
    expect(mls.sendAdmission()).toEqual({ epoch: 0, admissible: false, reason: 'terminal' })
    await f.device.groups
      .ports(key)
      .control.apply({ strand: { reason: 'lost-state' } }, 'terminal-strand')
    expect(mls.sendAdmission()).toEqual({ epoch: 0, admissible: false, reason: 'terminal' })
    expect(f.restoreCount(groupID)).toBe(restores)
  } finally {
    await f.close()
  }
})

for (const opened of [false, true]) {
  test(`registry ${opened ? 'opened' : 'first'} access failure updates admission without masking the storage diagnosis`, async () => {
    const groupID = `consumer-access-failure-${opened}`
    const f = await createRegistryFixture({ mode: 'real-mls', setup: 'seeded', groupID })
    try {
      const key = { groupID, incarnation: 1 }
      const mls = await api.createRegistryGroupMLS({
        registry: f.registry,
        key,
        recovery: f.environment,
        target: { targetID: 'hub', topicID: 'commit' },
        identity: f.identity,
        entrySlot: api.createLedgerEntrySlot(),
        onConfirmedRecovery: () => {},
      })
      if (opened) expect(await mls.readEpoch()).toBe(0)
      expect(mls.sendAdmission()).toEqual({ epoch: 0, admissible: true })
      await f.corruptState(key)
      await expect(mls.readEpoch()).rejects.toMatchObject({
        name: 'GroupUnavailableError',
        reason: 'state-unreadable',
      })
      expect(mls.sendAdmission()).toEqual({ epoch: 0, admissible: false, reason: 'stranded' })
    } finally {
      await f.close()
    }
  })
}
