# Automatic last-resort key-package provisioning

**Priority:** medium-high — the mechanism shipped, but nothing uses it automatically.
**Origin:** deliberately scoped out of the last-resort key-package work landed 2026-07-26; see
`docs/agents/plans/completed/2026-07-26-last-resort-keypackage.complete.md` for the design
decisions and invariants that work established.

## The gap

`@kumiai/mls` can generate a last-resort key package, the hub stores and serves it without
consuming it, and `hub-client` can upload one. Nothing decides *when* to do any of that.

Until a host wires it by hand, no DID has a last-resort package, every fetch behaves exactly as it
did before, and the drain residual the mechanism exists to close stays open in practice. The
defence is present but unarmed.

## What this needs to decide

- **Where provisioning belongs.** `mls-rpc` during identity setup is the obvious candidate, but
  that couples group-RPC to hub upload. A separate opt-in helper may layer better.
- **Rotation policy.** A last-resort package is long-lived by construction, which makes its
  lifetime a real question: MLS key packages carry a `lifetime` (not currently set explicitly by
  `createLastResortKeyPackageBundle`), and a package whose lifetime expires is rejected on Add. So
  a slot filled once and never refreshed eventually becomes as useless as an empty one — silently,
  and exactly when it is needed.
- **Retention on the host side.** The host must keep the last-resort `privatePackage` after a
  Welcome instead of deleting it as it would an ordinary bundle; delete it and the member is
  silently unaddable forever. Automatic provisioning has to provision *storage* as well as upload,
  or it makes this failure easier to hit rather than harder.
- **Replenishment of the ordinary pool.** Related and arguably the same feature: nothing tops up
  ordinary key packages either. A host that never re-uploads leans on the last-resort slot for
  every join, which works but forfeits forward secrecy for new members.

## Why it was deferred

Every question above is policy, not mechanism, and each has more than one defensible answer —
lifetime bounds, who owns the upload trigger, and how a host persists private key material are all
decisions the app layer may reasonably want to make differently. Bundling them into the mechanism
work would have meant guessing. The mechanism is complete and independently useful; this is the
policy layer on top.

## Scope

`@kumiai/mls-rpc` (or a new opt-in helper), `@kumiai/hub-client`. No hub-side change expected — the
server contract is already in place and covered by `@kumiai/hub-conformance`.
