import { HeadMismatchError } from '@kumiai/hub-protocol'
import { sealCapturedGroupInfo } from '@kumiai/mls'
import type { CapturedRejoinRecord } from '@kumiai/rpc'
import { afterEach, expect, test, vi } from 'vitest'

import { reconcileRecoveryCapture } from '../../../packages/mls-rpc/src/recovery.js'
import { decodeCapturedRecoveryCandidate } from '../../../packages/mls-rpc/src/recovery-codec.js'
import { operationRequest } from './app-lane-e2e.js'
import { createCapturedRecoveryFixture } from './fixtures/fork-halt.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()))
  vi.restoreAllMocks()
})

async function setup() {
  const fixture = await createCapturedRecoveryFixture()
  cleanup.push(() => fixture.close())
  return fixture
}

test('stale capture CAS recaptures poison at the same epoch and retries identical saved bytes', async () => {
  const s = await setup()
  const attempts: Array<{ publishID?: string; expectedHead?: string | null; payload: Uint8Array }> =
    []
  const records: Array<CapturedRejoinRecord> = []
  const apply = s.bob.control.apply.bind(s.bob.control)
  vi.spyOn(s.bob.control, 'apply').mockImplementation(async (changes, id) => {
    if (changes.putRejoin !== undefined && 'format' in changes.putRejoin)
      records.push(structuredClone(changes.putRejoin))
    return apply(changes, id)
  })
  let poison: string | undefined
  let mismatches = 0
  const publish = s.hub.publish.bind(s.hub)
  vi.spyOn(s.hub, 'publish').mockImplementation(async (params) => {
    if (
      params.senderDID !== s.bob.identity.id ||
      params.topicID !== s.topicID ||
      params.retain !== 'log'
    )
      return publish(params)
    attempts.push({ ...params, payload: params.payload.slice() })
    if (poison === undefined) {
      poison = (
        await publish({
          topicID: s.topicID,
          senderDID: s.alice.identity.id,
          retain: 'log',
          payload: new Uint8Array([255]),
        })
      ).sequenceID
    }
    try {
      return await publish(params)
    } catch (error) {
      if (error instanceof HeadMismatchError) mismatches++
      throw error
    }
  })
  await s.bob.peer.recover()
  await expect.poll(() => s.bob.owner.installedKey().incarnation, { timeout: 10_000 }).toBe(2)
  expect(mismatches).toBe(1)
  expect(attempts).toHaveLength(2)
  expect(attempts.map(({ expectedHead }) => expectedHead)).toEqual([null, poison])
  expect(attempts[1]?.publishID).toBe(attempts[0]?.publishID)
  expect(attempts[1]?.payload).toEqual(attempts[0]?.payload)
  expect(new Set(records.map(({ id }) => id)).size).toBe(1)
  expect(
    records.every(({ captureHead, searchFrom }) => captureHead === null && searchFrom === null),
  ).toBe(true)
  expect(records[0]?.expectedHead).toBeNull()
  expect(records.at(-1)?.expectedHead).toBe(poison)
  expect(await s.bob.mls.readEpoch()).toBe(await s.alice.mls.readEpoch())
  expect((await s.bob.control.load()).forkHalt).toBeNull()
  expect((await s.alice.control.load()).controlHold).toBeNull()
})

