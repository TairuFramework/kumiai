# @kumiai/mls-hub

Key-package provisioning between `@kumiai/mls` and a kumiai hub. It decides *when* to generate,
upload, retain, and discard both the ordinary key-package pool and the last-resort slot, and joins
from whichever of them a Welcome names — the mechanism for each of those already existed and
nothing decided anything.

## Exports

- `createKeyPackagePool` — `ensureStocked()`, `bundles()`, and `release(ref)`. Takes `identity`,
  `client` (`uploadKeyPackages` and `keyPackageStatus`), `store`, and optional `target` (default 20,
  integer `> 0`), `lowWater` (default 10, integer in `[1, target]`), and `retainAfterExpiryDays`
  (default 7, `>= 0`). `ensureStocked()` tops the hub's reported depth back up to `target` once it
  falls below `lowWater`, minting and storing each package before uploading the batch, and prunes
  retained records past their lifetime plus the grace. A record whose upload is interrupted is
  abandoned, not resumed — the pool appends, so resuming a possibly-landed upload would risk two
  copies of one init key both being served.
- `KeyPackagePoolStore`, `KeyPackageRecord` — the storage port the host implements.
- `createMemoryKeyPackagePoolStore` — the strict reference implementation. In-memory; see the
  warning below.
- `createLastResortProvisioner` — `ensureProvisioned()`, `bundles()`, and `release(ref)`. Takes
  `identity`, `client` (`uploadLastResortKeyPackage` and `keyPackageStatus`), `store`, and optional
  `rotateWithinDays` (default 30, must be `0 < n < 90`) and `retainAfterExpiryDays` (default 7, must
  be `>= 0`; zero means "prune the moment the lifetime ends"). Both are validated at construction —
  out of range they invert a guard rather than fail, so a bad value silently accumulates or destroys
  key material. Outside the rotation window, `ensureProvisioned()` reads back `keyPackageStatus()`
  and re-uploads if the hub's slot digest disagrees with the record it believes is live, rather than
  trusting `uploadedAt` alone.
- `LastResortStore`, `LastResortRecord` — the storage port the host implements.
- `createMemoryLastResortStore` — the strict reference implementation. In-memory; see the warning
  below.
- `processWelcomeFromSources` — joins a Welcome against a list of `BundleSource`s (a pool, a
  provisioner, or anything shaped like one), each queried in order. It selects the bundle the
  Welcome names by `KeyPackageRef` rather than by trial decryption, calls `processWelcome` with it,
  then releases it from whichever source it came from. One source failing to read does not abort the
  scan of the rest; both a source read failure and a release failure are reported on the result
  rather than thrown, so a storage problem never costs the caller a group it already joined.

```ts
import { createKeyPackagePool, createLastResortProvisioner, processWelcomeFromSources } from '@kumiai/mls-hub'

const pool = createKeyPackagePool({ identity, client: hubClient, store: poolStore })
const lastResort = createLastResortProvisioner({ identity, client: hubClient, store: lastResortStore })

// At startup and on whatever cadence the host already has. Idempotent and cheap when nothing is due.
await pool.ensureStocked()
await lastResort.ensureProvisioned()

// When a Welcome arrives, try the ordinary pool before the last-resort slot.
const { group } = await processWelcomeFromSources({
  identity,
  invite,
  welcome,
  ratchetTree,
  sources: [pool, lastResort],
})
```

`bundles()` throws if any retained record fails to decode, rather than skipping it and serving the
rest — so one corrupt retired record blocks every join from that source. Deliberate within a single
store: one that breaks its round-trip contract once is not trusted for its live record either.
`processWelcomeFromSources` isolates that rule per source, so a corrupt pool record cannot deny the
last-resort fallback.

## ⚠️ Security: the store holds private key material

Every `KeyPackageRecord.privatePackage` and `LastResortRecord.privatePackage` is a secret. Store it
where the host stores private keys, never log it, and never publish it.

`createMemoryKeyPackagePoolStore` and `createMemoryLastResortStore` lose everything on restart. The
hub keeps serving packages whose private halves are gone, leaving the owner silently unaddable —
the exact outage these stores exist to prevent. Tests and throwaway processes only.

## Two obligations this package now discharges

Both used to sit on the host, and both failed silently:

- **Retention.** A last-resort package is reusable, so its private half must survive a Welcome
  instead of being deleted as an ordinary bundle's would be. Records accumulate across rotations and
  are pruned only once the MLS lifetime plus a grace period has passed, because an inviter that
  fetched the slot before a rotation still holds the older package.
- **Rotation.** The package carries a 90-day MLS lifetime the *inviter* enforces, so an unrotated
  slot goes full-but-dead while the hub reports success. `ensureProvisioned` replaces it once fewer
  than 30 days remain. A crash between mint and upload leaves a pending record the next call
  resumes — unless it is already inside the rotation window, in which case it is abandoned for a
  fresh mint rather than finishing an upload no inviter would accept.
