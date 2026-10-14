import { randomIdentity } from '@kokuin/token'
import {
  decodeClientState,
  decodeKeyPackage,
  decodePrivateKeyPackage,
  encodeClientState,
  encodeKeyPackage,
  encodePrivateKeyPackage,
  type GroupHandle,
  type KeyPackageBundle,
  keyPackageRef,
  restoreGroup,
} from '@kumiai/mls'
import { createLedgerEntrySlot } from '@kumiai/mls-rpc'
import type { WelcomeObligation } from '@kumiai/rpc'
import { afterEach, expect, test, vi } from 'vitest'

import { judgeWelcomeAdmission } from '../../../packages/mls-hub/src/admission.js'
import { type BundleSource, openWelcome } from '../../../packages/mls-hub/src/join.js'
import { createMemoryKeyPackagePoolStore } from '../../../packages/mls-hub/src/pool-store.js'
import {
  buildInviteCommit,
  createEntryBodies,
  createFoundingGroup,
  makeMember,
  mintInvite,
  restoreMemberHandle,
} from './app-lane-e2e.js'
import { createMemoryHostDatabase } from './host-db.js'
import { createWireHub } from './log-hub-over-wire.js'

afterEach(() => vi.restoreAllMocks())

async function setup() {
  const hub = createWireHub()
  const identity = randomIdentity()
  const invitee = randomIdentity()
  const entrySlot = createLedgerEntrySlot()
  const group = await createFoundingGroup(identity, 'welcome-crash', entrySlot)
  const member = makeMember({ hub, identity, group, entrySlot })
  await member.peer.resync()
  const material = await mintInvite({
    admin: group,
    adminIdentity: identity,
    invitee,
    bodies: createEntryBodies(),
  })
  const store = createMemoryKeyPackagePoolStore()
  const ref = await keyPackageRef(material.bundle.publicPackage)
  await store.put(invitee.id, {
    kind: 'ordinary',
    ref,
    keyPackage: encodeKeyPackage(material.bundle.publicPackage),
    privatePackage: encodePrivateKeyPackage(material.bundle.privatePackage),
    notAfter: Number(material.bundle.publicPackage.leafNode.lifetime.notAfter),
  })
  const source: BundleSource = {
    sourceID: 'invitee-pool',
    bundles: async () => {
      return (await store.list(invitee.id)).map((row): KeyPackageBundle => {
        const publicPackage = decodeKeyPackage(row.keyPackage)
        const privatePackage = decodePrivateKeyPackage(row.privatePackage)
        if (publicPackage == null || privatePackage == null) throw new Error('Invalid bundle')
        return { publicPackage, privatePackage, ownerDID: invitee.id }
      })
    },
    consume: store.consume,
    receipt: store.receipt,
  }
  return { hub, member, material, invitee, source, store, ref, entrySlot }
}

function decodeArtifact(bytes: Uint8Array): {
  invite: Awaited<ReturnType<typeof mintInvite>>['invite']
  welcome: Uint8Array
  ratchetTree: GroupHandle['state']['ratchetTree']
} {
  return JSON.parse(new TextDecoder().decode(bytes), (_key, value) =>
    value?.bytes != null
      ? new Uint8Array(value.bytes)
      : value?.bigint != null
        ? BigInt(value.bigint)
        : value,
  )
}

async function deliverArtifact(ctx: Awaited<ReturnType<typeof setup>>) {
  let artifact: Uint8Array | undefined
  const request = buildInviteCommit(ctx.member, ctx.material, () => {})
  ctx.member.deliveries.set(request.id, (bytes) => {
    artifact = bytes
  })
  await ctx.member.peer.commit(request)
  if (artifact == null) throw new Error('No delivered invitation')
  return decodeArtifact(artifact)
}

test('Welcome after crash: restart delivers the complete invitation after accepted', async () => {
  const ctx = await setup()
  let restarted: ReturnType<typeof makeMember> | undefined
  try {
    let staleDeliveries = 0
    const request = buildInviteCommit(ctx.member, ctx.material, () => {
      throw new Error('Dead process callback invoked')
    })
    ctx.member.deliveries.set(request.id, () => {
      staleDeliveries++
    })
    const stopAtAccepted = () => {
      ctx.member.stateStore.database.seam('after-apply', async () => {
        if ((await ctx.member.control.load()).operations[0]?.stage === 'accepted')
          void ctx.member.peer.dispose()
        else stopAtAccepted()
      })
    }
    stopAtAccepted()
    await ctx.member.peer.enqueue(request)
    await expect
      .poll(async () => (await ctx.member.control.load()).operations[0]?.stage)
      .toBe('accepted')
    await ctx.member.peer.dispose()
    await ctx.member.peer.drained()
    await ctx.member.disconnect()
    expect(staleDeliveries).toBe(0)
    restarted = makeMember({
      hub: ctx.hub,
      identity: ctx.member.identity,
      group: await restoreMemberHandle(ctx.member, ctx.entrySlot),
      entrySlot: ctx.entrySlot,
      restartOf: ctx.member,
    })
    await restarted.peer.resync()
    expect(staleDeliveries).toBe(0)
    const pending = (await restarted.control.load()).welcomes
    expect(pending).toHaveLength(1)
    await restarted.peer.dispose()
    await restarted.peer.drained()
    await restarted.disconnect()
    const inboxes = new Map<string, Array<Uint8Array>>()
    const restartParams = {
      hub: ctx.hub,
      identity: ctx.member.identity,
      group: await restoreMemberHandle(ctx.member, ctx.entrySlot),
      entrySlot: ctx.entrySlot,
      restartOf: ctx.member,
      deliverWelcome: async (obligation: WelcomeObligation) => {
        for (const recipient of obligation.recipients) {
          const inbox = inboxes.get(recipient) ?? []
          inbox.push(obligation.welcome.slice())
          inboxes.set(recipient, inbox)
        }
      },
    }
    restarted = makeMember(restartParams)
    await restarted.peer.resync()
    expect(staleDeliveries).toBe(0)
    expect([...inboxes.keys()]).toEqual([ctx.invitee.id])
    expect(inboxes.get(ctx.invitee.id)).toHaveLength(1)
    const artifact = inboxes.get(ctx.invitee.id)?.[0]
    expect(artifact).toEqual(pending[0]?.welcome)
    expect(artifact).toBeInstanceOf(Uint8Array)
    if (artifact == null) throw new Error('No invitation after restart')
    const opened = await openWelcome([ctx.source], {
      identity: ctx.invitee,
      ...decodeArtifact(artifact),
    })
    if (!('joined' in opened)) throw new Error('Expected fresh join')
    expect(opened.joined.group.groupID).toBe(ctx.member.handle().groupID)
    expect(opened.joined.group.findMemberLeafIndex(ctx.invitee.id)).not.toBeNull()
    expect((await restarted.control.load()).welcomes).toEqual([])
  } finally {
    await restarted?.peer.dispose()
    await restarted?.peer.drained()
    await ctx.member.peer.dispose()
    await ctx.member.peer.drained()
    await ctx.hub.dispose()
  }
})

