# @kumiai/hub-http

Production HTTP hosting for Kumiai hubs, using the Teikyo database, access and rate-limit plugins.

```ts
import { Client } from '@enkaku/client'
import { ClientTransport } from '@enkaku/http-fetch'
import type { HubProtocol } from '@kumiai/hub-protocol'
import { randomIdentity } from '@kokuin/token'
import { createHubServer } from '@kumiai/hub-http'

const identity = randomIdentity()
const caller = randomIdentity()
const server = await createHubServer({
  identity,
  db: './hub.sqlite',
  port: 3000,
  trustProxy: ['10.0.0.0/8'],
  access: { grants: true, revocation: true },
})

const grants = server.hub.grants
if (grants == null) throw new Error('Grant plugin is required')
await grants.store.grant({
  subject: caller.id,
  pattern: 'hub/*',
  createdBy: identity.id,
})
server.handleSignals()
await server.listen()

const transport = new ClientTransport<HubProtocol>({ url: `${server.url}/hub` })
const client = new Client<HubProtocol>({ transport, identity: caller, serverID: identity.id })
await client.request('hub/v1/subscribe', {
  param: { topicID: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE' },
})
await client.dispose()
await transport.dispose()
```

The example trusts forwarded client addresses only from the listed proxy range.
`server.hub.grants.store` grants clients access and removes it with `revoke({ subject, pattern? })`.
`server.hub.revocation.backend` accepts issuer-signed records from Kokuin's `createRevocationRecord`.
These handles are available when their corresponding access plugins are enabled.
Revocation checks require a capability `jti` by default and look up its issuer's record at verification.

Persist the hub identity across restarts in production. The transport defaults to `/hub`.
Clients use `@enkaku/http-fetch` with the hub identity as their `serverID`.

`access.grants: true` gates `hub/*` through the grant store.
An array gates only its listed patterns and drops the default hub rules.
Supply `accessRules` for every ungated procedure you want to admit.
Those rules must not overlap the gated patterns. A broad `hub/*` rule overlaps any gated hub procedure.
An object accepts `{ patterns?, cacheTTLMs? }`, with `patterns` defaulting to `['hub/*']`.
`cacheTTLMs` configures the grant cache; `0` disables caching.
Without grant gating, the hub's default rules admit authenticated clients, subject to token checks.

`access.revocation: true` checks delegated capabilities against the persistent revocation backend.
An object also accepts `requireJTI` and Kokuin's `RevocationOptions`: `methods`, `resolver` and `cache`.
`requireJTI: false` admits capabilities without a `jti`; those capabilities cannot be revoked.
Direct authenticated calls follow the access rules.
Revoking a grant or capability does not terminate an already open `hub/v1/receive` stream.
It continues delivering ciphertext and metadata until the stream ends. Access is checked when opening a new stream.

The HTTP rate limit defaults to `{ windowMs: 60_000, limit: 600 }` per client IP.
Every RPC message counts, including acknowledgements, subscriptions, fetches and publishes.
Set `trustProxy` behind a proxy so clients do not all consume the proxy's IP budget.
Clients behind NAT share one budget. Size the limit for that traffic, or set `rateLimit: false` to disable it.
The hub's publish limits remain configurable through `rateLimits`.
HTTP server and hub resource settings share the `limits` option.

For custom composition, use `hubPlugin(params)` with `hozonDBPlugin`.
Include the matching access plugins when enabling grants or revocation.
Dependent plugins consume `KUMIAI_HUB` to read `{ registry, server, grants?, revocation? }`.
`createHubServer` registers those plugins when their `access` options are enabled.

Readiness at `/health/ready` includes the database check.
Shutdown ends HTTP streams before draining hub disposal and closing the database.
The close hook uses `limits.cleanupTimeoutMs`, defaulting to 30 seconds.

The SQL store defaults match the memory store: maximum requested retention is 30 days, and log depth is 1000 frames per topic.
Configure them with `store: { maxRetention, maxDepth }`; `Infinity` explicitly disables either bound.
`defaultRetention` defaults to `0` seconds. Periodic purge applies the age policy.
Pass `tablePrefix` to `createHubServer` to isolate tables when several hubs share one database.
An existing `HozonDB` uses its own configured prefix.

With multiple instances on one database, live push is per process.
A publish on one instance does not push to receive streams on another; clients must fetch or reconnect to discover those frames.
The default replay cache is also per process and resets on restart.
Use `replay.cache` with a shared backend when replay protection must span instances and restarts.
