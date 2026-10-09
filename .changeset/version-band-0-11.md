---
'@kumiai/broadcast': minor
'@kumiai/hub-client': minor
'@kumiai/hub-conformance': minor
'@kumiai/hub-http': minor
'@kumiai/hub-protocol': minor
'@kumiai/hub-server': minor
'@kumiai/hub-store': minor
'@kumiai/hub-tunnel': minor
'@kumiai/hub-wake': minor
'@kumiai/mls': minor
'@kumiai/mls-hub': minor
'@kumiai/mls-rpc': minor
'@kumiai/rpc': minor
'@kumiai/rpc-conformance': minor
---

The group moves from the 0.10 band to the 0.11 band for crash-safe control. Every publishable
package shares one meaningful version — the minor while pre-1.0, the major after — so a matched
band is a coherent set. Trailing segments still diverge freely: a package taking a patch release
on its own does not move anyone else.

This band introduces durable operation queues and outcomes, co-committed adoption writes,
Welcome obligations and epoch-based re-admission, fork-aware replay, and durable rejoin records
with explicit recovery keys. All fourteen publishable packages move together.

Recovery restores the durable rejoin record and its candidate and request key. Confirmed adoption
co-commits the required `AdoptionWrite` with MLS state; binding, lapse and floor refusals retry
renewal within the same recovery attempt and original deadline.
