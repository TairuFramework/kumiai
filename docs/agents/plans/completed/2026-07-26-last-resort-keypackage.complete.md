# MLS last-resort key packages

**Status:** complete
**Date:** 2026-07-26
**Branch:** `feat/last-resort-keypackage` (14 commits from `448afbd`)
**Scope:** `@kumiai/mls`, `@kumiai/hub-protocol`, `@kumiai/hub-server`, `@kumiai/hub-conformance`,
`@kumiai/hub-client`

## Goal

Close the residual left by the key-package drain hardening of 2026-07-25 (see
`2026-07-25-hub-keypackage-subscribe-caps.complete.md`). That work made the drain *rate-bounded*,
but an authorized attacker staying within quota could still eventually empty a victim's key-package
pool, after which the victim could not be added to any group until they re-uploaded.

MLS answers this with a *last-resort* key package: one reusable by design, which a hub may serve
repeatedly without consuming it. Nothing in the stack generated or stored one.

## What was built

- **`@kumiai/mls`** — `createLastResortKeyPackageBundle` generates a key package carrying the
  `last_resort` extension. Both bundle-creation functions now share a private `buildBundle` helper.
- **`@kumiai/hub-protocol`** — an optional `lastResort` flag on `hub/v1/keypackage/upload`, and two
  new `HubStore` methods: `storeLastResortKeyPackage` and `fetchLastResortKeyPackage`.
- **`@kumiai/hub-server`** — a single-slot map per DID in `memoryStore`, and handler routing for
  both upload and fetch.
- **`@kumiai/hub-conformance`** — six contract clauses pinning the slot's behavior.
- **`@kumiai/hub-client`** — `uploadLastResortKeyPackage`.

Released as a `minor` across all five packages.

## Key design decisions

**The extension is `0x000A`, from draft-ietf-mls-extensions — not RFC 9420.** RFC 9420 defines no
such extension. `ts-mls` (2.0.0-rc.13) has no built-in support, so it is added manually as a
`CustomExtension`. It is a *KeyPackage* extension rather than a leaf-node one, so leaf capabilities
are unaffected.

**Supplying `extensions` to `generateKeyPackageWithKey` suppresses ts-mls's default GREASE.** Its
internals do `params.extensions ?? greaseExtensions(defaultGreaseConfig)`, and `defaultGreaseConfig`
is not exported — so the last-resort path re-adds grease explicitly, restating the `0.1` probability
with a comment naming its source. The ordinary path passes no `extensions` key at all (a conditional
spread, never an explicit `undefined`), so ts-mls's own default still applies.

**The hub never decodes MLS; it trusts a client-supplied flag.** The hub stores key packages as
opaque strings and cannot distinguish a `last_resort`-marked package from an ordinary one. Giving
`hub-server` a dependency on `ts-mls` to check would break the opaque-blob layering the store rests
on. Trusting the flag is sound because upload is authenticated: a client can only write to its own
DID's slot, so mislabelling an ordinary package is init-key reuse against the uploader alone —
self-harm, not a cross-DID attack.

**One slot per DID, replaced on re-upload, outside the per-DID storage cap.** A one-entry-per-DID
map cannot grow, so it needs no quota of its own; charging it against `maxKeyPackagesPerDID` would
let a full ordinary pool block the availability floor the slot exists to provide. Rotation is just
another upload.

**A fetch appends the last-resort package at most once, never padding to the requested count.**
Handing one caller two Adds sharing an init key is exactly the reuse this feature must not
introduce.

**Only the per-target drain quota falls back; the per-requester limit and the authorize hook do
not.** `maxPerTargetConsumed` bounds *consumption*, and serving the slot consumes nothing, so it
charges nothing — when that budget is spent, the fetch serves the slot alone instead of refusing. A
target with no slot is refused exactly as before. The per-requester rate limit and the authorize
hook still refuse unconditionally, or the slot would become a free channel for hammering the hub or
evading host policy.

