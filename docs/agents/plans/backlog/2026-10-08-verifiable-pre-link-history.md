# Verifiable pre-link history for newly linked devices

**Priority:** backlog. Deferred from the client/messaging/e2e design (2026-10-08).

A device linked to an existing controller joins each group at its admission epoch. It cannot read
messages sent earlier, because MLS gives it no keys for earlier epochs. A sibling device could relay
the history, but the new device cannot verify what it receives.

Missing today:

- **An authenticated archive of historical membership.** To check that a relayed message's author
  was a member at that time, the new device needs past rosters, leaf keys, controller bindings and
  transcript checkpoints. No such archive exists, and a late joiner cannot rebuild it from the
  current group state.
- **Signed envelopes that survive re-sealing.** Authorship is MLS-authenticated only while a frame
  is live. A relayed message needs an application-level signature over stable content. rpc re-seals
  the same plaintext after epoch changes and rejoin resends, so the envelope must be signed before
  re-sealing and stay valid across every attempt.

Pick it up when a consumer (Kubun or messaging) needs history on new devices. Design both pieces
together; neither is useful alone.
