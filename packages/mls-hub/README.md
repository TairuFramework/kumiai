# @kumiai/mls-hub

Key-package provisioning between `@kumiai/mls` and a kumiai hub. It decides *when* to generate,
upload, retain, and discard a last-resort key package — the mechanism for each of those already
existed and nothing decided anything.

## Exports

- `createLastResortProvisioner` — `ensureProvisioned()` and `bundles()`. Takes `identity`, `client`
  (only `uploadLastResortKeyPackage` is used), `store`, and optional `rotateWithinDays` (default 30,
  must be `0 < n < 90`) and `retainAfterExpiryDays` (default 7, must be `>= 0`; zero means "prune the
  moment the lifetime ends"). Both are validated at construction — out of range they invert a guard
  rather than fail, so a bad value silently accumulates or destroys key material.
- `LastResortStore`, `LastResortRecord` — the storage port the host implements.
- `createMemoryLastResortStore` — the strict reference implementation. In-memory; see the warning
  below.

```ts
import { createLastResortProvisioner } from '@kumiai/mls-hub'

const provisioner = createLastResortProvisioner({ identity, client: hubClient, store })

// At startup and on whatever cadence the host already has. Idempotent and cheap when nothing is due.
await provisioner.ensureProvisioned()

// When a Welcome arrives, try the retained bundles newest first.
for (const bundle of await provisioner.bundles()) {
  try {
    return await processWelcome({ identity, invite, welcome, keyPackageBundle: bundle, ratchetTree })
  } catch {
    // Not this one — an inviter may hold a package from before the last rotation.
  }
}
```

`bundles()` throws if any retained record fails to decode, rather than skipping it and serving the
rest — so one corrupt retired record blocks every join above. Deliberate: a store that breaks its
round-trip contract once is not trusted for the live record either.

## ⚠️ Security: the store holds private key material

Every `LastResortRecord.privatePackage` is a secret. Store it where the host stores private keys,
never log it, and never publish it.

`createMemoryLastResortStore` loses everything on restart. The hub keeps serving the slot while the
private half needed to use it is gone, leaving the owner silently unaddable — the exact outage a
last-resort package exists to prevent. Tests and throwaway processes only.

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

## What it does not do

Nothing replenishes the **ordinary** key-package pool. A host that only wires this leans on the
last-resort slot for every join: correct, but it forfeits forward secrecy for new members. Doing it
properly needs a pool-depth query the hub protocol does not have.

It also cannot detect hub-side loss of the slot. `ensureProvisioned` takes `uploadedAt != null` as
proof the hub still holds the package and never re-checks, because the protocol offers no way for a
DID to read back its own last-resort slot. A hub that lost the slot is reported as fine until the
next rotation is due, up to `90 - rotateWithinDays` days. Filed alongside the missing pool-depth
query in `docs/agents/plans/next/2026-07-26-ordinary-keypackage-replenishment.md`.
