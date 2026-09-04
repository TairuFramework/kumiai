# Design: `GroupMLS` roster leaf identity

**Status:** approved design, ready for implementation planning
**Branch:** `feat/roster-leaf-identity`
**Milestone item:** [pre-1.0 breaking API surface](../../agents/plans/milestones/pre-1.0-breaking-api.md) →
[rpc API surface](../../agents/plans/backlog/rpc-api-surface.md), finding "`GroupMLS.rosterDIDs`
carries no leaf identity".

## Problem

`GroupMLS.rosterDIDs(): Promise<Array<string>>` (`packages/rpc/src/crypto.ts:271`) is documented as
"one entry per leaf", so a DID that holds two leaves appears twice — but nothing says *which* leaf
each entry is. There is no leaf index and no per-leaf metadata. While nothing needs to disambiguate
two leaves for the same DID, this is fine; the moment something does (a rejoin mid-fold, per-leaf
credential inspection), the return shape has to widen, and widening it is a breaking change.

Every package here is 0.x, so that break is a `minor` bump today and a `major` after 1.0. This is a
type-safety / forward-compatibility item, **not a correctness bug**: there is no filed consumer
forcing it. It is taken now because the 0.x window is the last cheap moment, and because making the
return an *object* is what lets every later per-leaf field ride in additively rather than as a
second break.

## Blast radius

Changing this port method touches three packages (plus their tests):

- **`@kumiai/rpc`** — the port declaration (`crypto.ts:271`), its re-export (`index.ts:40`), the
  sole consumer (`peer.ts:1211`, `:1229`), and doc comments that reference it (`crypto.ts:186`,
  `:258-270`).
- **`@kumiai/mls-rpc`** — the real implementation (`mls.ts:130`).
- **`@kumiai/rpc-conformance`** — the contract suite every implementation *and* every double must
  pass (`group-mls.ts:47` type row, `:313` describe block, assertions at `:223/:230/:261/:336/:454`).

Per `AGENTS.md`, a port change obliges running **both** contract suites against the real
implementation and the doubles.

## The change

### New type — `@kumiai/rpc`

Declared in `packages/rpc/src/crypto.ts`, exported from `packages/rpc/src/index.ts`:

```ts
export type RosterEntry = {
  /** Normalized short DID of the member holding this leaf. */
  did: string
  /** MLS ratchet-tree leaf index — stable for a member across their membership. */
  leafIndex: number
  /** The resolvable DID form (long form for did:peer:4, id itself for did:key). Never absent. */
  longForm: string
}
```

Rationale for an object now: an object return is open, so a later per-leaf field (credential
metadata, capability) is an **additive** change — a new optional property forces nothing on
implementors and gives consumers more. That is the whole reason to spend the break here rather than
carry `Array<string>` to 1.0. `longForm` is populated now because `GroupMember` already carries it
(`packages/mls/src/credential.ts:49-56`), so it is free real data rather than a speculative field.

### Port — `@kumiai/rpc`

`packages/rpc/src/crypto.ts`, `GroupMLS`:

```ts
// was
rosterDIDs(): Promise<Array<string>>
// now
rosterEntries(): Promise<Array<RosterEntry>>
```

The rename is taken in the same break: a method named `rosterDIDs` that returns entries is a
misnomer, and the break already rewrites every call site, so the honest name costs nothing extra.

Doc comments that describe the old method are rewritten for the new shape:

- `crypto.ts:258-270` — the `rosterEntries` doc block itself (still "one entry per leaf"; the entry
  is now `RosterEntry`, membership-only, read as a set of `did`).
- `crypto.ts:186` — the `CommitHeader.external` note that reads "`rosterDIDs` reads the same set
  before and after" → `rosterEntries`.

### Consumer + `detectRosterChange` — `@kumiai/rpc`

`detectRosterChange` (`packages/rpc/src/roster.ts:22`, exported at `index.ts:95`) **keeps its
`Array<string>` signature.** It is a pure DID-set comparison by design, and leaf identity does not
help it: a rejoin that reuses a blanked leaf index changes neither the DID set nor the leaf index,
so `CommitHeader.external` still owns rejoin detection. The two call sites in `advanceHandle`
(`peer.ts:1211`, `:1229`) extract `.did` before normalizing:

```ts
const rosterBefore = (await port.rosterEntries()).map((e) => normalizeDID(e.did))
// ...
detectRosterChange(rosterBefore, (await port.rosterEntries()).map((e) => normalizeDID(e.did)))
```

Anchor-rotation logic is otherwise unchanged. This keeps the consumer churn minimal and leaves the
`detectRosterChange` contract (and its tests) untouched.

### Real implementation — `@kumiai/mls-rpc`

`packages/mls-rpc/src/mls.ts:130`:

