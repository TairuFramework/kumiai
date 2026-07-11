import { Client } from '@enkaku/client'
import type { AnyClientMessageOf, AnyServerMessageOf } from '@enkaku/protocol'
import { DirectTransports } from '@enkaku/transport'
import { normalizeDID, type OwnIdentity, randomIdentity } from '@kokuin/token'
import { HubClient } from '@kumiai/hub-client'
import type { HubProtocol } from '@kumiai/hub-protocol'
import { createHub, createMemoryStore } from '@kumiai/hub-server'
import {
  commitInvite,
  commitLedgerEntries,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  exportGroupInfo,
  type GroupHandle,
  type GroupOptions,
  joinGroupExternal,
  ledgerEntryDigest,
  type MemberCredential,
  processWelcome,
  ROLE_ENTRY_TYPE,
  removeMember,
  signLedgerEntry,
} from '@kumiai/mls'
import { describe, expect, test } from 'vitest'

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')
const unb64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'))

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function groupTopic(groupID: string): string {
  return `group/${groupID}`
}

type HubTransports = DirectTransports<
  AnyServerMessageOf<HubProtocol>,
  AnyClientMessageOf<HubProtocol>
>

/** A real in-process hub: no per-topic authorize hook, so it is a pure byte pipe
 *  and every enforcement decision below happens in the receiving peer's processMessage. */
function createTestHub() {
  const hubIdentity = randomIdentity()
  const firstTransports: HubTransports = new DirectTransports()
  const allTransports: Array<HubTransports> = [firstTransports]
  const hub = createHub({
    identity: hubIdentity,
    store: createMemoryStore(),
    transport: firstTransports.server,
    purge: false,
  })
  let firstUsed = false

  function connect(identity: OwnIdentity = randomIdentity()) {
    let transports: HubTransports
    if (firstUsed) {
      transports = new DirectTransports()
      allTransports.push(transports)
      hub.server.handle(transports.server)
    } else {
      transports = firstTransports
      firstUsed = true
    }
    const rawClient = new Client<HubProtocol>({
      transport: transports.client,
      identity,
      serverID: hubIdentity.id,
    })
    return { client: new HubClient({ client: rawClient }), identity }
  }

  async function dispose(): Promise<void> {
    await hub.server.dispose()
    await Promise.all(allTransports.map((transports) => transports.dispose()))
  }

  return { connect, dispose }
}

/** Subscribe and open a receive channel before the sender publishes, so delivery
 *  is a deterministic single read rather than a race against a background loop. */
async function openReceiver(client: HubClient, topicID: string) {
  await client.subscribe(topicID)
  const channel = client.receive()
  const reader = channel.readable.getReader()
  await delay(50)
  return { channel, reader }
}

async function nextCommitBytes<T extends { payload: string }>(
  reader: ReadableStreamDefaultReader<T>,
): Promise<Uint8Array> {
  const msg = await reader.read()
  if (msg.done || msg.value == null) throw new Error('expected a queued hub message')
  return unb64(msg.value.payload)
}

function mapResolver(tokens: Map<string, string>): GroupOptions['resolveLedgerEntries'] {
  return async (ids) => ids.map((id) => tokens.get(id)).filter((t): t is string => t != null)
}

/** Invite and join a recipient directly (no hub): the Welcome itself is not the
 *  property under test in any scenario below, only the commits that follow it. */
async function inviteAndJoin(params: {
  inviterGroup: GroupHandle
  inviter: OwnIdentity
  recipient: OwnIdentity
  permission: 'admin' | 'member'
  recipientOptions?: GroupOptions
}): Promise<{ newGroup: GroupHandle; recipientGroup: GroupHandle; commitMessage: Uint8Array }> {
  const { invite } = await createInvite({
    group: params.inviterGroup,
    identity: params.inviter,
    recipientDID: params.recipient.id,
    permission: params.permission,
  })
  const keyPackageBundle = await createKeyPackageBundle(params.recipient)
  const { commitMessage, welcomeMessage, newGroup } = await commitInvite(
    params.inviterGroup,
    keyPackageBundle.publicPackage,
    invite,
  )
  const { group: recipientGroup } = await processWelcome({
    identity: params.recipient,
    invite,
    welcome: welcomeMessage,
    keyPackageBundle,
    ratchetTree: newGroup.state.ratchetTree,
    options: params.recipientOptions,
  })
  return { newGroup, recipientGroup, commitMessage }
}

