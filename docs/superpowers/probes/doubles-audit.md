# Doubles audit — are any test doubles MORE capable than the port they stand for?

Read-only probe, branch `feat/app-lane-delivery`. Nothing was edited.

**The rule audited against:** a double may be STRICTER than its port, never more permissive. A
double that refuses where the real thing allows costs a test; a double that answers where the real
thing refuses hides a production defect behind a green suite.

**Scope:** 16 doubles / fixtures / in-memory implementations across `rpc`, `hub-tunnel`,
`hub-server`, `broadcast`, `mls`.

| # | Double | Port it stands for |
|---|---|---|
| 1 | `packages/rpc/test/fixtures/fake-crypto.ts` | `GroupCrypto` (`rpc/src/crypto.ts:28`) |
| 2 | `packages/rpc/test/fixtures/memory-group-mls.ts` | `GroupMLS` (`rpc/src/crypto.ts:142`) / `GroupMLSHandle` (`mls/src/group-handle.ts`) |
| 3 | `packages/rpc/test/fixtures/fake-hub.ts` | `LogHub` (`hub-tunnel/src/transport.ts:~285`) / `HubStore` |
| 4 | `packages/rpc/test/fixtures/durable-fake-hub.ts` | `LogHub` + client-adapter redelivery |
| 5 | `packages/rpc/test/fixtures/journal.ts` | `CommitJournal` (`rpc/src/commit.ts`) |
| 6 | `packages/rpc/test/fixtures/anchor.ts` | `AnchorStore` (`rpc/src/anchor.ts`) |
| 7 | `packages/rpc/test/fixtures/app-cursor.ts` | `AppCursorStore` (`rpc/src/app-cursor.ts`) |
| 8 | `packages/rpc/test/fixtures/peer.ts` | the HOST (build closures, `adoptJournalled`, store lifetimes) |
| 9 | `packages/rpc/test/fixtures/commits.ts` | an off-stage member publishing a commit frame |
| 10 | `packages/hub-tunnel/test/fixtures/fake-hub.ts` | `MailboxHub` |
| 11 | `packages/hub-tunnel/test/fixtures/fake-encryptor.ts` | `Encryptor` (`hub-tunnel/src/encryptor.ts`) |
| 12 | `packages/hub-tunnel/test/fixtures/echo-protocol.ts` | a protocol definition (not a port double) |
| 13 | `packages/broadcast/src/bus.ts` `createMemoryBus` | `BroadcastBus` — the hub |
| 14 | `packages/hub-server/src/memoryStore.ts` | `HubStore` — a real implementation, used as the durable store's stand-in |
| 15 | `packages/mls/test/credential.test.ts:109` | an `Identity` missing `longForm` |
| 16 | `packages/mls/test/group.test.ts:55` `vi.mock('ts-mls')` | pass-through spy over `createApplicationMessage` |

**Findings: 2 high, 3 medium, 3 low.**

Verified as already fixed in the working tree: `fake-crypto`'s `exportSecret` now mixes the epoch
(`fake-crypto.ts:36,133`), and `memory-group-mls`'s `readCommitHeader` now refuses commits framed
ABOVE the handle's epoch (`memory-group-mls.ts:536`). The counter-example the audit calibrated
against — `unwrap` refusing every epoch but the live one (`fake-crypto.ts:117`), stricter than real
MLS's four-epoch window and deliberately so — is intact.

---

## HIGH 1 — `readCommitHeader` still answers for PAST epochs; the real handle returns `null`. Fork detection is dead in production.

- **Double:** `packages/rpc/test/fixtures/memory-group-mls.ts:520-538`. After the in-flight fix it
  refuses `parsed.epoch > epoch`, but a member commit framed at any epoch **below** the handle's
  still returns a full header: `{ epoch, committerDID }`, no epoch secret, no tree lookup.
