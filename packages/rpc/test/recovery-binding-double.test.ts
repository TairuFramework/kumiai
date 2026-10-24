import { expect, test } from 'vitest'

import { createMemoryGroupMLS } from './fixtures/memory-group-mls.js'

test('a refused bound candidate is not reused by the memory port', async () => {
  const binding = { id: 'controller', prefix: ['inception'], capability: 'initial-capability' }
  const options = {
    members: ['alice', 'bob'],
    binding,
    signatureKey: 'bob-key',
    controllerLog: {
      chain: ['inception'],
      events: [],
      grants: [{ capability: binding.capability, did: 'bob', key: 'bob-key' }],
    },
    recoveryBinding: async () => binding,
  }
  const alice = createMemoryGroupMLS({ ...options, localDID: 'alice' })
  const bob = createMemoryGroupMLS({ ...options, localDID: 'bob' })
  const request = await bob.createRecoveryRequest('refused-binding')
  const pending = await bob.applyRecovery(await alice.sealGroupInfo(request), 'refused-binding')
  if (pending == null || 'renewalRequired' in pending) throw new Error('No candidate')
  pending.markBindingUnusable()
  expect(await bob.prepareRecovery()).toBe('renewal-required')
})
