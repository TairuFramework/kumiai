import type { StoreDefinition, StoreProvider } from '@hozon/db'

import { hubStoreMigrations } from './migrations.js'
import { createHubStore, type HubStoreOptions, type SQLHubStore } from './store.js'
import type { HubTables } from './tables.js'

export const HUB_STORE = 'kumiai-hub'

export function createHubStoreDefinition(
  options: HubStoreOptions = {},
): StoreDefinition<HubTables, SQLHubStore> {
  return {
    name: HUB_STORE,
    migrations: hubStoreMigrations,
    createAPI: (db, adapter) => createHubStore({ db, adapter, options }),
  }
}

export async function getHubStore(provider: StoreProvider): Promise<SQLHubStore> {
  return (await provider.getStore(HUB_STORE)) as SQLHubStore
}
