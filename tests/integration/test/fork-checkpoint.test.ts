import {
  checkpointSignatureInput,
  commitKeyRotation,
  decodeEpochCheckpoint,
  encodeEpochCheckpoint,
  nobleCryptoProvider,
} from '@kumiai/mls'
import { digestAppliedCommit } from '@kumiai/rpc'
import { afterEach, expect, test, vi } from 'vitest'

import { entryCapability } from '../../../packages/mls-rpc/src/entry-capability.js'
import { createCheckpointSplitView } from './fixtures/checkpoint-split-view.js'
import { createForkFixture } from './fixtures/fork-halt.js'

const fixtures: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close()
  vi.restoreAllMocks()
})
function required<TValue>(value: TValue | undefined | null): TValue {
  if (value == null) throw new Error('Missing test value')
  return value
}

async function setup() {
  const fixture = await createCheckpointSplitView()
  fixtures.push(fixture)
  return fixture
}
async function published(f: Awaited<ReturnType<typeof setup>>) {
  await vi.waitFor(() => {
    for (const device of [f.left, f.right])
      expect(device.hub.published.filter((row) => row.topicID === f.topicID)).toHaveLength(2)
  })
}

test('both installed split views detect without halting', async () => {
  const f = await setup()
  await published(f)
  const frames = [f.left, f.right].map(
    (device) =>
      required(device.hub.published.filter((row) => row.topicID === f.topicID).at(-1)).payload,
  )
  expect(decodeEpochCheckpoint(required(frames[0])).body.authHash).not.toBe(
    decodeEpochCheckpoint(required(frames[1])).body.authHash,
  )
  expect(await f.left.service.compare(f.left.key, required(frames[1]))).toMatchObject({
    kind: 'conflict',
  })
  expect(await f.right.service.compare(f.right.key, required(frames[0]))).toMatchObject({
    kind: 'conflict',
  })
  await f.exchange()
  for (const device of [f.left, f.right]) {
    await vi.waitFor(async () =>
      expect(await device.service.forkNotices(device.key.groupID)).toHaveLength(1),
    )
    expect(device.controlWalk.safetyHold()).toBeNull()
    expect(device.mls.sendAdmission().admissible).toBe(true)
    await expect(
      device.peer.protocol('chat').dispatch('chat/changed', { data: {} }),
    ).resolves.toBeUndefined()
  }
})

test('buggy signer can only notify', async () => {
  const f = await setup()
  await published(f)
  const device = f.left
  await device.control.apply(
    {
      putOutcomes: [
        { id: crypto.randomUUID(), opID: crypto.randomUUID(), at: Date.now(), kind: 'unknown' },
      ],
    },
    crypto.randomUUID(),
  )
  const saved = await device.control.load()
  const state = await device.fixture.device.groups.loadState(device.key)
  const rebuild = vi.spyOn(device.mls, 'applyRecovery')
  const installed = device.hub.published.findLast((row) => row.topicID === f.topicID)
  if (installed === undefined) throw new Error('Missing installed frame')
  const body = { ...decodeEpochCheckpoint(installed.payload).body, authHash: 'A'.repeat(43) }
  const suite = await nobleCryptoProvider.getCiphersuiteImpl(body.ciphersuite)
  const signature = await suite.signature.sign(
    device.fixture.identity.privateKey,
    checkpointSignatureInput(body),
  )
  const frame = encodeEpochCheckpoint(body, signature)
  await device.hub.publish({
    topicID: f.topicID,
    senderDID: 'buggy-relay',
    payload: frame,
    retain: 'log',
  })
  await vi.waitFor(async () =>
    expect(await device.service.forkNotices(device.key.groupID)).toHaveLength(1),
  )
  expect(await device.control.load()).toEqual(saved)
  expect(await device.fixture.device.groups.loadState(device.key)).toEqual(state)
  expect(device.controlWalk.safetyHold()).toBeNull()
  expect(rebuild).not.toHaveBeenCalled()
  expect(device.prepareBuild).not.toHaveBeenCalled()
  await expect(
    device.peer.protocol('chat').dispatch('chat/changed', { data: {} }),
  ).resolves.toBeUndefined()
})