- **Real:** `packages/mls/src/group-handle.ts:723-767`. A member commit's committer is recovered by
  decrypting its sender-data with `this.#state.keySchedule.senderDataSecret` — **the current
  epoch's** — and mapping the leaf against the current tree (`#didOfLeaf`, `group-handle.ts:704`).
  A commit framed at a past epoch was sealed under a past sender-data secret: the AEAD refuses,
  `readSenderLeafIndex` returns `null`, and `readCommitHeader` returns `null`
  (`group-handle.ts:761-766`). MLS ratchets forward, so this is unrecoverable, not transient.
- **Direction:** double is MORE PERMISSIVE (answers below the current epoch where the port refuses).
- **What it hides:** `classifyCommit` (`packages/rpc/src/classify.ts:142-152`) reaches three of its
  six rows only through a non-null header whose epoch is BELOW the peer's:

  ```ts
  if (header.epoch < state.epoch) {
    const applied = state.appliedByEpoch.get(header.epoch)
    if (applied == null || applied === sequenceID) return { row: 'history' }
    return { row: 'fork', appliedSequenceID: applied, branch: sequenceID < applied ? 'losing' : 'winning' }
  }
  ```

  Against a real handle every one of those frames arrives as `header == null` and settles at
  `classify.ts:128` as `{ row: 'poison' }`. `'history'` and `'poison'` both advance the cursor, so
  that half is harmless. **`'fork'` is not.** The fork row is the ONLY detector of a hub that
  accepted two commits at one head — the failure mode `FakeHub.acceptAtAnyHead()`
  (`fake-hub.ts:88`) exists to produce and that `hideFrom`/`revealTo` (`fake-hub.ts:97,120`) exist
  to stage. In production it can never fire: the losing branch is never diagnosed, the peer never
  heals, and it sits on a divergent branch reporting itself healthy — the same class of defect as
  the stall this session already found, reached by a different door. Every fork test in
  `peer-commit-*.test.ts` is green solely because the double answers a question the real port
  refuses.
- **Note:** the in-flight fix on `classify.ts` / `group-handle.ts` / `memory-group-mls.ts` closes
  the `>` side of this. The `<` side is the same divergence and is not closed by it.

## HIGH 2 — every hub double's `subscribe` is infallible; the real one refuses, and the refusal is swallowed into a permanent silent stall.

- **Doubles:** `packages/rpc/test/fixtures/fake-hub.ts:135-143` (records `options?.retention` into a
  map for assertions, validates nothing, returns `void`);
  `packages/rpc/test/fixtures/durable-fake-hub.ts:45-52` (drops `options` entirely);
  `packages/hub-tunnel/test/fixtures/fake-hub.ts:64-70`. None can fail.
- **Real:** `packages/hub-server/src/memoryStore.ts:391-397` throws `RetentionExceededError` for a
  requested retention above the hub's ceiling — **refused, never clamped**, which the contract
  states explicitly (`hub-tunnel/src/transport.ts:77-81`) and the conformance suite asserts
  (`packages/hub-conformance/src/index.ts:246`). Beyond the ceiling, the production `subscribe` is
  an RPC over the wire (`packages/hub-client/src/client.ts:85-89`) and can reject for transport,
  auth, or server reasons.
- **Direction:** doubles are MORE PERMISSIVE (accept every subscribe, including one the hub refuses).
- **What it hides:** `packages/rpc/src/hub-mux.ts:112-116`:

  ```ts
  const retain = (topicID, options) => {
    const next = (refcount.get(topicID) ?? 0) + 1
    refcount.set(topicID, next)
    if (next === 1) void Promise.resolve(hub.subscribe(localDID, topicID, options)).catch(() => {})
  }
  ```

  The refcount is bumped BEFORE the subscribe and the rejection is swallowed. Since app and commit
  topics are retained for the peer's whole life and never released (`hub-mux.ts:96-102`), the count
  never returns to zero and **the subscribe is never retried**. The hub gates topic pulls on the
  caller's own subscription (`memoryStore.ts:310-315`), so every subsequent `fetchTopic` throws
  `NotSubscribedError` forever; the commit lane's seed swallows that too (`peer.ts:1543`, "a failed
  seed leaves the cursor put"), and `loadAppSegment` (`peer.ts:959`) raises into the same
  swallowing callers. Net effect: a peer that never applies a commit and never delivers an app
  frame, with no error anywhere — healthy by every observable the suite has.
