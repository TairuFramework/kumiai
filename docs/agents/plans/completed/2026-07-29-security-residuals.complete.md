# Security residuals: the two actionable items, closed

**Closed 2026-07-29** on `chore/security-residuals`. Supersedes
`next/2026-07-16-security-residuals.md`, which is deleted. The one item that stayed open moved to
`backlog/2026-07-29-commit-lane-ahead-storm.md` rather than ending here — it is live work, just not
work this repo can do.

## 1. Kubun's `exportSecret`, checked

Kubun hand-rolls the port rather than delegating: `kubun/packages/plugin-p2p/src/groups/group-crypto.ts`
exports its own `createGroupCrypto` over `mlsExporter`. It is nonetheless covered, which is why this
is prevention and not a live defect:

- It runs the suite — `testGroupCryptoConformance` at
  `kubun/packages/plugin-p2p/test/group-crypto-conformance.test.ts:215`, `testGroupMLSConformance` in
  the sibling file.
- Its `exportSecret` passes the caller's `label` and `length` straight to `mlsExporter`, and refuses
  `ENTRY_SEAL_LABEL` — the same refusal `@kumiai/mls-rpc` makes, with its own test.
- `test/group-crypto.test.ts` runs a differential against `createReferenceGroupCrypto` from
  `@kumiai/mls-rpc`, so a divergence between the two implementations fails there.

No changes were made to Kubun.

## 2. The obligation, stated where a port is written

Both READMEs already named the suite as mandatory. The gap was narrower than the residuals doc
implied: neither port TYPE said it, and a host writing its own `GroupCrypto` reads
`packages/rpc/src/crypto.ts`, not a README. The obligation now sits on the `GroupCrypto` and
`GroupMLS` doc blocks, `exportSecret` states that its only failure mode is silent, and the two
READMEs point at each other.

## 3. The replay question, answered

**A genuine external commit captured and re-published steers nothing.** The residuals doc guessed
the right conclusion from the wrong row — it expected "classifies as history and is stepped over".
Recording the mechanism, because it is the part that was guessed wrong and would be guessed wrong
again:

`sequenceID` is hub-assigned and strictly increasing, and idempotency keys on `publishID`, which the
replayer supplies. So a replay is APPENDED with a greater sequenceID rather than folded onto the
original. A peer that applied the original holds `appliedByEpoch[E]`, so the replay is
`fork`/**`winning`** — `peer.ts:1199` steps over it, and only `losing` heals. A peer holding no
record for E (restarted, re-seeded, late joiner) reads `history`. Neither reaches `processCommit`,
so `applied.advanced` stays false and the rejoin rotation at `peer.ts:1240` never fires: **the
app-lane topic does not move**. That was the steer that would have mattered.

It rests on one property — a replay never lands BELOW the original — which is now a clause in both
hub-conformance suites (`a re-published payload under a fresh publishID never lands below the
original`), so Kubun's sqlite and postgres stores inherit it. `packages/rpc/test/peer-commit-log-replay.test.ts`
pins the rpc half, and `commit-classify.test.ts:48` already pinned both fork branches.

Freshness and publish-side duplicate refusal were considered and are not needed: the bound the
residuals doc would have reached for only matters if the replay could steer, and it cannot.
