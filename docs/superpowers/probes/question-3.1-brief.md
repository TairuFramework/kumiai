# Probe brief — the returning-member drain, interleaved BEFORE each apply

Implementation probe in `/Users/paul/dev/yulsi/kumiai`, branch `feat/app-lane-delivery`. Do NOT switch
branches, do NOT commit. Leave changes uncommitted for review.

The riskiest question in the plan: the drain interacts with the existing commit-lane walk. **A previous
brief for this question was BLOCKED and was wrong** (details below, so you do not re-derive them). If
this approach also fights the code, report **BLOCKED** with evidence. Do not redesign it yourself.

## Context: what is already committed and true

- App-lane topics derive from the peer **anchor** `{secret, epoch}` = `protocolTopic(anchor.secret,
  anchor.epoch, name)`. The anchor sits at the **last roster change** (add OR remove) or rejoin, and is
  persisted in a **single-slot** `AnchorStore` (`packages/rpc/src/anchor.ts`), restored at construction.
- `captureAnchor()` (`peer.ts:~340`) exports the post-commit secret and persists it. Called at the
  genesis seed, the apply site in `pullCommits` (~`:929`, on `detectRosterChange(...) ||
  header?.external === true`), and the rejoin adopt in `recover()`.
- Logged events publish `retain: 'log'` (`retentionOf`, `packages/rpc/src/protocol.ts`). `fetchTopic`
  returns only log-class frames. Ephemeral events and all RPC never enter the log or the drain.
- **Hub fakes are trustworthy** — audited against the real store and `@kumiai/hub-conformance`, faithful
  on all ten properties the drain relies on. Do not re-audit.

## Established facts — do NOT re-derive, do NOT contradict without evidence

**1. The anchor is a topic-derivation secret, NOT a message key.** It names WHERE frames live and opens
nothing. Frames are sealed/opened by `crypto.wrap`/`unwrap`, bound to the handle's epoch. Retaining a
segment's anchor past the apply buys nothing — it fetches ciphertext the peer cannot open. **This is why
the previous brief was wrong**, and why the single-slot store stands. Do not propose a multi-slot store.

**2. ts-mls retains exactly 4 past epochs, and the drain must NOT lean on it.** Measured
(`docs/superpowers/probes/ts-mls-past-epoch-decrypt.md`): a state at epoch N decrypts application
messages sealed at N-1…N-4; beyond that `Cannot process message, epoch too old`. Eviction **zeroes** the
key material (structural). The window is spent by **epoch transitions, not time** — the catch-up walk
destroys the keys it would need, so a member away four commits could read and a member away a week could
not. Batching in ≤4 chunks was considered and **rejected**: it couples correctness to an undeclared
dependency default kumiai never sets. **Decrypt each frame at the epoch it was sealed at, full stop.**

**3. The fake is stricter than reality, deliberately.** `createFakeCrypto.unwrap` opens only at the
sealing epoch (`fake-crypto.ts:~88`); real MLS opens a 4-epoch window. Interleaved decryption sits
inside both, so green against the fake is correct in production. **Do not loosen the fake.**

## The exact question

Does a peer-internal per-segment drain deliver retained app frames in order under the correct per-epoch
keys, across a rotation boundary?

## Relevant spec section (verbatim, §5) — this is the design, and it was right

> **Returning (peer-internal, automatic on construct/reconnect):** walk the commit log epoch by epoch
> (deriving each `exportSecret()`), pulling **once per segment** — the run of epochs between two roster
> changes is one stable topic — to head, decrypting each frame under the epoch its MLS ciphertext names;
> at each roster-change boundary update the anchor and move to the next segment's topic.
> All members (publishers included) derive from the anchor, so a live publisher mid-segment writes the
> same topic a returning peer pulls. Delivered frames reach the host through the **existing `handlers`
> map** — no new host delivery API.

A **segment** is the run of epochs between two **roster changes** (adds included, not removals only).

## Approved approach (follow it; BLOCKED if it fights the code)

1. **The hook is BEFORE `port.processCommit`** (`peer.ts:~872`), not after it. The binding constraint is
   per-**frame-epoch**, not per-rotation: before advancing from epoch E to E+1, every frame sealed at E
   must already be decrypted, because after the apply the handle cannot open E.
