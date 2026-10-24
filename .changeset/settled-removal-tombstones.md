---
'@kumiai/mls': patch
---

`revokeWithProof` proves an incarnation removal from the settled chain when the settlement keeps the removed incarnation as a tombstone. This uses kokuin controller 0.2.4 snapshot `u`, the `snapshotOf` default. The proof keeps the existing `{ chainIndex }` reference. An epoch proof or a drop index is still preferred whenever one exists, so 0.12.0 receivers keep accepting every removal they could prove before. A 0.12.0 member refuses a tombstone-only proof, so a host may stop capturing `removalEvidence` only once every member of its lifecycle groups runs 0.12.1 or later. Evidence is still needed when a settlement drops the tombstone. As in 0.12.0, seeding a registry from a log learns no removal from tombstones alone.

Attest clocks are attributed only to an effective management member. A removed or denied incarnation sharing the issuer's DID no longer counts.

Note missing from 0.12.0: a `holderGrant` on a direct (non-chained) controller leaf is refused with `holder-evidence-mismatch`. 0.11 accepted one without verifying it. Attach holder grants only to chained leaves.