describe('an admin-authored Remove converges to every peer over the hub', () => {
  test('a receiver applies the removal from wire bytes and drops the removed peer', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const carol = randomIdentity()
    const groupID = `remove-${Math.random().toString(36).slice(2)}`

    const inviteTokens = new Map<string, string>()
    const { group: aliceGroup0 } = await createGroup(alice, groupID)
    const { newGroup: aliceWithBob, recipientGroup: bobGroup } = await inviteAndJoin({
      inviterGroup: aliceGroup0,
      inviter: alice,
      recipient: bob,
      permission: 'member',
      recipientOptions: { resolveLedgerEntries: mapResolver(inviteTokens) },
    })

    const { invite: carolInvite } = await createInvite({
      group: aliceWithBob,
      identity: alice,
      recipientDID: carol.id,
      permission: 'member',
    })
    for (const token of carolInvite.ledgerEntries) {
      inviteTokens.set(ledgerEntryDigest(token), token)
    }
    const carolKP = await createKeyPackageBundle(carol)
    const addCarol = await commitInvite(aliceWithBob, carolKP.publicPackage, carolInvite)
    // Bob catches up to the add-Carol commit directly; only the Remove under test ships over the hub.
    await bobGroup.processMessage(addCarol.commitMessage)

    const carolLeaf = addCarol.newGroup.findMemberLeafIndex(carol.id)
    if (carolLeaf == null) throw new Error('expected carol to hold a leaf')
    const removeCarol = await removeMember(addCarol.newGroup, carolLeaf)

    const testHub = createTestHub()
    const { client: aliceHub } = testHub.connect(alice)
    const { client: bobHub } = testHub.connect(bob)
    const topic = groupTopic(groupID)
    await aliceHub.subscribe(topic)
    const { channel, reader } = await openReceiver(bobHub, topic)

    await aliceHub.publish({ topicID: topic, payload: b64(removeCarol.commitMessage) })
    const received = await nextCommitBytes(reader)
    await bobGroup.processMessage(received)

    expect(bobGroup.findMemberLeafIndex(carol.id)).toBeUndefined()
    expect(bobGroup.epoch).toBe(removeCarol.epoch)
    // roster.roles is a DID-keyed permission ledger, not a tree-membership view: it
    // can hold a role for a DID with no current leaf, and a bare Remove (no demotion
    // entry) leaves Carol's last-granted role in place by design (roster.ts). Current
    // membership is listMembers()/findMemberLeafIndex, which do reflect the removal.
    expect(bobGroup.listMembers().map((m) => normalizeDID(m.id))).not.toContain(
      normalizeDID(carol.id),
    )

    channel.close()
    await expect(channel).rejects.toEqual('Close')
    await delay(50)
    await testHub.dispose()
  })

  test('a member cannot author a Remove', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const groupID = `remove-guard-${Math.random().toString(36).slice(2)}`

    const { group: aliceGroup0 } = await createGroup(alice, groupID)
    const { recipientGroup: bobGroup } = await inviteAndJoin({
      inviterGroup: aliceGroup0,
      inviter: alice,
      recipient: bob,
      permission: 'member',
    })

    const aliceLeaf = bobGroup.findMemberLeafIndex(alice.id)
    if (aliceLeaf == null) throw new Error('expected alice to hold a leaf')

    // commitWithEntries requires the committer be an admin, so a member never emits
    // a Remove at all — this is the reachable member-Remove behaviour through the
    // public API. The receiver-side rejection of a *forged* member-authored Remove
    // (one that skipped this guard) is proven at the unit/policy layer
    // (policy.test.ts, forge-based group.test.ts): forging a syntactically valid
    // member commit needs the low-level ts-mls client the public API deliberately
    // does not expose.
    await expect(removeMember(bobGroup, aliceLeaf)).rejects.toThrow(/admin/)
  })
})

