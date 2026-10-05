import { randomIdentity } from '@kokuin/token'
import {
  type ControllerBinding,
  commitInvite,
  commitLedgerEntries,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  signLedgerEntry,
} from '@kumiai/mls'
import { createLedgerEntrySlot, deriveRecoverySecret } from '@kumiai/mls-rpc'
import { commitTopic, protocolTopic, type RecoveryEvent } from '@kumiai/rpc'
import { afterEach, expect, test, vi } from 'vitest'

import {
  buildLedgerCommit,
  buildRemoveCommit,
  createEntryBodies,
  createFoundingGroup,
  encodeJournal,
  joinFromWelcome,
  type Member,
  makeMember,
  mintInvite,
} from './app-lane-e2e.js'
import { createGapHub } from './gap-hub.js'

const members: Array<Member> = []
afterEach(async () => {
  await Promise.all(
    members.splice(0).map(async (member) => {
      await member.peer.dispose()
      await member.peer.drained()
    }),
  )
  vi.restoreAllMocks()
})

const lifecycle = (await import(
  new URL('../../../packages/mls/test/fixtures/lifecycle-pipeline.ts', import.meta.url).href
)) as {
  timedBinding(
    identity: ReturnType<typeof randomIdentity>,
    iat: number,
    exp: number,
  ): Promise<ControllerBinding>
}

async function setup(
  options: {
    lifecycle?: boolean
    recoveryBinding?: () => Promise<ControllerBinding | null>
    events?: Array<RecoveryEvent>
  } = {},
) {
  const hub = createGapHub()
  const bodies = createEntryBodies()
  const aliceID = randomIdentity()
  const bobID = randomIdentity()
  const aliceSlot = createLedgerEntrySlot()
  const bobSlot = createLedgerEntrySlot()
  for (const slot of [aliceSlot, bobSlot])
    slot.install(async (ids) =>
      ids.map((id) => {
        const token = bodies.get(id)
        if (token == null) throw new Error('Unknown entry')
        return token
      }),
    )
  const group = options.lifecycle
    ? (
        await createGroup(aliceID, 'delivery-integration', {
          controller: await lifecycle.timedBinding(aliceID, 100, 500),
        })
      ).group
    : await createFoundingGroup(aliceID, 'delivery-integration', aliceSlot)
  const material = options.lifecycle
    ? {
        invite: (await createInvite({ group, identity: aliceID, recipientDID: bobID.id })).invite,
        bundle: await createKeyPackageBundle(bobID, {
          controller: await lifecycle.timedBinding(bobID, 100, 200),
        }),
      }
    : await mintInvite({ admin: group, adminIdentity: aliceID, invitee: bobID, bodies })
  bodies.publish(material.invite)
  const added = await commitInvite(group, material.bundle.publicPackage, material.invite)
  const joined = await joinFromWelcome({
    identity: bobID,
    invite: material.invite,
    welcome: added.welcomeMessage,
    bundle: material.bundle,
    ratchetTree: added.newGroup.state.ratchetTree,
    entrySlot: bobSlot,
  })
  const received: Array<unknown> = []
  const alice = makeMember({
    hub,
    identity: aliceID,
    group: added.newGroup,
    entrySlot: aliceSlot,
    handlers: { 'chat/posted': (ctx: { data: unknown }) => received.push(ctx.data) },
  })
  const bob = makeMember({
    hub,
    identity: bobID,
    group: joined,
    entrySlot: bobSlot,
    recoveryBinding: options.recoveryBinding,
    onRecovery: (event) => {
      options.events?.push(event)
    },
  })
  members.push(alice, bob)
  await Promise.all([alice.peer.resync(), bob.peer.resync()])
  return { hub, alice, bob, received }
}

test('real MLS delivers accepted plaintext after a commit overtakes publication', async () => {
  const { hub, alice, bob, received } = await setup()
  const secret = await deriveRecoverySecret(alice.handle())
  const topic = commitTopic(secret)
  const publish = hub.log.publish.bind(hub.log)
  let injected = false
  vi.spyOn(hub.log, 'publish').mockImplementation(async (params) => {
    if (
      params.senderDID === bob.identity.id &&
      params.topicID !== topic &&
      params.retain === 'log' &&
      !injected
    ) {
      injected = true
      await alice.peer.commit(buildLedgerCommit(alice, alice.identity, bob.identity.id, 'member'))
    }
    return publish(params)
  })
  const plaintext = { text: 'survives the epoch race' }
  await bob.peer.protocol('chat').dispatch('chat/posted', { data: plaintext })
  await vi.waitFor(() => expect(received).toEqual([plaintext]), { timeout: 3000 })
  await vi.waitFor(async () => expect(await bob.appOutbox.list()).toEqual([]), { timeout: 3000 })
  const anchor = alice.anchorStore.stored()
  if (anchor == null) throw new Error('Missing anchor')
  const publications = hub.log.published.filter(
    (m) => m.senderDID === bob.identity.id && m.topicID !== topic,
  )
  expect(publications).toHaveLength(2)
  expect(publications.at(-1)?.topicID).toBe(protocolTopic(anchor.secret, anchor.epoch, 'chat'))
  expect(bob.handle().epoch).toBe(alice.handle().epoch)
})

