# @kumiai/hub-tunnel

## 0.4.0

### Minor Changes

- `StoredMessage.logPosition` — the place a log-class frame occupies in its topic's log, carried
  on the push as well as the pull. Absent on mailbox frames, which have no place in any log — read
  the absence, not a falsy value.

### Patch Changes

- Updated dependencies:
  - @kumiai/hub-protocol@0.4.0

## 0.3.0

### Minor Changes

- BREAKING: the `HubLike*` types are renamed to `MailboxHub*` (`HubLike` -> `MailboxHub`, and the
  matching event types), and a new `LogHub` type is exported. The tunnel is mailbox-only by
  construction, so its publish params cannot carry the log-class CAS fields
  (`retain`/`expectedHead`/`publishID`) — a conditional publish through the tunnel is a compile
  error, not a silent degradation. `MailboxHub` and `LogHub` share a `HubBase` type for their
  common APIs, each adding its own `publish`, rather than `LogHub` deriving from `MailboxHub`.

### Patch Changes

- Updated dependencies:
  - @kumiai/hub-protocol@0.3.0
