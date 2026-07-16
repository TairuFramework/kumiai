# Probe report — question 3.1: the returning-member drain

**Status: BLOCKED.** The approved approach fights the code, and it fights it at exactly the point the
brief flagged as riskiest: the interaction with the commit-lane walk. No drain was implemented. The
one file added is evidence, not an implementation (see *Artifacts*).

The interleaving premise in the brief is right and is confirmed. What is not implementable is the
**ordering** the approach makes load-bearing (step 2, capture-then-drain *after* `processCommit`) and
the **multi-slot store** (step 1) that ordering exists to serve. Both rest on a claim that the port
contract contradicts, and the brief's own established fact 5 is what contradicts it.

---

## The blocker, stated precisely

Two facts about the ports, neither of which this layer can reach around:

1. **The only decrypt primitive is `GroupCrypto.unwrap(bytes)`, and it is bound to the live epoch.**
   There is no "open these bytes under epoch E". `packages/rpc/src/crypto.ts:12-17` — the whole port is
   `{ epoch, exportSecret, wrap, unwrap }`. The fake throws for any other epoch
   (`test/fixtures/fake-crypto.ts:86-89`), which the brief's fact 5 names as real behaviour to respect.
2. **The only secret exporter is `GroupCrypto.exportSecret()`, also live-epoch-only.** This is the
   brief's own premise ("a rebooted handle can never re-export an earlier epoch's secret") and the
   subject of `docs/agents/plans/next/2026-07-16-exporter-secret-surface.md`. `GroupMLS`
   (`packages/rpc/src/crypto.ts`) exposes no per-epoch exporter either — its whole surface is
   `rosterDIDs / readCommitHeader / processCommit / createRecoveryRequest / sealGroupInfo /
   applyRecovery / isLedgerComplete / getLedger / sealLedger / openSealedLedger / bootstrapLedger /
   exportRecoverySecret`.

`port.processCommit` ratchets the handle. Therefore:

> **After the apply, every frame of the segment just left is sealed at an epoch below the handle's, and
> no value the `AnchorStore` holds can open it.** The anchor is a *topic-derivation* secret, not a
> message key. Retaining it as "pending" buys the ability to **name** the topic and **fetch** the
> ciphertext, and nothing else.

Consequences, one per approved step:

- **Step 2 (capture-then-drain) delivers zero frames.** At the site the approach names —
  `processCommit` → capture → drain the pending segment — the pending segment's frames are already
  undecryptable. The drain runs, fetches, and drops every frame on `unwrap`.
- **Step 1 (multi-slot store) closes no loss.** Its stated justification — "it currently … drops a
  segment's key before that segment is drained — permanent message loss on a crash" — is false in one
  specific way: the anchor is not the segment's key. The loss on that crash is loss of
  *decryptability*, caused by the ratchet, and it is already permanent the instant `processCommit`
  returns, whatever the store holds. There is no crash window in which a pending anchor is the
  difference between arrival and loss:
  - crash **before** the apply → the handle is still inside the segment, the *current* anchor still
    names it, a single slot restores it, the construction drain delivers it;
  - crash **after** the apply → the frames are unreadable, pending anchor or not.
- **Done-when #2 is unimplementable**, because it asserts the opposite of the port contract: "crash a
  peer after a rotation but before its drain completes, restart it over the same store and handle, and
  assert the pending segment's frames still arrive". Over that handle they cannot arrive. Making them
  arrive requires teaching the fake crypto to open past epochs — forbidden by the brief, and correctly
  so: it is the exact shape of the two doubles that were caught lying this week.
- **Mutation (a) therefore cannot exist.** "Make the store single-slot again → the crash test goes red"
  presupposes a green crash test. There is none to redden. Mutation (b) was not run either: it tests an
  ordering the implementation never reached.

## The evidence

`packages/rpc/test/probe-drain-site.test.ts` (added, uncommitted, **evidence only**). It drives the
real peer to the exact state the approved drain site runs in and reads what is available there.

```
$ rtk proxy pnpm exec vitest run packages/rpc/test/probe-drain-site.test.ts

 RUN  v4.1.10 /Users/paul/dev/yulsi/kumiai

 Test Files  1 passed (1)
      Tests  2 passed (2)
   Start at  18:17:43
   Duration  365ms (transform 102ms, setup 0ms, import 194ms, tests 99ms, environment 0ms)
```

Case 1 — *the segment it just left is unreadable, though its anchor still names the topic*: bob at
epoch 1 with anchor 1; a logged app frame is published on segment 1's topic sealed at epoch 1; a
remove commit lands; bob applies it (`bob.mls.epoch() === 2`, `anchorEpoch() === 2`). Holding
segment 1's anchor, bob still derives the topic and `fetchTopic` still returns the frame — and
`unwrap` throws `cannot open bytes sealed at epoch 1: this member is at 2`, while
`exportSecret()` no longer equals `fakeEpochSecret(1)`. The fetch works; the read does not.