test.each([
  { expired: false, fresh: false },
  { expired: true, fresh: false },
  { expired: false, fresh: true },
  { expired: true, fresh: true },
])(
  'real lifecycle recovery delivers with expired binding $expired and fresh cursor $fresh',
  async ({ expired, fresh }) => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(150_000)
    const events: Array<RecoveryEvent> = []
    let replacement: ControllerBinding | null = null
    const host = vi.fn(async () => replacement)
    const initial = await setup({
      lifecycle: true,
      recoveryBinding: host,
      events,
    })
    const { hub, alice, received } = initial
    let bob = initial.bob
    const topic = commitTopic(await deriveRecoverySecret(alice.handle()))
    const commit = (value: string) =>
      alice.peer.commit(async () => {
        const token = await signLedgerEntry(alice.identity, {
          groupID: alice.handle().groupID,
          type: 'note',
          subject: alice.identity.id,
          value,
        })
        const result = await commitLedgerEntries(alice.handle(), [token])
        return {
          commit: result.commitMessage,
          bodies: [token],
          kind: 'ledger',
          journal: encodeJournal(result.newGroup),
          onAccepted: () => alice.adopt(result.newGroup),
        }
      })
    await commit('floor')
    await vi.waitFor(() => expect(bob.handle().epoch).toBe(alice.handle().epoch))
    hub.log.unsubscribe?.(bob.identity.id, topic)
    await commit('gap')
    hub.log.trim(topic, '999999999999')
    if (fresh) {
      await bob.peer.dispose()
      await bob.peer.drained()
      bob = makeMember({
        hub,
        identity: bob.identity,
        group: bob.handle(),
        entrySlot: bob.entrySlot,
        recoveryBinding: host,
        onRecovery: (event) => {
          events.push(event)
        },
        restartOf: bob,
      })
      members.push(bob)
      await bob.peer.resync()
      expect(events).toEqual([])
    } else hub.log.subscribe(bob.identity.id, topic)
    if (expired) now.mockReturnValue(250_000)
    await bob.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'bound recovery' } })
    if (expired) {
      await vi.waitFor(
        () =>
          expect(
            events.some((event) => event.phase === 'failed' && event.reason === 'renewal-required'),
          ).toBe(true),
        { timeout: 2500 },
      )
      expect(received).toEqual([])
      expect(await bob.appOutbox.list()).toHaveLength(1)
      const starts = events.filter((event) => event.phase === 'started').length
      await new Promise((resolve) => setTimeout(resolve, 1100))
      expect(events.filter((event) => event.phase === 'started')).toHaveLength(starts)
      replacement = await lifecycle.timedBinding(bob.identity, 250, 400)
      await bob.peer.recover()
    }
    await vi.waitFor(() => expect(received).toEqual([{ text: 'bound recovery' }]), {
      timeout: 3000,
    })
    await vi.waitFor(async () => expect(await bob.appOutbox.list()).toEqual([]))
    expect(bob.handle().epoch).toBe(alice.handle().epoch)
    expect(events.some((event) => event.phase === 'succeeded')).toBe(true)
    if (!expired) expect(host).not.toHaveBeenCalled()
  },
)

test('real MLS holds removed senders and clears their accepted plaintext', async () => {
  const { hub, alice, bob, received } = await setup()
  const secret = await deriveRecoverySecret(alice.handle())
  const topic = commitTopic(secret)
  hub.log.unsubscribe?.(bob.identity.id, topic)
  await alice.peer.commit(buildRemoveCommit(alice, bob.identity.id))
  hub.log.subscribe(bob.identity.id, topic)
  await bob.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'removed' } })
  await vi.waitFor(async () => expect(await bob.appOutbox.list()).toEqual([]), { timeout: 1500 })
  expect(received).toEqual([])
  expect(
    hub.log.published.filter((m) => m.senderDID === bob.identity.id && m.topicID !== topic),
  ).toEqual([])
})
