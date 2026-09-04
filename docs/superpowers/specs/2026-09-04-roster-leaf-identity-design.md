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
  /**
   * MLS ratchet-tree leaf index. Stable *while this leaf remains present* — a commit that does not
   * remove this member does not move it. A remove-then-rejoin (external commit) MAY reassign it:
   * the rejoin takes the leftmost blank, which need not be the slot just vacated. Not a stable
   * per-member identity across a membership gap.
   */
  leafIndex: number
  /**
   * The leaf credential's long form when it carries one, else `id` (the real impl is
   * `parsed.longForm ?? parsed.id`). Never absent — but NOT a guarantee of a dereferenceable /
   * resolvable DID: it is whatever the credential holds, and for an id with no long form it is
   * just the id.
   */
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

Caveat on `longForm` — it is **never absent** but **never a resolvability guarantee**. The real
impl sources it as `parsed.longForm ?? parsed.id` (`group-handle.ts:672`): the value is the leaf's
long form only when the credential carries one, and otherwise the `id` itself. Restored persisted
state that bypasses did:peer:4 validation (`group-handle.ts:662`) is one such case; an id that
simply has no long form (did:key, or the memory double's fixture ids) is the ordinary one. So the
contract is "long form or id fallback, always a non-empty string" — not "a dereferenceable DID."
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

**Ordering is part of the contract:** `rosterEntries()` returns entries in **ascending `leafIndex`
order**. The real impl already does (`listMembers` is "ascending leaf-index order",
`group-handle.ts:705-727`) and the double does likewise, so pinning it costs nothing and spares
external implementers an unspecified decision. `detectRosterChange` is order-independent regardless
(it compares DIDs as a set), so the guarantee is for other/future consumers, not this one.

Doc comments that describe the old method are rewritten for the new shape:

- `crypto.ts:258-270` — the `rosterEntries` doc block itself (still "one entry per leaf"; the entry
  is now `RosterEntry`, membership-only, read as a set of `did`).
- `crypto.ts:186` — the `CommitHeader.external` note that reads "`rosterDIDs` reads the same set
  before and after" → `rosterEntries`.

### Consumer + `detectRosterChange` — `@kumiai/rpc`

`detectRosterChange` (`packages/rpc/src/roster.ts:22`, exported at `index.ts:95`) **keeps its
`Array<string>` signature.** It is a pure DID-set comparison by design, and leaf identity does not
help it: an external-commit rejoin by a member the roster still holds leaves the DID set unchanged,
and a leaf-index diff cannot reliably catch it either (the rejoin may reuse the vacated slot or, if
an earlier blank exists, move to that one — see the `leafIndex` note), so `CommitHeader.external`
still owns rejoin detection. The two call sites in `advanceHandle`
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

- an **index → DID map** (`Map<number, string>`) of occupied leaves — **holes are simply absent
  keys, never compacted**. Prefer the map over a native sparse `Array`: a real sparse array is a
  footgun here, because `[...arr]` materializes holes as `undefined` and `.map`/`.forEach` skip
  them, which would corrupt both `leaves()` and `rosterEntries()`.
- **add** fills the lowest free index;
- **remove** blanks the index (so it is reused by the next add), matching ts-mls;
- **`leaves()`** returns the occupied DIDs in **ascending slot-index order** (numeric sort of the
  map keys, holes filtered — not `[...map]`). The three exact-array assertions that consume it were
  traced against this model and still hold: `peer-roster-change-detect.test.ts:67`
  (`{0:bob,1:carol}` → remove carol → add dave at freed slot 1 → `['bob','dave']`), `:102`
  (`{0:bob,1:carol}` unchanged → `['bob','carol']`), `:160` (`{0:bob,1:dave}` → resync blanks slot 1
  → dave refills slot 1 → `['bob','dave']`). The `toContain`/`not.toContain` reads
  (`peer-ledger-gather.test.ts:173`, `peer-app-segment-drain.test.ts:150`, `peer-recovery.test.ts:68`)
  are order-independent.

  **Order-change note (no test breaks today):** ascending-slot order is *not* identical to the old
  compact insertion order. An ordinary add after an unrelated removal fills the freed low slot, so
  `{0:a,1:b,2:c}` → remove `b`, add `d` projects `[a,d,c]` where the old compact model gave
  `[a,c,d]`. No current exact-array assertion exercises that case; the implementer must not
  reintroduce insertion order to "fix" a test — ascending slot order is the intended contract.
- **`rosterEntries()`** returns one `RosterEntry` per occupied slot, `leafIndex` = the slot index,
  `longForm` = the DID string. That is the **id fallback**, consistent with the port contract
  (`parsed.longForm ?? parsed.id`): the double's fixture ids (`alice`, `bob`) carry no long form, so
  `longForm === did` for them — correct, not a violation.

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
- **New clause** in that block asserting leaf identity. Structural properties: every entry has an
  integer `leafIndex >= 0`, unique across the roster; entries are returned in ascending `leafIndex`
  order; a given member's `leafIndex` is stable across a commit that does **not** touch that member
  (a remove/rejoin of the member itself is explicitly excluded — it may reassign the index); every
  entry has a non-empty `longForm`.
  **Value properties** (so a conforming impl cannot return stable-but-meaningless integers like
  `100,101,102`): a freshly created `n`-member group has `leafIndex` values exactly `{0..n-1}`; and
  an add after a removal reuses the freed leaf index — remove the member at slot 1 of a `{0,1,2}`
  group, add a new DID, and the new entry has `leafIndex === 1` (RFC 9420 leftmost-blank). This is
  the ordinary different-DID reuse path, distinct from the scoped-out duplicate-DID case.
  The `longForm` check asserts presence only, **not** resolvability — the contract is
  long-form-or-id fallback, so a resolvability assertion would be false against both the double's
  fixture ids and did:key leaves.

Still **not** asserted (the scoped-out case): that `leafIndex` identifies the *correct* leaf when one
DID holds two leaves — a remove/rejoin cycle that must disambiguate *which* of a DID's leaves moved.
The double addresses removal by DID and cannot model removing one of two same-DID leaves (see the
double section), and no consumer depends on it (the lane rotates on `CommitHeader.external`, not on
leaf identity). So the suite pins `leafIndex` values and different-DID reuse, but not the
duplicate-DID semantic — the **known coverage gap** the scope decision records, closed (double +
conformance clause, additive, non-breaking) when a consumer first needs it.

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

## Adjacent fix (optional, in `@kumiai/mls`)

`packages/mls/src/group-handle.ts:713-717` (the `listMembers` doc comment) claims an external-commit
rejoin's new leaf "takes the leftmost blank — the one just blanked", asserting the member's leaf
index is unchanged. That is overstated: if an earlier blank exists, the rejoin takes *that*, moving
the member's index. The rejoin-invisibility argument the comment supports still holds via the DID
set (and `CommitHeader.external`), so this is a comment accuracy fix, not a behavior change. Worth
correcting while in this area; not required for the change, and it lives in a different package.
