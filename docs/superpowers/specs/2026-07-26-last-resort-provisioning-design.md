# Automatic last-resort key-package provisioning

**Date:** 2026-07-26
**Branch:** `feat/last-resort-provisioning`
**Origin:** `docs/agents/plans/next/2026-07-26-last-resort-keypackage-provisioning.md`
**Scope:** `@kumiai/mls` (three additions), new package `@kumiai/mls-hub`

## The problem

`@kumiai/mls` can generate a last-resort key package, the hub stores and serves it without
consuming it, and `hub-client` can upload one. **Nothing decides when to do any of that.** Until a
host wires it by hand, no DID has a last-resort package, every fetch behaves exactly as it did
before, and the key-package drain residual the mechanism exists to close stays open in practice.

Two host obligations left by that work are documented and unenforceable:

1. **Retain the last-resort `privatePackage`** after processing a Welcome instead of deleting it as
   a host correctly would an ordinary single-use bundle. Delete it and the member is silently
   unaddable forever — the exact outage the slot prevents.
2. **Re-upload before the package's MLS lifetime elapses.** The hub stores opaque bytes, cannot see
   the expiry, and goes on reporting the slot full while serving a package every inviter refuses.

Both fail silently, and precisely when the floor is needed. This work moves them from doc comments
into code a host wires once.

## Corrections to the originating `next/` item

Recorded because the item's premises shaped its framing and two of them are stale:

- **"`lifetime` not currently set explicitly by `createLastResortKeyPackageBundle`"** — false. It
  passes an explicit 90-day lifetime (`LAST_RESORT_LIFETIME_DAYS`,
  `packages/mls/src/group-credential.ts:96`), back-dated a day against clock skew. The rotation
  deadline exists; nothing enforces it.
- **"`mls-rpc` during identity setup is the obvious candidate"** — `mls-rpc` has no identity setup.
  It exports `createGroupCrypto` and `createGroupMLS` only. Nothing in the repo provisions key
  packages at all: `createKeyPackageBundle` and `uploadKeyPackages` have zero production callers,
  tests only. There is no enrolment seam to hook, so one is being created.
- **New constraint the item did not have:** the hub protocol has no pool-depth query.
  `keypackage/upload` returns `{ stored: number }`, meaning stored-by-this-call; consumption is
  invisible to the client. Demand-driven replenishment of the *ordinary* pool therefore needs a hub
  protocol addition, contradicting the item's "no hub-side change expected".

## Scope decision: last-resort only

Ordinary-pool replenishment is **out of scope** and stays in `next/`. Doing it properly needs a
`hub/v1/keypackage/status` query returning the caller's own pool depth, plus conformance clauses and
a minor release across `hub-protocol`, `hub-server`, and `hub-conformance`. Doing it blindly means
uploading into a possibly-full pool and treating `KeyPackageQuotaExceededError` as normal operation.
Neither belongs in the same change as the last-resort policy layer.

Consequence to state plainly: a host that wires only this feature and never re-uploads ordinary
packages will lean on the last-resort slot for every join, which works but forfeits forward secrecy
for new members. That is the pre-existing situation, not a regression this introduces.

## Architecture

### Why a new package

`@kumiai/mls` must not depend on transport — it is the crypto core, and a group library that
imported a hub client would invert the stack. `@kumiai/hub-client` must not depend on `ts-mls` — its
whole character is that it never decodes MLS, matching the hub, and every consumer would otherwise
pay the dependency. `@kumiai/mls-rpc`'s charter is "the `@kumiai/rpc` consumer ports implemented
over `@kumiai/mls`", and provisioning implements no rpc port.

So the code joining the two belongs above both, which is the reasoning `mls-rpc`'s own module doc
already sets out for its existence: an implementation spanning two packages goes in a third, because
putting it in either one imports a dependency that package must not have. `@kumiai/mls-hub` is that
third package for `mls` × `hub-client`.

```
@kumiai/mls-hub  ──►  @kumiai/mls        (bundle generation, all codecs)
                 ──►  @kumiai/hub-client (upload transport)
```

`mls-hub` does **not** depend on `ts-mls`. Every MLS wire form it needs is reached through
`@kumiai/mls`, which is why the codecs below are added there rather than here.

### Additions to `@kumiai/mls`

