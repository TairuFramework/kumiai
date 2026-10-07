# @kumiai/hub-store

A SQL `HubStore` for Kumiai hubs, registered as a Hozon store. It runs on any Hozon adapter
(node:sqlite, Postgres) and passes the `@kumiai/hub-conformance` suites on both.

Use `@kumiai/hub-http` to host a hub over HTTP. Use this package directly when composing a hub
server with a custom transport or when you need the store API separately.

## Exports

- `createHubStoreDefinition(options?)` -- the Hozon `StoreDefinition`, named `'kumiai-hub'`
  (`HUB_STORE`).
- `getHubStore(provider)` -- the `HubStore` from a `HozonDB` or any Hozon `StoreProvider`.
- `HubStoreOptions`.

```ts
import { HozonDB } from '@hozon/db'
import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { createHubStoreDefinition, getHubStore } from '@kumiai/hub-store'

const db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: 'hub.db' }) })
db.register(createHubStoreDefinition({ maxRetention: 30 * 24 * 60 * 60, maxDepth: 1000 }))
const store = await getHubStore(db)
```

The database applies the store migrations when `getHubStore` first resolves the registered
definition. Close the `HozonDB` when the host shuts down.

## Options

| Option | Default | Meaning |
|--------|---------|---------|
| `defaultRetention` | `0` | Floor, in seconds, on how long a topic's frames are kept. |
| `maxRetention` | none | Ceiling, in seconds, a subscribe may request. Above it the subscribe is refused. |
| `maxDepth` | none | Retained log frames per topic. The oldest log frames are evicted first. |
| `maxKeyPackagesPerDID` | `100` | Ordinary key packages one DID may hold. An upload past it is refused. |
| `maxSubscriptionsPerDID` | `1000` | Distinct topics one DID may subscribe to. |

## Storage

The migrations name tables without a prefix (`hub_messages`, `hub_topics`, ...). `HozonDB` applies
its `tablePrefix`, so several hubs can share one database under different prefixes.

`publish` runs the dedup check, the head compare-and-set, the sequence mint, the append and the
head advance in one transaction. The head advance is a conditional write, so two hub processes on
one Postgres database cannot both accept a publish at the same head.
