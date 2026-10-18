import { randomIdentity } from '@kokuin/token'
import {
  commitInvite,
  commitKeyRotation,
  createInvite,
  createKeyPackageBundle,
  decodeClientState,
  encodeClientState,
  ledgerEntryDigest,
  restoreGroup,
} from '@kumiai/mls'
import { deriveEntryKey, sealEntries } from '@kumiai/mls-rpc'
import {
  encodeCommitFrame,
  encodeHandshakeFrame,
  encodeLedgerEntries,
  HANDSHAKE_KIND,
} from '@kumiai/rpc'
import { afterEach, expect, test, vi } from 'vitest'

import { recoveryTrustFor } from '../../../packages/mls-rpc/src/registry/trust.js'
import { createCapturedRecoveryFixture } from './fixtures/fork-halt.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()))
  vi.restoreAllMocks()
})

async function setup() {
  const fixture = await createCapturedRecoveryFixture({ timeoutMs: 5000, deadlineMs: 30_000 })
  cleanup.push(() => fixture.close())
  return fixture
}

test.each(['missing', 'unreadable', 'client-state'] as const)(
  'real registry recovers %s private state from retained trust without opening the old handle',
  { timeout: 60_000 },
  async (damage) => {
    const s = await setup()
    const bob = s.bob
    const before = await bob.fixture.device.groups.loadTrust(bob.key.groupID)
    await bob.stop()
    const newcomer = randomIdentity()
    const bundle = await createKeyPackageBundle(newcomer)
    const source = s.real.committer.handle
    const { invite } = await createInvite({
      group: source,
      identity: s.real.committer.identity,
      recipientDID: newcomer.id,
      permission: 'member',
    })
    for (const token of invite.ledgerEntries) s.real.bodies.set(ledgerEntryDigest(token), token)
    const invited = await commitInvite(source, bundle.publicPackage, invite)
    await s.hub.publish({
      senderDID: s.real.committer.identity.id,
      topicID: s.topicID,
      retain: 'log',
      payload: encodeHandshakeFrame(
        HANDSHAKE_KIND.commit,
        encodeCommitFrame(
          invited.commitMessage,
          sealEntries(await deriveEntryKey(source), encodeLedgerEntries(invite.ledgerEntries)),
        ),
      ),
    })
    await s.alice.peer.replay()
    const epoch = await s.alice.mls.readEpoch()
    expect(epoch).toBe(Number(invited.newGroup.epoch))
    if (damage === 'missing') await bob.fixture.removeStateBytes(bob.key)
    else await bob.fixture.corruptState(bob.key, damage)
    await bob.restart()
    await vi.waitFor(
      async () => {
        expect(bob.owner.installedKey().incarnation).toBe(2)
        expect((await bob.control.load()).rejoin).toBeNull()
        expect(await bob.mls.readEpoch()).toBe(epoch + 1)
        expect(await s.alice.mls.readEpoch()).toBe(epoch + 1)
      },
      { timeout: 30_000 },
    )
    const destination = bob.owner.installedKey()
    const state = await bob.fixture.device.groups.loadState(destination)
    const trust = await bob.fixture.device.groups.loadTrust(bob.key.groupID)
    if (state === null || state.deleted) throw new Error('Missing recovered state')
    expect(state.epoch).toBe(epoch + 1)
    expect(state?.incarnation).toBe(2)
    expect(trust?.genesisAnchor).toEqual(before?.genesisAnchor)
    expect(trust?.installed.incarnation).toBe(2)
    expect(trust?.spentEpochAuthenticators).toContainEqual(before?.installed.authenticator)
    expect((await bob.fixture.device.groups.ports(destination).control.load()).applied).toEqual([])
    expect((await bob.control.load()).forkHalt).toBeNull()
    expect((await bob.control.load()).recoveryUnavailable).toBeNull()
    const members = await (await bob.fixture.registry.access(bob.key.groupID)).read((group) =>
      group.listMembers(),
    )
    expect(members.filter(({ id }) => id === bob.identity.id)).toHaveLength(1)
    expect(members.some(({ id }) => id === newcomer.id)).toBe(true)
    expect(await bob.mls.getLedger()).toEqual(await s.alice.mls.getLedger())
    expect(await bob.mls.readEpoch()).toBe(await s.alice.mls.readEpoch())
  },
)