test('checkpoint outage leaves ordinary sends open', async () => {
  const f = await setup()
  await published(f)
  const device = f.left
  const fetch = device.hub.fetchTopic.bind(device.hub)
  const fetches = vi.spyOn(device.hub, 'fetchTopic').mockImplementation(async (params) => {
    if (params.topicID === f.topicID) throw new Error('checkpoint outage')
    return fetch(params)
  })
  const publications = (await device.service.readRecords()).filter(
    (row) => row.kind === 'publication',
  )
  await f.exchange()
  await vi.waitFor(() =>
    expect(fetches.mock.calls.some(([params]) => params.topicID === f.topicID)).toBe(true),
  )
  for (const procedure of ['chat/changed', 'chat/posted'] as const)
    await expect(
      device.peer.protocol('chat').dispatch(procedure, { data: {} }),
    ).resolves.toBeUndefined()
  expect(device.controlWalk.safetyHold()).toBeNull()
  expect((await device.service.readRecords()).filter((row) => row.kind === 'publication')).toEqual(
    publications,
  )
})

test('refused CAS loser never creates checkpoint installation', async () => {
  const f = await setup()
  await published(f)
  for (const [index, device] of [f.left, f.right].entries()) {
    const before = (await device.service.readRecords()).filter(
      (row) => row.kind === 'fact' || row.kind === 'coverage',
    )
    const branch = required(f.branches[1 - index])
    const result = await device.mls.processCommit(branch.commitMessage, {})
    expect(result.advanced).toBe(false)
    expect(
      (await device.service.readRecords()).filter(
        (row) => row.kind === 'fact' || row.kind === 'coverage',
      ),
    ).toEqual(before)
    expect(device.controlWalk.safetyHold()).toBeNull()
    expect(device.prepareBuild).not.toHaveBeenCalled()
    expect(digestAppliedCommit(branch.commitMessage)).not.toBe(
      digestAppliedCommit(required(f.branches[index]).commitMessage),
    )
  }
  const fork = await createForkFixture()
  fixtures.push(fork)
  const entry = entryCapability(fork.registry.device.groups)
  if (entry === null) throw new Error('Missing checkpoint records')
  const installed = async () =>
    (await entry.read(fork.key.groupID, (reads) => reads.checkpoints())).filter(
      (row) => row.kind === 'fact' || row.kind === 'coverage',
    )
  const receiver = fork.real.members[0]
  if (receiver === undefined) throw new Error('Missing receiver')
  const own = await commitKeyRotation(receiver.handle)
  const winner = await commitKeyRotation(fork.real.committer.handle)
  await fork.publish(winner.commitMessage, fork.real.committer.handle, null)
  await expect(fork.publish(own.commitMessage, receiver.handle, null)).rejects.toThrow()
  await fork.member.peer.replay()
  const before = await installed()
  // Historical delivery of the signed CAS loser cannot create an installation.
  await fork.publish(own.commitMessage, receiver.handle)
  await fork.member.peer.replay()
  expect(await installed()).toEqual(before)
  expect(fork.onRecovery).not.toHaveBeenCalled()
  expect(fork.member.controlWalk.safetyHold()).toBeNull()

  const ownSlot = await createForkFixture()
  fixtures.push(ownSlot)
  const competition = await ownSlot.competing('winning')
  const owner = entryCapability(ownSlot.registry.device.groups)
  if (owner === null) throw new Error('Missing own-slot checkpoint records')
  const facts = async () =>
    (await owner.read(ownSlot.key.groupID, (reads) => reads.checkpoints())).filter(
      (row) => row.kind === 'fact' || row.kind === 'coverage',
    )
  const installedBeforeSearch = await facts()
  const certified = await competition.certify()
  expect(certified.losers).toHaveLength(1)
  expect(await facts()).toEqual(installedBeforeSearch)
  expect(ownSlot.onRecovery).not.toHaveBeenCalled()
  expect(ownSlot.member.controlWalk.safetyHold()).toBeNull()
})
