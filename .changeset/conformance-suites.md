---
'@kumiai/hub-conformance': minor
'@kumiai/rpc-conformance': minor
---

Contract suites every implementation **and every double** must pass.

`@kumiai/rpc-conformance` is new: `testGroupCryptoConformance` and `testGroupMLSConformance`
for the two `@kumiai/rpc` consumer ports, run against the test doubles and against the real
`@kumiai/mls-rpc` implementations. `@kumiai/hub-conformance` gains `testLogHubConformance` and
`testMailboxHubConformance` alongside the existing store suite, so the hub-tunnel and rpc
doubles are held to the same contract as `createMemoryStore`.

They exist because a double that answers where its real port refuses hides a production defect
behind a green suite. Seven defects traced to exactly that, the worst of which made the app
lane deliver nothing at all over real MLS while 288 tests stayed green — the fake's `unwrap`
was a pure XOR where the real one spends a ratchet key.

Clauses worth naming, each of which found a real divergence: `unwrap` consumes, so a frame
opens exactly once; `exportSecret` is per-epoch, which is the whole of the removal boundary; a
commit removing the local member does not advance it and yet drops its own leaf; a recovery or
ledger responder refuses a requester it has removed; a gather key is not consumed, so a
requester can consider more than one responder; a tampered entry blob is refused rather than
opened; and a key package is served once, which is an MLS requirement no other component can
enforce.

Both suites carry a compile-time tripwire in their callers: a reverse type assignment that
fails the moment a contract grows a member the suite has never heard of. Without it that gap
is invisible, because a member with no clause simply is not exercised — which is how eight of
`GroupMLS`'s twelve members came to have no contract at all.
