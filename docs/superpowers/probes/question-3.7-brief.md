# Question 3.7 — does the lane outrun the mailbox and destroy downloaded messages? (G28)

Repo `/Users/paul/dev/yulsi/kumiai`, branch `feat/control-ledger-lane`. **Tree is green and committed
at `b2143e7`** (rpc 148, mls 287, 27/27). This is the **last question of Phase 3**, and the design's
purest silent failure.

Read first: `packages/rpc/src/peer.ts` (`buildEpoch`, `rebuildEpoch`, `pullCommits`, and every
`rebuildEpoch()` call site), `packages/rpc/src/topic.ts`, `packages/rpc/test/fixtures/fake-crypto.ts`.

---

## The question

> **Assumption:** an app frame is decryptable only from its own epoch's secret tree, `ts-mls` keeps
> **4 epochs by default** (`defaultKeyRetentionConfig.retainKeysForEpochs`), and a pull-driven commit
> lane that replays to head at step 0 therefore blows past the keys for every app frame already sitting
> in the mailbox.

## The spec, verbatim

> Today commits and app messages share one mailbox and drain in sequenceID order, so a commit is
> applied only after the app messages that preceded it. The interleave costs nothing and nobody had to
> think about it. **D1 makes the commit lane a separate, pull-driven lane that runs at lane step 0** —
> so replay races to the head while the mailbox is still full. Five commits later, every app frame the
> peer had already downloaded is undecryptable. The peer is perfectly in sync, the roster matches, no
> error is raised, and a week of messages is gone.
>
> The rule, which is local — the peer has every frame in hand and every epoch is readable without a key:
>
> > **Never apply the commit that leaves epoch E while app frames at epoch E are still undecrypted.**
> > Replay drains the mailbox up to E, applies the commit, drains E+1, applies, and so on. The lane
> > advances the group only as fast as the consumer drains it.
>
> Raise `retainKeysForEpochs` above 4 as well, but as a safety net for ordinary out-of-order delivery —
> *not* as the fix. **The fix is the ordering rule; a bigger retention window only widens the race it
> loses.**

At D1's target volume — 100 commits/day, the whole control plane on the ledger — **four epochs is under
an hour. A member offline over lunch loses its messages.**

## ⚠️ Wrong-but-passing: *everything*

This is the plan's only question whose wrong-but-passing note is a single word. The peer converges. The
epoch is right. The roster matches. `head` matches. **Nothing throws, anywhere. And a week of messages
is simply gone.** Every single existing test still passes.

**The only assertion that catches it is the plaintext of a message sent at an old epoch.** Do not assert
"no error". Do not assert convergence. **Assert the bytes.**

---

## Step 1 — write the failing test FIRST, and capture the red

**Before any fix.** Against the lane exactly as questions 3.1–3.6 leave it.

A peer goes offline. The group makes **ten commits** *and* sends an app message at an **early** epoch.
The peer reconnects. **Assert it reads the plaintext of that message.**

Run it. **Capture the exact failure output and put it in the report.** This is the same discipline
question 1.1 used to capture the store's failure before fixing it.

**If it PASSES without any fix, stop and report `BLOCKED`.** The premise is then wrong and the *spec*
needs revisiting, not the code. Do not go looking for a way to make it fail.

## Step 2 — establish WHAT actually broke, empirically. Do not assume.

**The spec says the keys are gone. There is reason to think that is not the whole story, and possibly
not the story at all.** Establish the real mechanism before fixing anything, and report it.

**The app lane's topics are epoch-derived.** `buildEpoch()` (`peer.ts:244`) computes
`protocolTopic(secret, epoch, name)` and `inboxTopic(secret, epoch, localDID)` from the *current* epoch,
and `rebuildEpoch()` tears those clients down and builds new ones at the new epoch. So when the commit
lane advances, the peer may not merely lose the *keys* for epoch E's frames — **it may stop being
subscribed to the topic they live on at all**, and abandon the client that would have delivered them.

Those are **different bugs with different fixes**, and it matters which one you have:

- If it is **key retention**, the spec's rule is the fix: drain what is already in the mailbox before
  applying the commit that leaves E.
- If the peer **tears down the epoch-E topic subscription**, then "drain the mailbox up to E" may not
  even *reach* the frames — and a peer with infinite key retention would still lose them. The spec does
  not mention this and the rule as written may be insufficient.
- It may be **both**, in which case say so, and say which one your test is actually catching. A fix that
  addresses one while the other silently persists is worse than no fix, because it retires the test.

**Report what you found, with evidence.** If the spec's account of the mechanism is incomplete, that is
a finding, and it outranks a green test.

## Step 3 — the fix, and the instrument

The rule: **never apply the commit that leaves epoch E while app frames at epoch E are still
undecrypted.** The peer has every frame in hand, and every frame's epoch is readable **without a key**
(it is in the cleartext header — `readMessageEpoch` in `packages/mls/src/group.ts:1458`; the fake crypto
stamps the epoch in its first two bytes for the same reason).

**On the test instrument — read this carefully, because it decides whether your test means anything.**

`createFakeCrypto` (`test/fixtures/fake-crypto.ts:56`) opens **only the current epoch**: `sealedAt !==
epoch` throws. Real ts-mls retains **4**. So the double is **stricter than reality**, and that is
*deliberately the right instrument here*: it removes the safety net entirely, so **only the ordering
rule can make the test pass**. A double with a 4-epoch window would let a broken lane pass a test that
happened to make fewer than 4 commits.

Which means: **the retention window must not be doing the work.** The spec is explicit —

> assert the interleave holds with the default still in place, or the config is doing the work and the
> bug is merely postponed.

If you raise `retainKeysForEpochs` anywhere, it is a **safety net for out-of-order delivery, never the
fix**, and you must show the test still passes **without** it.

## Definition of done

- The failing test, its red output captured in the report, **written before the fix**.
- An empirical account of the actual mechanism (keys, subscription, or both), with evidence.
- The ordering rule implemented, and the test green **because of the rule** — not because of a retention
  window, a bigger buffer, or a retry.
- **A mutation check**: remove the interleave, and show the test goes red. Then show that *nothing else*
  in the suite goes red with it — that is the measure of how silent this failure is, and it belongs in
  the report.
- **Assert the plaintext.** Every assertion in this test that is not "the bytes came back" is decoration.

## Conventions

`type` not `interface`; `Array<T>` not `T[]`; never `any`; capital `ID`/`HTTP`/`JWT`/`DID`; ES
`#fields`, never `private`/`readonly`. pnpm only. **Never edit generated `lib/`.**

**Code, comments, and test names never reference plan questions, decision numbers, or phase labels** —
no `// Q3.7:`, no `// G28`. State the invariant directly.

Verify from the repo root — **an `rtk` shim intercepts bare `pnpm run`**:

```
rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test
```

## Stop conditions

- **The test passes with no fix → `BLOCKED`.** The premise is wrong; the spec is wrong; say so.
- **The mechanism is not what the spec says → report it before fixing.** Do not quietly fix a different
  bug than the one described.
- If the fix does not work, **`BLOCKED`**. Do not invent an alternative design. Every probe in this plan
  that reported `BLOCKED` was right to, and one of them killed a fix the user had already approved.
- **Do not commit.**

## Report contract

Write `docs/superpowers/probes/question-3.7-report.md`: the red output before the fix, the mechanism you
found, the fix, the mutation check (including **what else went red — and what did not**), and the full
verify output. Return only: status, a one-line test summary, and concerns.
