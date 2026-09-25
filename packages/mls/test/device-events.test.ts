import { normalizeDID } from '@kokuin/token'
import { defaultProposalTypes, encode, mlsMessageEncoder } from 'ts-mls'
import { describe, expect, test } from 'vitest'

import { restoreGroup } from '../src/group.js'
import { commitWithEntries } from '../src/group-commit.js'
import {
  announceControllerBeacon,
  labelDevice,
  registerDevice,
  revokeDevice,
} from '../src/group-device.js'
import {
  beaconOf as _barrelBeaconOf,
  type ControllerBeacon as _CB,
  type ControllerBinding as _CBind,
  type GroupHandleEvents as _GHE,
  MLS_LEAF_ACT as _LEAF_ACT,
  MLS_LEAF_RES as _LEAF_RES,
  announceControllerBeacon as _pub,
} from '../src/index.js'
import { ledgerEntryDigest, signLedgerEntry } from '../src/ledger.js'
import { beaconOf } from '../src/registry.js'
import { publishTokens, twoDeviceProfileGroup } from './fixtures/device-harness.js'

// Reachability (Step 7): prove the Slice-3 write API and its supporting types resolve from the
// public entry point, not just the internal module.
void (_pub satisfies typeof announceControllerBeacon)
type _ReachabilityCheck = _CB extends { logLength: number; headDigest: string } ? true : false
type _ReachabilityCheck2 = _GHE extends { deviceRevoked: unknown } ? true : false

// Fix 4: prove the previously-omitted names resolve from the public entry point.
void (_barrelBeaconOf satisfies typeof beaconOf)
type _ReachabilityBinding = _CBind extends { id: string; capability: string } ? true : false
void (_LEAF_ACT satisfies string)
void (_LEAF_RES satisfies string)

/**
 * The EventEmitter surface (Task 4): revokedDevices() as a folded-state accessor, and
 * deviceRevoked firing on the receive path (an existing member's processMessage of a revoke
 * commit). The write side's own local fire (deriveGroup + emitControlEvents on the sender's
 * derived handle) is Task 5's — not exercised here.
 */