`key-package-codec.ts` already argues that leaving a canonical string form to each host is exactly
how an uploader and a fetcher come to disagree about packages already sitting in a hub. The same
argument applies to the private half now that something other than the generating process must
persist it, so the forms are decided in one place:

```ts
/** Serialize a private key package for durable storage. */
export function encodePrivateKeyPackage(privatePackage: PrivateKeyPackage): string

/** Parse a stored private key package, or null if the string is not exactly one. */
export function decodePrivateKeyPackage(encoded: string): PrivateKeyPackage | null

/** The KeyPackageRef a Welcome names, base64. */
export function keyPackageRef(keyPackage: KeyPackage, options?: GroupOptions): Promise<string>
```

`decodePrivateKeyPackage` is strict in the same three ways `decodeKeyPackage` is, and for the same
reasons:

1. `fromB64`'s throw on a bad alphabet is absorbed rather than propagated.
2. The input must be the canonical base64 of its own bytes (`toB64(bytes) === encoded`), because
   `fromB64` tolerates padding variation and trims whitespace while stores compare strings.
3. `privateKeyPackageDecoder` is called directly rather than through ts-mls's `decode()`, whose
   `dec(t, 0)?.[0]` discards the consumed length and so silently accepts trailing garbage; the
   consumed length is compared against the input length instead. Its own throw on a
   variable-length field overrunning the buffer is absorbed in a separate `try`, so the two failure
   paths stay independent.

`keyPackageRef` wraps ts-mls `makeKeyPackageRef(keyPackage, hash)` with the cipher suite's hash from
`resolveMlsContext(options)`. It is the record ID below. Using the ref rather than the encoded
package as the key keeps the ID 32 bytes rather than several hundred, and it is the value a Welcome
names — so a future "which retained bundle does this Welcome match" helper needs no migration.

### `@kumiai/mls-hub` surface

```ts
export type LastResortRecord = {
  /** keyPackageRef output — this record's ID. */
  ref: string
  /** encodeKeyPackage output: the exact string uploaded to the hub's slot. */
  keyPackage: string
  /** encodePrivateKeyPackage output. Secret. */
  privatePackage: string
  /**
   * The package's MLS lifetime notAfter, in seconds since the epoch.
   *
   * Denormalized so a SQL store can index pruning without decoding MLS. A SCHEDULING HINT ONLY —
   * nothing security-relevant reads it. An inviter validates the real lifetime inside the package
   * when it builds the Add, and that check is the authority.
   */
  notAfter: number
  /**
   * When the hub's slot was confirmed to hold this package, milliseconds; null = minted but not yet
   * uploaded.
   *
   * Only its NULLNESS is ever read — no code compares the value — so it carries a local timestamp
   * for host observability and does not need to agree with `notAfter`'s unit.
   */
  uploadedAt: number | null
}

export type LastResortStore = {
  list(ownerDID: string): Promise<Array<LastResortRecord>>
  put(ownerDID: string, record: LastResortRecord): Promise<void>
  delete(ownerDID: string, ref: string): Promise<void>
}

export type LastResortProvisionerParams = {
  identity: OwnIdentity
  /** Narrowed to the one method used, so nothing else about the client is coupled. */
  client: Pick<HubClient, 'uploadLastResortKeyPackage'>
  store: LastResortStore
  /** Passed through to createLastResortKeyPackageBundle. */
  options?: GroupOptions
  /** Rotate once the live package has less than this many days left. Default 30. */
  rotateWithinDays?: number
  /** Keep a retired record this many days past its notAfter. Default 7. */
  retainAfterExpiryDays?: number
}

export type LastResortProvisioner = {
  /**
   * `rotated` means THE HUB'S SLOT WAS WRITTEN BY THIS CALL — true both for a fresh mint and for
   * completing an interrupted upload, false when the live package was already good enough to leave
   * alone. `ref` names the package this call left in the slot.
   */
  ensureProvisioned(): Promise<{ rotated: boolean; ref: string }>
  /** Every retained bundle, `notAfter` descending, for processWelcome. */
  bundles(): Promise<Array<KeyPackageBundle>>
}

export function createLastResortProvisioner(
  params: LastResortProvisionerParams,
): LastResortProvisioner

/** In-memory LastResortStore. The strict reference implementation; loses everything on restart. */
export function createMemoryLastResortStore(): LastResortStore
```