- **Why this branch, specifically:** the app lane is what introduced retention-carrying subscribes
  (`peer.ts:501` and `peer.ts:959`, both `mux.retainTopic(topicID, { retention: appLogRetentionSeconds })`).
  `appLogRetentionSeconds` is host-settable and its own doc says it is "overridable up to the hub
  operator's own cap" (`peer.ts:179-184`) — i.e. the one knob whose out-of-range value the real hub
  refuses is exactly the one this branch added, and no double can refuse it. The default (30 days,
  `2_592_000`) sits precisely ON `DEFAULT_MAX_RETENTION` (`memoryStore.ts:52`): one second more from
  a host, or one operator with a tighter cap, and the peer silently stops working.
- **Structural root cause:** `@kumiai/hub-conformance` is applied to exactly one implementation
  (`packages/hub-server/test/conformance.test.ts`). The three `LogHub`/`MailboxHub` doubles the rpc
  and tunnel suites actually run against are checked by nothing.

## MEDIUM 3 — `FakeEncryptor`'s tag is key-independent: a wrong-key ciphertext decrypts successfully.

- **Double:** `packages/hub-tunnel/test/fixtures/fake-encryptor.ts:48-68`. `decrypt` accepts any
  ciphertext ending in the constants `0xaa 0x55` (`:5-6`) — the tag is not derived from the key, so
  bytes encrypted under a DIFFERENT key pass the check and XOR out to garbage that is returned as
  plaintext.
- **Real:** the `Encryptor` port (`packages/hub-tunnel/src/encryptor.ts`) is fronted in production
  by an AEAD, which refuses a wrong key.
- **Direction:** MORE PERMISSIVE (succeeds where the real one throws).
- **What it hides:** `createEncryptedHubTunnelTransport` stamps `groupID` into the envelope on
  publish and **never checks it on receive** (`packages/hub-tunnel/src/encrypted-transport.ts:42-51`
  vs `:75-101`). Cross-group and cross-key isolation therefore rests entirely on `decrypt`
  throwing. No test can observe that: every encrypted-transport test wires both sides with the same
  `SHARED_KEY`, and the two negative tests use the explicit `failNextDecrypts` /
  `corruptNextCiphertexts` controls rather than a genuinely foreign key. Swapping the production
  encryptor for a non-authenticating cipher (CTR/CBC with no tag) would keep the whole suite green
  while foreign-group frames were accepted as authenticated plaintext.

## MEDIUM 4 — the rpc hub doubles never lose a frame on their own; the real store trims on every publish.

- **Doubles:** `fake-hub.ts:310` and `durable-fake-hub.ts:164` expose `trim(topicID, before)` as a
  manual test control and nothing else. Neither enforces a depth bound, and neither ages anything
  out.
- **Real:** `memoryStore.ts:236-247` trims the oldest log-class frames on **every** log publish once
  `maxDepth` (default 1000) is exceeded, and `purge` (`memoryStore.ts:371-389`) removes by age.
- **Direction:** MORE PERMISSIVE (retains unconditionally where the real store deletes).
- **What it hides:** every code path that does not have a `trim()` in its test never meets a cursor
  below `oldest`. The app lane's below-retention notice is exercised (`peer-app-retention.test.ts`),
  but the commit-lane pull and journal replay reach a trimmed log only where a test remembers to
  arrange it — a peer that returns after 1000 commits and finds its commit cursor gone is a
  scenario the doubles will never produce by themselves.

## MEDIUM 5 — `createMemoryBus` echoes a publish back to the publisher; the hub does not.

- **Double:** `packages/broadcast/src/bus.ts:11-25` — `publish` calls every subscriber of the topic,
  including the publisher's own.
- **Real:** the store builds recipients as "current subscribers **minus the sender**"
  (`memoryStore.ts:190-197`), and both rpc hub doubles reproduce that (`fake-hub.ts:198`,
  `durable-fake-hub.ts:91`). `peer.ts:1130` states it as a design fact: "the live fan-out never
  echoes a publisher its own broadcast".
