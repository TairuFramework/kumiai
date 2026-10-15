import { expect, test } from 'vitest'

import { createMemoryGroupMLS } from './fixtures/memory-group-mls.js'

test('a refused bound candidate is not reused by the memory port', async () => {
  const binding = { id: 'controller', prefix: [], capability: 'initial-capability' }
  const options = { members: ['alice', 'bob'], binding, recoveryBinding: async () => binding }
  const alice = createMemoryGroupMLS({ ...options, localDID: 'alice' })
  const bob = createMemoryGroupMLS({ ...options, localDID: 'bob' })
  const { request, requestKey } = await bob.createRecoveryRequest('refused-binding')
  const pending = await bob.applyRecovery(
    await alice.sealGroupInfo(request),
    'refused-binding',
    requestKey,
  )
  if (pending == null || 'renewalRequired' in pending) throw new Error('No candidate')
  pending.markBindingUnusable()
  expect(await bob.prepareRecovery()).toBe('renewal-required')
})

test('fresh recovery requests build distinct external commits while candidate restore preserves bytes', async () => {
  const options = { members: ['alice', 'bob'] }
  const alice = createMemoryGroupMLS({ ...options, localDID: 'alice' })
  const bob = createMemoryGroupMLS({ ...options, localDID: 'bob' })
  const first = await bob.createRecoveryRequest('first-attempt')
  const pending = await bob.applyRecovery(
    await alice.sealGroupInfo(first.request),
    'first-attempt',
    first.requestKey,
  )
  if (pending == null || 'renewalRequired' in pending) throw new Error('No first candidate')
  const second = await bob.createRecoveryRequest('fresh-attempt')
  const fresh = await bob.applyRecovery(
    await alice.sealGroupInfo(second.request),
    'fresh-attempt',
    second.requestKey,
  )
  if (fresh == null || 'renewalRequired' in fresh) throw new Error('No fresh candidate')
  expect(fresh.commit).not.toEqual(pending.commit)
  const restored = await bob.restoreRecovery(await pending.serialize(), first.requestKey)
  expect(restored.commit).toEqual(pending.commit)
})
