import { protocolTopic } from '@kumiai/rpc'
import { describe, expect, test } from 'vitest'

import {
  buildInviteCommit,
  buildLedgerCommit,
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
   * The whole thesis in one scenario: a member is away while the group both talks and changes
   * its roster twice — an add AND a remove, so the anchor rotates for both reasons — and comes
   * back to find every message it missed, in order, exactly once, across the rotation.
   *
   * Two invariants carry it here that no fake can express, and both are about opening:
   *
   * - A live frame is opened ONCE. Opening consumes the frame's ratchet key on a real handle,
   *   so the two consumers this lane puts on one topic share a single open.
   * - A commit's entry blob is opened with a DERIVED key, not as an application message. The MLS
   *   port opens it from inside the apply of the very commit that carries it, where an open that
   *   spends a ratchet generation or touches handle state is unsound however it is scheduled.
   */
  test('an absent member returns and receives every message it missed, in order, exactly once', async () => {
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
   * No roster change here, so nothing rotates: what is under test is the read position alone,
   * and the two deliverers that write it — the pull that hands over the backlog and the live
   * push that resumes behind it — agreeing about where the member had got to.
   */
  test('a peer restarted mid-history loses nothing and duplicates nothing', async () => {
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
    // anchor store, its cursor store, its journal. The connection goes with the process: the
    // hub holds one receive writer per member, so a restart onto a socket that never closed is
    // refused its push channel and reads by pull alone.
    await bob.peer.dispose()
    await bob.disconnect()
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

  /**
   * A frame published while a returning peer is INSIDE its commit walk, over real MLS and a real
   * hub — the branch's load-bearing claim that had only ever run against the fakes.
   *
   * The walk pulls the app segment once and then dispenses it epoch by epoch as it ratchets. A
   * frame that reaches the log AFTER that pull is one no later read of the same pull asks for, and
   * here it is also one the live push is racing to deliver: both deliverers see it, and there is
   * ONE durable read position between them. The publish is hung off the delivery of the first
   * frame, so it lands strictly after the pull and strictly before the walk ends — a timer would
   * race the walk and pass by luck.
   *
   * Roster-neutral commits throughout, so the anchor never moves and there is one app topic for
   * the whole run: what separates the mid-walk frame from the others is WHEN it was published,
   * never which segment it landed on. And it is sealed at the epoch alice is at when she sends it,
   * which is an epoch bob has not reached at the moment it arrives — so it can only be opened once
   * his walk gets there, which is the whole ordering under test.
   */
  test('a frame published while a peer is mid-walk is delivered, in order, exactly once', async () => {
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

    let aliceHandle = await createFoundingGroup(aliceID, 'mid-walk-e2e', aliceSlot)
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
    await flush()

    // Bob is away. One frame at epoch 1, then a roster-neutral commit carrying the group to
    // epoch 2 — the anchor does not move, so both frames live on one topic.
    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'at epoch one' })
    const advanced = await alice.peer.commit(
      buildLedgerCommit(alice, aliceID, `did:key:subject-${Date.now()}`, 'member'),
    )
    expect(advanced.lost).toBeUndefined()
    await flush()
    expect(alice.handle().epoch).toBe(2n)

    const seen: Array<unknown> = []
    let injected = false
    const bob = makeMember({
      hub,
      identity: bobID,
      group: bobHandle,
      entrySlot: bobSlot,
      handlers: {
        'chat/posted': async (ctx: { data: unknown }) => {
          seen.push(ctx.data)
          if (injected) return
          injected = true
          // Bob's walk has pulled the segment and has not yet applied the commit that leaves
          // epoch 1. Alice publishes at epoch 2 — an epoch bob is not at yet.
          await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'mid-walk, at two' })
        },
      },
    })
    await flush(500)

    expect(bob.handle().epoch).toBe(2n)
    expect(seen).toEqual([{ text: 'at epoch one' }, { text: 'mid-walk, at two' }])

    await alice.peer.dispose()
    await bob.peer.dispose()
    await hub.dispose()
  })

  /**
   * A RESTART MID-WALK, over real MLS and a real hub: the process dies partway through the walk
   * that is catching it up, and comes back over everything it persisted.
   *
   * The death is hung off the delivery of the first frame rather than a timer, so it lands with
   * the walk genuinely in flight — the segment pulled, the backlog part-delivered, and commits
   * still to apply. What must survive it is the pair the whole lane rests on: the durable read
   * position, so the frame already handed to the host is not handed over again, and the persisted
   * MLS state, so the second process resumes the walk rather than restarting it. Neither has ever
   * been exercised against a real ratchet, where a frame already opened CANNOT be opened again.
   */
  test('a peer that dies mid-walk resumes over its persisted state and loses nothing', async () => {
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

    let aliceHandle = await createFoundingGroup(aliceID, 'restart-mid-walk-e2e', aliceSlot)
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
    await flush()

    // A backlog spanning three epochs, with no roster change: one topic, three seal epochs, and
    // a walk that has to ratchet twice to read all of it.
    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'at epoch one' })
    for (const [index, value] of [['a', 'member'] as const, ['b', 'member'] as const].entries()) {
      const result = await alice.peer.commit(
        buildLedgerCommit(alice, aliceID, `did:key:subject-${value[0]}-${index}`, value[1]),
      )
      expect(result.lost).toBeUndefined()
      await flush()
      await alice.peer
        .protocol('chat')
        .dispatch('chat/posted', { text: `at epoch ${Number(alice.handle().epoch)}` })
      await flush()
    }
    expect(alice.handle().epoch).toBe(3n)

    const seen: Array<unknown> = []
    let dying: Member | undefined
    const handlers = {
      'chat/posted': async (ctx: { data: unknown }) => {
        seen.push(ctx.data)
        const process = dying
        if (process == null) return
        // The process dies HERE: the peer stops and the socket goes with it, which is what a
        // process death is. The hub binds one receive writer per DID and is right to refuse a
        // second, so a restart onto a connection that never closed gets no push lane.
        dying = undefined
        await process.peer.dispose()
        await process.disconnect()
      },
    }

    let bob: Member = makeMember({
      hub,
      identity: bobID,
      group: bobHandle,
      entrySlot: bobSlot,
      handlers,
    })
    dying = bob
    await flush(400)

    // It died partway: the first frame reached the host and the walk did not finish.
    expect(seen).toEqual([{ text: 'at epoch one' }])

    const restoredHandle = await restoreMemberHandle(bob, bobSlot)
    bob = makeMember({
      hub,
      identity: bobID,
      group: restoredHandle,
      entrySlot: bobSlot,
      handlers,
      restartOf: bob,
    })
    await flush(600)

    // The second process finished the walk, in order, and lost nothing.
    //
    // The epoch-one frame arrives TWICE, and that is the correct answer rather than a defect: the
    // first process died INSIDE its handler, so the read position was never written past it and
    // the host never confirmed the frame. The lane is at-least-once across a crash mid-delivery,
    // and the alternative — advancing the cursor before the host holds the frame — is the one that
    // loses messages. What makes the repeat possible at all against a real ratchet is that bob
    // restored MLS state persisted BEFORE the open, so the frame's message key had not been spent
    // in anything durable. A peer that persisted after opening could not re-open it.
    expect(bob.handle().epoch).toBe(3n)
    expect(seen).toEqual([
      { text: 'at epoch one' },
      { text: 'at epoch one' },
      { text: 'at epoch 2' },
      { text: 'at epoch 3' },
    ])

    await alice.peer.dispose()
    await bob.peer.dispose()
    await hub.dispose()
  })
})
