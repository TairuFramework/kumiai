import { protocolTopic } from '@kumiai/rpc'
import { describe, expect, test } from 'vitest'

import {
  buildInviteCommit,
  buildRemoveCommit,
  createEntryBodies,
  createFoundingGroup,
  joinFromWelcome,
  type Member,
  makeMember,
  mintInvite,
  newIdentity,
  restoreMemberHandle,
} from './app-lane-e2e.js'
import { createWireHub } from './log-hub-over-wire.js'

const flush = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The branch's thesis, end to end, with nothing substituted: the real `hub-server` reached
 * over the real Enkaku wire, real `@kumiai/mls` handles doing real MLS, and the real
 * `GroupCrypto` / `GroupMLS` from `@kumiai/mls-rpc`.
 *
 * Every other test of this behaviour in the repo runs against a fake crypto whose
 * `exportSecret` is an XOR of a fixed base — a value any member can compute at any epoch. The
 * one claim that fake structurally could not carry is the one that matters most: that a
 * removed member cannot NAME the group's next topic. Here it can be real.
 */
describe('app-lane delivery across a roster rotation, end to end', () => {
  /**
   * BLOCKED, and deliberately left written out rather than deleted — it is the branch's thesis
   * and it is the shape the fix has to satisfy. Two defects stop it, both found by this run and
   * both invisible to every existing test because the doubles are pure functions:
   *
   * 1. **Re-entrancy deadlock (blocks the roster change).** `CommitContext.resolveLedgerEntries`
   *    opens the entry blob with `GroupCrypto.unwrap`, and the port calls it from inside
   *    `GroupMLS.processCommit`. Against one real `GroupHandle` both are the same object and
   *    `processMessage` already holds its mutex, so the resolver waits forever on the lock the
   *    commit it is resolving for is holding. Confirmed by substituting a resolver that does not
   *    re-enter the handle: the add applies, the remove applies, and an absent member walks
   *    2 -> 3 -> 4 with the roster right. The mutex is not the whole problem — `unwrap` also
   *    mutates handle state, so opening a blob mid-apply would be unsound even if it could be
   *    reached. The two ports cannot both be served by one handle as specified.
   *
   * 2. **`unwrap` is called twice per live frame.** `peer.ts` builds two
   *    `segmentBoundTransport(name, topicID)` instances on the same protocol topic — one for the
   *    `BroadcastClient` (peer.ts:619), one for `createGroupBusServer` (peer.ts:628) — and each
   *    registers its own listener that unwraps every inbound frame. Real MLS consumes the
   *    per-message ratchet key on the first open, so the second fails with ts-mls's
   *    `Desired gen in the past` and whichever transport loses the race drops the message. The
   *    XOR fake is a pure function, so double-unwrapping is free against it.
   *
   * Both live in `packages/rpc/src`, which this probe may report on but not change. See
   * `docs/superpowers/probes/e2e-report.md`.
   */
  test.skip('an absent member returns and receives every message it missed, in order, exactly once', async () => {
    const hub = createWireHub()
    const bodies = createEntryBodies()

    const aliceID = newIdentity()
    const bobID = newIdentity()
    const carolID = newIdentity()
    const daveID = newIdentity()

    // --- The founding group, built out of band: three members at epoch 2. -----------------
    // These commits predate the peers, so the hub's commit log starts empty and every frame
    // on it below is one a peer actually published.
    const aliceSlot = (await import('@kumiai/mls-rpc')).createLedgerEntrySlot()
    const bobSlot = (await import('@kumiai/mls-rpc')).createLedgerEntrySlot()
    const carolSlot = (await import('@kumiai/mls-rpc')).createLedgerEntrySlot()
    const daveSlot = (await import('@kumiai/mls-rpc')).createLedgerEntrySlot()
    for (const slot of [aliceSlot, bobSlot, carolSlot, daveSlot]) {
      slot.install(async (ids) =>
        ids.map((id) => {
          const token = bodies.get(id)
          if (token == null) throw new Error(`unknown ledger entry ${id}`)
          return token
        }),
      )
    }

    let aliceHandle = await createFoundingGroup(aliceID, 'app-lane-e2e', aliceSlot)

    const bobMaterial = await mintInvite({
      admin: aliceHandle,
      adminIdentity: aliceID,
      invitee: bobID,
      bodies,
    })
    const { commitInvite } = await import('@kumiai/mls')
    const addBob = await commitInvite(
      aliceHandle,
      bobMaterial.bundle.publicPackage,
      bobMaterial.invite,
    )
    aliceHandle = addBob.newGroup
    const bobHandle = await joinFromWelcome({
      identity: bobID,
      invite: bobMaterial.invite,
      welcome: addBob.welcomeMessage,
      bundle: bobMaterial.bundle,
      ratchetTree: aliceHandle.state.ratchetTree,
      entrySlot: bobSlot,
    })

    const carolMaterial = await mintInvite({
      admin: aliceHandle,
      adminIdentity: aliceID,
      invitee: carolID,
      bodies,
    })
    const addCarol = await commitInvite(
      aliceHandle,
      carolMaterial.bundle.publicPackage,
      carolMaterial.invite,
    )
    aliceHandle = addCarol.newGroup
    const carolHandle = await joinFromWelcome({
      identity: carolID,
      invite: carolMaterial.invite,
      welcome: addCarol.welcomeMessage,
      bundle: carolMaterial.bundle,
      ratchetTree: aliceHandle.state.ratchetTree,
      entrySlot: carolSlot,
    })
    await bobHandle.processMessage(addCarol.commitMessage)

    expect(aliceHandle.epoch).toBe(2n)
    expect(bobHandle.epoch).toBe(2n)
    expect(carolHandle.epoch).toBe(2n)

    // --- Peers. Carol's is NOT started: she is the member who is away. ---------------------
    const alicePosted: Array<unknown> = []
    const bobPosted: Array<unknown> = []
    const alice = makeMember({
      hub,
      identity: aliceID,
      group: aliceHandle,
      entrySlot: aliceSlot,
      handlers: { 'chat/posted': (ctx: { data: unknown }) => void alicePosted.push(ctx.data) },
    })
    const bob = makeMember({
      hub,
      identity: bobID,
      group: bobHandle,
      entrySlot: bobSlot,
      handlers: { 'chat/posted': (ctx: { data: unknown }) => void bobPosted.push(ctx.data) },
    })
    await flush()

    // --- Messages on the first segment. ----------------------------------------------------
    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'one' })
    await bob.peer.protocol('chat').dispatch('chat/posted', { text: 'two' })
    await flush()

    const anchorBefore = alice.peer.anchorEpoch()

    // --- The roster changes twice: an ADD and a REMOVE. Both rotate the anchor, for
    //     different reasons — the add because the member set grew, the remove because a leaf
    //     was dropped and the evicted member must not follow the group onto its next topic.
    const daveMaterial = await mintInvite({
      admin: alice.handle(),
      adminIdentity: aliceID,
      invitee: daveID,
      bodies,
    })
    let daveWelcome: Uint8Array | undefined
    const addResult = await alice.peer.commit(
      buildInviteCommit(alice, daveMaterial, (welcome) => {
        daveWelcome = welcome
      }),
    )
    // `lost` is how the lane reports a commit that did not land. Absent means accepted.
    expect(addResult.lost).toBeUndefined()
    await flush()

    const removeResult = await alice.peer.commit(buildRemoveCommit(alice, bobID.id))
    expect(removeResult.lost).toBeUndefined()
    await flush()

    expect(alice.handle().epoch).toBe(4n)
    expect(daveWelcome).toBeDefined()

    // The anchor moved: the group is on a different topic than it was.
    const anchorAfter = alice.peer.anchorEpoch()
    expect(anchorAfter).not.toBe(anchorBefore)

    // --- Messages on the new segment. ------------------------------------------------------
    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'three' })
    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'four' })
    await flush()

    // Nothing reached Carol: she was never online, and a subscription back-fills nothing.
    const carolPosted: Array<unknown> = []

    // --- Carol comes back. Her handle is still at epoch 2. ---------------------------------
    expect(carolHandle.epoch).toBe(2n)
    const carol = makeMember({
      hub,
      identity: carolID,
      group: carolHandle,
      entrySlot: carolSlot,
      handlers: { 'chat/posted': (ctx: { data: unknown }) => void carolPosted.push(ctx.data) },
    })
    await flush(400)

    // She walked the commit log to the head...
    expect(carol.handle().epoch).toBe(4n)
    // ...and every message she missed arrived, in order, exactly once — across the rotation,
    // each opened at the epoch it was sealed at.
    expect(carolPosted).toEqual([
      { text: 'one' },
      { text: 'two' },
      { text: 'three' },
      { text: 'four' },
    ])

    await alice.peer.dispose()
    await bob.peer.dispose()
    await carol.peer.dispose()
    await hub.dispose()
  })

  /**
   * The claim the XOR fake structurally could not carry. Bob was removed at epoch 4. He keeps,
   * for life, every exporter secret he ever held and every topic he ever derived from them —
   * and epoch numbers are a counter he can enumerate. The group's protection is that the
   * post-removal epoch's exporter secret is not among them and cannot be reached from what he
   * holds, which is true only against real MLS.
   */
  test('a removed member cannot derive the group topic the group rotated onto', async () => {
    const hub = createWireHub()
    const bodies = createEntryBodies()
    const { createLedgerEntrySlot } = await import('@kumiai/mls-rpc')
    const { commitInvite } = await import('@kumiai/mls')

    const aliceID = newIdentity()
    const bobID = newIdentity()
    const aliceSlot = createLedgerEntrySlot()
    const bobSlot = createLedgerEntrySlot()
    for (const slot of [aliceSlot, bobSlot]) {
      slot.install(async (ids) =>
        ids.map((id) => {
          const token = bodies.get(id)
          if (token == null) throw new Error(`unknown ledger entry ${id}`)
          return token
        }),
      )
    }

    let aliceHandle = await createFoundingGroup(aliceID, 'removed-blind-e2e', aliceSlot)
    const material = await mintInvite({
      admin: aliceHandle,
      adminIdentity: aliceID,
      invitee: bobID,
      bodies,
    })
    const added = await commitInvite(aliceHandle, material.bundle.publicPackage, material.invite)
    aliceHandle = added.newGroup
    const bobHandle = await joinFromWelcome({
      identity: bobID,
      invite: material.invite,
      welcome: added.welcomeMessage,
      bundle: material.bundle,
      ratchetTree: aliceHandle.state.ratchetTree,
      entrySlot: bobSlot,
    })

    const alice = makeMember({ hub, identity: aliceID, group: aliceHandle, entrySlot: aliceSlot })
    const bob = makeMember({ hub, identity: bobID, group: bobHandle, entrySlot: bobSlot })
    await flush()

    // Everything Bob holds while he is still a member — including the exact topic the group
    // is on, which he can name because he is on it.
    const bobSecretAsMember = await bob
      .handle()
      .exportSecret('kumiai/app-topic/v1', new Uint8Array())
    const topicAsMember = protocolTopic(bobSecretAsMember, Number(bob.handle().epoch), 'chat')

    const removal = await alice.peer.commit(buildRemoveCommit(alice, bobID.id))
    expect(removal.lost).toBeUndefined()
    await flush()
    expect(alice.handle().epoch).toBe(2n)

    // The group's topic after the rotation.
    const groupSecret = await alice.handle().exportSecret('kumiai/app-topic/v1', new Uint8Array())
    const groupTopic = protocolTopic(groupSecret, Number(alice.handle().epoch), 'chat')
    expect(groupTopic).not.toBe(topicAsMember)

    // Bob's handle never advanced — the remove commit's UpdatePath excludes his leaf, so
    // there is no message that could have carried him forward.
    expect(bob.handle().epoch).toBe(1n)

    // Nothing Bob holds names the group's new topic. Not his own secret, at any epoch number
    // he cares to try — and enumerating them is free.
    const bobsGuesses = new Set<string>()
    const bobSecret = await bob.handle().exportSecret('kumiai/app-topic/v1', new Uint8Array())
    for (let epoch = 0; epoch <= 8; epoch++) {
      bobsGuesses.add(protocolTopic(bobSecret, epoch, 'chat'))
      bobsGuesses.add(protocolTopic(bobSecretAsMember, epoch, 'chat'))
    }
    // ...nor the lifelong recovery secret, which really is his for life.
    const recovery = await (async () => {
      const { createGroupMLS } = await import('@kumiai/mls-rpc')
      return await createGroupMLS({
        handle: () => bob.handle(),
        adopt: () => {},
        identity: bobID,
        entrySlot: bobSlot,
      }).exportRecoverySecret()
    })()
    for (let epoch = 0; epoch <= 8; epoch++) {
      bobsGuesses.add(protocolTopic(recovery, epoch, 'chat'))
    }

    expect(bobsGuesses.has(topicAsMember)).toBe(true) // the enumeration is real: it finds the old one
    expect(bobsGuesses.has(groupTopic)).toBe(false) // and it cannot reach the new one

    await alice.peer.dispose()
    await bob.peer.dispose()
    await hub.dispose()
  })

  /**
   * The durable cursor survives a restart: nothing lost, nothing duplicated.
   *
   * BLOCKED on defect 2 alone (the double `unwrap`) — it drives no roster change, so the
   * deadlock never fires. Not one app frame reaches a handler over real MLS.
   */
  test.skip('a peer restarted mid-history loses nothing and duplicates nothing', async () => {
    const hub = createWireHub()
    const bodies = createEntryBodies()
    const { createLedgerEntrySlot } = await import('@kumiai/mls-rpc')
    const { commitInvite } = await import('@kumiai/mls')

    const aliceID = newIdentity()
    const bobID = newIdentity()
    const aliceSlot = createLedgerEntrySlot()
    const bobSlot = createLedgerEntrySlot()
    for (const slot of [aliceSlot, bobSlot]) {
      slot.install(async (ids) =>
        ids.map((id) => {
          const token = bodies.get(id)
          if (token == null) throw new Error(`unknown ledger entry ${id}`)
          return token
        }),
      )
    }

    let aliceHandle = await createFoundingGroup(aliceID, 'restart-e2e', aliceSlot)
    const material = await mintInvite({
      admin: aliceHandle,
      adminIdentity: aliceID,
      invitee: bobID,
      bodies,
    })
    const added = await commitInvite(aliceHandle, material.bundle.publicPackage, material.invite)
    aliceHandle = added.newGroup
    const bobHandle = await joinFromWelcome({
      identity: bobID,
      invite: material.invite,
      welcome: added.welcomeMessage,
      bundle: material.bundle,
      ratchetTree: aliceHandle.state.ratchetTree,
      entrySlot: bobSlot,
    })

    const seen: Array<unknown> = []
    const handlers = { 'chat/posted': (ctx: { data: unknown }) => void seen.push(ctx.data) }

    const alice = makeMember({ hub, identity: aliceID, group: aliceHandle, entrySlot: aliceSlot })
    let bob: Member = makeMember({
      hub,
      identity: bobID,
      group: bobHandle,
      entrySlot: bobSlot,
      handlers,
    })
    await flush()

    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'before restart' })
    await flush()
    expect(seen).toEqual([{ text: 'before restart' }])

    // Bob's process dies and comes back over everything it persisted — its handle, its
    // anchor store, its cursor store, its journal.
    await bob.peer.dispose()
    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'while away' })
    await flush()

    const restoredHandle = await restoreMemberHandle(bob, bobSlot)
    bob = makeMember({
      hub,
      identity: bobID,
      group: restoredHandle,
      entrySlot: bobSlot,
      handlers,
      restartOf: bob,
    })
    await flush(300)

    // The message sent while he was gone arrived; the one he had already read did not
    // arrive twice. That second half is the durable cursor, and nothing else.
    expect(seen).toEqual([{ text: 'before restart' }, { text: 'while away' }])

    // And a frame published after he is back is delivered live.
    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'after restart' })
    await flush()
    expect(seen).toEqual([
      { text: 'before restart' },
      { text: 'while away' },
      { text: 'after restart' },
    ])

    await alice.peer.dispose()
    await bob.peer.dispose()
    await hub.dispose()
  })
})
