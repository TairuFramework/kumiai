# Audit: `@kumiai/mls-hub` public API surface

**Date:** 2026-08-02
**Scope:** the public surface of `@kumiai/mls-hub` — every symbol reachable from
`packages/mls-hub/src/index.ts` — ahead of the package's **first publish** in the 0.5 band release.
**Dimensions:** API shape, security of the exported storage ports, code health of the exported
paths. Not covered: test coverage, internal implementation quality beyond what the surface implies,
performance.
**Method:** single-context read of all eight source files plus the README, with two probes run
against the real package (a `tsc` assignability probe and a vitest behavioural probe). Both probes
were deleted after use; nothing in the working tree changed.

## Why this package, why now

The pre-1.0 breaking-API milestone records that `mls-hub` "postdates the 2026-07-20 audits, so its
surface has never been read for shape by either milestone"
(`../plans/milestones/pre-1.0-breaking-api.md`). It is also the only package in the repo returning
`AsyncResult`. `npm view @kumiai/mls-hub` returns 404 — the surface is currently free to reshape at
zero cost to anyone. After the 0.5 release each item below costs a consumer break.

## Summary

The surface is in good shape. It is unusually well documented, the port contracts state their
obligations explicitly, and the two things most likely to be wrong in a package like this — leaking
secret material into error messages, and exporting internal helpers — are both handled correctly
(`toRetryableOrThrow` and `attempt` are internal; `records.ts:62-64` names a ref and never the
material).

One finding is worth acting on before publish. It is not a bug in correct usage; it is a gap in
what the type system can distinguish, and the type system is the only thing standing between a host
and the misuse.

## Verified findings

### 1. The two storage ports are silently interchangeable in one direction — MEDIUM

**Closed 2026-08-02** on `fix/mls-hub-record-kind`, by the first remediation below: both record
types now carry a `kind` literal, and both callers re-check it on every read of the store. The
`@ts-expect-error` pair in `test/store-ports.test.ts` fails the build if either assignment ever
becomes legal again.

`LastResortStore` (`src/store.ts:48-52`) and `KeyPackagePoolStore` (`src/pool-store.ts:45-49`)
declare the same three methods with the same signatures. Their record types differ by exactly one
field: `LastResortRecord` (`store.ts:10-30`) is `KeyPackageRecord` (`pool-store.ts:13-25`) plus
`uploadedAt`. Because TypeScript methods are bivariant and arrays covariant, **`LastResortStore` is
assignable to `KeyPackagePoolStore`**.

Verified with a `tsc --noEmit` probe against the package's own test tsconfig. Assigning a
`LastResortStore` to a `KeyPackagePoolStore`, and passing one to `createKeyPackagePool`, produce **no
error**. The reverse direction is correctly rejected:

```
error TS2322: Type 'KeyPackagePoolStore' is not assignable to type 'LastResortStore'.
  Property 'uploadedAt' is missing in type 'KeyPackageRecord' but required in type 'LastResortRecord'.
```

So a host that implements one durable store and wires it to both — a plausible reading, given the
two ports look identical and the README shows them constructed side by side (`README.md:46-47`) —
gets no diagnostic on the wrong half.

**What follows at runtime.** The provisioner's resume path tests `candidate.uploadedAt == null`
(`provisioner.ts:164`). A pool-minted `KeyPackageRecord` has no `uploadedAt` at all, so `undefined ==
null` is true and it reads as "minted but not yet uploaded". `pickCandidate` (`provisioner.ts:98-110`)
reads only `notAfter` and `ref`, both present. Nothing else distinguishes the two record kinds.

**The default configuration contains this by an exact tie, not by design.**
`ORDINARY_KEY_PACKAGE_LIFETIME_DAYS` is 30 (`packages/mls/src/group-credential.ts:73`) and the
default `rotateWithinDays` is also 30 (`provisioner.ts:20`). The gate is
`candidate.notAfter - nowSeconds > rotateWithinDays * DAY_SECONDS` (`provisioner.ts:165`) — strictly
greater — so a freshly minted ordinary package misses by approximately zero and falls through to a
correct mint. A behavioural probe confirmed this: with defaults, the provisioner ignored two
pool-minted ordinary records and minted a proper last-resort package.

Set `rotateWithinDays` to any value below 30 and the containment is gone. The validator
(`provisioner.ts:79-87`) accepts anything finite in `0 < n < 90`, so every value from 1 to 29 is
legal and documented. With `rotateWithinDays: 7`, the same probe asserted — and passed — that the
provisioner selects a pool-minted ordinary key package, uploads it via
`uploadLastResortKeyPackage`, and returns `rotated: true`.

