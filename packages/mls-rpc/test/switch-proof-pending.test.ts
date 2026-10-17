import { expect, test, vi } from 'vitest'

import { createRecoveryContinuationPort } from '../src/registry/continuation.js'
import { registryRecoveryCoordinator } from '../src/registry/recovery-coordinator.js'
import { createRegistryPeer, type RegistryPeer } from '../src/registry-peer.js'
import { createRegistryFixture } from './fixtures/registry.js'

test('unresolved switch proof stays pending without a bound', async () => {
  const key = { groupID: 'switch-proof-pending', incarnation: 1 }
  const f = await createRegistryFixture({ mode: 'real-mls', setup: 'seeded', groupID: key.groupID })
  let owner: RegistryPeer | undefined
  try {
    const recovery = await f.confirmedRecovery(key, { confirm: true })
    if (!('format' in recovery.record)) throw new Error('Missing captured recovery')
    const resolve = vi
      .spyOn(registryRecoveryCoordinator(f.registry), 'resolveRecoverySwitch')
      .mockResolvedValue({ kind: 'pending' })
    const unexpected = () => {
      throw new Error('Unproven switch must not start a peer')
    }
    vi.useFakeTimers()
    owner = await createRegistryPeer({
      registry: f.registry,
      key,
      recovery: f.environment,
      target: recovery.record.target,
      continuation: createRecoveryContinuationPort({
        registry: f.registry,
        persistence: f.device.groups,
      }),
      createMLS: unexpected,
      createPeer: unexpected,
    })
    let ready = false
    void owner.ready.then(() => {
      ready = true
    })
    await vi.advanceTimersByTimeAsync(0)
    for (let round = 0; round < 12; round++) {
      expect(resolve.mock.calls.length).toBe(round + 1)
      expect(owner.status().kind).toBe('pending')
      expect(owner.peer()).toBeNull()
      expect(ready).toBe(false)
      await vi.advanceTimersToNextTimerAsync()
    }
    expect(owner.status().kind).toBe('pending')
    expect((await f.device.groups.ports(key).control.load()).rejoin).toEqual(recovery.record)
  } finally {
    owner?.dispose()
    await owner?.drained()
    vi.useRealTimers()
    vi.restoreAllMocks()
    await f.close()
  }
})
