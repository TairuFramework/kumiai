# Closing the two actionable security residuals

Closes the two items `docs/agents/plans/next/2026-07-16-security-residuals.md` names as actionable,
and disposes of the record around them.

- **Section 2's open question** — whether a replayed genuine external commit can steer anything —
  answered, and the answer pinned by tests plus the hub clause it rests on.
- **Section 1's item 2** — make running `rpc-conformance` an obligation stated where a host writes
  its own port, not only where the suite lives.
- **Section 1's item 1** — check Kubun's `exportSecret`. Done during design; recorded, no code.

The `ahead` storm stays open. It is not closable in this repo and is carried forward rather than
buried in a completed file.

---

## 1. The replay question

### The answer

A genuine external commit captured and re-published by the hub steers nothing. The residuals doc
guessed the right conclusion from the wrong row: it expected "classifies as history and is stepped
over". The actual path for a peer that applied the original is `fork`.

`sequenceID` is hub-assigned and "lexicographically ordered, strictly increasing"
(`packages/hub-protocol/src/types.ts:7`). Idempotency keys on `publishID`, which the replayer
supplies, so a replay is appended as a **new** entry with a **greater** sequenceID rather than folded
onto the original. Then, in `classifyCommit` (`packages/rpc/src/classify.ts`):

- A peer that applied the original holds `appliedByEpoch[E] = S₁`. The replay arrives at `epoch E <
  state.epoch` with `S₂ > S₁`, so `sequenceID < applied ? 'losing' : 'winning'` settles **`winning`**.
  `peer.ts:1199-1207` advances `reconciledHead` and continues; only `losing` sets `healRequested`.
- A peer with no record for E — restarted (the map is in-memory by design), late joiner, re-seeded —
  gets `history` and steps over it just the same.

Neither row reaches `processCommit`, so `applied.advanced` stays false, and the anchor rotation at
`peer.ts:1240` (`result.advanced && header?.external === true`) does not fire. **The app-lane topic
does not move.** That is the steer that would have mattered: a rotation the group did not ask for
walks every peer onto a new topic.

The conclusion is conditional on one property: the replay never receives a sequenceID *below* the
original's. Everything below exists to stop that condition from being an assumption.

### rpc tests

New file `packages/rpc/test/peer-commit-log-replay.test.ts`. Not added to
`peer-external-forgery.test.ts`: that file's subject is what a signature check does and does not
assert, and a replay is explicitly not a forgery — same bytes, same key, same context. It reuses that
file's fixtures (`FakeHub`, `makeMLSPeer`, `publishCommit`) and its two local helpers, `wakeLane`
(publishes a mailbox frame on the commit topic to say "read your log again" without writing to the
log) and `recoveryRequests` (counts heals actually put on the wire).

1. **A replay after the group moved on is stepped over.** Alice at epoch 1 applies Bob's genuine
   external rejoin and reaches epoch 2. Re-publish the identical commit bytes. Wake the lane.
   Assert: zero recovery requests, epoch still 2, roster unchanged, **app-lane topic unchanged**, and
   a second wake re-reads nothing — the cursor moved past the replay rather than parking on it.
2. **A peer holding no record reads it as history.** Construct a peer at epoch 2 that never applied
   the epoch-1 commit (`makeMLSPeer(..., { epoch: 2 })`) and let it walk a log holding both copies.
   Assert: no heal, no apply, cursor advances past both.
No third test. Both fork branches are already pinned at `packages/rpc/test/commit-classify.test.ts:48`
— a greater sequenceID gives `winning`, a lower one gives `losing`. What is missing there is not a
case but a link: the new file's header states that the replay's safety is the `winning` half of that
existing test, and the reason the `losing` half is not hypothetical is a non-monotonic hub store.

### The hub-conformance clause

The rpc conclusion rests on sequenceID order; this pins it at the layer that owns it. Added
to **both** suites, mirroring how the existing `sequenceIDs are lexicographically ordered across the
9 to 10 boundary` clause is carried in both:

- `packages/hub-conformance/src/index.ts` — `testHubStoreConformance`, over `HubStore`.
- `packages/hub-conformance/src/log-hub.ts` — the `LogHub` suite.

