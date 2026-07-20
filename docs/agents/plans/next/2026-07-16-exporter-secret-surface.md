# A host that hand-rolls `GroupCrypto.exportSecret` can still get the one thing wrong

## What this was, and what closed

The app-lane topic derives from the peer anchor, which is sealed from `GroupCrypto.exportSecret()` —
"an epoch-bound topic-derivation secret" (`packages/rpc/src/crypto.ts:4`). That per-epoch property is
the **only** thing that cuts a removed member off: a removed member keeps the lifelong recovery secret
and every topic ID it ever derived, and epoch numbers are a counter it can enumerate. An anchor sealed
from anything a removed member keeps rotates onto a topic it walks straight back onto.

This was filed when `@kumiai/mls` exposed no exporter surface and every host implemented that method
itself. Both of those are now false, on this branch:

- `GroupHandle.exportSecret` (`packages/mls/src/group-handle.ts:600`, added in `e33319d`) is the MLS
  exporter (RFC 9420 §8.5), documented at length with the removed-member reasoning above.
- `@kumiai/mls-rpc` wires the port to it (`packages/mls-rpc/src/crypto.ts:126`), so the ordinary path
  is right by construction rather than by care.
- The seam is watched: `rpc-conformance`'s clause *"is PER-EPOCH: the group rotates onto a different
  secret and the removed member keeps the old one"* (`packages/rpc-conformance/src/group-crypto.ts:141`)
  runs over the real `createGroupCrypto` from `packages/mls-rpc/test/ports-conformance.test.ts`.

## The residue

A host that does **not** take `@kumiai/mls-rpc` still implements `GroupCrypto` itself, and
`exportSecret` remains the one method in it whose only failure mode is silent. Nothing fails: the
group works, members talk, removals remove, the roster and epoch are right, the health monitor is
quiet. The single symptom is that an evicted member can still name and read the topic.

The seam is now watched only from inside this repo. A host's own implementation is watched only if
that host runs the conformance suite against it — and the host that would wire the bug is the host
that skips it.

## What to do about it

1. **Check Kubun's `exportSecret()`** — the concrete instance, and the reason this stays filed rather
   than being deleted with the rest. Kubun is not on this machine, so it was not checked here. If it
   already delegates to `@kumiai/mls-rpc`, this is prevention; if it hand-rolls one, it is live.
2. **Make running `rpc-conformance` the documented obligation of implementing the ports**, so a host
   that writes its own `GroupCrypto` is told, where it is writing it, that the suite is not optional.
3. Beyond that there is little left to build — the surface exists and the clause exists. What remains
   is getting hosts onto both.

## Context

Found during the app-lane delivery work, Question 2.5. See
`docs/superpowers/specs/2026-07-16-app-lane-delivery-design.md` §2 — "**Load-bearing:** the anchor must
feed the per-epoch `exportSecret()`, never the lifelong recovery secret".
