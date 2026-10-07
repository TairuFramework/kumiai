import type { StoreDefinition, StoreProvider } from '@hozon/db'
import type { HubStore } from '@kumiai/hub-protocol'

import { hubStoreMigrations } from './migrations.js'
import { createHubStore, type HubStoreOptions } from './store.js'
import type { HubTables } from './tables.js'

export const HUB_STORE = 'kumiai-hub'

export function createHubStoreDefinition(
  options: HubStoreOptions = {},
): StoreDefinition<HubTables, HubStore> {
  return {
    name: HUB_STORE,
    migrations: hubStoreMigrations,
    createAPI: (db, adapter) => createHubStore(db, adapter, options),
  }
}

export async function getHubStore(provider: StoreProvider): Promise<HubStore> {
  return (await provider.getStore(HUB_STORE)) as HubStore
}
