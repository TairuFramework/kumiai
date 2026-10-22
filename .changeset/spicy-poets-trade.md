---
"@kumiai/rpc": patch
"@kumiai/mls": patch
"@kumiai/mls-rpc": patch
"@kumiai/rpc-conformance": patch
---

Reserve and persist a fresh MLS handshake sender generation before each commit build. Retry after refused, historical or malformed CAS winners without waiting for an epoch advance, and preserve generation uniqueness across restart. Add an optional preparation hook for ports whose builders do not already reserve durably, and an MLS handshake reservation API that preserves the epoch and application ratchet.