describe('a promotion travels with the commit that relies on it', () => {
  test('every peer folds the same roster after the promotion crosses the wire', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const carol = randomIdentity()
    const groupID = `promote-${Math.random().toString(36).slice(2)}`
    const promotionTokens = new Map<string, string>()

    const { group: aliceGroup0 } = await createGroup(alice, groupID)
    const { newGroup: aliceGroup, recipientGroup: bobGroup } = await inviteAndJoin({
      inviterGroup: aliceGroup0,
      inviter: alice,
      recipient: bob,
      permission: 'member',
      recipientOptions: { resolveLedgerEntries: mapResolver(promotionTokens) },
    })

    const promoteBob = await signLedgerEntry(alice, {
      type: ROLE_ENTRY_TYPE,
      groupID,
      subject: bob.id,
      value: 'admin',
    })
    promotionTokens.set(ledgerEntryDigest(promoteBob), promoteBob)
    const promotion = await commitLedgerEntries(aliceGroup, [promoteBob])

    const testHub = createTestHub()
    const { client: aliceHub } = testHub.connect(alice)
    const { client: bobHub } = testHub.connect(bob)
    const topic = groupTopic(groupID)
    await aliceHub.subscribe(topic)
    const { channel, reader } = await openReceiver(bobHub, topic)

    await aliceHub.publish({ topicID: topic, payload: b64(promotion.commitMessage) })
    const received = await nextCommitBytes(reader)
    await bobGroup.processMessage(received)

    expect(promotion.newGroup.roster.roles.get(normalizeDID(bob.id))).toBe('admin')
    expect(bobGroup.roster.roles.get(normalizeDID(bob.id))).toBe('admin')

    channel.close()
    await expect(channel).rejects.toEqual('Close')
    await delay(50)
    await testHub.dispose()

    // Bob, now an admin the group agrees on, invites Carol; the invite carries the
    // whole ledger, promotion included, so Carol folds the same roster everyone else does.
    const { invite: carolInvite } = await createInvite({
      group: bobGroup,
      identity: bob,
      recipientDID: carol.id,
      permission: 'member',
    })
    const carolKP = await createKeyPackageBundle(carol)
    const addCarol = await commitInvite(bobGroup, carolKP.publicPackage, carolInvite)
    const { group: carolGroup } = await processWelcome({
      identity: carol,
      invite: carolInvite,
      welcome: addCarol.welcomeMessage,
      keyPackageBundle: carolKP,
      ratchetTree: addCarol.newGroup.state.ratchetTree,
    })

    expect(carolGroup.roster.roles.get(normalizeDID(alice.id))).toBe('admin')
    expect(carolGroup.roster.roles.get(normalizeDID(bob.id))).toBe('admin')
    expect(carolGroup.roster.roles.get(normalizeDID(carol.id))).toBe('member')
  })
})

describe('a missing ledger entry blocks a commit until it is resolved out of band', () => {
  test('processMessage rejects naming the missing entry, then a clean retry on the same handle succeeds', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const groupID = `missing-entry-${Math.random().toString(36).slice(2)}`
    const promotionTokens = new Map<string, string>()

    const { group: aliceGroup0 } = await createGroup(alice, groupID)
    const { newGroup: aliceGroup, recipientGroup: bobGroup } = await inviteAndJoin({
      inviterGroup: aliceGroup0,
      inviter: alice,
      recipient: bob,
      permission: 'member',
      // Empty at first: Bob cannot yet resolve the promotion's body.
      recipientOptions: { resolveLedgerEntries: mapResolver(promotionTokens) },
    })

    const promoteBob = await signLedgerEntry(alice, {
      type: ROLE_ENTRY_TYPE,
      groupID,
      subject: bob.id,
      value: 'admin',
    })
    const promoteID = ledgerEntryDigest(promoteBob)
    const promotion = await commitLedgerEntries(aliceGroup, [promoteBob])

    const testHub = createTestHub()
    const { client: aliceHub } = testHub.connect(alice)
    const { client: bobHub } = testHub.connect(bob)
    const topic = groupTopic(groupID)
    await aliceHub.subscribe(topic)
    const { channel, reader } = await openReceiver(bobHub, topic)

    await aliceHub.publish({ topicID: topic, payload: b64(promotion.commitMessage) })
    const received = await nextCommitBytes(reader)

    const epochBefore = bobGroup.epoch
    await expect(bobGroup.processMessage(received)).rejects.toMatchObject({
      name: 'MissingLedgerEntriesError',
      ids: [promoteID],
    })
    expect(bobGroup.epoch).toBe(epochBefore)

    // Resolve out of band: populate the map the resolver closure reads, then
    // retry the exact same bytes on the same handle.
    promotionTokens.set(promoteID, promoteBob)
    await bobGroup.processMessage(received)

    expect(bobGroup.epoch).toBe(epochBefore + 1n)
    expect(bobGroup.roster.roles.get(normalizeDID(bob.id))).toBe('admin')

    channel.close()
    await expect(channel).rejects.toEqual('Close')
    await delay(50)
    await testHub.dispose()
  })
})

