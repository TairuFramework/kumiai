import { testWakeRegistryConformance } from '@kumiai/hub-conformance'
import type { WakeRegistration } from '@kumiai/hub-protocol'
import { describe, expect, test } from 'vitest'

import { createMemoryWakeRegistry } from '../src/memoryRegistry.js'

testWakeRegistryConformance({ createRegistry: () => createMemoryWakeRegistry() })

describe('createMemoryWakeRegistry isolation', () => {
  function registration(): WakeRegistration {
    return {
      did: 'did:key:alice',
      kind: 'webpush',
      endpoint: 'https://push.example/aaa',
      publicKey: 'cHVibGlj',
      authSecret: 'YXV0aA',
    }
  }

  test('mutating the object passed to put does not corrupt the stored entry', async () => {
    const registry = createMemoryWakeRegistry()
    const entry = registration()
    await registry.put(entry)

    entry.endpoint = 'https://push.example/mutated-after-put'

    await expect(registry.get('did:key:alice')).resolves.toEqual(registration())
  })

  test('mutating the object returned by get does not corrupt the stored entry', async () => {
    const registry = createMemoryWakeRegistry()
    await registry.put(registration())

    const first = await registry.get('did:key:alice')
    if (first == null) throw new Error('expected a registration')
    first.endpoint = 'https://push.example/mutated-after-get'

    await expect(registry.get('did:key:alice')).resolves.toEqual(registration())
  })
})
