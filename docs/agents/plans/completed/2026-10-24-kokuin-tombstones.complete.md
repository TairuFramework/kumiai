# Settled removal tombstones (kumiai 0.12.1) — complete

**Date:** 2026-10-24
**Status:** complete
**Packages:** `@kumiai/mls` (patch).
**Origin:** follow-up item 2 of the band 0.12 management tier
(`2026-10-24-management-tier.complete.md`): adopting the additions in kokuin controller 0.2.4.
Kokuin stays on 0.2.x patches by user decision.

## Goal

kokuin 0.2.4 keeps removed management members through a settle. `snapshotOf` writes them to
snapshot `u` by default, and each settled chain state exposes `KeyState.tombstones` keyed by `add`.
kumiai should accept that chain evidence as proof of a removal, so hosts need `removalEvidence` less
often.

## Key design decisions

- **Reuse `{ chainIndex }`; no wire change.** A remove claim may point at a chain state whose
  tombstone is newly added there:
  - the event is a same-generation `rot`;
  - the prior state lacks the tombstone;
  - the tombstone's DID matches the claim;
  - `genFloor` applies to the referenced state.

  A new `{ tombstone }` ref kind was rejected, because it changes the signed schema and every 0.12.0
  member would refuse it.
- **Preference order: epoch event, then drop, then tombstone.** When a member was live in a chain
  state, the same index is both a drop and a tombstone, and 0.12.0 accepts it as a drop. A 0.12.0
  member refuses a tombstone-only proof. A host may therefore stop capturing `removalEvidence` only
  once every group member runs 0.12.1 or later. Evidence is still needed when a settle drops the
  tombstone.
- **Registry seeding stays version-neutral.** When kumiai has no prior record of the controller's log
  (`claimsFor` with `recorded` undefined), it does not learn removals from tombstones. A blind review
  found that doing so would:
  - make 0.12.0 and 0.12.1 members judge the same ledger differently at seed, Welcome and restore
    (0.12.0 reads such a member as an unknown incarnation and retains its leaves);
  - throw `no-rev` for unrelated claims when a tombstone predates a reset.
- **Registry proof-ref upgrade.** After a settle, the upgrade of `{ event }` to `{ chainIndex }`
  falls back to a tombstone index, but only to one that names the removed DID.
- **Attest clocks** credit only an effective member of the recorded head. This is enforced in the
  registry fold, not only at admission. kokuin pins one key per DID, so incarnations sharing a DID
  never compete.
- **Changeset** also records something missing from 0.12.0: a `holderGrant` on a direct leaf is
  refused, because 0.11 accepted one unverified.

## Coordination

- Kubun 0.19 stays root-only and dropped `removalEvidence` capture. Kubun adopts 0.12.1 when it
  ships.
- Sakui authors no rotate or settle today. The only root-event builder in the stack, kokuin's
  `createDeviceRevoke`, keeps tombstones.

## Verification

- Repo-wide forced `turbo run test:types test:unit` passed 57 of 57 tasks, none cached: mls 1385,
  mls-rpc 294, integration 150. Biome and the version check are clean.
- Every new guard was mutation-checked: the newly added rule, the DID checks in the checker and in
  the upgrade, the registry upgrade fallback, version-neutral seeding, and attest effectiveness.
- A blind Codex review found two Important issues and one Minor issue. All were fixed.

## Follow-ons

`../backlog/2026-10-24-management-tier-residuals.md` (review notes predating this patch).