test.each(['joined-before-consume', 'consume-mid-transaction', 'consumed-before-ack'] as const)(
  'invitee crash boundary: %s',
  async (boundary) => {
    const ctx = await setup()
    try {
      const artifact = await deliverArtifact(ctx)
      const opened = await openWelcome([ctx.source], { identity: ctx.invitee, ...artifact })
      if (!('joined' in opened)) throw new Error('Expected fresh join')
      const database = createMemoryHostDatabase()
      const groupID = opened.joined.group.groupID
      await database.seed(groupID, encodeClientState(opened.joined.group.state))
      const persisted = structuredClone({
        control: await database.control(groupID, { groupID, incarnation: 1 }).load(),
        state: encodeClientState(opened.joined.group.state),
        ledger: opened.joined.group.ledgerTokens,
        joinRef: opened.joinRef as typeof opened.joinRef | null,
        spentEpochAuthenticators: [
          opened.joined.group.state.keySchedule.epochAuthenticator.slice(),
        ],
      })
      const state = decodeClientState(persisted.state)
      if (state == null) throw new Error('Invalid saved joined state')
      const saved = {
        group: await restoreGroup({
          state,
          credential: opened.joined.group.credential,
          ledgerEntries: persisted.ledger,
        }),
        joinRef: persisted.joinRef,
      }
      if (boundary === 'consume-mid-transaction') {
        const set = Map.prototype.set
        const fault = vi.spyOn(Map.prototype, 'set').mockImplementation(function (
          this: Map<unknown, unknown>,
          key,
          value,
        ) {
          if (value?.groupID === saved.group.groupID) throw new Error('receipt write interrupted')
          return set.call(this, key, value)
        })
        await expect(ctx.source.consume(ctx.ref, saved.group.groupID)).rejects.toThrow(
          'receipt write interrupted',
        )
        fault.mockRestore()
        expect(await ctx.store.list(ctx.invitee.id)).toHaveLength(1)
        expect(await ctx.source.receipt(ctx.ref)).toBeNull()
      }
      if (boundary === 'joined-before-consume') {
        const repeated = await openWelcome([ctx.source], { identity: ctx.invitee, ...artifact })
        if (!('joined' in repeated)) throw new Error('Package was consumed before the host saved')
        expect(
          judgeWelcomeAdmission({
            held: {
              incarnation: 1,
              epoch: Number(saved.group.epoch),
              deleted: false,
              forkHalted: persisted.control.forkHalt !== null,
            },
            spentEpochAuthenticators: persisted.spentEpochAuthenticators,
            welcome: {
              epoch: Number(repeated.joined.group.epoch),
              epochAuthenticator: repeated.joined.group.state.keySchedule.epochAuthenticator,
            },
          }),
        ).toBe('refused')
      }
      if (boundary === 'consumed-before-ack') await ctx.source.consume(ctx.ref, saved.group.groupID)
      // Startup finishes the saved joinRef before clearing it, including an already committed consume.
      if (saved.joinRef != null) {
        expect(saved.joinRef.sourceID).toBe(ctx.source.sourceID)
        await ctx.source.consume(saved.joinRef.ref, saved.group.groupID)
        saved.joinRef = null
        persisted.joinRef = null
      }
      expect(persisted.joinRef).toBeNull()
      expect(await ctx.store.list(ctx.invitee.id)).toEqual([])
      expect(await ctx.source.receipt(ctx.ref)).toEqual({ groupID: saved.group.groupID })
      const bundles = vi
        .spyOn(ctx.source, 'bundles')
        .mockRejectedValue(new Error('must not decrypt again'))
      expect(await openWelcome([ctx.source], { identity: ctx.invitee, ...artifact })).toEqual({
        alreadyJoined: saved.group.groupID,
      })
      expect(bundles).not.toHaveBeenCalled()
      expect(
        judgeWelcomeAdmission({
          held: {
            incarnation: 1,
            epoch: Number(saved.group.epoch),
            deleted: false,
            forkHalted: persisted.control.forkHalt !== null,
          },
          spentEpochAuthenticators: persisted.spentEpochAuthenticators,
          welcome: {
            epoch: Number(opened.joined.group.epoch),
            epochAuthenticator: opened.joined.group.state.keySchedule.epochAuthenticator,
          },
        }),
      ).toBe('refused')
    } finally {
      await ctx.member.peer.dispose()
      await ctx.member.peer.drained()
      await ctx.hub.dispose()
    }
  },
)