2. **Pull once per segment, buffer, dispense per epoch.** At a segment's start (construction, and each
   anchor rotation) `fetchTopic` the segment's topic to head and buffer the ciphertexts in log order.
   Before each apply at epoch E, take frames from the buffer while they open under `unwrap`, deliver
   them, and stop at the first that does not — publish order is non-decreasing in seal-epoch, so each
   epoch's frames are a contiguous run at the front. On rotation the segment ends: drop the buffer, and
   the new anchor starts the next segment's pull.
3. **`unwrap` throwing is normal control flow here, not an error.** It is how a frame says "not my
   epoch". The existing lane already survives a log full of them; match that posture.
4. **Delivery goes through the existing `handlers` map**, in publish order. No new host delivery API.
5. **Document the port contract you are relying on** — `GroupCrypto.unwrap`'s doc (`crypto.ts:12-17`) is
   currently **silent** on past epochs, and that silence is the gap this question fell into. State it:
   rpc requires `unwrap` to open frames sealed at the handle's CURRENT epoch, and the drain never relies
   on past-epoch decryption (real MLS's 4-epoch window is real but must not be depended on — the walk
   spends it). Mirror it on the fake, so its strictness reads as the contract rather than an accident.

## Known residuals — do NOT close, do NOT report as surprises

- **The `processCommit`→`save` window** (from Question 2.4): a crash between them restores a stale anchor
  and misses the new segment until the next roster change. Needs the anchor in the same durable write as
  the handle; out of reach here. Accepted.
- **A laggard publisher** — a member still at epoch E writing to segment E's topic after others rotated
  past it is unreadable under any ordering or store. Inherent. Accepted; a comment naming it is welcome.
- **A fresh joiner cannot drain pre-join frames** (its ts-mls window is empty). Correct by design (§4).

## Done when (all required)

1. A test seeds logged app frames across **at least two segments separated by a roster change**, brings
   a peer up cold, and asserts the handler receives **every frame's plaintext in publish order**.
2. A test covers **several epochs inside one segment** (no roster change between them), asserting frames
   sealed at each epoch all arrive — this is what proves per-epoch decryption rather than per-segment.
3. **Mutation checks (required, paste each):** (a) move the drain to AFTER `processCommit` → a test goes
   red (this is the previous brief's design; it must not pass); (b) drain only at the anchor epoch
   instead of at each epoch in the segment → the multi-epoch test goes red. Revert both, confirm green,
   no residue.
4. Existing tests green — the whole suite. `peer-app-drain.test.ts:72` stays **skipped** (it is the next
   question); if the drain makes it pass, say so, do not un-skip it here.

## The fixture's app protocol is ephemeral

`fixtures/peer.ts:16`'s `chat/changed` has no `retain: 'log'`, so nothing it publishes enters the log and
nothing is drainable. **Add a logged procedure alongside it** — do NOT flip the existing one, which would
silently change every test that uses `chat`.

## Scope boundary

The interleaved drain ONLY. No pruned-window event (Phase 4) — if the drain finds a gap below retention,
leave a clearly-marked seam, do not design the signal. No retention default change. Do not touch
`detectRosterChange`, the external signal, `retentionOf`, or the `AnchorStore` shape.

## Conventions

`kigu:conventions` + repo `AGENTS.md`/`CLAUDE.md`. `type` not `interface`; `Array<T>`; no `any`; capital
`ID`; `#fields`; never edit `lib/`. Code/comments/tests never name plan questions or phases — state the
invariant ("a frame is opened at the epoch it was sealed at, so it is read before the handle ratchets
past it").

## Verify (repo root, paste real output)

`pnpm run build && rtk proxy pnpm run lint && pnpm test`
(`pnpm run lint` alone → eslint via the `rtk` shim; use `rtk proxy pnpm run lint`.)

## Report contract

Full report → `docs/superpowers/probes/question-3.1-report.md` (overwrite the BLOCKED one; changes with
file:line, both mutations pasted, whether the pre-apply hook was where you expected, what the buffer
costs on a long walk, surprises, concerns). Return ONLY: status, uncommitted-changes note, one-line test
summary, concerns. No full diff.
