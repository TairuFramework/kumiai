---
'@kumiai/mls': patch
---

`attestedTreeTime` and `leafExpiry` reuse one fold per recorded controller log instead of re-verifying every signature in it on each frame.