```ts
async rosterEntries(): Promise<Array<RosterEntry>> {
  return handle()
    .listMembers()
    .map((m) => ({ did: m.id, leafIndex: m.leafIndex, longForm: m.longForm }))
}
```

`listMembers()` returns `GroupMember` (`packages/mls/src/group-handle.ts:725`), which already
carries `id`, `leafIndex`, and `longForm` — the mapping is mechanical. The existing doc note at
`mls.ts:105` ("`rosterDIDs` reads the ratchet tree, so a leaf with an unparsable credential is
simply absent") is retitled for `rosterEntries` and still holds: an unparsable leaf is absent from
`listMembers`, so it is absent from the entries.

### Double — `@kumiai/rpc` fixtures

`packages/rpc/test/fixtures/memory-group-mls.ts` currently tracks membership as a `Set<string>` of
DIDs (`leaves`, returned by `rosterDIDs` at `:485` and by the `leaves()` accessor). To yield real
leaf indices it becomes a **leaf-slot model**:

- an index → DID map (or sparse array) of occupied leaves;
- **add** fills the lowest free index;
- **remove** blanks the index (so it is reused by the next add), matching ts-mls;
- `rosterEntries()` returns one `RosterEntry` per occupied slot, `longForm` = the DID string (the
  memory double's DIDs are self-resolving).

This is the one non-mechanical piece. It is required rather than optional because of the
test-double strictness rule: **a double may be stricter than its port, never more permissive.** A
double that synthesized insertion-order indices and never reused a slot would accept behavior the
real ts-mls-backed port does not exhibit, and could mask a real implementation that reuses indices.
Modeling lowest-free-index assignment keeps the double no more permissive than the port.

Any other fixture accessor that exposed the old string roster (`leaves()`) stays available for
tests that only care about DIDs; it reads the slot model's occupied DIDs.

### Conformance — `@kumiai/rpc-conformance`

`packages/rpc-conformance/src/group-mls.ts`:

- The port type row (`:47`) changes `rosterDIDs: () => Promise<Array<string>>` →
  `rosterEntries: () => Promise<Array<RosterEntry>>`.
- Existing membership assertions (`:223`, `:230`, `:261`, `:336`, `:454`) rekey from
  `.toContain(carol.did)` / `new Set(...)` over strings to the entry `.did`. A small local helper
  `const dids = (r: Array<RosterEntry>) => r.map((e) => e.did)` keeps them readable.
- The `describe('rosterDIDs')` block (`:313`) is renamed to `rosterEntries`. Its existing test
  ("reflects an APPLIED roster change, and only an applied one") is preserved, rekeyed to `.did`.
- **New clause** in that block asserting leaf identity: for a live roster, every entry has an
  integer `leafIndex >= 0`, `leafIndex` is unique across the roster, a given member's `leafIndex`
  is stable across a commit that does not touch that member, and every entry has a non-empty
  `longForm`.

Not asserted: reuse-after-remove of a blanked leaf index. It is a real ts-mls property, but no
consumer depends on it (the lane rotates on `CommitHeader.external`, not on leaf reuse), so testing
it is out of scope for this change. The double implements lowest-free-index assignment anyway, so
the property holds; it is simply not a conformance clause.

## Testing

- **rpc unit tests** touching the roster update to entries:
  `peer-commit-log-replay.test.ts:109` and `peer-removed-member-anchor.test.ts:73` (both read
  `rosterDIDs()` directly). `did-normalization.test.ts:61` documents the ingress normalize and its
  intent is unchanged.
- **Type-level regression:** an `expectTypeOf` assertion that `rosterEntries()` resolves to
  `Array<RosterEntry>` and that `.did` / `.leafIndex` / `.longForm` are typed.
- **Both contract suites** run against the real implementation (`@kumiai/mls-rpc`) and the double,
  per `AGENTS.md`.
- **Repo-wide type check:** this is a breaking type change, so verification is
  `turbo run test:types` across the repo, never a per-package `--filter` — a consumer package can
  hide un-migrated call sites that a filtered run reports green.
- Lint via `rtk proxy pnpm run lint` (the `rtk` shim otherwise fakes both `pnpm run lint` and
  `pnpm exec biome`); test via a forced `pnpm test` with `Cached: 0` confirmed.

## Sequencing and release

One PR, one package band `minor` bump (the twelve packages share a version band). No dependency on
any other milestone item. After merge, mark the `rosterDIDs` finding taken in
`docs/agents/plans/backlog/rpc-api-surface.md` and in the milestone index, linking a completion doc
under `docs/agents/plans/completed/`.

## Out of scope

- Any per-leaf credential object beyond `longForm` — deferred, and additive when a consumer needs
  it (the object return is what makes that free).
- Changing `detectRosterChange` to be leaf-aware — it stays a DID-set compare.
- Rejoin/leaf-reuse detection in the lane — already owned by `CommitHeader.external`.
