# Blocked on ts-mls: missing exports and the stable v2 release

**Priority:** backlog — every item here waits on an upstream release. Nothing in this repo unblocks
them.
**Merged 2026-07-28** from `ts-mls-v2-stable-upgrade.md` and `peer4-mls-leaf-rotation.md`. Both were
one thing: ts-mls does not export what `@kumiai/mls` needs. Check all three items together whenever
a new ts-mls lands.

> **Relocated from enkaku** (0.18 stack split, 2026-06-30): MLS moved to `@kumiai/mls`,
> `@enkaku/token` → `@kokuin/token`. Origin/`completed/` links point at the **enkaku** repo.

## 1. The version pin

`pnpm-workspace.yaml` pins `ts-mls` at `2.0.0-rc.13` while every other catalog entry is a `^` range.
When a stable 2.0.0 releases, move to `^2.0.0` and verify no API changes between the latest RC and
stable.

As of 2026-05-27, npm `dist-tags` showed `latest: 1.6.2` and `rc: 2.0.0-rc.13` — stable not yet
released. **Re-check the dist-tags before assuming this is still true.** Keep tracking RC bumps until
stable lands.

## 2. `decryptSenderData` is not re-exported — so we reimplemented it

`packages/mls/src/sender-data.ts` reimplements RFC 9420 §6.3.2 sender-data decrypt. ts-mls
`2.0.0-rc.13` ships `decryptSenderData` but does not re-export it from the package index (the
`exports` map exposes only `.`, so deep imports are blocked). See
`../completed/2026-07-15-committer-reader.complete.md`.

On any upgrade: check whether ts-mls now re-exports `decryptSenderData` and the sender-data TLS
codecs. If so, delete `sender-data.ts` and delegate `GroupHandle`'s sender-leaf lookup to ts-mls's
own — the reimplementation exists only to route around the missing export.

## 3. `signLeafNodeUpdate` is not exported — so peer4 leaf rotation is blocked

**Predecessor:** `2026-05-27-did-peer-4-mls-auth-service.complete.md` — in the **enkaku** repo, per
the relocation note above, not this one.

### The blocker

ts-mls (as of 2026-05-27) does not export `signLeafNodeUpdate` — only `signLeafNodeCommit` and
`signLeafNodeKeyPackage`. Building a `LeafNodeUpdate` requires the same
`signWithLabel("LeafNodeTBS", ...)` operation, but the public surface omits it. Paths forward:

1. File an issue / PR upstream to expose `signLeafNodeUpdate` (and `signWithLabel`).
2. Vendor a small internal sign helper inside `@kumiai/mls`. Risk: TBS encoding tied to ts-mls
   internals; needs a version pin plus a compat test.
3. Implement rotation via Remove + Add. Loses tree-level continuity; does not work for single-member
   groups.

Defer until path 1 lands, or paths 2/3 become acceptable.

### The goal, when unblocked

Let a peer4 member rotate their identity (new keypair → new short form / longForm) without leaving
and rejoining. Today an identity change requires Remove + external rejoin; the native MLS Update
proposal is not wired for credential changes.

- **`proposeUpdate(group, newIdentity, options?)`** — wraps ts-mls's Update proposal. The new
  `LeafNode` carries `makeMLSCredential(newIdentity)` and a new signature key, signed by the old
  leaf's signature key (continuity proof at the MLS layer).
- **Capability continuity** — the old identity issues a rotation token via `@kokuin/token`'s
  `createRotationAssertion(oldIdentity, newIdentity)`. **Re-derive this against the ledger/roster
  model**: the `MemberCredential.capabilityChain` this originally extended was deleted by
  `../completed/2026-07-11-mls-permission-enforcement.complete.md`, so rotation continuity is now a
  ledger question, not a capability-chain one.
- **`processMessage`** — on receipt of an Update commit, pre-populate the cache with the new peer4
  document via `populateCacheFromCredential`. Auth service unchanged (each leaf is validated against
  its own credential). Write the new document to cache only *after* the commit's signature verifies.
- **`findMemberLeafIndex(oldID)` post-rotation** returns `undefined` (the leaf now binds to the new
  id); `findMemberLeafIndex(newID)` works as expected.

### Open questions

- Does ts-mls's Update proposal API support credential changes, or only signature-key changes? If
  only signature keys, peer4 rotation must go through Remove + Add (worse ergonomics).
- Any member, or admins only? RFC 9420 places no restriction; access control is application-defined.
  Reasonable default: any member rotates themselves, admins can rotate anyone (TBD).

### Out of scope

Identity revocation / key-compromise recovery (see `mls-roster-grants-and-revocation.md`), rotating
between peer4 and did:key, post-quantum ciphersuites.

### Test plan sketch

Single-key peer4 self-rotation (alice rotates, bob receives the Update, alice's new key signs
subsequent messages); multi-sig peer4 rotating the primary key while preserving a secondary;
concurrent rotation at one epoch (one commit wins, the other rebases); rotation across cached
resolver state.
