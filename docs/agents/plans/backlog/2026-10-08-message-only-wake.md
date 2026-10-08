# Message-only push wake

**Priority:** backlog. Deferred from the client/messaging/e2e design (2026-10-08).

Wake registration is per device DID with no topic selector, so every publication wakes offline
subscribers: messages, and also receipts and typing signals. The hub coalesces hints and rate-limits
them, which bounds the cost but still wakes a device for traffic a user never sees.

Missing today:

- **A wake-selection contract.** Per-topic or per-protocol registration, so a device asks to be
  woken by `kumiai.messaging` frames only.
- **Conformance cases for it.** Selection must follow topic rotation (app topics are per-epoch) and
  membership changes (a removed member's registration must stop matching).

Pick it up when wake volume or battery cost becomes a measured problem, or when a consumer needs
per-protocol wake.