The consequence is an ordinary, single-use, 30-day key package installed in the hub's last-resort
slot, which is meant to hold a reusable 90-day one. The provisioner's `release()` is a deliberate
no-op (`provisioner.ts:249`), so the package is never consumed on join — the exact init-key reuse
the ordinary pool exists to remove (`pool-store.ts:8-11`).

**Remediation.** Make the two record types nominally distinct so the assignment fails at the
boundary — a branded field, a literal discriminant (`kind: 'ordinary'` / `kind: 'last-resort'`), or
a private-symbol brand on the port types. A discriminant also gives a store one honest column to
key on, and would make the `uploadedAt == null` test read a field that means what it says. Free
today; a consumer break after publish.

**Runner-up remediation, if the shapes stay identical:** at minimum, have the provisioner ignore a
record with no `uploadedAt` *property* rather than a nullish one, so a foreign record cannot enter
the resume path. That is a smaller change but leaves the two ports mutually confusable for every
other purpose.

## Secondary findings

### 2. `AsyncResult<T, HubRetryableError>` does not carry the error that actually throws — LOW/design

`ensureStocked()` (`pool.ts:52`) and `ensureProvisioned()` (`provisioner.ts:51`) are typed
`AsyncResult<…, HubRetryableError>`, but `HubRefusedError` throws straight through them
(`errors.ts:105-110`). A caller who reads the type and writes only `.isError()` handling gets an
unhandled rejection on a refusal.

Recorded as design rather than defect: the split is deliberate and the README argues it at length
(`README.md:92-98`) — a refusal needs a human, and an unhandled throw is how a host that wrote no
handler finds out. The method doc comments state it too (`pool.ts:48-50`, `provisioner.ts:46-49`).
The finding is only that the *type* is silent on it, which is the sort of thing worth settling while
the surface is free. Relevant to the open `stack-wide Result adoption` question
(`../plans/backlog/2026-07-28-stack-wide-result-adoption.md`).

### 3. The in-memory reference stores ship from the package root — LOW

`createMemoryKeyPackagePoolStore` and `createMemoryLastResortStore` are exported from
`src/index.ts:30,41` alongside the production API, while their own doc comments say "Tests and
throwaway processes only" and warn that losing them leaves the hub serving packages whose private
halves are gone (`pool-store.ts:54-56`, `store.ts:54-59`).

The repo's own convention puts doubles behind a boundary — `rpc-conformance` and `hub-conformance`
are separate packages. `package.json` declares `"exports": {".": "./lib/index.js"}` with no
subpaths, so moving these behind `@kumiai/mls-hub/memory` requires an exports-map change: additive
if done before publish, breaking after.

### 4. `BundleSource` conformance is structural but undeclared — LOW

`KeyPackagePool` (`pool.ts:39-57`) and `LastResortProvisioner` (`provisioner.ts:38-60`) both satisfy
`BundleSource` (`join.ts:18-21`), and `provisioner.ts:54-58` says a provisioner "can stand in as a
`BundleSource`" — but neither type declares the relationship. It works structurally. Declaring it
would document the contract and catch a drift in either shape. Non-breaking to add later, so it
carries no publish deadline.

## Checked and clean

- `toRetryableOrThrow` and `attempt` are internal — not re-exported from `index.ts`.
- Error messages name refs and config values, never key material (`records.ts:62-64`,
  `pool.ts:76,83,88`).
- `codeOf` (`errors.ts:92-98`) reads an arbitrary `.code` off a thrown value, but the refused set is
  `EK02`/`EK06`/`EK08` plus two `HUB_*` codes — opaque enough that a stray Node `errno` string
  cannot collide into a false refusal.
- Publish metadata: `files: ["lib/*"]`, `sideEffects: false`, MIT, `publishConfig.access: public`,
  repository directory correct.
- README (138 lines) documents the surface accurately, including the throw/return split and the
  secret-material warning. It does not mention finding 1.

## Coverage

**Audited:** all eight files under `packages/mls-hub/src/` and every symbol exported from
`index.ts`; `package.json` publish metadata; `README.md`.

**Not audited, and not claimed:** the package's test suite (7 files, ~99KB) was listed but not read,
so nothing here is a statement about coverage; internal correctness of the provisioning state
machine beyond the paths finding 1 traverses; the `@kumiai/hub-client` and `@kumiai/mls` surfaces it
depends on; performance and concurrency beyond the single-flight comments.

**Deviation from the audit skill:** the skill prescribes parallel per-unit explorer agents. This ran
in a single context at the user's standing instruction not to dispatch subagents. For a one-package
scope that is a fair trade — but it means findings rest on one reader, not several, and no
independent verifier re-derived finding 1. The two probes are the substitute, and both are
reproducible from the evidence above.