Three surface decisions:

**Every store method takes `ownerDID`.** This matches `HubStore`, whose methods are all
owner-scoped, and it means one store safely serves a multi-identity process. It also names the
obligation a SQL implementation must honour — see the port contract below.

**`bundles()` returns all retained bundles, not the live one.** `processWelcome` takes a single
bundle, so the host tries them newest-first and takes the first that succeeds. This is not a
convenience: an inviter that fetched the slot before the last rotation holds the *previous* package,
and `fetchKeyPackages(did, N>1)` callers cache for future joins, so a Welcome arriving after a
rotation legitimately matches an older record. Retention is a set with expiry-based pruning, never a
slot.

**The clock is not injectable.** Tests drive every rotation decision by seeding `notAfter` values
directly, so there is no reason to add a seam that only tests would use.

### Port contract for `LastResortStore`

Documented on the type as MUST-language rather than pinned by a conformance package. The port is
three CRUD methods with no ordering or transactional requirement, and the provisioner tolerates
every plausible deviation except `put` followed by `list` not returning the record. What it does
*not* tolerate, and what the doc must state, are the two `WHERE owner = ?` omissions:

- `list(ownerDID)` MUST return only that owner's records. Returning another owner's leaks **private
  key material** across DIDs — strictly worse than the ordinary-package fallthrough that justified
  `hub-conformance`'s sixth clause.
- `delete(ownerDID, ref)` MUST NOT remove a record belonging to another owner, and MUST be a no-op
  for a `ref` this owner does not hold.
- `put` MUST replace a record with the same `ref` rather than duplicating it, since the second write
  of the upload sequence re-puts the same `ref` with `uploadedAt` set.

`createMemoryLastResortStore` is written as the strict reference for these rules.

Accepted cost of not shipping a conformance package: a third-party SQL implementation gets a
document, not a suite. Revisit if one appears — `kubun/packages/hub/src/hub-store.ts` is precedent
that third-party implementations of this repo's ports do appear.

## The algorithm

`ensureProvisioned()`:

All time comparisons below convert the day-valued options to seconds and compare against `notAfter`,
which is in seconds because that is the unit MLS's own `Lifetime` uses.

1. `records = await store.list(identity.id)`.
2. `candidate` = the record with the greatest `notAfter`; on a tie the lexicographically greater `ref`
   wins, so the choice is deterministic. An empty list means there is no candidate and step 5 runs.
3. If `candidate.uploadedAt == null` **and it still has more than `rotateWithinDays` of life left** →
   **upload that record's `keyPackage`**, then `put` it with `uploadedAt` set. This is the crash-retry
   path; it is why a retry does not mint.

   The lifetime half of that guard closes a hole in the recovery path. A freshly minted pending record
   has ~90 days left, comfortably outside the 30-day window, so ordinary crash-retry still resumes —
   but a process that stays down past the package's expiry would otherwise come back, upload a package
   no inviter will accept, and return `rotated: true`, telling the host the floor is in place when the
   slot is full-but-dead. That is the exact failure this feature exists to remove, so a pending record
   too stale to be worth uploading falls through to the mint in step 5 instead, and is pruned normally
   once past its grace. This can never discard a still-valid package: a pending record is always the
   newest mint and so always has the greatest `notAfter`, so if it is expired, every other record is
   too.
4. Else if `candidate.notAfter - now > rotateWithinDays` → nothing to do. Return
   `{ rotated: false, ref: candidate.ref }`.
5. Else mint and rotate:
   a. `createLastResortKeyPackageBundle(identity, options)`
   b. `put(ownerDID, { …, uploadedAt: null })`
   c. `client.uploadLastResortKeyPackage(record.keyPackage)`
   d. `put(ownerDID, { …, uploadedAt: Date.now() })`
6. Prune: `delete` every record whose `notAfter + retainAfterExpiryDays` is in the past, **except the
   record this call settled on**. Runs on *every* path including the no-op of step 4 — a host calling
   daily would otherwise never prune between rotations, which are 90 days apart — and always after
   the upload, so the store is never momentarily empty. The keep-the-settled-record exception matters
   on the step-3 path, where an interrupted record can itself be old enough to prune and must not be
   deleted immediately after being uploaded.