describe('device events', () => {
  test('revokedDevices() lists a revoked binding with its controller', async () => {
    const g = await twoDeviceProfileGroup()
    const res = await revokeDevice(g.managerGroup, g.managerIdentity, {
      device: g.targetDeviceID,
      capability: g.capability,
    })
    const revoked = res.newGroup.revokedDevices()
    expect(revoked.map((r) => r.device)).toContain(normalizeDID(g.targetDeviceID))
    expect(revoked.find((r) => r.device === normalizeDID(g.targetDeviceID))?.controller).toBe(
      normalizeDID(g.controllerID),
    )
  })

  test('a receiver fires deviceRevoked exactly once when it processes a revoke commit', async () => {
    const g = await twoDeviceProfileGroup()
    const seen: Array<Array<{ device: string; controller: string }>> = []
    g.creatorGroup.events.on('deviceRevoked', (batch) => {
      seen.push(batch)
    })

    const res = await revokeDevice(g.managerGroup, g.managerIdentity, {
      device: g.targetDeviceID,
      capability: g.capability,
    })
    publishTokens(g.tokens, res.newGroup)
    await g.creatorGroup.processMessage(res.commitMessage)

    expect(seen.length).toBe(1)
    expect(seen[0]?.map((r) => r.device)).toContain(normalizeDID(g.targetDeviceID))
  })

  test('a failed commit persist emits no revoke; retry emits it once', async () => {
    const g = await twoDeviceProfileGroup()
    const seen: Array<string> = []
    g.creatorGroup.events.on('deviceRevoked', (batch) => {
      seen.push(...batch.map((entry) => entry.device))
    })
    const res = await revokeDevice(g.managerGroup, g.managerIdentity, {
      device: g.targetDeviceID,
      capability: g.capability,
    })
    publishTokens(g.tokens, res.newGroup)
    const before = g.creatorGroup.epoch
    await expect(
      g.creatorGroup.processMessage(res.commitMessage, {
        persist: async () => {
          throw new Error('disk failed')
        },
      }),
    ).rejects.toThrow('disk failed')
    expect(g.creatorGroup.epoch).toBe(before)
    expect(seen).toEqual([])
    await g.creatorGroup.processMessage(res.commitMessage, { persist: async () => {} })
    expect(seen).toEqual([normalizeDID(g.targetDeviceID)])
  })

  test('a throwing ledger callback still delivers a durable revoke event', async () => {
    const g = await twoDeviceProfileGroup()
    const receiver = await restoreGroup({
      state: g.managerGroup.state,
      credential: g.managerGroup.credential,
      ledgerEntries: g.managerGroup.ledgerTokens,
      options: {
        resolveLedgerEntries: async (ids) =>
          ids.flatMap((id) => {
            const token = g.tokens.get(id)
            return token == null ? [] : [token]
          }),
        onLedgerEntries: () => {
          throw new Error('host callback failed')
        },
      },
    })
    const seen: Array<string> = []
    receiver.events.on('deviceRevoked', (batch) => {
      seen.push(...batch.map((entry) => entry.device))
    })
    const res = await revokeDevice(g.managerGroup, g.managerIdentity, {
      device: g.targetDeviceID,
      capability: g.capability,
    })
    const revokeToken = res.newGroup.ledgerTokens.at(-1)
    if (revokeToken == null) throw new Error('missing revoke token')
    const note = await signLedgerEntry(g.creatorIdentity, {
      type: 'note',
      groupID: receiver.groupID,
      subject: g.targetDeviceID,
      value: 'notify',
    })
    const removed = g.creatorGroup.findMemberLeafIndex(g.targetDeviceID)
    if (removed == null) throw new Error('missing target leaf')
    const combined = await commitWithEntries(
      g.creatorGroup,
      [{ proposalType: defaultProposalTypes.remove, remove: { removed } }],
      [revokeToken, note],
    )
    g.tokens.set(ledgerEntryDigest(revokeToken), revokeToken)
    g.tokens.set(ledgerEntryDigest(note), note)
    const before = receiver.epoch
    await expect(
      receiver.processMessage(encode(mlsMessageEncoder, combined.commit), {
        persist: async () => {},
      }),
    ).rejects.toThrow('host callback failed')
    expect(receiver.epoch).toBe(before + 1n)
    expect(seen).toEqual([normalizeDID(g.targetDeviceID)])
  })

  test('a failed bootstrap persist emits no revoke; retry emits it once', async () => {
    const g = await twoDeviceProfileGroup()
    const res = await revokeDevice(g.managerGroup, g.managerIdentity, {
      device: g.targetDeviceID,
      capability: g.capability,
    })
    const fresh = await restoreGroup({
      state: res.newGroup.state,
      credential: res.newGroup.credential,
      ledgerEntries: [],
    })
    const seen: Array<string> = []
    fresh.events.on('deviceRevoked', (batch) => {
      seen.push(...batch.map((entry) => entry.device))
    })
    await expect(
      fresh.bootstrapLedger(res.newGroup.ledgerTokens, {
        persist: async () => {
          throw new Error('disk failed')
        },
      }),
    ).rejects.toThrow('disk failed')
    expect(fresh.ledgerTokens).toEqual([])
    expect(seen).toEqual([])
    await fresh.bootstrapLedger(res.newGroup.ledgerTokens, { persist: async () => {} })
    expect(seen).toEqual([normalizeDID(g.targetDeviceID)])
  })

  test('a receiver processing a register/add-only commit fires no deviceRevoked', async () => {
    const g = await twoDeviceProfileGroup()
    const seen: Array<Array<{ device: string; controller: string }>> = []
    g.creatorGroup.events.on('deviceRevoked', (batch) => {
      seen.push(batch)
    })

    const res = await labelDevice(g.managerGroup, g.managerIdentity, {
      device: g.targetDeviceID,
      label: 'laptop',
      capability: g.capability,
    })
    publishTokens(g.tokens, res.newGroup)
    await g.creatorGroup.processMessage(res.commitMessage)

    expect(seen.length).toBe(0)
  })

  test('a receiver processing a self-register commit fires no deviceRevoked', async () => {
    // Distinct from the label-op guard above: op-filter mutation coverage for 'register'
    // specifically (emitControlEvents' revoke branch keys on `value.op === 'revoke'` alone).
    const g = await twoDeviceProfileGroup()
    const seen: Array<Array<{ device: string; controller: string }>> = []
    g.creatorGroup.events.on('deviceRevoked', (batch) => {
      seen.push(batch)
    })

    const res = await registerDevice(g.managerGroup, g.managerIdentity, {
      device: g.managerIdentity.id,
      controller: g.controllerID,
    })
    publishTokens(g.tokens, res.newGroup)
    await g.creatorGroup.processMessage(res.commitMessage)

    expect(seen.length).toBe(0)
  })

  test('a fresh fold of prior history is silent — no replayed events, but the state is visible', async () => {
    // There is no fresh-join helper in the Slice 2 harness (see device-harness.ts), so this
    // drives the SAME silent path a fresh join actually takes: `processWelcome` folds a
    // joiner's starting ledger via `applyLedgerEntries` (group-welcome.ts), and that method
    // never calls emitControlEvents — only the commit path, bootstrapLedger, and the local
    // write APIs do (see GroupHandle.emitControlEvents's doc comment). So a brand-new handle,
    // seeded from a live member's MLS state but with an EMPTY ledger, that then folds the
    // group's whole ledger (including a revoke and a beacon) via one applyLedgerEntries call is
    // exactly what a joiner's welcome-fold does, and is honest about exercising that path.
    const g = await twoDeviceProfileGroup()
    const r1 = await revokeDevice(g.managerGroup, g.managerIdentity, {
      device: g.targetDeviceID,
      capability: g.capability,
    })
    const r2 = await announceControllerBeacon(r1.newGroup, g.managerIdentity, {
      controller: g.controllerID,
      logLength: 5,
      headDigest: 'zH5',
    })

    // A fresh handle: same MLS state/credential as an existing member, but constructed with
    // no ledger tokens, so its registry starts empty — it has not folded the revoke or beacon.
    const fresh = await restoreGroup({
      state: g.creatorGroup.state,
      credential: g.creatorGroup.credential,
    })
    let fired = 0
    fresh.events.on('deviceRevoked', () => {
      fired++
    })
    fresh.events.on('controllerBeaconChanged', () => {
      fired++
    })

    // Fold the WHOLE ledger (genesis through the revoke and beacon above) in one
    // applyLedgerEntries call — the same shape processWelcome's bulk fold takes.
    await fresh.applyLedgerEntries(r2.newGroup.ledgerTokens)

    expect(fired).toBe(0)
    expect(fresh.revokedDevices().map((r) => r.device)).toContain(normalizeDID(g.targetDeviceID))
    expect(beaconOf(fresh.registry, g.controllerID)).toEqual({ logLength: 5, headDigest: 'zH5' })
  })
})