Case 2 — *the same frame opens if it is drained BEFORE the commit is applied*: identical setup, bob
still at epoch 1, the frame opens. The difference between the two cases is one `processCommit`.

This is also what the one passing test in `peer-app-drain.test.ts:18` has been relying on all along:
the redelivered epoch-1 app frame reaches bob's handler only because `redeliver` pushes it **ahead of**
the commit frames that take him to epoch 11. Reorder those two and it goes red.

## Where the drain would have hooked in, and whether that was where I expected

The apply site the brief names is the right *place* — `packages/rpc/src/peer.ts:929-934`, the
`detectRosterChange(...) || header?.external === true` branch inside `pullCommits` — but the hook has
to sit **one statement earlier than the approach puts it**, and the difference is the whole finding:

- brief: `port.processCommit` (`peer.ts:872`) → `captureAnchor()` (`:933`) → drain the pending segment.
- what the port permits: drain the current segment's frames for `crypto.epoch()` → `port.processCommit`
  → `captureAnchor()`. Nothing pends, so nothing needs a second slot.

So: same site, opposite side of the apply. That is not where I expected to land — I expected the
established facts to survive contact and the ordering argument to hold. The ordering argument
("drain-first would leave the store pointing at the old anchor") turns out to be about a race that
only exists once you accept a pending slot that cannot help.

Worth recording: **the design spec §5 is on the port's side, not the brief's.** "Walk the commit log
epoch by epoch (deriving each `exportSecret()`) … decrypting each frame under the epoch its MLS
ciphertext names" reads exactly as drain-before-apply — at each epoch the walk sits at, the handle
*is* at that epoch, so `exportSecret()` and `unwrap` both work with no past-epoch capability at all.
"Pulling once per segment … to head" survives too: pull on entering the segment, buffer, dispense per
epoch as the walk passes it. The spec's line about the handle persisting epoch secrets
(`…design.md:182`) is about at-rest posture, not about opening a past epoch. It is the brief's step 1
and step 2 that are the outliers.

## Hub-fake audit — property by property

Audited **before** trusting the fakes, as required. Real contract read from
`packages/hub-protocol/src/types.ts:87-132`, `packages/hub-server/src/memoryStore.ts:150-344`, and
`packages/hub-conformance/src/index.ts`. Result: **`FakeHub` and `DurableFakeHub` are faithful on every
property the drain relies on. No divergence found.**

| Property | Real contract | `FakeHub` | `DurableFakeHub` | Verdict |
| --- | --- | --- | --- | --- |
| `fetchTopic` returns **only** `retain: 'log'` frames | `types.ts:88-95`; `memoryStore.ts:322-324`; conformance *"a mailbox publish to a log topic is delivered, and does not appear in the log"* (`:131`) | `fake-hub.ts:219-221`, filters `#logClass` | `durable-fake-hub.ts:106-108`, same | ✅ |
| **Not** delivery-filtered — a peer pulls back its own frames, and acked frames stay | `memoryStore.ts:310-343` reads `topicLogs`, never `deliveries`; conformance *"ack deletes the delivery, not the log entry"* (`:201`) | no sender filter, no ack filter on the pull path | tracks acks for `redeliver` only; `fetchTopic` ignores them | ✅ |
| Publish order preserved | append-order log; `formatSequenceID` zero-pads to 12 so lexicographic = numeric; conformance *"sequenceIDs are lexicographically ordered across the 9 to 10 boundary"* (`:315`) | `fake-hub.ts:21-23` pads to 12 | `durable-fake-hub.ts:16-18` pads to 12 | ✅ |
| `after` is an **exclusive** cursor | `types.ts:101-107`; `memoryStore.ts:329`; conformance `:176` | `fake-hub.ts:230-232` (`m.sequenceID > after`) | `durable-fake-hub.ts:110` (same) | ✅ |
| A log-class publish with **no subscriber** is still retained | `memoryStore.ts:198-202` (only the *mailbox* fast path drops); conformance *"a publish to a topic with no subscribers is retained and can be pulled later"* (`:180`) | `publish` appends to `#logs` regardless of `#topics` | same | ✅ |
| `head` is stored state and survives a trim | `types.ts:112-124`; conformance `:285`, `:590` | `#heads`, moved only by `retain: 'log'`; `trim` (`:310-317`) leaves it | `#heads`; `trim` (`:164-166`) leaves it | ✅ |
| `oldest` | `types.ts:125-126` | class-filtered log's first entry; trim-aware | `durable-fake-hub.ts:169-172`, same | ✅ |
| `limit` applied **after** the class filter | `memoryStore.ts:326-330` — a page of mailbox frames must not eat the limit | `fake-hub.ts:233` slices the class-filtered selection | `durable-fake-hub.ts:111`, same | ✅ |
| Fetch gated on the caller's own subscription | `memoryStore.ts:311-315` → `NotSubscribedError` | `fake-hub.ts:210-214` | `durable-fake-hub.ts:98-101` | ✅ |
| Delivery = subscribers **minus sender** | `memoryStore.ts:189-196` | `fake-hub.ts:197-198` | `durable-fake-hub.ts:90-92` | ✅ |

