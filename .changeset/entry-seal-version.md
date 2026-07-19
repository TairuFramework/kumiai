---
'@kumiai/mls-rpc': minor
---

The sealed ledger-entry blob now carries a format version: `[ VERSION(1) | NONCE(24) |
CIPHERTEXT ]`, and `ENTRY_SEAL_LABEL` is exported alongside `APP_TOPIC_LABEL`.

The byte buys diagnosis, not compatibility — there is no version of this a v1 peer can read,
and a format change is a flag day whatever it says. What changes is that the failure reads as
"this blob is v2 and I speak v1" instead of an AEAD refusal indistinguishable from a wrong
epoch or a tampered frame.

**It lives inside the blob, and never in the frame header.** An unknown blob version fails the
open, which a peer survives: the commit files as poison, is stepped over, and the next frame —
framed at an epoch ahead of it — strands the peer into a rejoin that re-gathers the ledger. An
unknown frame version would fail the decode instead, before the frame is ever classified, and
a peer that steps over every frame without classifying one never learns the group moved past
it. It would report itself fully reconciled at a dead epoch, forever, with no error and no
heal.
