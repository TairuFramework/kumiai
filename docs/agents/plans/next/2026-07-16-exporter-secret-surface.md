# `@kumiai/mls` exposes no exporter-secret surface

## The gap

The app-lane topic derives from the peer anchor, which is sealed from `GroupCrypto.exportSecret()` —
"an epoch-bound topic-derivation secret" (`packages/rpc/src/crypto.ts:4`). That per-epoch property is
the **only** thing that cuts a removed member off: a removed member keeps the lifelong recovery secret
and every topic ID it ever derived, and epoch numbers are counters it can enumerate. An anchor sealed
from anything a removed member keeps rotates onto a topic it walks straight back onto.

`@kumiai/mls` exposes no exporter-secret surface at all. Hosts implement `exportSecret()` themselves
against ts-mls.

Both halves of the property are now proved, in two places that never meet:

- `packages/mls/test/crypto.test.ts` — a removed member cannot produce the post-removal **exporter**
  secret (against ts-mls directly).
- `packages/rpc/test/peer-removed-blind.test.ts` — nothing a removed member holds derives the rotated
  topic (against the fake port).

Neither watches the seam between them. **A host implementing `exportSecret()` as
`exportRecoverySecret()` — or as any epoch-independent value — passes everything in this repo** and
silently ships a group whose removals cut nobody off. The rpc-side mutation for exactly that bug is
red (`carol derives the group's topic from the recovery secret, hers for life, at epoch 2`), but only
against the port; nothing constrains what a real host puts behind it.

## Why it is a footgun and not a bug

Nothing fails. The group works, members talk, removals remove — the roster is right, the epoch is right,
the health monitor is quiet. The only symptom is that an evicted member can still name and read the
topic, which no test on either side of the boundary is positioned to notice.

## Options to weigh

1. **Expose the derivation from `@kumiai/mls`** — a `exportAppSecret(handle, label, context)` or similar
   over ts-mls's `mlsExporter`, so hosts wire a function that is right by construction instead of
   implementing the one thing that must not be got wrong. Closes the seam; costs an API surface.
2. **A conformance test hosts run against their own port** — cheaper, but a host has to opt in, and one
   that would wire the bug is the one that skips it.
3. **Document the contract harder** on `GroupCrypto.exportSecret` and leave it to hosts. Weakest: the
   doc already says "epoch-bound", and the repo's own fake violated it until 2026-07-16.

Lean 1. Check Kubun's actual `exportSecret()` implementation first (`../kubun/packages/`) — if it is
already correct, this is prevention; if it is not, it is live.

## Context

Found during the app-lane delivery work, Question 2.5. See
`docs/superpowers/plans/2026-07-16-app-lane-delivery-plan.md` (Decision Log, Question 2.5) and
`docs/superpowers/specs/2026-07-16-app-lane-delivery-design.md` §2 — "**Load-bearing:** the anchor must
feed the per-epoch `exportSecret()`, never the lifelong recovery secret".
