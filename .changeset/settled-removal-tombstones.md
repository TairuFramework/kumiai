---
'@kumiai/mls': patch
---

`revokeWithProof` proves an incarnation removal from the settled chain when the settlement keeps the removed incarnation as a tombstone. This uses kokuin controller 0.2.4 snapshot `u`, the `snapshotOf` default. In that case hosts no longer need `removalEvidence`; it is still needed when a settlement drops the tombstone. The proof keeps the existing `{ chainIndex }` reference. A drop index or epoch proof is still preferred whenever one exists, so 0.12.0 receivers keep accepting every removal they could prove before.

Attest clocks are attributed only to an effective management member. A removed or denied incarnation sharing the issuer's DID no longer counts.

Note missing from 0.12.0: a `holderGrant` on a direct (non-chained) controller leaf is refused with `holder-evidence-mismatch`. 0.11 accepted one without verifying it. Attach holder grants only to chained leaves.
