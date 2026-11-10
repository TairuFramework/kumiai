# @kumiai/hub-store

A SQL `HubStore` for Kumiai hubs, registered as a Hozon store. It runs on any Hozon adapter
(node:sqlite, Postgres) and passes the `@kumiai/hub-conformance` suites on both.

Use `@kumiai/hub-http` to host a hub over HTTP. Use this package directly when composing a hub
server with a custom transport or when you need the store API separately.

## Exports

- `createHubStoreDefinition(options?)` -- the Hozon `StoreDefinition`, named `'kumiai-hub'`
  (`HUB_STORE`).
- `getHubStore(provider)` -- the `SQLHubStore` from a `HozonDB` or any Hozon `StoreProvider`.
- `HubStoreOptions`, `HubSubscriptionReaper`, and `SQLHubStore` (the hub contract, subscription reaping, occupancy and persistent store identity).

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

| Option                   | Default             | Meaning                                                                          |
| ------------------------ | ------------------- | -------------------------------------------------------------------------------- |
| `defaultRetention`       | `0`                 | Floor, in seconds, on how long a topic's frames are kept.                        |
| `maxRetention`           | `2592000` (30 days) | Ceiling, in seconds, a subscribe may request. Above it the subscribe is refused. |
| `maxDepth`               | `1000`              | Retained log frames per topic. The oldest log frames are evicted first.          |
| `maxKeyPackagesPerDID`   | `100`               | Ordinary key packages one DID may hold. An upload past it is refused.            |
| `maxSubscriptionsPerDID` | `1000`              | Distinct topics one DID may subscribe to.                                        |

Set `maxRetention` or `maxDepth` to `Infinity` to disable that bound explicitly.
These defaults match the memory store. Periodic purge applies the age policy.

## Storage

The migrations name tables without a prefix (`hub_messages`, `hub_topics`, ...). `HozonDB` applies
its `tablePrefix`, so several hubs can share one database under different prefixes.

`publish` claims the publish ID, then runs the head compare-and-set, sequence mint, append and the
head advance in one transaction. The head advance is a conditional write, so two hub processes on
one Postgres database cannot both accept a publish at the same head.

Concurrent retries of one publish ID wait for the accepting transaction and return its sequence ID with `deduped: true`.

## Subscription reaping

`store.purgeSubscriptions({ olderThan })` removes subscriptions inactive for strictly more than `olderThan` seconds.
It returns exactly the deleted `{ topicID, subscriberDID }` pairs. A subscription refreshed at the boundary survives.
The delete and return happen atomically, so a refreshed subscription is neither removed nor reported.
This operation emits no event. `createHub` calls it after scheduled message purge when the store supports it.

## Attribution migration and occupancy

Migration `1-attribution` adds `payload_size`, nullable `account`, `actor` and `via` columns, plus the `hub_meta` table.
It backfills payload sizes and persists a generated `storeID` in `hub_meta`.
Existing message, retention and delivery semantics remain unchanged.

`publish({ ..., attribution? })` accepts `{ account, actor, via: 'direct' | 'delegated' | 'group' }`.
Without attribution, these columns remain null.
Legacy and unattributed rows fall back to `sender_did` for both account and actor, with `via: 'direct'`.

`store.occupancy()` returns retained payload bytes and frame counts grouped by account, actor and via.
Each physical frame counts once, regardless of recipient count.
Ack, trim, purge and unsubscribe affect occupancy through their existing frame deletion rules.
`store.storeID()` returns the persistent identifier shared by processes using the same store.

Publish results include `outcome` and `storedBytes`.
Only `outcome: 'inserted'` contributes payload bytes. Deduplicated and no-recipient publishes report zero stored bytes.
