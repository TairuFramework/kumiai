import { commitKeyRotation, restoreGroup } from '@kumiai/mls'
import { deriveRecoverySecret } from '@kumiai/mls-rpc'
import { checkpointTopic } from '@kumiai/rpc'

import { createCheckpointService } from '../../../../packages/mls-rpc/src/checkpoint.js'
import { createRealGroup } from '../../../../packages/mls-rpc/test/fixtures/real-group.js'
import { createRegistryFixture } from '../../../../packages/mls-rpc/test/fixtures/registry.js'
import { DurableFakeHub } from '../../../../packages/rpc/test/fixtures/durable-fake-hub.js'
import { makeCheckpointPeer } from './fork-halt.js'

export async function createCheckpointSplitView() {
  const real = await createRealGroup(2, `checkpoint-split-${crypto.randomUUID()}`)
  const secret = await deriveRecoverySecret(real.committer.handle)
  const topicID = checkpointTopic(secret)
  const branches = await Promise.all([
    commitKeyRotation(real.committer.handle),
    commitKeyRotation(real.committer.handle),
  ])
  const devices: Array<Awaited<ReturnType<typeof device>>> = []
  async function device(index: number) {
    const member = real.members[index]
    const branch = branches[index]
    if (member === undefined || branch === undefined) throw new Error('Missing split member')
    const fixture = await createRegistryFixture({
      mode: 'real-mls',
      setup: 'empty',
      groupID: real.committer.handle.groupID,
      identity: member.identity,
      options: { resolveLedgerEntries: real.resolveLedgerEntries },
    })
    const hub = new DurableFakeHub()
    const key = await fixture.registry.seed(
      await restoreGroup({
        state: member.handle.state,
        credential: member.handle.credential,
        ledgerEntries: member.handle.ledgerTokens,
        options: fixture.environment.options,
      }),
      { packageUse: { sourceID: 'split-member', ref: `split-${index}`, kind: 'ordinary' } },
    )
    const access = await fixture.registry.access(key.groupID)
    await access.mutate(async (handle, persist) => {
      await handle.processMessage(branch.commitMessage, { persist })
    })
    const service = createCheckpointService({
      registry: fixture.registry,
      key,
      identity: member.identity,
    })
    const peer = await makeCheckpointPeer(fixture, member, hub)
    await peer.peer.replay()
    return { fixture, key, hub, service, ...peer }
  }
  try {
    for (let i = 0; i < 2; i++) devices.push(await device(i))
  } catch (error) {
    for (const device of devices) {
      await device.peer.dispose()
      await device.peer.drained()
      await device.fixture.close()
    }
    throw error
  }
  const [left, right] = devices
  if (left === undefined || right === undefined) throw new Error('Missing devices')
  return {
    real,
    branches,
    secret,
    topicID,
    left,
    right,
    async exchange() {
      // Only opaque checkpoint bytes cross logs. Commit histories remain independent.
      for (const [from, to] of [
        [left, right],
        [right, left],
      ] as const) {
        for (const row of from.hub.published.filter((row) => row.topicID === topicID)) {
          await to.hub.publish({
            topicID,
            senderDID: row.senderDID,
            payload: row.payload.slice(),
            retain: 'log',
            publishID: `bridge:${row.senderDID}:${row.sequenceID}`,
          })
        }
      }
    },
    async close() {
      for (const device of devices) {
        await device.peer.dispose()
        await device.peer.drained()
        await device.fixture.close()
      }
    },
  }
}
