# Probe report — a removed member cannot derive or read the post-removal app topic

Branch `feat/app-lane-delivery`, uncommitted. **No `src/` file was changed** — the whole diff is
fixtures and tests. `pnpm run build && rtk proxy pnpm run lint && pnpm test` is green (30/30 turbo
tasks; rpc 200 passed / 1 skipped, mls 18 passed).

## Answer

**Yes, and it rests entirely on the anchor being sealed from `exportSecret()`.** A removed member
keeps the recovery secret for life and every topic ID it ever derived; the group never takes any of
that back and never tries to. What cuts it off is the per-epoch secret, which it cannot follow: the
rotation re-derives the topic from the secret exported at the post-removal epoch, an epoch its
handle can never reach. The mutation below shows there is exactly one thing holding this up, and
that nothing else in the suite was watching it.

One thing the question's framing does not survive contact with the code: **the delivery half cannot
fail.** A removed member is stranded at its last epoch, so its anchor epoch NUMBER alone already
puts it on a different topic — even with the anchor sealed from the recovery secret it hears
nothing through its own peer. Silence is therefore not evidence. The property lives in the topic
ID: whether anything the removed member holds NAMES the topic the group moved to. That is what the
new test asserts and what the mutation breaks.

## Changes

### 1. The fake's `exportSecret` is epoch-derived (the blocker, cleared first)

- `packages/rpc/test/fixtures/fake-crypto.ts:19` — `FAKE_BASE_SECRET`, the base every fake member
  shares (was an inline literal).
- `packages/rpc/test/fixtures/fake-crypto.ts:35` — `fakeEpochSecret(epoch, base)`: base XOR the
  epoch, per byte. Trivial, reversible, and modelling none of the ratchet's one-wayness — the doc
  comment says so and points at `@kumiai/mls` for where that is real. Exported because a test that
  wants the topic the group is on needs the ANCHOR epoch's secret, which the live handle has
  usually run past — the same reason the anchor is persisted.
- `packages/rpc/test/fixtures/fake-crypto.ts:102` — `exportSecret: () => fakeEpochSecret(epoch, secret)`.
- `packages/rpc/test/fixtures.test.ts:28` — new fixture self-test: different epoch → different
  bytes; members AT an epoch agree; one stuck behind does not follow.

### 2. The memory MLS double: a removed member's handle stops (an unanticipated second blocker)

- `packages/rpc/test/fixtures/memory-group-mls.ts:544` — `processCommit` returns
  `{ advanced: false }` for a Commit that removes `localDID`, leaving the tree alone.

**This was not in the brief and the removed-member property cannot be expressed without it.** The
double's `enact` applied every Commit uniformly, so the member being removed dropped its own leaf
and **advanced its own epoch**, exporting the post-removal secret and rotating its anchor onto the
group's new topic. Against that double a removed member walks on no matter what `captureAnchor`
seals from — the same shape of blocker as the fake's fixed `exportSecret`, in the neighbouring
fixture. The real behaviour is the opposite and is why the property holds at all: the commit's
UpdatePath excludes the leaf it drops, so the removed member is handed nothing to derive the new
epoch's secrets from. `{ advanced: false }` and not a throw, matching the port contract; the tree is
left stale because a member that cannot apply the commit does not learn its roster from it. The mls
test in §4 is the same fact against ts-mls.

No existing test removes its own local peer, so nothing else is affected by this.

### 3. rpc — `packages/rpc/test/peer-removed-blind.test.ts` (new)

Alice, Bob and Carol; Carol hears an event as a member (so her later silence means something), an
admin commits `removes: ['carol']`, the remaining two exchange logged events across the rotation.

- The group's topic is read from **Alice's own anchor store**, not recomputed — so the comparison
  follows the lane to wherever it actually sealed the anchor from, and the mutation cannot slip out
  from under the assertion.
- Carol's handle is at epoch 1, her anchor at 1; Alice's and Bob's at 2.
- Plaintext both ways: `bobSaw`/`aliceSaw` carry the post-eviction events; `carolSaw` holds only the
  one from when she was a member.
- **The assertion**: every secret Carol still holds — the recovery secret, hers for life, and the
  per-epoch secret of the last epoch she holds — against every epoch number she can name (0..6; they
  are counters, so she can name all of them, the group's included). None of it is the group's topic.
- Wire: both events are on the group's topic, Carol's own topic holds only the pre-removal one, and
  the group's topic has exactly two subscribers.

### 4. mls — `packages/mls/test/crypto.test.ts:234` (new sibling)

`a removed member cannot produce the post-removal exporter secret`, next to
`member removal with forward secrecy`, which is untouched — no duplicated decryption assertion. The
neighbour covers the message keys (what a removed member can READ); this covers the exporter secret
(what it can NAME), which is the key the topic actually derives from. Against ts-mls directly, via
`mlsExporter(state.keySchedule.exporterSecret, …)`:

- while Bob is a member the two exports agree — the topic is shared at all;
- Alice's post-removal export differs from the pre-removal one — the exporter secret rotated;
- Bob's state is stuck at epoch 1 (`bobState.groupContext.epoch === 1n` vs Alice's `2n`) and still
  produces the OLD export exactly — he is not broken, he keeps for life the secret the group used
  while he was in it — and cannot produce the new one;