Return `{ rotated: true, ref }` for paths 3 and 5, `{ rotated: false }` for path 4. An expired
candidate is not a special case: `notAfter - now` is negative, so step 4 falls through to a mint.

`notAfter` is read from the generated bundle's leaf node: `KeyPackage.leafNode` is typed
`LeafNodeKeyPackage`, which always carries `lifetime`, so `publicPackage.leafNode.lifetime.notAfter`
type-checks directly with no narrowing. It is a `bigint` and the record holds a `number`.

### Persist before upload, always

The reverse order — upload, then persist — has a crash window in which the hub serves a package
whose private half was never written down. That is exactly the "silently unaddable forever" outage
the last-resort slot exists to prevent, so automatic provisioning must not be the thing that
introduces it. **This ordering is the load-bearing decision of the whole design.**

Both crash windows in the chosen order are benign:

- **Crash after 5b.** A record with `uploadedAt: null` and no hub state. The next call takes step 3
  and uploads it. Nothing minted, nothing leaked, no accumulation.
- **Crash after 5c, before 5d.** The hub holds the package; the record says otherwise. The next call
  re-uploads identical bytes. The slot is replace-on-upload, so a redundant upload is a no-op.

### Rotation constants

The shipped lifetime is 90 days. Rotating at 30 days remaining means a host calling
`ensureProvisioned` daily, weekly, or even every 60 days always rotates in time — the 60-day caller
rotates on its second call with 30 days still valid.

7-day post-expiry retention covers a Welcome from an Add built just before expiry: the inviter's
lifetime check has already passed by then, and `processWelcome` still needs the private half.

### Concurrency

Overlapping in-process calls are serialized behind a single-flight promise, so two callers produce
one rotation.

Two *processes* provisioning one DID is not prevented and needs no defence: the outcome is one
occupied slot and two retained records, both valid, no failure mode. Documented as such.

### Errors

- `client.uploadLastResortKeyPackage` rejecting propagates unchanged. The record is already durable,
  so the retry path is step 3. Never swallowed — a host that cannot reach the hub must know.
- `store.put` rejecting at 5b propagates with no hub state touched.
- `bundles()` **throws** on a record whose `privatePackage` will not decode. A store handing back
  bytes it did not round-trip is broken, and narrowing that to "you appear to have no last-resort
  package" recreates the silent-failure class this feature removes. The blast radius is contained
  because `ensureProvisioned` reads only `notAfter` and never decodes a private package — so
  rotation keeps working through a corrupt old record, and only the join path complains.

## Wire-compatibility question: settled, no code change

The originating item asked whether draft-ietf-mls-extensions requires a publisher to advertise
extension type `0x000A` in its capabilities. Read and answered:

- **draft -05**, which `0x000A` matches: `Value: 0x000A`, `Name: last_resort_key_package`,
  `Message(s): KP`, `Recommended: Y`. No sentence requires advertising it in capabilities.
- **draft -08**, current, restructured it: last_resort is no longer an extension type but an *MLS
  Component Type* — `0x0000 0004 | last_resort_key_package | KP | Y` — carried inside the
  `app_data_dictionary` extension.
- **RFC 9420 independently:** its capabilities rule binds *leaf node* extensions. last_resort is
  `Where: KP`, so the rule does not reach it. This is also why `ts-mls` checks a peer's declared
  capabilities only against leaf extensions, as the shipped branch verified.

**`controlCapabilities()` stays as it is.** Record the verified reason in the codebase where the
0x000A constant is defined.

Two things to note rather than change:

- `0x000A` remains the interoperable value today: OpenMLS `main` ships
  `ExtensionType::LastResort => 10` and skips deleting the leaf encryption keypair for a last-resort
  package in `new_from_welcome`. Draft -08's relocation is not yet what deployed implementations do.
- Under -08's shape the advertisement question **would** go live, because -08 does tell clients to
  advertise `app_data_dictionary` support in `capabilities.extensions` in their LeafNodes. Whoever
  migrates to the component form must revisit `controlCapabilities()` at the same time.

Sources: draft-ietf-mls-extensions -05 and -08 (ietf.org/archive/id/), OpenMLS
`openmls/src/extensions/mod.rs` on `main`.