describe('a roster member may resync; a stranger may not', () => {
  test('a legitimate member resync is accepted and converges', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const groupID = `resync-${Math.random().toString(36).slice(2)}`

    const { group: aliceGroup0 } = await createGroup(alice, groupID)
    const { newGroup: aliceGroup, recipientGroup: bobGroupInitial } = await inviteAndJoin({
      inviterGroup: aliceGroup0,
      inviter: alice,
      recipient: bob,
      permission: 'member',
    })
    const bobCredential = bobGroupInitial.credential

    const testHub = createTestHub()
    const { client: aliceHub } = testHub.connect(alice)
    const { client: bobHub } = testHub.connect(bob)
    const topic = groupTopic(groupID)
    const { channel, reader } = await openReceiver(aliceHub, topic)

    const { groupInfo } = await exportGroupInfo({ group: aliceGroup })
    const { commitMessage } = await joinGroupExternal({
      identity: bob,
      groupInfo,
      credential: bobCredential,
      resync: true,
    })

    const epochBefore = aliceGroup.epoch
    await bobHub.publish({ topicID: topic, payload: b64(commitMessage) })
    const received = await nextCommitBytes(reader)
    await aliceGroup.processMessage(received)

    expect(aliceGroup.epoch).toBe(epochBefore + 1n)
    expect(aliceGroup.findMemberLeafIndex(bob.id)).toBeDefined()
    expect(aliceGroup.roster.roles.get(normalizeDID(bob.id))).toBe('member')

    channel.close()
    await expect(channel).rejects.toEqual('Close')
    await delay(50)
    await testHub.dispose()
  })

  test('a stranger with a leaked groupInfo cannot construct a well-formed external commit', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const mallory = randomIdentity()
    const groupID = `resync-stranger-${Math.random().toString(36).slice(2)}`

    const { group: aliceGroup0 } = await createGroup(alice, groupID)
    const { newGroup: aliceGroup } = await inviteAndJoin({
      inviterGroup: aliceGroup0,
      inviter: alice,
      recipient: bob,
      permission: 'member',
    })

    const { groupInfo } = await exportGroupInfo({ group: aliceGroup })
    // Mallory builds a credential for her own identity, the same way a real
    // caller would — she is in no roster, so there is no prior leaf of hers to resync.
    const malloryCredential: MemberCredential = { id: mallory.id, groupID }

    const epochBefore = aliceGroup.epoch
    const rosterBefore = [...aliceGroup.roster.roles.entries()]

    // The public API only exposes resync-flavoured external joins (`resync: true`
    // is the only accepted value). joinGroupExternal refuses before any commit
    // bytes exist, so there is nothing for Mallory to ship through the hub.
    await expect(
      joinGroupExternal({
        identity: mallory,
        groupInfo,
        credential: malloryCredential,
        resync: true,
      }),
    ).rejects.toThrow(/resync|leaf/i)

    expect(aliceGroup.epoch).toBe(epochBefore)
    expect(aliceGroup.findMemberLeafIndex(mallory.id)).toBeUndefined()
    expect([...aliceGroup.roster.roles.entries()]).toEqual(rosterBefore)
  })
})
