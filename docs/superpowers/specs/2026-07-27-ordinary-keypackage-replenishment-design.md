# Ordinary key-package pool replenishment

**Date:** 2026-07-27
**Branch:** `feat/ordinary-keypackage-pool`
**Scope:** `@kumiai/mls`, `@kumiai/hub-protocol`, `@kumiai/hub-server`, `@kumiai/hub-conformance`,
`@kumiai/hub-client`, `@kumiai/mls-hub`
**Origin:** `docs/agents/plans/next/2026-07-26-ordinary-keypackage-replenishment.md`, scoped out of the
last-resort provisioning work landed 2026-07-26.

## The problem

`@kumiai/mls-hub` keeps the last-resort slot filled. Nothing keeps the ordinary pool filled. A host
that uploads once at enrolment and never again eventually serves every join from the reusable
last-resort package — correct, and the availability floor works as designed, but a reused init key
means new members do not get the forward secrecy a fresh package would give them.

A client cannot learn its own pool depth. `hub/v1/keypackage/upload` returns `{ stored }`, meaning
stored-by-this-call; consumption happens on someone else's fetch and is never reported.

### The part the origin item missed

Depth alone does not say the pool is *usable*, and a depth-only design wedges permanently.

- Ordinary bundles omit `lifetime`, so they carry ts-mls's unexported `defaultLifetime()` of roughly
  15 days (`packages/mls/src/group-credential.ts:58`). Last-resort sets 90 explicitly.
- `storeKeyPackage` rejects at the per-DID cap and **never evicts** (`memoryStore.ts:487`, default
  100). That reject-never-evict choice is deliberate, from the hub-caps DoS work.
- `fetchKeyPackages` is FIFO (`memoryStore.ts:499`), so it serves the oldest — nearest-expiry —
  entry first.
- `HubStore` has no delete for ordinary packages.

So a host topping up ~20 per lifetime accumulates dead entries against the cap and can never upload
again after roughly five rounds; and until then the hub serves expired packages that the inviter
rejects when it builds the Add.

## Design

### Expiry is carried on upload

`hub/v1/keypackage/upload` gains an optional `notAfter` — an integer of seconds, one value for the
whole batch, since a batch is minted together and shares a lifetime. Absent means "no expiry known":
never pruned, counts against the cap, exactly today's behaviour.

The hub stores opaque blobs and cannot read an MLS lifetime, so it takes the uploader's word. That
trust shape has precedent in this same procedure: the `lastResort` flag is likewise taken on the
uploader's word, and lying only harms the uploader's own DID — here, under-reporting expiry evicts
your own live packages and over-reporting keeps your own dead ones.

Sending `notAfter` together with `lastResort: true` is an `invalidPayload` error, raised beside the
existing arity check. The slot's staleness is handled by rotation, and a hub refusing to serve an
expired slot on its own clock would deny the availability floor over clock skew.

### `HubStore` learns expiry

`storeKeyPackage(ownerDID, keyPackage, notAfter?)` gains a third parameter, and the port documents in
MUST language:

- an entry whose `notAfter` has passed MUST NOT be served by `fetchKeyPackages`, MUST NOT be counted
  by `countKeyPackages`, and MUST NOT charge the per-owner cap
- an entry with no `notAfter` never expires

That closes both halves: the wedge, and FIFO serving the nearest-expiry entry first.

New method `countKeyPackages(ownerDID): Promise<number>` — live entries only.

### `hub/v1/keypackage/status`

Empty param object. **No `did` field exists**, so the reconnaissance channel the origin item warned
about — a query telling an attacker exactly when a drain has succeeded — is closed by construction
rather than by an authorization rule that a later edit could relax.

Result `{ count: integer, lastResort: string | null }`. The handler derives the DID from the session,
calls `authorize({ action: 'keypackage/status', did })`, charges the existing `perDID` limiter as
upload does, then calls `countKeyPackages` and `fetchLastResortKeyPackage`.

`lastResort` is a digest, not a boolean: a boolean detects a hub that lost the slot, a digest also
detects a hub holding a package that is not the one the provisioner believes it uploaded.