## Testing

Harness follows `packages/hub-client/test/client.test.ts`: `createMemoryStore()` + `createHub()` over
`DirectTransports`, so tests run against a real hub rather than a mock client. Rotation decisions are
driven by seeding store records with computed `notAfter` values (`now + 60d` = no rotation,
`now + 10d` = rotate, `now - 30d` = prune), so no clock faking is needed for any of them.

One test is the exception, and it is not a rotation-decision test: the prune-exception test mocks
the global `Date.now` (with an offset on top of the real clock, *not* `vi.useFakeTimers()`, which
interferes with the enkaku transports the hub fixture builds) to simulate a forward clock correction
landing between the rotation check and `prune`'s own clock read. Seeded `notAfter` values cannot
express that, because the thing under test is the clock MOVING between two reads inside a single
call, not the record's position relative to a fixed now. This does not contradict "the clock is not
injectable" above: there is still no seam in the implementation, and the test reaches around it.

| # | Guard |
|---|-------|
| 1 | Empty store: mints, uploads exactly once, persists with `uploadedAt` set, `rotated: true` |
| 2 | Second call inside validity: upload count stays 1, `rotated: false`, same `ref` |
| 3 | Seeded `uploadedAt: null` record: uploads *that* `ref` and mints nothing |
| 4 | Upload rejects: record durable with `uploadedAt: null`, error propagates; the next call succeeds on the same `ref` |
| 5 | Near expiry: rotates; both records retained; `bundles()` returns 2, newest first |
| 6 | Past `notAfter + retainAfterExpiryDays`: pruned from the store |
| 7 | **Central claim** — a bundle from `bundles()`, so round-tripped through the store's string forms, joins a real group through `processWelcome` |
| 8 | The same retained bundle joins two independent groups, separate creators and separate group IDs |
| 9 | `bundles()` throws on an undecodable `privatePackage` |
| 10 | Concurrent `ensureProvisioned()` calls produce one rotation and one upload |
| 11 | `@kumiai/mls`: `decodePrivateKeyPackage` returns `null` for non-canonical base64, trailing garbage, and truncated input |
| 12 | `@kumiai/mls`: `encodePrivateKeyPackage` → `decodePrivateKeyPackage` round-trips a generated bundle's private half |

Test 7 is the one that would catch a lossy private-package codec, which is the failure this feature
could plausibly introduce and which no unit test of the codec alone would reveal. Test 8 mirrors the
shipped branch's central test at the new layer.

Every test mutation-checked: break the implementation, confirm the matching test fails, restore, and
prove the restoration with `git diff`.

## Deliverables

- `@kumiai/mls`: `encodePrivateKeyPackage`, `decodePrivateKeyPackage`, `keyPackageRef`, exported from
  `index.ts`; the verified capability-advertisement reason recorded at the `0x000A` constant; README
  note on the new codecs.
- New `packages/mls-hub`: `package.json` (following `hub-client`'s shape — `exports` with a single
  `.`, swc/tsc build scripts, `tsconfig.json` + `tsconfig.test.json` extending `@kigu/dev`),
  `src/index.ts`, `src/provisioner.ts`, `src/store.ts`, `README.md`, tests.
- Dependencies: `@kumiai/mls` and `@kumiai/hub-client` as `workspace:^`; `@kokuin/token` from the
  catalog; `@kumiai/hub-server` + `@enkaku/*` as devDependencies for the test harness.
- Changesets: `minor` for `@kumiai/mls`, and the initial release for `@kumiai/mls-hub`.
- `docs/agents/plans/next/2026-07-26-last-resort-keypackage-provisioning.md` deleted; the
  ordinary-pool replenishment residual re-filed as its own `next/` item recording the missing
  pool-depth query.

## Out of scope

- Ordinary key-package pool replenishment, and the `hub/v1/keypackage/status` query it needs.
- Any hub-side change. The server contract is already in place and covered by
  `@kumiai/hub-conformance`.
- Migrating to draft -08's component form of last_resort.
- A conformance package for `LastResortStore`.
- Matching a Welcome to a specific retained bundle. The host tries them newest-first; `keyPackageRef`
  is chosen as the record ID so that a helper can be added later without a store migration.
