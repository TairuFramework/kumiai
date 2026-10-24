# Settled removal tombstones (kumiai 0.12.x patch) — design

## Intent

kokuin controller 0.2.4 carries removed management members through a settle: `snapshotOf(state)` writes
them to snapshot `u` by default, and each settled chain state exposes them as
`KeyState.tombstones: ReadonlyMap<add, MemberEntry>`. kumiai should accept that chain evidence as proof
of a removal. Then a host no longer has to capture `removalEvidence` before a settle in the normal
case.

The patch also closes two smaller items from the management-tier follow-ups:

- attest-clock attribution goes to effective members only;
- a re-check of canonical DID handling wherever kumiai reads kokuin deny or member state.

## Why now

The kubun 0.19 adoption stays root-only and dropped the `removalEvidence` capture duty, so nothing
blocks on this patch. Kubun picks it up whenever it ships. The future member tier (member `rmv`,
settles) then inherits a cheaper host contract.

## What is true today

- A settled removal is proven only by a **drop**: a same-generation `rot` whose prior chain state
  holds the member live, while the new state lacks it (`effectProofs.drops`, `memberDropIndices`).
  The proof is referenced as `{ chainIndex }`.
- A member added and removed inside one epoch was never live in any chain state, so it has no drop.
  After the settle prunes the `rmv`, only host-captured `removalEvidence` (the `rmv` closure) can
  prove it.
- Attest attribution (`registry.ts`, `clock` with `attest: true`) matches any member of the recorded
  log's head by DID. The head also holds epoch removals (`removed: true`) and denied members. The
  admission gate already refuses removed attestors, so this is defence in depth.
- On the stack's current branches, no code drops tombstones. Kubun and Sakui author no rotate or
  settle. kokuin's `createDeviceRevoke` uses `snapshotOf(head)`.

## Goals

- A remove claim may reference `{ chainIndex: i }` where chain state `i` newly holds the tombstone,
  and the claim verifies against it.
- `revokeWithProof` finds that reference by itself, so no `evidence` is needed when the settle kept
  tombstones.
- Registry proof-reference upgrades (an `{ event }` ref downgraded to `{ chainIndex }` after a settle)
  also use tombstone indices.
- Attest clocks attribute only to a member that is effective in the previous projection's fold and
  not in `removedMembers`.

## Non-goals

- No new `ProofRef` variant and no wire change.
- No band raise; this is a patch.
- `removalEvidence` is not removed. It stays as the fallback for a settle that deliberately drops a
  tombstone (`snapshotOf(state, { members: [add] })`).
- No kokuin changes.

## Anti-goals

- A 0.12.x producer must not emit a reference that a 0.12.0 receiver would refuse, in any case where
  0.12.0 itself could have produced an accepted one.
- No path may treat a tombstone as a denial. Tombstones stay incarnation-scoped (by `add`), as
  `removedMembers` already is.

## Approaches

- **A, chosen: reuse `{ chainIndex }`.** A tombstone index becomes a second source of chain proof
  for remove claims, beside drops. The wire shape is unchanged.
  - Mixed-version safety comes from the producer's preference order:
    1. an `{ event }` ref (the live `rmv`, or host evidence);
    2. a drop index;
    3. a tombstone index.
  - A 0.12.0 receiver refuses a tombstone-only ref, but that is exactly the case where 0.12.0 had no
    proof without evidence, and a host that supplies evidence still gets an `{ event }` ref.
- **B: a new `{ tombstone }` ref kind.** More explicit, but it changes the signed entry schema, and
  0.12.0 members refuse it in every case. Breaking, so not a patch.
- **C: no proof work.** Ship only the attest fix and the DID re-check. Smallest, but the host duty
  stays for the member tier.

## Decided

- **Tombstone index rule.** Index `i` (with `i ≥ 1`) is a tombstone proof for `add` when all of these
  hold:
  - `chain[i]` is a `rot`;
  - `states[i].gen === states[i-1].gen`;
  - `states[i].tombstones` has `add`;
  - `states[i-1].tombstones` lacks `add`.

  This is the first carrying state in its generation. A reset opens a generation with no tombstones
  (kokuin `RESET_HAS_TOMBSTONES`), so a later re-tombstone in a new generation gets its own index.
- **DID check.** For a tombstone proof, the claim's `member.did` must equal the tombstone's `did`
  after `normalizeDID`, the same rule as the drop branch.
- **`genFloor` still applies** to the referenced state, as for drops.
- **Same index for a drop and a tombstone.** When a member was live in the prior state and moves to
  the tombstone map in the same `rot`, the index is both a drop and a tombstone. The producer picks
  it through the drop path, which 0.12.0 accepts.
- **Changeset.** A patch for `@kumiai/mls` (and `@kumiai/mls-rpc` only if its docs or README change).
  It also carries a note that was missing from 0.12.0: a `holderGrant` on a direct (non-`cap`) leaf
  is refused with `holder-evidence-mismatch`, because 0.11 accepted it unverified.
- **Docs.** The mls README and the `removalEvidence` docs say evidence is needed only when a settle
  drops the member's tombstone.

## Left to the builder

- Where the tombstone indices live: inside `effectProofs` next to `drops`, plus an internal helper
  mirroring `memberDropIndices` for the registry upgrade.
- The exact attest predicate's shape. When the same DID has several incarnations, the effective one
  wins. When none is effective, the result is `effects-mismatch`, as today.
- The canonical DID re-check: find each place kumiai compares DIDs from kokuin deny or member state.
  Confirm that both sides go through `normalizeDID`, or that `resolveDenySet`'s canonical entries are
  used. Fix any gap in place.

## Tests that pin it

- A member added and `rmv`'d in one epoch, then settled with `snapshotOf`: `revokeWithProof` with no
  evidence builds a tombstone-indexed remove claim, and a receiver accepts it.
- The same with a settle that drops the tombstone: without evidence it fails `no-rev`; with evidence
  it succeeds and produces an `{ event }` ref.
- A member live at the prior settle, then removed and settled: the producer emits the drop index,
  which equals the tombstone index, and 0.12.0's acceptance rule passes. Assert this through the drop
  path.
- A tombstone DID mismatch is refused with `effects-mismatch`.
- A tombstone below `genFloor` is refused with `generation-floor`.
- A registry `{ event }` ref for a tombstone-only removal upgrades to `{ chainIndex }` after the
  settle.
- Attest: a removed incarnation with the same DID as a live one attributes to the live one. An
  attest from a removed-only DID is refused with `effects-mismatch`. Mutation-check the predicate.