`@kumiai/hub-protocol` exports `keyPackageDigest(stored: string): Promise<string>` — SHA-256 over the
stored string's UTF-8 bytes, base64url. Computed in the handler rather than in the store, so no store
implementation can drift from the definition and every one gets it for free.

Two things to verify during planning rather than assume: that the enkaku schema layer accepts a
nullable result field (`type: ['string', 'null']`), and whether `@kumiai/hub-protocol` already has a
crypto import path or gains its first Web Crypto use.

### `@kumiai/mls`: two additions

`ORDINARY_KEY_PACKAGE_LIFETIME_DAYS = 30`, passed explicitly by `createKeyPackageBundle` and
back-dated a day for skew as `lastResortLifetime()` already does. Today the refresh cadence the whole
feature is built around lives in a dependency's private default and can shift under a patch bump. 30
sits well under ts-mls's declared 4-month `maximumTotalLifetime` and makes a weekly top-up cadence
comfortable rather than marginal.

`welcomeKeyPackageRefs(welcome): Promise<Array<string>>` — the base64 refs a Welcome's secrets name,
pairing with the existing `keyPackageRef`. Without it, bundle selection degrades to trying every
retained bundle until one decrypts. Reads a ts-mls Welcome's `secrets[].newMember`; the exact field is
a planning-step verification, with try-in-order as the fallback if it is not reachable.

### `@kumiai/mls-hub`: the pool

`KeyPackagePoolStore` has the same three methods as `LastResortStore` (`list`/`put`/`delete`,
owner-scoped, replace-by-`ref`, non-aliasing), the same MUST language, and the same strict in-memory
reference implementation. A separate port rather than a generalization of the shipped one: churning a
port that just landed buys nothing.

Its record is `LastResortRecord` **minus `uploadedAt`**, and that omission is the load-bearing
difference between the two designs.

> The last-resort slot is replaced in place, so re-uploading a pending record is idempotent and
> resuming one is safe. The ordinary pool **appends** — re-uploading a record that was in fact
> uploaded before the crash puts two copies of one init key in the pool, and both get served. So a
> pending record is never resumed: `ensureStocked` abandons it and mints fresh against the deficit.
> The abandoned private half is not lost in any harmful sense — it stays in the store, so a Welcome
> naming it still resolves through `bundles()`, and expiry prunes it.

Store-before-upload still applies, for the reason the last-resort design records: the reverse order
has a crash window in which the hub serves a package whose private half was never written down.

`createKeyPackagePool({ identity, client, store, options, target = 20, lowWater = 10,
retainAfterExpiryDays = 7 })`, every numeric option range-validated at construction as the
provisioner's are.

- `ensureStocked()` reads `client.keyPackageStatus()`; when `count < lowWater` it mints
  `target - count` bundles, persists each, uploads the batch in one call carrying `notAfter`, then
  prunes records past `notAfter + retainAfterExpiryDays`. It prunes on the no-op path too, or a daily
  caller never prunes. Returns `{ minted, depth }`, where `depth` is what this call left behind — the
  count status reported plus `minted`, not a second status read. Single-flight, no internal timer, no
  clock seam.
- `bundles()` returns every retained bundle for Welcome matching, throwing on a corrupt record rather
  than skipping it, for the reason recorded on the last-resort branch.

The 7-day grace covers a Welcome built just before expiry and delivered to a recipient who was
offline; it matches the provisioner's default. An ordinary bundle is dropped on use, so the grace only
governs unused ones.

### The Welcome wrapper

A `BundleSource` is `{ bundles(); release(ref) }`. The pool's `release` deletes; the provisioner gains
a no-op `release`, so both satisfy it and a host can add its own source.

```
processWelcomeFromSources({ identity, invite, welcome, ratchetTree, options, sources })
  → { group, credential, releaseError?: Error }
```

It matches `welcomeKeyPackageRefs(welcome)` against `keyPackageRef` of each bundle each source
returns, calls `processWelcome` with the one bundle that matches, and on success releases it from the
source it came from. No match throws, naming
the refs sought — it does not quietly fall back to trying everything.

