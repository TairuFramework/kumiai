import { nodeTypes } from 'ts-mls'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { restoreGroup } from '../src/group-create.js'
import { makeMLSCredential } from '../src/group-credential.js'
import { deriveGroup } from '../src/group-handle.js'
import {
  agent,
  lowLevelWelcome,
  pipelineGroup,
  timedBinding,
} from './fixtures/lifecycle-pipeline.js'

beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(150_000))
afterEach(() => vi.restoreAllMocks())

test.each([true, false])(
  'restoring an unparseable leaf preserves the ledger registry (standard: %s)',
  async (standard) => {
    const setup = await pipelineGroup({ standard })
    const target = agent(51)
    const { author: group } = await lowLevelWelcome(
      setup.group,
      target,
      await timedBinding({ identity: target, iat: 100, exp: 200 }),
    )
    const state = structuredClone(group.state)
    // Keep local send admission independent of lifecycle expiry checks, which validate leaves.
    const own = state.ratchetTree[state.privatePath.leafIndex * 2]
    if (own?.nodeType !== nodeTypes.leaf) throw new Error('Missing own leaf')
    own.leaf.credential = makeMLSCredential(setup.identity)
    const leafIndex = group.listMembers().find((member) => member.id === target.id)?.leafIndex
    if (leafIndex == null) throw new Error('Missing target leaf')
    const node = state.ratchetTree[leafIndex * 2]
    if (node?.nodeType !== nodeTypes.leaf || !('identity' in node.leaf.credential)) {
      throw new Error('Missing basic credential')
    }
    node.leaf.credential.identity = new TextEncoder().encode('not-json-garbage')
    const constructed = deriveGroup(group, structuredClone(state))
    expect(constructed.registry).toEqual(group.registry)
    const restored = await restoreGroup({
      state,
      credential: group.credential,
      ledgerEntries: group.ledgerTokens,
    })
    expect(restored.registry).toEqual(group.registry)
    await restored.applyLedgerEntries([])
    expect(restored.registry).toEqual(group.registry)
  },
)
