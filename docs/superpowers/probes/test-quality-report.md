# Probe report — tests that pass whether or not the thing they name works

Branch `feat/app-lane-delivery`. Nothing committed; everything left in the working tree.

## IMPORTANT — a second probe is running in this tree

The brief said no other probes were running. That is not true. Partway through this probe the
following appeared, none of it mine:

```
 M packages/hub-client/src/client.ts
 M packages/hub-conformance/src/log-hub.ts
 M packages/hub-protocol/src/protocol.ts
 M packages/hub-protocol/src/types.ts
 M packages/hub-server/src/handlers.ts
 M packages/hub-server/src/memoryStore.ts
 M packages/hub-tunnel/src/encrypted-transport.ts
 M packages/rpc/src/peer.ts
 M packages/rpc/test/fixtures/durable-fake-hub.ts
 M packages/rpc/test/fixtures/fake-hub.ts
?? docs/superpowers/probes/f5-unblock-brief.md
```

It is adding a `logPosition` to hub frames and removing `appSegmentLoaded` from `peer.ts` — the
"live lane's missing read position" item the brief lists as *filed, blocked*. At one point its
edit left `packages/rpc/src/peer.ts` failing to typecheck mid-flight (`Cannot find name
'appSegmentLoaded'`, `Property 'fetched' is missing`). I touched none of those files and reverted
every temporary mutation of my own by hand.

Two consequences for what follows:

- **Item 2's finding is time-stamped.** It rests on the one-pull-per-segment latch, which that
  probe is in the middle of removing. The measurement was correct when taken; re-take it after
  they land.
- The final verification run below is against a tree that contains their in-flight work.

## The standard applied

Every claim below is a mutation: the named code was deleted or inverted, the suite was run, and
the output pasted. Nothing was weakened or deleted to make anything pass.

---

## 1. Two guards in `deliverAppFrames` — FIXED, both redden on deletion

New describe in `packages/rpc/test/peer-app-drain-integrity.test.ts`: *"the drain delivers only
what the live lane would"*.

### `retentionOf(...) !== 'log'`

Test: *a retained frame naming an ephemeral procedure is not delivered*. A frame is published
around Alice's peer — same topic, same epoch key, same sender, `retain: 'log'` on `chat/changed`,
which the protocol declares ephemeral. Bob restarts and drains. Both procedures share one topic,
so topic separation cannot be doing the work.

Deleting the guard (`packages/rpc/src/peer.ts:1249`):

```
PASS (4) FAIL (1) skipped (1)
   AssertionError: expected [ { text: 'alice is typing' } ] to deeply equal []
```

### `opened.senderDID === localDID`

Test: *a member's own frame in the log is not delivered back to it*. Bob publishes, the hub does
not echo it to him, nothing moves his read position past it, and his restart drains the topic
whole — his own frame included. Alice's frame is the control that proves the drain ran.

Deleting the guard (`packages/rpc/src/peer.ts:1238`):

```
PASS (4) FAIL (1) skipped (1)
   AssertionError: expected [ { text: 'alice said this' }, …(3) ] to deeply equal [ { text: 'alice said this' }, …(2) ]
```

Both guards restored by hand-inverting the edit.

---

## 2. `peer-app-drain.test.ts:20` — MOVED, and a finding about why it could not be converted

**The measurement.** `deliverAppFrames` was stubbed to deliver nothing:

```
 × a peer that was restarted still reads the messages sent at its epoch
 × a peer reads the messages sent at an epoch it was never online for
 × a peer reads a message sent at its own epoch that reached the log after the commit leaving it
 × a returning peer is given the logged history and none of the ephemeral history
```

Four of the five reddened. The fifth — the one at line 20 — stayed green with the drain dead.

**Why it cannot be made a drain test.** I tried: `chat/posted` instead of `chat/changed`, and
convergence driven by a live commit rather than `hub.redeliver`. Result:

```
PASS (4) FAIL (1)
   AssertionError: expected [] to deeply equal [ { text: 'before lunch' } ]
```

