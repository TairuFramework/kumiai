import type { GroupKey } from '../../src/persistence-types.js'
import { retireIncarnation } from '../../src/registry/retired.js'
import { preparedTransition } from './closing.js'
import type { RegistryFixtureBase } from './registry.js'
import { requireValue } from './require-value.js'
import { makeStorageSeed, nextChange, writeInstallationCheckpoint } from './storage-seed.js'

// Reconstructs an earlier retirement whose certified backlog predates lifecycle drainage.
export async function retireStoredSource(
  fixture: RegistryFixtureBase,
  source: GroupKey,
  mode: 'real-mls' | 'double',
): Promise<void> {
  const groups = fixture.device.groups
  const seed = await makeStorageSeed({
    id: source.groupID,
    incarnation: source.incarnation + 1,
    epoch: 1,
    mode,
    identity: fixture.identity,
    options: fixture.environment.options,
  })
  const mutationID = crypto.randomUUID()
  await preparedTransition(
    groups,
    await nextChange(groups, source.groupID, mutationID),
    async (reads) => {
      const lifetime = await reads.lifetime()
      if (lifetime === null) throw new Error('Missing lifetime')
      return {
        states: [seed.state],
        lifetime: {
          ...lifetime,
          activeIncarnation: seed.key.incarnation,
          latestIncarnation: seed.key.incarnation,
          revision: lifetime.revision + 1,
          mutationID,
        },
      }
    },
    async (stores, closingData) => {
      const lifetime = await stores.lifetime.load()
      const trust = await stores.trust.load()
      if (lifetime === null || trust === null) throw new Error('Missing retirement source')
      await retireIncarnation(stores, requireValue(closingData.retirement))
      await stores.lifetime.save({
        ...lifetime,
        activeIncarnation: seed.key.incarnation,
        latestIncarnation: seed.key.incarnation,
        revision: lifetime.revision + 1,
        mutationID,
      })
      await stores.incarnation(seed.key.incarnation).state.save(seed.state)
      await stores.trust.save({
        ...seed.trust,
        genesisAnchor: trust.genesisAnchor,
        spentEpochAuthenticators: trust.spentEpochAuthenticators,
      })
      await writeInstallationCheckpoint(stores, {
        key: seed.key,
        confirmedTranscriptHash: seed.confirmedTranscriptHash,
        mutationID,
        stateVersion: seed.state.version,
      })
    },
    {
      source,
      nextIncarnation: seed.key.incarnation,
      mutationID,
      at: 12,
    },
  )
}
