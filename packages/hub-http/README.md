# @kumiai/hub-http

Production HTTP hosting for Kumiai hubs, using the Teikyo database, access and rate-limit plugins.

```ts
import { randomIdentity } from '@kokuin/token'
import { createHubServer } from '@kumiai/hub-http'

const server = await createHubServer({
  identity: randomIdentity(),
  db: './hub.sqlite',
  port: 3000,
  trustProxy: ['10.0.0.0/8'],
  access: { grants: true, revocation: true },
})

server.handleSignals()
await server.listen()
```

The example trusts forwarded client addresses only from the listed proxy range. Add a grant for
each client and procedure pattern through the Teikyo grant store. Remove it with `grantStore.revoke`.
To revoke a delegated capability, add a revocation record signed by its issuer (Kokuin
`createRevocationRecord`) through the `ACCESS_REVOCATION` backend. With revocation enabled,
capabilities need a `jti`; each verification looks up the record for that `jti` and issuer.

Persist the hub identity across restarts in production. The transport defaults to `/hub`.
Clients use `@enkaku/http-fetch` with the hub identity as their `serverID`.

`access.grants: true` gates `hub/*` through the grant store.
An array gates the listed patterns instead.
Caller access rules must not overlap those patterns.
Without grant gating, the hub's default rules admit authenticated clients, subject to token checks.

`access.revocation: true` checks delegated capabilities against the persistent revocation backend.
Capabilities must carry a `jti`.
Direct authenticated calls follow the access rules.

The HTTP rate limit defaults to `{ windowMs: 60_000, limit: 600 }` per client IP.
Set `rateLimit: false` to disable it.
The hub's publish limits remain configurable through `rateLimits`.
HTTP server and hub resource settings share the `limits` option.

For custom composition, use `hubPlugin(params)` with `hozonDBPlugin`.
Include the matching access plugins when enabling grants or revocation.
Dependent plugins consume `KUMIAI_HUB` to read `{ registry, server }`.
`createHubServer` registers those plugins when their `access` options are enabled.

Readiness at `/health/ready` includes the database check.
Shutdown ends HTTP streams before draining hub disposal and closing the database.
The close hook uses `limits.cleanupTimeoutMs`, defaulting to 30 seconds.