Two deliberate, opt-in `FakeHub` departures — `acceptAtAnyHead()` and `revealTo()` (a frame served
below the cursor) — are hostile-hub modelling, off by default, documented as such at
`fake-hub.ts:79-128`, and touch nothing the drain would rely on.

**The fake that diverges is not a hub fake.** `createFakeCrypto`'s `unwrap` models the strictest
possible MLS handle — zero past epochs retained — while `GroupCrypto.unwrap`'s own doc
(`crypto.ts:5-11`) says only that it "closes over the live group" and is silent on past epochs. That
silence is the gap this question fell into: the brief's fact 5 reads the fake as the contract, the
approved approach's steps 1-2 need the opposite, and nothing in the repo adjudicates. **I did not touch
the fake.** Deciding what a real handle may open is a port-contract question, not a fixture question,
and it is the sibling of the gap already tracked in
`docs/agents/plans/next/2026-07-16-exporter-secret-surface.md` — same seam, same cause: no `@kumiai/mls`
surface behind `GroupCrypto`, so nothing constrains what a host puts there.

## Not done (all of it blocked on the above)

Untouched, deliberately: the logged procedure alongside `fixtures/peer.ts:16`'s `chat/changed`; the
multi-slot `AnchorStore` and its type docs; the drain itself; both done-when tests; both mutations.
Adding the logged fixture procedure alone would have been harmless, but it is only useful to a drain,
and there is no drain to feed it.

`peer-app-drain.test.ts:72` stays skipped and untouched.

## What would unblock it

Not a redesign — the two mutually exclusive readings, for the decision-maker:

1. **The fake is right (a handle opens only its live epoch).** Then the drain is drain-**before**-apply,
   per epoch, with the **existing single-slot** `AnchorStore`, pulling once per segment and buffering
   —which is what design spec §5 already describes. Done-when #2 and mutation (a) are struck; the
   crash-safety property they were reaching for is delivered by the ordering instead, and a crash test
   *can* be written against that (crash before the apply, restart, assert the frames arrive) — a
   different test, asserting a different mechanism.
2. **A real handle retains past epoch secrets** (`max_past_epochs > 0`, RFC 9420's out-of-order
   application-message case). Then the brief's ordering works — but `GroupCrypto.unwrap`'s contract has
   to say so, the fake has to model it (an *extension*, not a weakening — and one that needs the
   decision made first), and the pending anchor becomes genuinely load-bearing. This also revives the
   question the exporter-secret plan raises: nothing constrains what a host puts behind the port.

The cost of guessing wrong is asymmetric and silent, which is why this is a report and not a patch. Take
(1) and ship it against a host whose handle *does* retain past epochs: the drain is merely stricter than
it needs to be, and nothing is lost. Take (2) and ship it against a host whose handle does **not**: every
segment boundary silently eats its backlog, the peer converges, the roster is right, the epoch is right,
and nothing anywhere reports it — the failure mode this whole plan exists to close.

## Concerns

1. **The brief's fact 5 and its approved steps 1-2 cannot both be honoured.** That is the block. Fact 5
   is the one consistent with the port, the fake, and design spec §5; steps 1-2 are the outliers.
2. **A laggard publisher's frames are unreadable regardless** — carol still at epoch 1 publishing to
   segment 1's topic after bob has rotated to epoch 2. Inherent to anchoring topics on a ratcheting
   secret, closable by neither ordering nor store, and out of scope here. Flagged because a drain that
   looks complete will still miss these.
3. **`GroupCrypto.unwrap`'s past-epoch behaviour is unspecified** and now load-bearing for a whole
   phase of this plan. It belongs next to the exporter-secret gap, and it is the same seam: no
   `@kumiai/mls` surface, hosts implement the one thing that must not be got wrong.

## Artifacts

- `packages/rpc/test/probe-drain-site.test.ts` — added, uncommitted, **evidence for this report**, not a
  proposed test. It passes and the suite is green with it in. Delete it or re-home it as the reviewer
  prefers; nothing depends on it.
- No source file was modified. No fake was modified.

## Verify

```
$ rtk proxy pnpm test
 Test Files  35 passed (35)
      Tests  202 passed (1 skipped) (203)
 Tasks:    30 successful, 30 total

$ rtk proxy pnpm run lint
$ biome check --write ./packages ./tests
Checked 219 files in 164ms. No fixes applied.
```