This is why the consumption signal is a wrapper and not a documented host obligation: the last-resort
completion doc's own finding was that two documented, unenforceable host obligations both failed
silently at exactly the moment they mattered. A host that forgets `drop(ref)` keeps a used single-use
private half on disk for the rest of its lifetime, weakening the forward secrecy this feature exists
to restore.

A `release` that fails does not fail the join: the group is returned with `releaseError` set. That is
the separate-diagnostic-channel shape the last-resort work settled on — surface the failure, never
narrow silently.

### The sibling gap: reading back the last-resort slot

`ensureProvisioned()` gains a status read and compares `lastResort` against
`keyPackageDigest` of its own live record. A mismatch or `null` re-uploads that record, reported as
`rotated: true` since the slot was written by the call. Re-uploading is safe here precisely because
the slot replaces in place — the property the ordinary pool lacks.

This widens `client` from `Pick<HubClient, 'uploadLastResortKeyPackage'>` to include
`keyPackageStatus`, which breaks only a host passing a hand-made client object.

## Testing

`hub-conformance` gains the clauses that are the real specification of the expiry decision: an entry
past `notAfter` is not served, not counted, and does not charge the cap; an entry with no `notAfter`
never expires; `countKeyPackages` is owner-scoped. Only `hub-server`'s `memoryStore` runs the suite
today, so that is where they land.

Per package:

- **`mls`** — pin the lifetime in *seconds*, asserting the 30-day delta explicitly. An unpinned unit
  on `notAfter` was a real finding on the last-resort branch: a milliseconds regression would have
  disabled rotation forever with every test still green. `welcomeKeyPackageRefs` against a real
  Welcome.
- **`hub-protocol`** — schema round-trip for the new procedure and for `notAfter`; `keyPackageDigest`
  against a fixed vector.
- **`hub-server`** — status derives the DID from the session, calls the authorize hook with the new
  action, charges the rate limiter, and returns a digest equal to the helper's output;
  `notAfter` with `lastResort: true` is `invalidPayload`.
- **`hub-client`** — `keyPackageStatus`.
- **`mls-hub`** — pool option range validation; `ensureStocked` no-ops above `lowWater`, mints exactly
  the deficit, persists before uploading (asserted with a store that throws on `put`), and **abandons
  a pending record rather than resuming it**, asserted as "no second upload of that ref"; prune
  arithmetic with pinned units; `bundles()` ordering and its throw on a corrupt record;
  `processWelcomeFromSources` selects by ref, releases only from the source the bundle came from,
  retains the last-resort bundle, and surfaces `releaseError` instead of throwing.
- **End-to-end** through `packages/mls-hub/test/fixtures/hub.ts`, which drives a real `HubClient`
  against a real hub, so status, expiry and top-up are exercised over the wire rather than against a
  double.

## Sequencing

Each step leaves the tree green.

1. `mls`: lifetime constant, `welcomeKeyPackageRefs`
2. `hub-protocol`: `notAfter`, the `status` procedure, `keyPackageDigest`
3. `hub-conformance`: the new clauses — red against today's `memoryStore`, which is the point
4. `hub-server`: expiry-aware `memoryStore` and `countKeyPackages`, then the handler
5. `hub-client`: `keyPackageStatus`
6. `mls-hub`: store port and its strict in-memory reference
7. `mls-hub`: `createKeyPackagePool`
8. `mls-hub`: `processWelcomeFromSources`, provisioner `release` no-op, provisioner digest repair

## Release

Minor changesets across `mls`, `hub-protocol`, `hub-server`, `hub-conformance`, `hub-client`,
`mls-hub`. No compatibility shim: `notAfter` is optional and its absence is today's behaviour, and
pre-1.0 the group moves together.

## Out of scope

The reject-at-cap decision from the hub-caps DoS work stands — expiry removes the wedge without
touching it. No hub-side eviction, no change to fetch limits or the drain budget. `hub-tunnel` is
untouched: it has no key-package references, it moves frames rather than procedures.
