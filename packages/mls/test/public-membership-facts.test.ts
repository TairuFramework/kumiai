import { normalizeDID } from '@kokuin/token'
import { afterEach, expect, test, vi } from 'vitest'

import { deriveGroup } from '../src/group-handle.js'
import { renewLeaf } from '../src/group-lifecycle.js'
import { publicMembershipFacts } from '../src/lifecycle.js'
import {
  agent,
  lowLevelWelcome,
  pipelineGroup,
  timedBinding,
} from './fixtures/lifecycle-pipeline.js'

afterEach(() => vi.restoreAllMocks())

test('public facts match validated handles before and after lapse and own removal', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(150_000)
  const { group, identity } = await pipelineGroup()
  const peer = agent(51)
  const joined = await lowLevelWelcome(
    group,
    peer,
    await timedBinding({ identity: peer, iat: 90, exp: 110 }),
  )
  const advanced = await renewLeaf(
    joined.author,
    await timedBinding({ identity, iat: 150, exp: 250 }),
  )
  await joined.joined.processMessage(advanced.commitMessage)
  for (const [handle, lapsed] of [
    [group, false],
    [joined.joined, true],
  ] as const) {
    const facts = publicMembershipFacts({
      tree: handle.state.ratchetTree,
      anchor: handle.anchor,
      registry: handle.registry,
      ownerDID: handle.credential.id,
    })
    expect(facts.members).toEqual(handle.listMembers().map((member) => normalizeDID(member.id)))
    expect(facts.ownPresent).toBe(true)
    expect(facts.lapsed).toBe(lapsed)
    expect(facts.lapsed).toBe(!handle.sendAdmission().admissible)
  }
  const state = structuredClone(advanced.newGroup.state)
  state.ratchetTree[state.privatePath.leafIndex * 2] = undefined
  state.groupActiveState = { kind: 'removedFromGroup' }
  const removed = deriveGroup(advanced.newGroup, state)
  expect(
    publicMembershipFacts({
      tree: removed.state.ratchetTree,
      anchor: removed.anchor,
      registry: removed.registry,
      ownerDID: identity.id,
    }),
  ).toEqual({ members: [peer.id], ownPresent: false, lapsed: false })
  expect(removed.findMemberLeafIndex(identity.id)).toBeUndefined()
})