The clause: publishing an identical payload a second time with a **fresh `publishID`** never returns
a sequenceID below the original's. Stated as a floor rather than "appends a strictly greater one"
deliberately — a store that content-deduplicated and handed back the original sequenceID would also
be safe for the rpc path, and the clause should not forbid a correct implementation to describe the
one it happens to have. Both halves of the `publishID` contract stay covered by the existing
idempotency clauses; this adds only what the replay path needs.

Kubun's sqlite and postgres stores run this suite, so they inherit the check on their next bump.

## 2. The conformance obligation

Both READMEs already name the suite. `@kumiai/rpc`'s says "`@kumiai/rpc-conformance` is the contract
every implementation and every double must pass"; `@kumiai/rpc-conformance`'s opens with the rule
itself. What is missing is narrower than the residuals doc implies, and the work should match:

- **Neither port type says it.** A host writing its own `GroupCrypto` is reading
  `packages/rpc/src/crypto.ts`, not either README. Add it to the TSDoc of `GroupCrypto` (line 27) and
  `GroupMLS` (line 226): implementing the port obliges running `@kumiai/rpc-conformance` against the
  implementation.
- **`exportSecret`'s failure mode is not stated as silent.** Its TSDoc explains what per-epoch and
  domain-separated mean; it does not say that getting them wrong breaks nothing observable. Nothing
  throws, the group works, removals remove, the health monitor is quiet — the single symptom is that
  an evicted member can still name and read the app topic. Add that, at the method, as the reason the
  suite is not optional for this one.
- **`@kumiai/rpc`'s README** gains the same obligation in "The two consumer ports", beside the three
  constraints already listed there.
- **`@kumiai/rpc-conformance`'s README** gains the reciprocal pointer: which port types in
  `@kumiai/rpc` it governs, so a reader arriving from either direction finds the other. Its "Exports"
  and harness sections already cover how to wire it.

No new doc page. The obligation belongs where the implementation is being written and where the suite
is documented; a third location is a third thing to keep current.

## 3. Kubun, checked

Kubun hand-rolls the port: `kubun/packages/plugin-p2p/src/groups/group-crypto.ts` exports its own
`createGroupCrypto` over `mlsExporter` rather than delegating to `@kumiai/mls-rpc`. It is nonetheless
covered:

- It runs the suite — `testGroupCryptoConformance` at
  `kubun/packages/plugin-p2p/test/group-crypto-conformance.test.ts:215`, and `testGroupMLSConformance`
  in the sibling file.
- Its `exportSecret` passes the caller's `label` and `length` straight through to `mlsExporter`, and
  refuses `ENTRY_SEAL_LABEL` — the same refusal `@kumiai/mls-rpc` makes, with its own test.
- `test/group-crypto.test.ts` additionally runs a differential against `createReferenceGroupCrypto`
  from `@kumiai/mls-rpc`, so a divergence between the two implementations fails there.

So the concrete instance the residuals doc kept the section open for is prevention, not a live defect.
**No changes to Kubun.** This is recorded in the completed file and is not work.

## 4. Doc disposition

- `docs/agents/plans/completed/2026-07-29-security-residuals.complete.md` — records the three
  closures above, including the replay answer with its mechanism, since the mechanism is the part
  that was guessed wrong and would be guessed wrong again.
- A new `docs/agents/plans/backlog/` entry carries the still-open `ahead` storm forward: the bare
  `PrivateMessage` with a rewritten cleartext epoch, the cheaper unknown-frame-version trigger, why
  no signature check and no refusal helps, where the bound belongs (whoever gates publish
  authorization on the commit topic), and the adjacent per-drain `justifiedEpochCeiling` walk on the
  app lane.
- `docs/agents/plans/next/2026-07-16-security-residuals.md` is deleted.

## Verification

- `rpc-conformance` and `hub-conformance` both run against the real implementations and the doubles
  (`AGENTS.md`: changing a port means running both suites against both). The new hub clause must pass
  against `memoryStore` and every double standing in for a `LogHub`.
- The two new rpc tests must fail when the guard they cover is broken: flip `classifyCommit`'s branch
  comparison and confirm test 1 fails before restoring it. A replay test that passes against a broken
  classifier proves nothing.
- Full `pnpm test` with cached results forced off.