describe('controller beacon', () => {
  test('announceControllerBeacon folds the beacon, surfaces it on the member view, and fires locally', async () => {
    const g = await twoDeviceProfileGroup()
    let beaconEvent: { controller: string; logLength: number; headDigest: string } | undefined
    // The fire lands on the derived handle's SHARED emitter, so a listener registered on the
    // pre-write handle still sees it.
    g.managerGroup.events.on('controllerBeaconChanged', (e) => {
      beaconEvent = e
    })

    const res = await announceControllerBeacon(g.managerGroup, g.managerIdentity, {
      controller: g.controllerID,
      logLength: 12,
      headDigest: 'zFullHead',
    })

    expect(beaconOf(res.newGroup.registry, g.controllerID)).toEqual({
      logLength: 12,
      headDigest: 'zFullHead',
    })
    expect(beaconEvent).toEqual({
      controller: normalizeDID(g.controllerID),
      logLength: 12,
      headDigest: 'zFullHead',
    })
    const member = res.newGroup
      .listMembers()
      .find((m) => normalizeDID(m.id) === normalizeDID(g.managerIdentity.id))
    expect(member?.controllerBeacon).toEqual({ logLength: 12, headDigest: 'zFullHead' })
  })

  test('a receiver folds and fires controllerBeaconChanged when it processes the beacon commit', async () => {
    const g = await twoDeviceProfileGroup()
    let received: { controller: string; logLength: number; headDigest: string } | undefined
    const res = await announceControllerBeacon(g.managerGroup, g.managerIdentity, {
      controller: g.controllerID,
      logLength: 3,
      headDigest: 'zH3',
    })
    publishTokens(g.tokens, res.newGroup)

    g.creatorGroup.events.on('controllerBeaconChanged', (e) => {
      received = e
    })
    await g.creatorGroup.processMessage(res.commitMessage)

    expect(received).toEqual({
      controller: normalizeDID(g.controllerID),
      logLength: 3,
      headDigest: 'zH3',
    })
  })

  test('revokeDevice fires deviceRevoked on the local (author) handle', async () => {
    const g = await twoDeviceProfileGroup()
    const seen: Array<{ device: string; controller: string }> = []
    g.managerGroup.events.on('deviceRevoked', (batch) => {
      seen.push(...batch)
    })

    await revokeDevice(g.managerGroup, g.managerIdentity, {
      device: g.targetDeviceID,
      capability: g.capability,
    })

    expect(seen.map((r) => r.device)).toContain(normalizeDID(g.targetDeviceID))
  })
})
