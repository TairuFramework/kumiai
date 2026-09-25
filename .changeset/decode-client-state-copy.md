---
"@kumiai/mls": patch
---

`decodeClientState` no longer aliases its input. ts-mls decoded secrets as views into the encoded bytes, and ratcheting zeroes consumed secrets in place, so a host that kept the bytes it restored from (a cache, or a retry after a failed transaction) found them corrupted by the next decrypt.
