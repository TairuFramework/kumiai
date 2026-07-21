# @kumiai/rpc-conformance

## 0.4.0

### Minor Changes

- New package: `testGroupCryptoConformance` and `testGroupMLSConformance`, the contract suites for
  `@kumiai/rpc`'s two consumer ports, run against the test doubles and against the real
  `@kumiai/mls-rpc` implementations.

  They exist because a double that answers where its real port refuses hides a production defect
  behind a green suite. Clauses worth naming, each of which found a real divergence: `unwrap`
  consumes, so a frame opens exactly once; `exportSecret` is per-epoch, and derives different
  bytes for different labels; a commit removing the local member does not advance it and yet drops
  its own leaf; a recovery or ledger responder refuses a requester it has removed; a gather key is
  not consumed, so a requester can consider more than one responder; a tampered entry blob is
  refused rather than opened; and a key package is served once.

  The suite carries a compile-time tripwire in its callers: a reverse type assignment that fails
  the moment a contract grows a member the suite has never heard of. Without it that gap is
  invisible, because a member with no clause simply is not exercised — which is how eight of
  `GroupMLS`'s twelve members came to have no contract at all.
