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
  copies of one init key both being served. `ensureStocked()` returns an `AsyncResult` — see
  *Retryable and refused* below. Pruning runs on every path, including the failure paths.
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
  trusting `uploadedAt` alone. `ensureProvisioned()` returns an `AsyncResult` — see *Retryable and
  refused* below. A hub it cannot reach leaves the local record untouched, so the next call redoes
  the readback.
- `LastResortStore`, `LastResortRecord` — the storage port the host implements.
- `createMemoryLastResortStore` — the strict reference implementation. In-memory; see the warning
  below.
- `processWelcomeFromSources` — joins a Welcome against a list of `BundleSource`s (a pool, a
  provisioner, or anything shaped like one), each queried in order. It selects the bundle the
  Welcome names by `KeyPackageRef` rather than by trial decryption, calls `processWelcome` with it,
  then releases it from whichever source it came from. One source failing to read does not abort the
  scan of the rest; both a source read failure and a release failure are reported on the result
  rather than thrown, so a storage problem never costs the caller a group it already joined.
- `HubRetryableError`, `HubRefusedError`, `HubCallStage` — the two outcomes of a failed hub call.

```ts
import { createKeyPackagePool, createLastResortProvisioner, processWelcomeFromSources } from '@kumiai/mls-hub'

const pool = createKeyPackagePool({ identity, client: hubClient, store: poolStore })
const lastResort = createLastResortProvisioner({ identity, client: hubClient, store: lastResortStore })

// At startup and on whatever cadence the host already has. Idempotent and cheap when nothing is due.
// Both return an AsyncResult — awaiting `.value` re-throws a retryable failure instead of
// silently swallowing it. See *Retryable and refused* below for the isError() alternative.
await pool.ensureStocked().value
await lastResort.ensureProvisioned().value

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

## Retryable and refused

Both entry points return `AsyncResult` from `@sozai/result`. The success types are unchanged —
`{ minted, depth }` and `{ rotated, ref }` — and no field ever holds a placeholder for something the
hub never confirmed.

```ts
const result = await pool.ensureStocked()
if (result.isError()) {
  // The hub could not be reached, or answered something that clears on its own. Nothing to fix:
  // the next call re-reads the hub and self-corrects.
}
// Or, to let a failure propagate: `await pool.ensureStocked().value`
```

A `HubRefusedError` is **thrown** rather than returned. The split is by what the caller must do: an
unhandled throw is surfaced, which is right for something that needs credentials or configuration
changed; an unhandled retryable failure would surface as a crash, which is wrong for something whose
correct response is to carry on and try later. `HubRefusedError` carries `code` and `stage`, so a
host that disagrees can catch and downgrade deliberately.

Refused today: `HUB_AUTHORIZATION_DENIED`, `HUB_INVALID_PAYLOAD`, and enkaku's `EK02`, `EK06`, and
`EK08`. `EK08` is how an oversized batch fails — the upload schema caps `keyPackages` at 50 entries,
so a `target` above that never succeeds. Everything else, including `HUB_KEYPACKAGE_QUOTA` and every
transport failure, is retryable: a cap clears as packages are consumed or expire.

**Call these on a cadence, not only at startup.** The self-healing depends on it. Nothing is written
on a failure path that would suppress a later check, so a hub outage costs nothing as long as a
later call happens — but a host that provisions once at startup and never again degrades silently,
and the damage lands on whoever tries to invite the user next.

An unreachable hub costs the user nothing while it lasts: an inviter fetches key packages through
the same hub, so a top-up that fails during an outage denies nobody anything. That is why failing
startup over it would be the worse trade.

During a prolonged outage where `keyPackageStatus` succeeds but every upload keeps failing, each
call strands a fresh batch of private halves in the store. That growth is expected and bounded: the
stranded records age out at their own `notAfter` plus the retention grace, same as any other retired
record — an operator watching store size climb during an outage is not looking at a leak.

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
