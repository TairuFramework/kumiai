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
  sole consumer (`peer.ts:1211`, `:1229`), doc comments that reference it (`crypto.ts:186`,
  `:258-270`), and prose references to the old name in a test comment
  (`test/did-normalization.test.ts:61`).
- **Docs** — `docs/agents/architecture.md:46` names `rosterDIDs` in prose; update to `rosterEntries`.
  (Historical `completed/` docs keep the old name as-is — they record what was true then.)
- **`@kumiai/mls-rpc`** — the real implementation (`mls.ts:130`).
- **`@kumiai/rpc-conformance`** — the contract suite every implementation *and* every double must
  pass (`group-mls.ts:47` type row, `:313` describe block, roster assertions at
  `:223/:230/:261/:327/:329/:333/:336/:339/:454`).

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
metadata, capability) is an **additive** change **only if the new field is optional** — a new
optional property forces nothing on implementors and gives consumers more; a new *required* field
would still be a break. That is the whole reason to spend the break here rather than carry
`Array<string>` to 1.0. `longForm` is populated now because `GroupMember` already carries it as a
required field (`packages/mls/src/credential.ts:64`; the type is `GroupMember` at `:49-64`), so it
is free real data rather than a speculative field.

Caveat on `longForm`: it is **never absent** (the type is `string`, and `listMembers` fills it —
see the real-impl section), but it is not *guaranteed resolvable* in one edge case: restored
persisted state can bypass the did:peer:4 validation (`group-handle.ts:662`), so a malformed legacy
leaf may carry the short form here. "Never absent" holds; "always a resolvable long form" does not.
No current consumer reads `longForm`, so this is a documented property, not a live risk.

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
carries `id`, `leafIndex`, and `longForm` — `longForm` is sourced as `parsed.longForm ?? parsed.id`
(`group-handle.ts:672`), so `m.longForm` is always a string and the mapping type-checks. It is
mechanical. The existing doc note at
`mls.ts:105` ("`rosterDIDs` reads the ratchet tree, so a leaf with an unparsable credential is
simply absent") is retitled for `rosterEntries` and still holds: an unparsable leaf is absent from
`listMembers`, so it is absent from the entries.

### Double — `@kumiai/rpc` fixtures

`packages/rpc/test/fixtures/memory-group-mls.ts` currently tracks membership as a compact
`Array<string>` of DIDs (`leaves`, `:368`), returned by `rosterDIDs` (`:485`) and the `leaves()`
accessor. To yield leaf indices it becomes a **hole-preserving leaf-slot model**:

- a sparse array (or index → DID map) of occupied leaves — **holes are preserved, never compacted**;
- **add** fills the lowest free index;
- **remove** blanks the index (so it is reused by the next add), matching ts-mls;
- `rosterEntries()` returns one `RosterEntry` per occupied slot, `leafIndex` = the slot index,
  `longForm` = the DID string (the memory double's DIDs are self-resolving).

Hole preservation is required, not optional, because of the test-double strictness rule: **a double
may be stricter than its port, never more permissive.** A compact array with `leafIndex` = array
position would shift every later member's index on a removal — indices the real ts-mls port keeps
stable — so it would accept index-reshuffling behavior the real port never exhibits. Hole-preserving
slots with lowest-free-index reuse keep the double no more permissive than the port, and make
`leafIndex` stable and reused exactly as real MLS does.

**Every roster-mutating path must preserve holes,** not only the accessor. The current double
mutates a compact array with `splice` (which shifts positions) and `push` (which appends), so all
**six** distinct roster operations convert to blank-in-place / fill-lowest-free-slot:

1. ordinary remove — `splice` at `:451`
2. ordinary add — `push` at `:457` (must become fill-lowest-free-slot, not append)
3. external-rejoin — `splice` `:465` + `push` `:467`
4. direct `evict` — `splice` at `:523`
5. self-removal — `splice` at `:597`
6. recovery adoption — `splice` `:739` + `push` `:741`

A path left on `splice`/`push` would reintroduce position-indices and break the stability the
conformance clause asserts.

**Scope decision — duplicate-DID removal is out of scope (deliberate).** The double addresses
removal by DID (`removes?: Array<string>`, `:177`) and blanks *every* slot matching that DID. Real
MLS removal is leaf-index-addressed, so it can remove *one* of two leaves a single DID holds — the
exact case `leafIndex` exists to disambiguate. The double is **not** being made faithful to that
case: doing so would rewrite its commit representation to leaf-index-addressed removal and raise the
conformance bar for every external double, for a semantic **no consumer uses today**. Justification
matches the milestone's own logic (no filed consumer), and nothing in the decision changes the port
shape or what any consumer receives — `RosterEntry` carries both `did` and `leafIndex` regardless,
and the real `mls-rpc` impl is already faithful via ts-mls. This is recorded as a **known
double-coverage gap**, to be closed (double + conformance, additive to test infra, non-breaking to
the API) when a consumer first needs duplicate-DID leaf disambiguation.

Any other fixture accessor that exposed the old string roster (`leaves()`) stays available for
tests that only care about DIDs; it reads the slot model's occupied DIDs.

### Conformance — `@kumiai/rpc-conformance`

`packages/rpc-conformance/src/group-mls.ts`:

- The port type row (`:47`) changes `rosterDIDs: () => Promise<Array<string>>` →
  `rosterEntries: () => Promise<Array<RosterEntry>>`.
- Existing membership assertions — `.toContain(carol.did)` at `:223/:230/:261/:336/:454` and the
  `new Set(...)`-over-strings comparisons at `:327/:329/:333/:339` — rekey to the entry `.did`. A
  small local helper `const dids = (r: Array<RosterEntry>) => r.map((e) => e.did)` keeps them
  readable.
- The `describe('rosterDIDs')` block (`:313`) is renamed to `rosterEntries`. Its existing test
  ("reflects an APPLIED roster change, and only an applied one") is preserved, rekeyed to `.did`.
- **New clause** in that block asserting leaf identity: for a live roster, every entry has an
  integer `leafIndex >= 0`, `leafIndex` is unique across the roster, a given member's `leafIndex`
  is stable across a commit that does not touch that member, and every entry has a non-empty
  `longForm`.

Not asserted: (a) reuse-after-remove of a blanked leaf index, and (b) that `leafIndex` identifies
the *correct* leaf through a remove/reuse cycle or when one DID holds two leaves. These are real
ts-mls properties, but no consumer depends on them (the lane rotates on `CommitHeader.external`, not
on leaf identity or reuse), and the double is deliberately not made faithful to duplicate-DID
removal (see the double section). So the suite guarantees `leafIndex` is present, unique, and stable
— not that it is the semantically correct leaf under duplicate-DID membership. That is the **known
coverage gap** the scope decision records; closing it (double + a conformance clause) is additive
and waits on a consumer. The double's lowest-free-index reuse means property (a) holds in practice;
it is simply not a conformance clause.

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
any other milestone item.

The two tracking docs that still name `rosterDIDs` — `docs/agents/plans/backlog/rpc-api-surface.md:51`
and `docs/agents/plans/milestones/pre-1.0-breaking-api.md:118` — are handled at **completion**, not
renamed as part of the change: they are struck through / marked *taken* with a link to a completion
doc under `docs/agents/plans/completed/`. This is distinct from `docs/agents/architecture.md:46`,
which is a live API reference and is renamed to `rosterEntries` in the change itself.

## Out of scope

- Any per-leaf credential object beyond `longForm` — deferred, and additive when a consumer needs
  it (the object return is what makes that free).
- Changing `detectRosterChange` to be leaf-aware — it stays a DID-set compare.
- Rejoin/leaf-reuse detection in the lane — already owned by `CommitHeader.external`.
