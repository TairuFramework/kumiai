---
"@kumiai/rpc": patch
"@kumiai/mls": patch
"@kumiai/mls-rpc": patch
"@kumiai/rpc-conformance": patch
---

Persist epoch-scoped MLS handshake reservations and reuse only durable evidence of an unconsumed reservation after non-framing failures or restart. Persist consumption before journalling a returned commit. Bound same-epoch generation advances to half the ts-mls receiver window (100 by default), rejecting with HandshakeWindowError without stranding or recovery. Epoch advances reset the budget. Preserve retry progress after refused, historical or malformed CAS winners within that bound. Wipe newly derived consumed secrets on reservation persistence failure. Add an optional consumption hook alongside preparation, and read legacy client-state checkpoints conservatively while writing reservation evidence in format v3. Refuse the incompatible v2 layout and unknown versions.
