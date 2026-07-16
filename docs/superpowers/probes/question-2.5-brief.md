# Probe brief — a removed member cannot derive or read the post-removal app topic

Implementation probe in `/Users/paul/dev/yulsi/kumiai`, branch `feat/app-lane-delivery`. Do NOT switch
branches, do NOT commit. Leave changes uncommitted for review.

## Context: what is already committed and true

- App-lane topics derive from the peer **anchor** `{secret, epoch}` — `protocolTopic(anchor.secret,
  anchor.epoch, name)`. The anchor is captured in `captureAnchor()` (`packages/rpc/src/peer.ts:~330`)
  from **`crypto.exportSecret()`** — the port's per-epoch secret — and rotates at every roster change.
- The anchor is persisted (`AnchorStore`, `packages/rpc/src/anchor.ts`) and restored at construction.

## The exact question

Is a member removed at the rotation commit unable to derive the new topic ID and unable to read frames
on it?

## Relevant spec excerpt (verbatim)

> **Load-bearing:** the anchor must feed the **per-epoch** `exportSecret()`, never the lifelong recovery
> secret (which removed members keep for life). A topic derived from the recovery secret plus a
> guessable epoch number would cut nobody off.

## The blocker this question must clear FIRST (established — do not re-derive)

**The fake crypto cannot express the property.** `packages/rpc/test/fixtures/fake-crypto.ts:78` is
`exportSecret: () => secret` — a **fixed** value, identical at every epoch. So the app topic in every
rpc test varies with the epoch NUMBER alone (`peer-app-topic.test.ts:35` and
`peer-anchor-restart.test.ts:31` both say so).

That fake **is** "a lifelong secret plus a guessable epoch number" — precisely the bug the spec names.
Against it, a correct implementation and the named bug are indistinguishable, so no test at this layer
can tell them apart. It also contradicts its own port doc, which calls `exportSecret` "an epoch-bound
topic-derivation secret" (`packages/rpc/src/crypto.ts:4`).

`@kumiai/mls` exposes **no exporter-secret surface** — the host derives it from ts-mls itself. That is
noted, not in scope.

## Approved approach (follow it; BLOCKED if it fights the code — do not redesign)

1. **Fix the fake first, as its own reviewable step.** `exportSecret` becomes **epoch-derived** — a
   deterministic function of `(secret, epoch)` — so the double honours the port contract it claims. Keep
   it trivial and reversible (the fake is not real crypto and must not pretend to be); the property that
   matters is only *different epoch, different bytes*. Update the two comments that assert the old
   epoch-independence (`peer-app-topic.test.ts:35`, `peer-anchor-restart.test.ts:31`) to say what is now
   true. ~15 call sites read `exportSecret()`; they read it at the epoch they care about, so most should
   be unaffected — but **any test that breaks is a finding, not a nuisance**: report it, do not paper
   over it by re-fixing the expectation until it passes.
2. **rpc test — the removed member is cut off.** New `packages/rpc/test/peer-removed-blind.test.ts`:
   remove a member, have the remaining members publish logged (`retain:'log'`) events on the rotated
   topic, and assert the removed peer (a) derives a **different** topic ID from everything it still
   holds, and (b) receives nothing. Assert the plaintext, not just the count.
3. **mls test — the crypto truth, where it is real.** `packages/mls/test/crypto.test.ts:165` already has
   `member removal with forward secrecy`, but it covers **message decryption only** — not the **exporter
   secret**, which is what the topic actually derives from. That is the gap. Add the exporter-secret
   assertion against ts-mls directly, in that file, next to its neighbour: a removed member's state is
   stuck at the pre-removal epoch and cannot produce the post-removal epoch's exporter secret. Extend or
   add a sibling test — your call, state it — but do NOT duplicate the decryption assertion.

## Done when (all required)

1. The fake's `exportSecret` is epoch-derived and the whole suite is green, with every test that moved
   reported and explained.
2. The rpc test asserts the removed member derives a different topic and receives nothing.
3. The mls test asserts a removed member cannot produce the post-removal **exporter** secret.
4. **Mutation check (required, and the point of all of it)** — change `captureAnchor` to seal the anchor
   from the **recovery secret** instead of `crypto.exportSecret()`. The rpc removed-member test MUST go
   red (the removed member walks back onto the topic). Paste the failure. This is the spec's named bug,
   and nothing in the suite can catch it today. Revert, confirm green, no residue.
5. **Second mutation (required)** — revert the fake to `exportSecret: () => secret` and confirm mutation
   (4) goes **green again**. That is the proof the fixture fix is what makes the property testable at
   all. Paste it, revert, confirm green.

## Scope boundary

The removed-member property + the fake fix ONLY. No returning-member drain. No pruned-window event. Do
not touch `detectRosterChange`, the external signal, or the anchor store — all committed and correct. Do
not add an exporter-secret surface to `@kumiai/mls`.

## Conventions

`kigu:conventions` + repo `AGENTS.md`/`CLAUDE.md`. `type` not `interface`; `Array<T>`; no `any`; capital
`ID`; `#fields`; never edit `lib/`. Code/comments/tests never name plan questions or phases — state the
invariant ("a removed member keeps the recovery secret for life and every topic ID it ever derived; it
is the per-epoch secret it cannot follow").

## Verify (repo root, paste real output)

`pnpm run build && rtk proxy pnpm run lint && pnpm test`
(`pnpm run lint` alone → eslint via the `rtk` shim; use `rtk proxy pnpm run lint`.)

## Report contract

Full report → `docs/superpowers/probes/question-2.5-report.md` (changes with file:line, both mutation
results pasted, every test that moved when the fake changed and why, surprises, concerns). Return ONLY:
status, uncommitted-changes note, one-line test summary, concerns. No full diff.
