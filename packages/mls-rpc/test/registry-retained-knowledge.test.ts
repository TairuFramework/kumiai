import { type ControllerLog, createRotate, type FoldResult, snapshotOf } from '@kokuin/controller'
import type { OwnIdentity } from '@kokuin/token'
import {
  commitKeyRotation,
  createGroup,
  type DeviceRegistry,
  publishControllerLog,
  RecoveryKnowledgeError,
} from '@kumiai/mls'
import { afterEach, expect, test, vi } from 'vitest'

import { assertTrustTransition } from '../src/persistence-guards.js'
import { knownRecoveryRegistry } from '../src/recovery.js'
import { recoveryTrustFor } from '../src/registry/trust.js'
import { bareTestHandle } from './fixtures/real-group.js'
import { createGatedRegistryFixture } from './fixtures/registry.js'

const { buildEpoch } = (await import(
  new URL('../../mls/test/fixtures/controller-epoch.ts', import.meta.url).href
)) as {
  buildEpoch(): Promise<{
    seed: Uint8Array
    did: string
    log: ControllerLog
    members: Array<{ identity: OwnIdentity; add: string }>
  }>
}
const { foldControllerLog } = (await import(
  new URL('../../mls/src/controller-log.ts', import.meta.url).href
)) as { foldControllerLog(did: string, log: ControllerLog): FoldResult }

afterEach(() => vi.restoreAllMocks())

async function leaseSettlement() {
  vi.spyOn(Date, 'now').mockReturnValue(150_000)
  const f = await buildEpoch()
  const owner = f.members[0]
  const signer = f.members[1]
  if (owner === undefined || signer === undefined) throw new Error('Missing members')
  const signerAdd = signer.add
  function settle(log: ControllerLog, lease?: number): ControllerLog {
    const folded = foldControllerLog(f.did, log)
    const prior = log.chain.at(-1)
    if (!folded.ok || prior === undefined) throw new Error('Invalid fixture log')
    const snapshot = snapshotOf(folded.head)
    if (lease !== undefined)
      snapshot.members = snapshot.members.map((member) =>
        member.add === signerAdd ? { ...member, lease } : member,
      )
    return {
      chain: [
        ...log.chain,
        createRotate({ seed: f.seed, profile: 0, did: f.did, prior: prior.event, snapshot }),
      ],
      events: [],
    }
  }
  const log = settle(f.log)
  const fixture = await createGatedRegistryFixture({
    mode: 'real-mls',
    setup: 'empty',
    groupID: 'retained-settlement',
    identity: owner.identity,
  })
  try {
    const { group } = await createGroup(owner.identity, 'retained-settlement', {
      ...fixture.environment.options,
      controller: { id: f.did, prefix: log.chain, member: { add: owner.add, g: 0 }, iat: 100 },
      controllerLog: log,
    })
    const published = await publishControllerLog(await bareTestHandle(group), settle(log, 200))
    if (published === null) throw new Error('Missing settlement publication')
    let stale = await bareTestHandle(group)
    for (let epoch = 0; epoch < 2; epoch++) stale = (await commitKeyRotation(stale)).newGroup
    const key = { groupID: group.groupID, incarnation: 1 }
    const retained = recoveryTrustFor(published.newGroup, key, null)
    retained.spentEpochAuthenticators.push(retained.installed.authenticator.slice())
    const lease = (registry: DeviceRegistry) => {
      const recorded = registry.controllers.get(f.did)?.recordedLog
      if (recorded === undefined) throw new Error('Missing recorded log')
      const folded = foldControllerLog(f.did, recorded)
      if (!folded.ok) throw new Error(folded.reason)
      return folded.head.members.get(signer.add)?.lease
    }
    expect(lease(retained.registry)).toBe(200)
    expect(lease(stale.registry)).toBe(1000)
    return { fixture, key, retained, stale, current: published.newGroup, lease }
  } catch (error) {
    await fixture.close()
    throw error
  }
}

test('trust transition refuses a settled lease rollback from 200 to 1000', async () => {
  const s = await leaseSettlement()
  try {
    const next = recoveryTrustFor(s.stale, s.key, null)
    next.spentEpochAuthenticators = s.retained.spentEpochAuthenticators
    expect(() => assertTrustTransition(s.retained, next)).toThrow(
      new RecoveryKnowledgeError('forked'),
    )
  } finally {
    await s.fixture.close()
  }
})

test('switch trust refuses a settled lease rollback from 200 to 1000', async () => {
  const s = await leaseSettlement()
  try {
    expect(() =>
      recoveryTrustFor(s.stale, { ...s.key, incarnation: 2 }, s.retained),
    ).toThrow(new RecoveryKnowledgeError('forked'))
  } finally {
    await s.fixture.close()
  }
})

test('recovery merge refuses a settled lease rollback from 200 to 1000', async () => {
  const s = await leaseSettlement()
  try {
    expect(() => knownRecoveryRegistry(s.retained.registry, s.stale.registry)).toThrow(
      new RecoveryKnowledgeError('forked'),
    )
  } finally {
    await s.fixture.close()
  }
})

test.each(['seed', 'readmission'] as const)(
  '%s refuses a settled lease rollback from 200 to 1000 before persistence',
  async (path) => {
    const s = await leaseSettlement()
    try {
      const packageUse = { sourceID: 'settlement', ref: 'package', kind: 'ordinary' as const }
      await s.fixture.registry.seed(s.current, { packageUse })
      if (path === 'seed') await s.fixture.registry.delete(s.key)
      const before = await s.fixture.inspectRows()
      await expect(
        s.fixture.registry.seed(s.stale, { packageUse, replace: path === 'readmission' }),
      ).rejects.toThrow(new RecoveryKnowledgeError('forked'))
      expect(await s.fixture.inspectRows()).toEqual(before)
      const trust = await s.fixture.device.groups.loadTrust(s.key.groupID)
      if (trust === null) throw new Error('Missing retained trust')
      expect(s.lease(trust.registry)).toBe(200)
    } finally {
      await s.fixture.close()
    }
  },
)