**Two dedicated store methods rather than a widened `fetchKeyPackages`.** `fetchKeyPackages` keeps
its signature and stays purely destructive; "was this consumed?" is answered by which method was
called, not by a flag that could be misread.

## Host obligation (documented, not enforced)

`@kumiai/mls` never owns private key material — `processWelcome` takes the bundle as a parameter —
so a host **must retain the last-resort `privatePackage`** after processing a Welcome rather than
deleting it as it would an ordinary bundle. Delete it and the member becomes silently unaddable
forever, which is the very failure this feature exists to prevent. Enforcement is a doc comment on
the generator plus a `⚠️ Security` callout in the `@kumiai/mls` README; nothing in code can check it.

## A ruled-on limitation: identical bytes uploaded to both paths

A client can upload byte-identical blobs as both an ordinary package and its last-resort package,
which would put two copies of the same blob in one response through entirely correct code. This was
reviewed and judged to need no mitigation, on the following reduction:

- If the bytes carry `0x000A`, both copies *are* last-resort packages, reuse is by design, and the
  response is no worse than one client fetching the slot twice.
- If they do not, the client has mislabelled an ordinary package as last-resort — the self-harm case
  the design already accepts.

There is no third case, so the hazard collapses into two already-ruled-on outcomes. Closing it would
require the hub to decode MLS, which the layering forbids. Note also that `fetchKeyPackages(did, N)`
returns N packages all belonging to one DID, and a commit can add that DID at most once — so a
caller fetching N>1 is caching for future joins, not building N Adds in one commit.

## Verification

- Whole-branch review on the most capable model, clean after one fix wave.
- Every task's tests were mutation-checked: the implementation was deliberately broken, the matching
  test confirmed failing, then restored and the restoration proven with `git diff`.
- The feature's central claim is tested rather than assumed — one last-resort bundle joins two
  independent groups (separate creators, separate group IDs), both joins asserted.
- `turbo run test:types test:unit --force` green at branch HEAD: 40/40 tasks, `Cached: 0`. Lint clean
  over 279 files. No `ts-mls`/`@kumiai/mls` dependency in `hub-server` or `hub-protocol`.

## Things worth remembering

**`@kumiai/hub-conformance` has a live third-party consumer outside this repo.**
`kubun/packages/hub/src/hub-store.ts` is a SQL-backed `HubStore` that runs this suite. It pins
`@kumiai/hub-protocol: ^0.4.1`, so a minor bump does not auto-reach it — but the suite is a published
contract, not an internal test helper, and clauses must be written for stores that do not exist yet.

This mattered concretely: the original five clauses all passed against a plausible SQL store whose
`fetchLastResortKeyPackage` omitted an `AND is_last_resort` predicate. Under the new fallback path
that store would serve an *ordinary* package repeatedly and never consume it — init-key reuse,
reached through entirely correct handler code. A sixth clause (a DID holding ordinary packages but
no slot must read `null`) now pins it. The gap existed because the conformance clauses were written
before the fetch path that weaponized the underlying store bug; no task-scoped review could see it.

**Consumer packages resolve siblings through built `lib/`, not `src/`.** After editing
`hub-protocol` or `hub-conformance` sources, that package must be rebuilt before a consumer's tests
observe the change. Turbo handles it (`test:unit` declares `dependsOn: ["^build:js", "^build:types"]`);
a direct `pnpm --filter … exec vitest` invocation does not, and will silently test stale artifacts.

## Follow-on work

- `2026-07-26-last-resort-keypackage-provisioning.md` (next) — nothing generates or uploads a
  last-resort package automatically, so the residual stays open for any app that does not wire it by
  hand.
- `2026-07-26-hub-store-error-mapping.md` (backlog) — store errors on the fetch path reach clients
  without a wire code.

## Process note

The plan's per-step checkboxes were never ticked: execution ran through per-task briefs extracted
from the plan rather than through the plan file itself. Completion is evidenced by the branch's
commits, the per-task and whole-branch reviews, and the green suite at HEAD.
