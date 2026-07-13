# Probe brief — Question 2.1

## The question

**Does a commit really rotate the committer's leaf HPKE key?**

- **Assumption (G14's premise):** every MLS Commit carries an UpdatePath that installs a **fresh
  leaf HPKE key for its author**. So a peer that committed — and then lost the result — cannot open
  a recovery reply sealed to the leaf key the rest of the group can still see for it.
- **Done when:** a test demonstrates it **directly**, in two halves:
  1. the committer's leaf `encryption_key` in the post-commit ratchet tree **differs** from the
     pre-commit one; and
  2. the **pre-commit private key does not open** an HPKE seal made to the **post-commit** public
     key. Bytes differing is not proof the old private key is useless — seal and fail to open it.
- **⚠️ Wrong-but-passing:** running this against a **non-committing** member. Leaf-sealing works
  perfectly for that peer, which is exactly how the flaw survived three revisions of the spec. The
  seal must be aimed at the **committer's** stale leaf and it must fail.

## Why this question exists, and why it is read-only

This is a **verification probe, not a feature**. The entire ephemeral-key sealing design in question
2.2 exists *only* because leaf-sealing fails for the committer. If the premise turns out **false**,
that machinery is unnecessary and we stop and revise the spec rather than build it.

So: **expect to change no `src/` code at all.** If you find you need a `src/` change to answer the
question, that is itself a finding — report it rather than making it.

The failure this premise describes, concretely:

> A member commits. The hub **accepts**. The member's process dies before it adopts the new group
> handle, so it is left holding a pre-commit handle while the group has moved on. It later calls
> `recover()`. A responder seals the reply to the requester's leaf key **as the responder sees it in
> the current tree** — which is the **post-commit** key, installed by the requester's own
> now-forgotten commit. The requester holds only the **pre-commit** private key. It cannot open its
> own rescue.

Note the asymmetry that makes this subtle: the *other* recovery case — the trim-strand peer, the one
that was merely behind and never committed — has a leaf the group sees and it *can* open a
leaf-sealed reply. A test written with that peer passes and proves nothing.

## Spec excerpt (verbatim)

> the committer's path is whose path a commit rotates — every Commit carries an UpdatePath
> installing a fresh leaf HPKE key for its author… Only the trim-strand peer — the one that was
> merely behind — could open its own rescue.

## The approved approach

1. **Read first.** `packages/mls/src/group.ts` for how commits are built and applied
   (`commitInvite`, `commitLedgerEntries`, and whatever adopts the new handle). `ts-mls` for the
   ratchet-tree and UpdatePath types — where a leaf node's `encryption_key` (HPKE public) lives, and
   where a client's own leaf **private** key is held in its `ClientState`.
   `packages/mls/test/ts-mls-spike.test.ts` is precedent for a test that interrogates the library
   directly; follow its shape.

2. **The test.** Build a small group. Have a member **commit** (any commit that carries an
   UpdatePath — say the ordinary add/ledger path the code already uses). Capture, around the commit:
   - the committer's leaf `encryption_key` from the tree **before**, and the matching **private**
     key from its pre-commit `ClientState`;
   - the committer's leaf `encryption_key` from the tree **after**, as seen by **another member**
     (this is the point: the responder seals to what *it* sees, not to what the committer kept).

   Then assert both halves: the public keys differ, **and** HPKE-seal something to the post-commit
   public key and show the pre-commit private key **fails to open it**. Use whatever HPKE the repo
   already uses for sealing (find it — do not invent a second one).

3. **Also pin the negative control.** In the same test file, show the **non-committing** member's
   leaf key is *unchanged* by someone else's commit, so its pre-commit private key **does** open a
   seal to what the group sees. That is the case leaf-sealing handles — naming it explicitly is what
   stops someone re-deriving the broken design later. Two members, two outcomes, one file.

4. **If the premise is false** — the committer's leaf key does *not* rotate, or the old private key
   *does* open the new seal — **stop and report it**. Do not work around it, do not try another
   commit type without asking. That answer kills the ephemeral machinery and the spec changes.

## Rules

- **BLOCKED on the first failure of the approach.** Do not try alternatives without asking.
- **No `src/` changes.** If the question cannot be answered without one, report why.
- Everything currently green stays green.

## Conventions

`kigu:conventions` skill and the repo's `AGENTS.md`. `type` not `interface`; `Array<T>`; never
`any`; capital `ID`; ES `#fields`. **Code, comments and test names never reference plan questions,
phase labels, or G-numbers** — state the fact directly ("a commit rotates its author's leaf HPKE
key").

## Verify

```
rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test
```

from the repo root (`rtk proxy` prefix required). Include the output. Note: an `mls` test has flaked
once per run under parallel load in earlier questions and does not reproduce in isolation. If you
see it, re-run `mls` alone and report both results rather than investigating.

## Report contract

Write to `docs/superpowers/probes/question-2.1-report.md`:

- **The answer, first line: does a commit rotate the committer's leaf HPKE key — yes or no.**
- The mechanism, with `file:line` into `ts-mls`: *where* the fresh leaf key is installed, and
  *where* the committer's own private half is replaced. Do not paraphrase the spec back — show the
  code path.
- The test, and its pasted output. Both halves (keys differ; old private key fails to open), plus
  the non-committing negative control.
- **Whether the committer can recover its own private key from anything it still holds.** If it can,
  the whole premise softens and 2.2 changes — say so loudly.
- Anything surprising about how `ts-mls` handles a commit the author never adopts.
- The full verify output.

**Return to the caller only:** status, a one-line test summary, concerns. Do not commit.
