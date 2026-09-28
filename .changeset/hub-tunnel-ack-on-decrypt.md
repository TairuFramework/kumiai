---
"@kumiai/hub-tunnel": patch
---

Acknowledge a hub delivery as soon as decryption spends its receive key. A decrypted frame the tunnel cannot deliver during teardown or inbox overflow is dropped instead of being redelivered undecryptable. Drain in-flight decrypts before closing the receive iterator, with a bounded timeout and observability events for timeout and hub acknowledgment failures.