- **Direction:** MORE PERMISSIVE (delivers a message the real hub never delivers).
- **What it hides:** any broadcast component whose correctness turns on receiving its own
  publish — a gather that counts its own reply toward a quorum, a client that confirms a publish by
  observing it arrive, a responder that self-answers. It passes on the memory bus and delivers
  nothing in production. (`packages/broadcast/test/*` runs almost entirely on this bus.)

## LOW 6 — `hub-tunnel`'s `FakeHub` echoes to the sender and mints unpadded sequenceIDs.

`packages/hub-tunnel/test/fixtures/fake-hub.ts:88-96` delivers to every subscriber of the topic with
no sender exclusion (same divergence as #5), and `:81` mints `String(++this.#sequence)` where both
the real store (`memoryStore.ts:54`) and both rpc doubles zero-pad to 12 digits because a bare
decimal breaks every `>` comparison at the 9→10 boundary — a property the conformance suite asserts
(`hub-conformance/src/index.ts:315`). Harmless today (the mailbox lane compares no sequenceIDs), but
it is a trap for the first caller that does.

## LOW 7 — `frameEpoch` on the fake crypto returns `null` only for 0- or 1-byte payloads.

`packages/rpc/test/fixtures/fake-crypto.ts:104-109` tries `decodeMemoryCommit`, then falls back to
reading the first two bytes as a little-endian epoch for anything ≥ 2 bytes long — so arbitrary
garbage gets a plausible epoch. The port requires `null` for "bytes that are not a readable sealed
frame" (`rpc/src/crypto.ts:33-37`), which a real `readMessageEpoch` gives. Direction: more
permissive. The consequence is contained — `peer.ts:1148-1157` treats `null` and "below the walk"
identically (dead, cursor advances) — so the only cost is that the `sealedAt == null` branch is
unreachable through this double. Worth noting because the ONE case where it would matter is garbage
whose leading bytes read as a justified future epoch, which pins the cursor.

## LOW 8 — the durable host stores never fail, never delay, and never refuse a backwards write.

`journal.ts`, `anchor.ts` and `app-cursor.ts` all resolve instantly and unconditionally. Real host
stores (IndexedDB, SQLite, a keychain) reject and stall. In particular
`app-cursor.ts:save` accepts a position older than the one it holds; the advance rule ("a cursor may
only pass a frame that is DELIVERED or DEAD", `rpc/src/app-cursor.ts:11-16`) lives entirely in
`peer.ts`, so the store cannot catch a regression in it — only the `history()` accessor and a test
that remembers to assert on it can. Noted rather than ranked: no caller's correctness currently
turns on a store rejecting, and the peer's own error handling for a failed `save` is a separate
question from this audit.

---

## Not findings (checked, clean)

- `fake-crypto.unwrap` (`:111-129`) — stricter than real MLS by design and documented as such. The
  model the rest of this audit is measured against.
- `memory-group-mls`'s `authorize` (`:385-403`) throws for a requester with no leaf, matching the
  roster-intrinsic refusal the port demands of `sealGroupInfo`/`sealLedger`; `bootstrapLedger`
  (`:602-616`) checks the head BEFORE writing anything, matching the port; `sealToKey`/`openWithKey`
  (`:303-333`) keep a real X25519 trapdoor, so a confidentiality test cannot pass for the wrong
  reason.
- `memory-group-mls.processCommit` (`:539-595`) returns `{ advanced: false }` for every
  inapplicable frame and throws only `MissingLedgerEntriesError`, exactly as
  `isMissingLedgerEntries` (`rpc/src/crypto.ts:318`) requires.
- `commits.ts` `publishCommit` separates the transport sender from the MLS committer, which is the
  distinction the design turns on.
- `vi.mock('ts-mls')` in `mls/test/group.test.ts:55` is a pass-through spy over the real
  implementation, not a substitute for it. The mls suite runs on real crypto throughout.
