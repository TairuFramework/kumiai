---
"@kumiai/hub-tunnel": minor
---

BREAKING: the `HubLike*` types are renamed to `MailboxHub*` (`HubLike` → `MailboxHub`, and the matching event types), and a new `LogHub` type is exported. The tunnel is mailbox-only by construction, so its publish params cannot carry the log-class CAS fields (`retain`/`expectedHead`/`publishID`) — a conditional publish through the tunnel is a compile error, not a silent degradation.
