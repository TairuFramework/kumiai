# @kumiai/mls-hub

Key-package provisioning between `@kumiai/mls` and a kumiai hub. It decides *when* to generate,
upload, retain, and discard a last-resort key package — the mechanism for each of those already
existed and nothing decided anything.

## Why a separate package

`@kumiai/mls` is the crypto core and must not depend on transport. `@kumiai/hub-client` must not
depend on `ts-mls` — it never decodes MLS, matching the hub. So the code joining them lives above
both, exactly as `@kumiai/mls-rpc` does for `mls` × `rpc`. This package does **not** depend on
`ts-mls`.

## Exports

- `createLastResortProvisioner` — `ensureProvisioned()` and `bundles()`. Takes `identity`, `client`
  (only `uploadLastResortKeyPackage` is used), `store`, and optional `rotateWithinDays` (default 30)
  and `retainAfterExpiryDays` (default 7). Both options are validated at construction and throw on
  a non-finite value, a negative `retainAfterExpiryDays`, or a `rotateWithinDays` outside
  `0 < n < 90` — the package's own lifetime, since a window at or beyond it means every package is
  born already due for rotation and every call mints another one. `retainAfterExpiryDays: 0` is
  legal and means "prune the moment the lifetime ends".
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

`bundles()` decodes every retained record eagerly — including a retired one kept only for an old
cached invite — and throws if any of them fails to decode; it does not skip the bad record and serve
the rest. A single corrupt retired record can therefore block every join above, not just the one it
belongs to. That is a deliberate trade-off, not an oversight: a store that fails its own round-trip
contract for one record is not trusted for the live record either. See the comment on `bundles()` in
`packages/mls-hub/src/provisioner.ts`.

## ⚠️ Security: the store holds private key material

Every `LastResortRecord.privatePackage` is a secret. Store it where the host stores private keys,
never log it, and never publish it.

`createMemoryLastResortStore` loses everything on restart, which for this port is worse than it
sounds: the hub keeps serving the slot while the private half needed to use it is gone, so the owner
is silently unaddable — the exact outage a last-resort package exists to prevent. Use it in tests
and throwaway processes only.

## Two obligations this package now discharges

Both used to sit on the host, and both failed silently:

- **Retention.** A last-resort package is reusable, so its private half must survive a Welcome
  instead of being deleted as an ordinary bundle's would be. Records accumulate across rotations and
  are pruned only once the MLS lifetime plus a grace period has passed, because an inviter that
  fetched the slot before a rotation still holds the older package.
- **Rotation.** The package carries a 90-day MLS lifetime that the *inviter* enforces, so an
  unrotated slot goes full-but-dead while the hub reports success. `ensureProvisioned` replaces it
  once fewer than 30 days remain. A crash between mint and upload leaves an un-uploaded record that
  the next call resumes and finishes — but only while that record still has more than
  `rotateWithinDays` of life left; a pending record found already inside the rotation window is
  abandoned in favor of a fresh mint, rather than finishing an upload no inviter would accept anyway.

## What it does not do

Nothing replenishes the **ordinary** key-package pool. A host that only wires this leans on the
last-resort slot for every join: correct, but it forfeits forward secrecy for new members. Doing it
properly needs a pool-depth query the hub protocol does not have.

It also cannot detect hub-side loss of the slot. `ensureProvisioned` trusts its own record of a
successful upload — `uploadedAt != null` is taken as proof the hub still holds the package — and
never re-checks, because the protocol offers no way for a DID to read back its own last-resort slot.
A hub that lost the slot is therefore reported as fine until the next rotation is due, up to
`90 - rotateWithinDays` days — strictly positive, and at most 90, because `rotateWithinDays` is
constrained to `0 < n < 90` at construction. The missing self-read is the same protocol gap as the
missing pool-depth query filed in
`docs/agents/plans/next/2026-07-26-ordinary-keypackage-replenishment.md`.