- and it is not the label that separates them: at the post-removal epoch every export Bob can make
  differs from the group's, for every label tried.

## Mutation check 4 (required) — the anchor sealed from the recovery secret

`packages/rpc/src/peer.ts:341`, `captureAnchor`:

```ts
anchor = { secret: (await mls?.exportRecoverySecret()) ?? new Uint8Array(), epoch: crypto.epoch() }
```

(The literal `await mls.exportRecoverySecret()` crashes the 19 tests whose peers are built without
an MLS port — `mls` is optional in `createGroupPeer`. The guarded form is the same bug without that
noise, and is what the numbers below are from.)

```
 × test/peer-removed-blind.test.ts > a member removed at the rotation cannot reach the topic the group rotates onto > nothing the removed member still holds derives the new topic, and nothing reaches her 261ms
   → carol derives the group's topic from the recovery secret, hers for life, at epoch 2: expected 'VUl8ONYPwnImX23bAjrXhN_dlmYwHVmlPa0aO…' not to be 'VUl8ONYPwnImX23bAjrXhN_dlmYwHVmlPa0aO…' // Object.is equality

 Test Files  1 failed (1)
      Tests  1 failed (1)

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/peer-removed-blind.test.ts > a member removed at the rotation cannot reach the topic the group rotates onto > nothing the removed member still holds derives the new topic, and nothing reaches her
AssertionError: carol derives the group's topic from the recovery secret, hers for life, at epoch 2: expected 'VUl8ONYPwnImX23bAjrXhN_dlmYwHVmlPa0aO…' not to be 'VUl8ONYPwnImX23bAjrXhN_dlmYwHVmlPa0aO…' // Object.is equality
 ❯ test/peer-removed-blind.test.ts:157:15
    155|           protocolTopic(secret, epoch, 'room'),
    156|           `carol derives the group's topic from ${what}, at epoch ${ep…
    157|         ).not.toBe(groupTopic)
       |               ^
```

The failure message is the spec's sentence back verbatim: *the recovery secret, hers for life, at
epoch 2*. Reverted; `git diff packages/rpc/src/peer.ts` is empty and the suite is green.

Suite-wide under this mutation: **15 fail, 185 pass**. Only `peer-removed-blind` fails saying what
is actually wrong. The other 14 are the app-topic/anchor-restart/control-lane/commit-lane topic
identity tests failing as `NotSubscribedError: bob is not a subscriber of <id>` — "the topic I
computed is not where the frames landed". They now pin the topic to `exportSecret` through
`fakeEpochSecret`, so they notice the anchor moved and cannot say why; before this probe they used a
value the fake made identical to everything else and noticed nothing.

## Mutation check 5 (required) — the fake reverted to `exportSecret: () => secret`, mutation 4 kept

**It does not go green. The brief's predicted outcome for this check does not hold, and the reason
is worth more than the check was.**

```
 × test/peer-removed-blind.test.ts > … > nothing the removed member still holds derives the new topic, and nothing reaches her 268ms
   → carol derives the group's topic from the recovery secret, hers for life, at epoch 2: expected 'VUl8ONYPwnImX23bAjrXhN_dlmYwHVmlPa0aO…' not to be 'VUl8ONYPwnImX23bAjrXhN_dlmYwHVmlPa0aO…' // Object.is equality

 Test Files  1 failed (1)
      Tests  1 failed (1)
```

Why: the check assumes the test catches mutation 4 through something the old fake defeats. It does
not. It catches it through the **recovery secret**, which the fake never supplied — it comes from
`mls.exportRecoverySecret()` — so reverting the fake changes nothing about that candidate. Nor could
a different design fix this: with the removed member's handle correctly stranded at epoch 1, the
delivery half is green under mutation 4 (her epoch number alone keeps her off the topic), so the
derivation half is the only thing that can catch it, and the recovery secret must be in the
candidate set for it to.

**The claim mutation 5 exists to prove is nevertheless true, and this run shows it** — old fake,
`captureAnchor` **correct and unmutated**:

```
 × test/peer-removed-blind.test.ts > … > nothing the removed member still holds derives the new topic, and nothing reaches her 269ms
   → carol derives the group's topic from the per-epoch secret of the last epoch she holds, at epoch 2: expected 'Ed3gwxWXWpMcFV2EQzYEcYfKUqq4rT5Ez46Qf…' not to be 'Ed3gwxWXWpMcFV2EQzYEcYfKUqq4rT5Ez46Qf…' // Object.is equality
