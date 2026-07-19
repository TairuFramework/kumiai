---
'@kumiai/rpc': minor
---

Deliver app messages to a member that was away. Before this, an app message was lost to
anyone offline when it was sent: app topics were derived from the live epoch and app frames
were mailbox-class, so a frame nobody was subscribed for was dropped rather than retained.

- **Logged events.** A procedure declaring `retain: 'log'` publishes to a retained, pullable
  log; ephemeral events and all RPC stay on the live lane. `defineGroupProtocol` carries the
  declaration.
- **The anchor.** An app topic is derived from the secret of the epoch of the last roster
  change, not the live epoch, so it holds constant while the group talks and rotates only when
  membership changes. The anchor is persisted through the new `AnchorStore`, never re-derived:
  a member cannot export a past epoch's secret, so a restart without it partitions the peer
  from its own group.
- **The returning-member drain.** On reconnect a peer pulls each segment from its durable
  read position (`AppCursorStore`), interleaved with the commit walk and ahead of each apply,
  because a frame opens only at the epoch it was sealed at. Frames reach the host through the
  existing `handlers` map. A cursor advances only past a frame that was delivered or is dead,
  and `onAppWindowPruned` reports a retention floor that passed the read position.
- **`onReceiveEnded`** reports a push lane that ended and will not restart — the hub refused
  it, the connection dropped, or a newer channel for the same DID took it. Previously the
  drain swallowed every ending, leaving a peer that received nothing while every call kept
  succeeding. With no handler wired it is reported through `@sozai/log` at error, falling back
  to the console when logging is not configured; `onSubscribeFailed` now does the same.
- **Directed RPC opened every inbox frame twice** and was answered by nobody over real MLS:
  the acceptor and each directed client held an `unwrap` apiece and raced for one per-message
  ratchet key. There is now one open-once path per topic, shared by every consumer.

`GroupCrypto` gains `sealEntries`/`openEntries`, and `GroupMLS.readCommitHeader` also reports
`external`. A host supplying the `mls` port must now also supply `AnchorStore`,
`AppCursorStore` and `CommitJournal`; the type enforces it, because each fails silently when
absent.