test.each(['present', 'absent'] as const)(
  'authenticated later fresh leaf %s settles X and keeps its epoch floor across reconstruction',
  async (leaf) => {
    const s = await setup()
    const initialEpoch = await s.bob.mls.readEpoch()
    const origin = await (await s.alice.fixture.registry.access(s.alice.key.groupID)).read(
      (handle) => handle,
    )
    let saved: CapturedRejoinRecord | undefined
    const apply = s.bob.control.apply.bind(s.bob.control)
    vi.spyOn(s.bob.control, 'apply').mockImplementation(async (changes, id) => {
      if (saved === undefined && changes.putRejoin !== undefined && 'format' in changes.putRejoin)
        saved = structuredClone(changes.putRejoin)
      await apply(changes, id)
      if (changes.putSettledRejoins !== undefined) void s.bob.peer.dispose()
    })
    let interrupted = false
    const publish = s.hub.publish.bind(s.hub)
    vi.spyOn(s.hub, 'publish').mockImplementation(async (params) => {
      if (
        params.senderDID !== s.bob.identity.id ||
        params.topicID !== s.topicID ||
        params.retain !== 'log' ||
        interrupted
      )
        return publish(params)
      interrupted = true
      if (leaf === 'present') {
        await publish(params)
        await expect.poll(() => s.alice.mls.readEpoch()).toBe(saved?.epochAfter)
      }
      await s.alice.peer.commit(operationRequest('rotation', {}))
      if (leaf === 'absent') return publish(params)
      throw new Error('Lost acknowledgement after remote acceptance and advancement')
    })
    const recovering = s.bob.peer.recover()
    void recovering.catch(() => {})
    await expect
      .poll(async () => (await s.bob.control.load()).settledRejoins.length, { timeout: 15_000 })
      .toBe(1)
    await recovering.catch(() => {})
    await s.bob.peer.dispose()
    await s.bob.peer.drained()
    const snapshot = await s.bob.control.load()
    if (saved === undefined) throw new Error('Missing saved attempt')
    const floor = await s.alice.mls.readEpoch()
    expect(snapshot.rejoin).toBeNull()
    expect(snapshot.recoveryEpochFloor).toBe(floor)
    expect(snapshot.settledRejoins).toHaveLength(1)
    const settlement = snapshot.settledRejoins[0]
    expect(settlement).toMatchObject({
      kind: leaf === 'present' ? 'accepted-unadoptable' : 'not-accepted',
      id: saved.id,
      ledgerBefore: saved.ledgerBefore,
    })
    if (leaf === 'present')
      expect(settlement).toMatchObject({
        epochAfter: saved.epochAfter,
        acceptedEpoch: floor,
        leafDigest: expect.any(String),
      })
    else expect(settlement).toMatchObject({ epoch: floor })
    for (const key of ['request', 'requestKey', 'candidate', 'payload'])
      expect(settlement).not.toHaveProperty(key)
    expect(await s.bob.mls.readEpoch()).toBe(initialEpoch)
    vi.mocked(s.bob.control.apply).mockRestore()
    await s.bob.restart()
    const again = s.bob
    const requestID = crypto.randomUUID()
    const staleRequest = await again.mls.createRecoveryRequest(requestID)
    const staleReply = await sealCapturedGroupInfo({
      group: origin,
      identity: s.alice.identity,
      request: new TextDecoder().decode(staleRequest.request),
      captureHead: null,
    })
    expect(
      await reconcileRecoveryCapture({
        source: decodeCapturedRecoveryCandidate(saved.candidate, saved.requestKey).source,
        target: s.target,
        record: saved,
        reply: {
          sealed: staleReply,
          requestID,
          requestKey: staleRequest.requestKey,
          epochFloor: (await again.control.load()).recoveryEpochFloor,
        },
        environment: {
          ...again.fixture.environment,
          accept: async () => {
            throw new Error('Stale recapture cannot adopt')
          },
        },
      }),
    ).toEqual({ kind: 'retry', reason: 'target-behind' })
    expect((await again.control.load()).recoveryEpochFloor).toBe(floor)
    expect((await again.control.load()).rejoin).toBeNull()
    await again.peer.recover()
    await expect
      .poll(async () => (await again.control.load()).rejoin, { timeout: 10_000 })
      .toBeNull()
    await expect.poll(() => again.mls.readEpoch(), { timeout: 10_000 }).toBe(floor + 1)
    await again.peer.replay()
    expect((await again.control.load()).recoveryEpochFloor).toBe(floor)
    expect(await again.mls.readEpoch()).toBe(await s.alice.mls.readEpoch())
    const members = await (await again.fixture.registry.access(again.key.groupID)).read((handle) =>
      handle.listMembers(),
    )
    expect(members.filter(({ id }) => id === s.bob.identity.id)).toHaveLength(1)
    expect((await again.control.load()).forkHalt).toBeNull()
    expect((await again.control.load()).controlHold).toBeNull()
  },
)