```

Against the old fake **the correct implementation fails this test**, and fails it saying that a
removed member derives the group's topic from a secret she keeps. That is the blocker exactly: the
old fake's `exportSecret` *is* the lifelong secret the spec forbids, so the correct implementation
and the named bug are the same object from the test's point of view, and the test is red for both.
The fixture fix is what makes the property assertable — it is just that this shows up as "a correct
implementation now passes", not as "the mutation stops being caught". Reverted; suite green.

## Every test that moved when the fake changed, and why

Six failed on the fixture fix. **All six are one finding, and it is the fixture's fault, not
theirs**: each computed an app topic by pairing a secret read from a live handle at one epoch with
an anchor epoch NUMBER from another. That is a topic no member is on — `Anchor`'s own doc says the
two halves only ever move as a pair — and it only ever worked because the fake made the secret the
same at every epoch. The invariant each test asserts is unchanged; what changed is that the topic ID
is now the anchor's actual pair. None had its expectation weakened.

| test | was | now |
| --- | --- | --- |
| `peer-app-topic` ×4 (Remove rotates; add-only rotates; member booting later; rejoin) | `secret` read at boot (epoch 1), used with anchor epochs 2 and 4 | `roomTopic(epoch)` helper (`peer-app-topic.test.ts:50`): that epoch's secret, under that epoch |
| `peer-commit-lane` — pull-driven catch-up | `secret` read at Dave's live epoch 3, used with anchor epoch 1 | `fakeEpochSecret(1)` at 1 — the pair his anchor holds, and the one his handle at 3 could no longer export (`peer-commit-lane.test.ts:51`) |
| `peer-control-lanes` — control lane lifecycle | `secret` read at epoch 1, used with epoch 2 after the eviction | local `chatTopic(epoch)` helper (`peer-control-lanes.test.ts:52`) |

Two more moved without failing, because their assertion was `toBe(0)` and a wrong topic has no
subscribers either — vacuous rather than false:
`peer-control-lanes.test.ts:156` and `peer-anchor-restart.test.ts:150` named the topic a per-epoch
derivation would have moved the group onto using a secret from the wrong epoch. They now name it
with `fakeEpochSecret(<that epoch>)`, so "nobody went there" is about the place they meant.

Comments updated to say what is now true: `peer-app-topic.test.ts` and `peer-anchor-restart.test.ts`
file docs (both asserted the old epoch-independence).

The other ~9 `exportSecret()` readers were unaffected, as the brief predicted: they read at the
epoch they care about.

## Surprises

1. **The double had the same defect as the fake, one file over** (§2). A removed member applied its
   own removal and advanced. The brief established one blocker; there were two, in the same family —
   fixtures that cannot express the difference between a member that is cut off and one that is not.
2. **The delivery half of the question is unfalsifiable.** Once the removed member is correctly
   stranded, her epoch number keeps her off the topic whatever the anchor is sealed from. "She
   receives nothing" is true and worth asserting, but it is not what the property rests on and it
   catches no bug. Only the topic ID does.
3. **`exportSecret` was load-bearing for nothing measurable before this.** With the fake's value
   fixed, `crypto.exportSecret()` and any other constant were interchangeable throughout the rpc
   suite. The port doc at `packages/rpc/src/crypto.ts:4` called it "an epoch-bound
   topic-derivation secret" and no test agreed with it.

## Concerns

1. **`@kumiai/mls` still exposes no exporter-secret surface** (noted in the brief, not in scope). The
   two halves of this property are proved in two places that do not meet: the rpc suite proves the
   lane binds the topic to whatever `GroupCrypto.exportSecret()` returns, and the mls suite proves
   ts-mls's exporter secret rotates out of a removed member's reach. Nothing tests that the real
   host wires the second into the first. A host that implemented `exportSecret()` as
   `exportRecoverySecret()` would pass everything here. That is the largest remaining gap and it is
   exactly one adapter wide.
2. **`fakeEpochSecret` is XOR-with-the-epoch, so it is invertible**: a fake member holding one
   epoch's bytes can compute any other's. Deliberate and documented (the brief asked for trivial),
   and no rpc test relies on one-wayness — the removed member's candidate set is built from what she
   holds, not from what she could compute. But it means the rpc layer can never test a
   forward-secrecy claim, only a derivation-binding one. The mls test is where the one-wayness is
   real.
3. **The mutation is caught in only one place, by one assertion.** Fourteen other tests go red under
   it and none of them can say what happened. If `peer-removed-blind` is ever weakened to "she
   receives nothing" — the natural-sounding half — the suite goes back to not watching this at all.
4. `fakeEpochSecret` mixes the epoch as `(epoch + i) & 0xff`, so epochs 256 apart collide. No test
   goes past single digits.
