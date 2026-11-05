import { randomIdentity } from '@kokuin/token'
import {
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  processWelcome,
} from '@kumiai/mls'
import {
  type AppCompletionCoverage,
  type AppCompletionCoverageSource,
  appFrameIdempotencyKey,
  encodeAppAAD,
  frameID,
  type PreOpenAppFrameRef,
} from '@kumiai/rpc'

import { coordinatorBinding } from '../../src/entry-capability.js'
import { bindGroupBatchOptions } from '../../src/group-batch-binding.js'
import { createHandlerCompletion } from '../../src/handler-completion.js'
import type { OpenAppInput, PendingAppFrame } from '../../src/persistence-types.js'
import { createAsyncLocalOwnershipContext } from './ownership-context.js'
import { createGatedRegistryFixture } from './registry.js'
import { registryHandle } from './registry-welcome.js'
import { createStorageFixture } from './storage-persistence.js'

export async function completionFixture(
  mode: 'real-mls' | 'double',
  supplied: boolean,
  cap = 64,
  maxBatchWorkMs = 8,
) {
  const identity = randomIdentity()
  const fixture = await createStorageFixture({
    id: crypto.randomUUID(),
    identity,
    mode,
    ownershipContext: supplied ? createAsyncLocalOwnershipContext() : undefined,
  })
  const groups = fixture.ports.device.groups
  const life = (await groups.list()).find((value) => value.groupID !== 'group-B')
  if (life === undefined) throw new Error('Missing lifetime')
  const key = { groupID: life.groupID, incarnation: 1 }
  const binding = coordinatorBinding(groups)
  if (binding === null) throw new Error('Missing binding')
  bindGroupBatchOptions(binding, { maxBatchFrames: cap, maxBatchWorkMs })
  const capability = fixture.entry()
  await capability.run(
    { groupID: key.groupID, mutationID: crypto.randomUUID() },
    async (reads) => ({ expected: await reads.lifetime(), value: undefined }),
    async (stores) => {
      const rows = stores.incarnation(1)
      await rows.pending.complete([
        ...(await rows.pending.list()).map((r) => r.frame.id),
        ...(await rows.pending.listPoison()).map((r) => r.frame.id),
      ])
      await rows.cursor.clear()
    },
  )
  const record = (id: string, position = id, topicID = 'chat'): PendingAppFrame => {
    const frame = {
      ...key,
      id,
      position,
      topicID,
      protocol: 'chat',
      procedure: 'posted',
      segment: 1,
    }
    return {
      frame,
      payload: new Uint8Array([1, 2]),
      senderDID: 'sender',
      epoch: 3,
      idempotencyKey: appFrameIdempotencyKey(frame),
    }
  }
  const plant = async (records: Array<PendingAppFrame>, poison = false) =>
    capability.run(
      { groupID: key.groupID, mutationID: crypto.randomUUID() },
      async (reads) => ({ expected: await reads.lifetime(), value: undefined }),
      async (stores) => {
        if (poison)
          await stores.incarnation(1).pending.poison(
            records.map(({ frame }) => ({
              frame,
              reason: 'malformed-plaintext',
              keyConsumed: true,
            })),
          )
        else await stores.incarnation(1).pending.put(records)
      },
    )
  const pending = () => capability.read(key.groupID, (reads) => reads.pendingFrames(1))
  const cursor = (topicID = 'chat') =>
    capability.read(key.groupID, (reads) => reads.appCursor(1, topicID))
  return {
    fixture,
    identity,
    groups,
    key,
    capability,
    binding,
    record,
    plant,
    pending,
    cursor,
    completion: createHandlerCompletion({ persistence: groups, key }),
  }
}

export function orderedCoverage(
  records: Array<{ frame: PreOpenAppFrameRef }>,
  states?: Array<'pending' | 'dead' | 'completed'>,
) {
  const first = records[0]
  if (first === undefined) throw new Error('Missing coverage frame')
  let previous: string | null = null
  let generation = 1
  let prefix: AppCompletionCoverage['prefix'] = records.map((record, i) => ({
    frame: { ...record.frame },
    state: states?.[i] ?? 'pending',
  }))
  const source: AppCompletionCoverageSource = {
    capture: () =>
      prefix.length === 0
        ? []
        : [
            {
              key: { groupID: first.frame.groupID, incarnation: first.frame.incarnation },
              topicID: first.frame.topicID,
              generation,
              previous,
              through: prefix.at(-1)?.frame.position ?? null,
              prefix: structuredClone(prefix),
            },
          ],
    current: (coverage) => coverage.generation === generation && coverage.previous === previous,
    committed(ids, coverage) {
      for (const row of prefix) if (ids.includes(row.frame.id)) row.state = 'completed'
      for (const proof of coverage) {
        if (proof.through === null) continue
        const index = prefix.findIndex((row) => row.frame.position === proof.through)
        if (index >= 0) {
          prefix = prefix.slice(index + 1)
          previous = proof.through
        }
      }
    },
  }
  return {
    source,
    reset() {
      generation++
    },
    remaining: () => structuredClone(prefix),
  }
}

export async function authenticatedCompletionFixture(
  mode: 'real-mls' | 'double',
  supplied: boolean,
) {
  const groupID = crypto.randomUUID()
  const fixture = await createGatedRegistryFixture({
    mode,
    groupID,
    setup: 'empty',
    ownershipContext: supplied ? createAsyncLocalOwnershipContext() : undefined,
  })
  const remote = randomIdentity()
  const options = fixture.environment.options ?? {}
  const base = (await createGroup(fixture.identity, groupID, options)).group
  const bundle = await createKeyPackageBundle(remote, options)
  const { invite } = await createInvite({
    group: base,
    identity: fixture.identity,
    recipientDID: remote.id,
    permission: 'member',
  })
  const added = await commitInvite(base, bundle.publicPackage, invite)
  const joined = (
    await processWelcome({
      identity: remote,
      invite,
      welcome: added.welcomeMessage,
      keyPackageBundle: bundle,
      options,
    })
  ).group
  const sender = await registryHandle({ mode, handle: joined, options })
  const key = await fixture.registry.seed(
    await registryHandle({ mode, handle: added.newGroup, options }),
    { packageUse: await fixture.packageUse() },
  )
  const access = await fixture.registry.access(groupID)
  const completion = createHandlerCompletion({ persistence: fixture.device.groups, key })
  return {
    fixture,
    key,
    access,
    completion,
    async seal(position: string): Promise<OpenAppInput> {
      const topicID = 'chat'
      const expectedAAD = encodeAppAAD({ topicID, intent: 'log' })
      const ciphertext = await sender.encrypt(new TextEncoder().encode('{}'), { aad: expectedAAD })
      return {
        frame: {
          ...key,
          id: frameID(topicID, ciphertext),
          topicID,
          protocol: 'chat',
          segment: access.epoch(),
          position,
        },
        ciphertext,
        expectedAAD,
      }
    },
  }
}