Bob reaches epoch 12 and reads nothing. The peer's process never died, so `appSegmentLoaded`
latched at a startup where the log was empty and the segment is never pulled again. **A
still-running peer's drain cannot deliver anything published after it came up** — that is the
latch the brief lists as filed-and-blocked. The scenario in this test (transport dropped, process
alive) is therefore structurally a live-lane scenario.

**What was done.** Moved to a new file `packages/rpc/test/peer-app-live-backlog.test.ts`,
retitled *"the live lane replays a reconnecting member its mailbox backlog"* / *"a peer whose
transport dropped still reads the **ephemeral** messages sent at its epoch"*, with a header
comment stating why it is not in the drain suite. Confirmed it reddens for its own reason, by
mutating the double to stop replaying mailbox-class frames:

```
 FAIL  test/peer-app-live-backlog.test.ts > the live lane replays a reconnecting member its mailbox backlog > a peer whose transport dropped still reads the ephemeral messages sent at its epoch
AssertionError: expected [] to deeply equal [ { text: 'before lunch' } ]
```

**Overclaim caught while doing this.** My first draft titled it *"…is opened before the commits
behind it ratchet past its epoch"*. Reversing the replay order in the double (newest first, so the
frame arrives after all ten commits) left it **green** — the commits are buffered rather than
applied, so the ordering is not what the test proves. The ordering claim was removed from the
title and the comment before landing.

---

## 3. `peer-removed-blind.test.ts` — RETITLED, and the confidentiality half has nowhere to go

The overclaim is in the assertion block, not only the title. Adding the epoch-2 secret —
recomputed from the shared base, which any member including the removed one can do — to the list
of secrets Carol is tried against:

```
AssertionError: carol derives the group's topic from MUTATION: epoch 2 recomputed from the base,
at epoch 2: expected 'ryhLB9g-7-kX7DEYYGqGfRp7s1t2NeqJUdWbj…' not to be
'ryhLB9g-7-kX7DEYYGqGfRp7s1t2NeqJUdWbj…' // Object.is equality
```

In this test's own crypto the removed member **can** derive the group's new topic. The derivation
failure the test demonstrates is an artefact of not trying, not of one-wayness — `fakeEpochSecret`
is a reversible XOR mix of a shared base.

What the fake **does** carry, and what the test genuinely pins: the anchor is sealed from
`exportSecret()` and not from the lifelong recovery secret, so the topic sits behind forward
secrecy rather than one counter away from a secret the removed member keeps forever. That half of
the loop stays green under the mutation above.

Landed:
- describe → *"the rotation puts the group on a topic only the post-removal epoch secret names"*
- test → *"the lifelong recovery secret does not derive the new topic, and nothing reaches her"*
- a `WHAT THIS CANNOT SAY` paragraph in the header comment, naming the mutation and its result.

**The confidentiality claim cannot be moved to `packages/mls`.** `GroupCrypto` has no
implementation anywhere in this repo — it is a consumer-supplied port, and `@kumiai/mls` exports
no epoch-secret export to ask the question of (`grep -rn "exportSecret" packages/mls/src` finds
only the unrelated HPKE `hpke.exportSecret`). There is no surface today that can carry "a removed
member's handle cannot export the post-removal epoch secret". Finding, not a fix.

---

## 4. `peer-recover-lane.test.ts` winning branch — POSITIVE COMPANION ADDED, plus a finding

**The finding first: the peer cannot be asked.** `packages/rpc/src/peer.ts` handles `history` and
a `fork`/`winning` disposition with the same three statements — `reconciledHead = position`,
`continue`, heal nothing. They are behaviourally identical at the peer by design, so *no*
assertion on the peer's surface can distinguish "the fork was detected and correctly ignored" from
"no fork was detected". This is not an observability oversight to be closed.

Demonstrated by mutating `classifyCommit` so the winning branch is never diagnosed as a fork
(returns `history` instead). The entire recover-lane suite, including the test in question:

```
      Tests  12 passed (12)
```

Only `commit-classify.test.ts` caught it — `PASS (15) FAIL (3)`.

**The companion.** Since the verdict exists only in the classifier, the test now asks the
classifier about *the scenario's own frames at the positions the hub actually gave them*, rather
than about hand-picked sequence IDs. It reddens under the exact mutation the peer assertions
survive:

```
 FAIL  test/peer-recover-lane.test.ts > a hub that forked the log > the winning branch sees the same fork and does not heal
AssertionError: expected { row: 'history' } to deeply equal { row: 'fork', …(2) }
```

The comment states plainly that this is the classifier's word and not the peer's, and why.

---

## 5. `fake-crypto.frameEpoch` invents an epoch for garbage — FIXED

`frameEpoch` now checks structure, not just length: a sealed frame is
`[epoch(2)][ xor([didLen(2)][did][payload]) ]`, so it is at least four bytes and its own length
must hold the sender it declares. Both the epoch and the XOR key are in the clear, so this is a
check every member can make.

**The end-to-end case, written red first.** New test in `peer-app-drain-integrity.test.ts`:
*"bytes that are not a frame claim no epoch, however their leading bytes read"*. Eight bytes of
`03 00 ff ff ff ff ff ff` on the app topic; `03 00` little-endian is epoch 3, and two commits
carry the group to 3, so the commit-log ceiling justifies the number. Against the unfixed double:

```
AssertionError: expected [ '000000000001', '000000000002' ] to deeply equal [ '000000000002' ]
```

Two cursor writes instead of one: the position rested behind the garbage from epoch 1 to epoch 3,
and any restart in that window re-delivers the frame in front of it. With the fix the garbage is
dead at the first epoch that sees it and the cursor never stops behind it.

**Unit case too**, in `fixtures.test.ts`, red against the unfixed double:

```
 FAIL  test/fixtures.test.ts > … > bytes that are not a frame answer null, however their leading bytes read
AssertionError: expected 3 to be null
```

---

## 6. Durable store doubles — DONE for `app-cursor`, nothing reddened

`createMemoryAppCursorStore().save` now throws on a position strictly older than the one it holds.
Equal is allowed (re-saving what is already held is a no-op, not a move). The comment states why
the store is the only place that can say this: the advance rule lives entirely in `peer.ts`.

It reddened **nothing** — full rpc suite green with the refusal in place — so there is no
finding hiding behind it. Its own test in `fixtures.test.ts` is red without the guard:

```
 FAIL  test/fixtures.test.ts > the durable app-cursor double refuses what the real store must > a position older than the one it holds is refused
AssertionError: promise resolved "undefined" instead of rejecting
```

`journal.ts` and `anchor.ts` were left alone: the brief named `app-cursor.save` as the specific
gap, and neither of the other two has an ordering rule the peer does not already own.

---

## Verification (repo root)

```
$ pnpm run build
 Tasks:    8 successful, 8 total

$ rtk proxy pnpm run lint
$ biome check --write ./packages ./tests
Checked 233 files in 233ms. No fixes applied.

$ pnpm test
@kumiai/rpc:test:unit: Test Files  43 passed (43)
@kumiai/rpc:test:unit:      Tests  276 passed | 1 skipped (277)
 Tasks:    30 successful, 30 total

$ pnpm exec vitest run   (packages/mls)
PASS (311) FAIL (0)

$ pnpm exec vitest run --dir tests/integration
PASS (23) FAIL (0)
```

rpc went 266 → 276. Six of those are mine (three in `peer-app-drain-integrity.test.ts`, three in
`fixtures.test.ts`); the drain test was moved rather than added, so it is net zero. The remaining
four come from the other probe's additions to `packages/hub-conformance/src/log-hub.ts`, which
`packages/rpc/test/hub-conformance.test.ts` runs.

## Files I changed

- `packages/rpc/src/*` — **nothing**. Every src touch was a mutation, reverted by hand.
- `packages/rpc/test/peer-app-drain-integrity.test.ts` — three tests added
- `packages/rpc/test/peer-app-drain.test.ts` — one test removed (moved out)
- `packages/rpc/test/peer-app-live-backlog.test.ts` — new
- `packages/rpc/test/peer-removed-blind.test.ts` — titles and comments
- `packages/rpc/test/peer-recover-lane.test.ts` — positive companion assertion
- `packages/rpc/test/fixtures/fake-crypto.ts` — `frameEpoch` structural check
- `packages/rpc/test/fixtures/app-cursor.ts` — backwards-write refusal
- `packages/rpc/test/fixtures.test.ts` — three tests added
