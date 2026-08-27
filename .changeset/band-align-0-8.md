---
"@kumiai/broadcast": minor
"@kumiai/hub-client": minor
"@kumiai/hub-conformance": minor
"@kumiai/hub-server": minor
"@kumiai/hub-tunnel": minor
"@kumiai/hub-wake": minor
"@kumiai/mls": minor
"@kumiai/mls-hub": minor
"@kumiai/mls-rpc": minor
"@kumiai/rpc": minor
"@kumiai/rpc-conformance": minor
---

Align the shared pre-1.0 version band to 0.8.0. The twelve packages move as one minor band
(AGENTS.md); the `topicID` schema narrowing (`@kumiai/hub-protocol`) raises the band, so the
remaining packages take a no-op minor to keep every package on the same minor. No functional change
in these packages.
