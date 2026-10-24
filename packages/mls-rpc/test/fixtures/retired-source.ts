import type { GroupKey } from '../../src/persistence-types.js'
import { retireIncarnation } from '../../src/registry/retired.js'
import type { RegistryFixtureBase } from './registry.js'
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
  await groups.transition(await nextChange(groups, source.groupID, mutationID), async (stores) => {
    const lifetime = await stores.lifetime.load()
    const trust = await stores.trust.load()
    if (lifetime === null || trust === null) throw new Error('Missing retirement source')
    await retireIncarnation(stores, {
      source,
      nextIncarnation: seed.key.incarnation,
      mutationID,
      at: 12,
    })
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
  })
}