test('source drainage gates switching and a destination bootstrap crash preserves outcomes and owed Welcomes', async () => {
  const s = await setup()
  const bob = s.bob
  const outcome = {
    id: 'prior-outcome',
    opID: 'prior-operation',
    at: 123,
    kind: 'unknown' as const,
  }
  const welcome = {
    opID: 'owed-invite',
    welcome: new Uint8Array([1, 2, 3]),
    recipients: [s.alice.identity.id],
    committed: true as const,
  }
  await bob.fixture.installRows({
    key: bob.key,
    control: { putOutcomes: [outcome], putWelcomes: [welcome] },
  })
  let releaseDrain = () => {}
  const drainage = new Promise<void>((resolve) => {
    releaseDrain = resolve
  })
  let draining = false
  const source = bob.peer
  const drained = source.drained.bind(source)
  vi.spyOn(source, 'drained').mockImplementation(async () => {
    draining = true
    await drainage
    await drained()
  })
  let releaseCreate = () => {}
  const creation = new Promise<void>((resolve) => {
    releaseCreate = resolve
  })
  let destinationWaiting = false
  bob.hooks.beforePeer = async (key) => {
    if (key.incarnation === 2) {
      destinationWaiting = true
      await creation
    }
  }
  cleanup.push(async () => {
    releaseDrain()
    releaseCreate()
  })
  const recovery = source.recover()
  void recovery.catch(() => {})
  await expect.poll(() => draining, { timeout: 10_000 }).toBe(true)
  expect((await bob.fixture.device.groups.load(bob.key.groupID))?.activeIncarnation).toBe(1)
  expect(bob.created.map(({ key }) => key.incarnation)).toEqual([1])
  releaseDrain()
  await expect.poll(() => destinationWaiting, { timeout: 10_000 }).toBe(true)
  const destination = { ...bob.key, incarnation: 2 }
  expect((await bob.control.load()).rejoin?.stage).toBe('adopted')
  expect((await bob.control.load()).outcomes).toContainEqual(outcome)
  expect((await bob.control.load()).welcomes).toEqual([welcome])
  bob.owner.dispose()
  releaseCreate()
  await bob.owner.drained()
  await recovery.catch(() => {})
  bob.hooks.beforePeer = undefined
  const row = await bob.fixture.device.groups.loadState(destination)
  if (row === null || row.deleted || row.state === null) throw new Error('Missing switched state')
  const state = decodeClientState(row.state)
  if (state === undefined) throw new Error('Invalid switched state')
  const handle = await restoreGroup({
    state,
    credential: row.credential,
    ledgerEntries: row.ledger,
    options: bob.fixture.environment.options,
  })
  const ledger = await s.alice.mls.getLedger()
  await handle.bootstrapLedger(ledger)
  const rotated = (await commitKeyRotation(handle)).newGroup
  await bob.fixture.installRows({
    key: destination,
    state: {
      ...row,
      version: row.version + 1,
      epoch: Number(rotated.epoch),
      epochAuthenticator: rotated.state.keySchedule.epochAuthenticator.slice(),
      state: encodeClientState(rotated.state),
      ledger: rotated.ledgerTokens,
    },
    trust: recoveryTrustFor(
      rotated,
      destination,
      await bob.fixture.device.groups.loadTrust(bob.key.groupID),
    ),
  })
  await bob.restart()
  await expect.poll(async () => (await bob.control.load()).rejoin, { timeout: 10_000 }).toBeNull()
  expect(await bob.mls.readEpoch()).toBe(Number(rotated.epoch))
  expect((await bob.control.load()).outcomes).toContainEqual(outcome)
  expect((await bob.control.load()).welcomes).toEqual([welcome])
  const delivered: Array<string> = []
  expect(
    await bob.fixture.serveRetiredWelcomes(bob.key, async ({ opID }) => {
      delivered.push(opID)
    }),
  ).toMatchObject({ remaining: [], failures: [] })
  expect(delivered).toEqual(['owed-invite'])
  await bob.restart()
  expect((await bob.control.load()).outcomes.filter(({ id }) => id === outcome.id)).toEqual([
    outcome,
  ])
  expect((await bob.control.load()).welcomes).toEqual([])
})
