---
'@kumiai/mls': minor
---

Enforce `GroupAnchor.version` on decode. `decodeGroupAnchor` now withholds the opaque `app`
payload when an anchor's `version` is above the version this build understands
(`> CURRENT_VERSION`), returning the structural anchor (`creatorDID`, `version`) with `app`
undefined. A future-version anchor still decodes to a non-null value, so `readGroupAnchor`
returns it and a member joins the group — only the payload it provably cannot interpret is
dropped. `version <= CURRENT_VERSION` is unchanged.

Non-breaking: `CURRENT_VERSION` is the only value ever written, so no anchor in the wild carries
a higher version today. This closes the last remaining format in the repo where a version was
declared and never checked — shipping it now avoids a future fix having to forever carry a
sniffing rule for the unversioned era.

Contract this rests on, now stated on `decodeGroupAnchor`/`readGroupAnchor`: a `version` bump
means `app` semantics changed and nothing else; any future control-relevant field must go in a
new GroupContext extension type, never inside the anchor where a version-tolerant older peer
would silently ignore it.
