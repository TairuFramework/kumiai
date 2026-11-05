import { randomIdentity } from '@kokuin/token'
import { decodeClientState, restoreGroup } from '@kumiai/mls'
import type { GroupCrypto, GroupKey } from '@kumiai/rpc'

import { createGroupCrypto } from '../../src/crypto.js'
import { GroupUnavailableError } from '../../src/persistence-errors.js'
import { createGroupHandleRegistry } from '../../src/registry/registry.js'
import type { GroupHandleRegistry } from '../../src/registry/types.js'
import { registryOptions } from '../../src/registry/validation.js'
import { gateRegistryMaintenance } from '../../src/testing.js'
import { openedDeliveryContext } from './ownership-context.js'
import { restoreMemoryControlHandle } from './sealed-memory-mls.js'
import { createStorageFixture } from './storage-persistence.js'

export async function createHandlerConformanceFixture(
  params: Parameters<typeof createStorageFixture>[0],
) {
  const identity = params.identity ?? randomIdentity()
  const fixture = await createStorageFixture({ ...params, identity })
  let registry: GroupHandleRegistry | undefined
  async function attach() {
    const ports = fixture.ports
    const options = registryOptions({})
    registry = createGroupHandleRegistry({
      persistence: ports.device,
      providerID: ports.device.providerID,
      packages: ports.packages,
      openedDeliveryContext,
      recovery: { identity, options },
      async restoreCandidate() {
        throw new Error('Handler fixture does not import recovery candidates')
      },
      async restore(record) {
        const state = decodeClientState(record.state)
        if (state === undefined) throw new Error('Invalid conformance state')
        return (params.mode === 'real-mls' ? restoreGroup : restoreMemoryControlHandle)({
          state,
          credential: record.credential,
          ledgerEntries: record.ledger,
          options,
        })
      },
    })
    gateRegistryMaintenance(registry)
    const cryptoPorts = new Map<string, GroupCrypto>()
    const restorePending = (await ports.device.load()).restoreWork !== null
    for (const lifetime of restorePending ? [] : await ports.device.groups.list()) {
      if (lifetime.activeIncarnation === null) continue
      const key = { groupID: lifetime.groupID, incarnation: lifetime.activeIncarnation }
      const access = await registry.access(key.groupID)
      cryptoPorts.set(JSON.stringify([key.groupID, key.incarnation]), createGroupCrypto({ access }))
    }
    return {
      ...ports,
      crypto(key: GroupKey): GroupCrypto {
        if (restorePending) throw new GroupUnavailableError({ reason: 'restore-pending' })
        const port = cryptoPorts.get(JSON.stringify([key.groupID, key.incarnation]))
        if (port === undefined) throw new Error('No live crypto for requested key')
        return port
      },
    }
  }
  let currentPorts = await attach()
  const reopen = async (barrier: boolean) => {
    await registry?.dispose()
    if (barrier) await fixture.reopen()
    else await fixture.reopenWithoutBarrier()
    currentPorts = await attach()
    return currentPorts
  }
  return {
    ...fixture,
    get ports() {
      return currentPorts
    },
    reopen: () => reopen(true),
    reopenWithoutBarrier: () => reopen(false),
    async close() {
      await registry?.dispose()
      await fixture.close()
    },
  }
}
