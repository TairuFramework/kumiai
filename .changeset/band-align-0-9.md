---
"@kumiai/hub-server": minor
"@kumiai/hub-tunnel": minor
"@kumiai/hub-wake": minor
"@kumiai/mls-hub": minor
"@kumiai/hub-conformance": minor
---

Version-band alignment. The twelve packages in this repo share one pre-1.0 version band (same minor), so a minor landing in any of them raises the whole group together (see `AGENTS.md`). This cycle's feature intents bump `mls`, `broadcast`, `hub-protocol`, `hub-client`, `rpc`, `mls-rpc`, and `rpc-conformance`; this intent carries the remaining band members to the same minor.

Of these, `hub-server`, `mls-hub`, and `hub-conformance` migrated internal call sites and the reference `HubStore`/`HubClient` doubles to the new params-object signatures (no exported-surface change of their own); `hub-tunnel` and `hub-wake` carry no source change this cycle and rise solely to keep the band aligned.
