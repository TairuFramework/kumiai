# Question 5.1 — the sealed reply authenticates nobody, and a forged GroupInfo hijacks a healing peer

Repo `/Users/paul/dev/yulsi/kumiai`, branch `feat/control-ledger-lane`. **Tree is green and committed at
`7459db4`** (rpc 162 + 1 skipped, mls 294, 27/27). This came out of a **code review of the finished
branch**, not from the plan. It is the most serious finding in the project.

Read first: `packages/mls/src/recovery.ts` (`sealToRequest`, `openSealedReply`, `sealGroupInfo`,
`openSealedGroupInfo`, `recoveryAAD`), `packages/mls/src/crypto.ts` (the HPKE implementation —
`keySchedule`, line ~332), `packages/mls/src/group.ts` (`joinGroupExternal` ~1627, `bootstrapLedger`
~527, `isLedgerComplete`), `packages/mls/src/anchor.ts`, `packages/mls/test/recovery.test.ts` and
`recovery-ledger.test.ts` (the existing adversarial tests — they are good, and they are the model).

---

## The defect, confirmed

**The seal is HPKE base mode.** `packages/mls/src/crypto.ts`:

```ts
const mode = 0 // mode_base
```

Base mode requires only the recipient's **public** key to seal. And every input to the AAD and the
`info` — `groupID`, the requester's DID, the `requestID`, and the ephemeral **public** key — rides the
wire **in the clear inside the request token**, on a topic the design calls *"public and secretless"*.

**So anyone who observes one rendezvous request can forge a reply that opens.** The hub. A removed
member. A stranger who learned the topic.

The code asserts the opposite, in three places. `recovery.ts:488`:

> *"The AEAD proves a group member sealed these bytes for this request"*

It proves nothing of the kind. **The roster check is entirely on the ASK direction. The ANSWER
direction has no authentication at all.**

### The ledger path survives. The GroupInfo path does not.

**The ledger reply is saved by the head check** — `bootstrapLedger` re-derives every id from the token
bytes and gates on the MLS-authenticated `ledger_head`, which a forger cannot hit. That is exactly the
bound the spec claims. Only the doc comment overclaims. (Residual: a forged reply *opens* rather than
being refused, so an attacker can burn a peer's gather attempts at will. Note it; it is a DoS, not a
compromise.)

**The GroupInfo reply is a full compromise of the healing peer.** `openSealedGroupInfo` validates only
that the plaintext *parses* as a framed `MLSMessage(GroupInfo)`. **Nothing binds that GroupInfo to the
group being healed:**

- `openSealedGroupInfo` never compares the offered `groupContext.groupId` against `group.groupID`.
- `joinGroupExternal` never compares it against the credential either — it checks
  `identity.id === credential.id` and nothing else — and it builds the returned `GroupHandle` from the
  **caller's** credential, so the handle *reports the expected group id whatever group it actually
  joined*.

The attack, as the reviewer walked it: build your own MLS group with `group_id` set to the real one, a
genesis-anchor extension naming yourself creator and admin, `ledger_head = genesisHead(groupID)`, and
two leaves — your own, plus the victim's genuine KeyPackage leaf (a `key_package`-source LeafNode binds
neither group id nor leaf index, so it splices in and passes validation). Export a GroupInfo, sign it
with your own leaf key, HPKE-seal it to the ephemeral key from the victim's request with the correct
AAD. Then:

- `openSealedGroupInfo` **succeeds**.
- `joinGroupExternal({ resync: true })` matches the victim's prior leaf **by signature public key** —
  the victim's *public* DID key — so the external commit builds.
- **`isLedgerComplete()` returns `true`**: an empty ledger against the attacker's genesis head. *The
  peer's own completeness invariant certifies the hijack as healthy.*
- The roster folds from the attacker's anchor. The attacker is admin.
- Everything the peer sends afterwards is encrypted under an epoch secret the attacker holds.

**The suite is green because no test ever seals a reply from a party with no group state at all.** Every
responder in every existing test is a real member.

---

## Step 1 — the red, before any fix. This is not optional.

Write the test that does not exist: **a reply sealed by a party with NO group state**, built by calling
`hpke.seal` directly with the AAD and `info` reconstructed from the public request — exactly as
`recovery-ledger.test.ts`'s hub-attacker test already does for its *negative* case, except this one is
expected to **succeed** today.

Then carry it through: the victim `openSealedGroupInfo`s it, `joinGroupExternal`s it, and **assert what
it ends up believing** — its roster, its `isLedgerComplete()`, and whether its epoch secret is one the
attacker also holds. **Capture that output verbatim in the report.** The value of this probe is as much
in showing what the peer believes after the hijack as in preventing it.

**If the attack does not reproduce, stop and report `BLOCKED`** with what actually stopped it. Do not go
looking for a variant that works.

## Step 2 — the fix. TWO mechanisms, and they are not alternatives.

### (a) Bind the reply to the group — required, and it costs nothing

`openSealedGroupInfo` must byte-compare the offered GroupInfo's **`groupContext.groupId`** against
`group.groupID`, **and** its **genesis-anchor extension** against the requester's own
(`readGroupAnchorExtension`). The anchor is **immutable for the group's whole life** and the requester
already holds it, so this has **zero availability cost** and it kills every attacker who was never a
member. Also add the assertion inside `joinGroupExternal` itself — a caller should not be able to join
a group its credential does not name.

### (b) Authenticate the responder — required, and it has a real hazard

The anchor check alone does **not** stop a **removed member**: they hold the real anchor and the real
group id, and they hold the victim's leaf from the tree they had. They can build the same forged group
and it passes (a).

The mirror already exists and is unused: `openSealedGroupInfo` **has the requester's own handle** and
therefore a ratchet tree. Make the responder prove membership — sign the reply with its DID identity
key, or use HPKE **auth** mode — and have the open side require the signer to hold a leaf in the
requester's last-known tree. That is exactly symmetric to `sealToRequest`'s check, and it makes the
rendezvous roster-intrinsic in **both** directions.

**⚠️ The hazard, and you must reason about it explicitly rather than assuming it away.** The
requester's tree is **stale by construction** — that is why it is healing. So:

- **A responder who joined AFTER the requester went away is not in the requester's tree**, and a strict
  check refuses a perfectly honest healer. In a small group that may be the *only* member online. **A
  fix that makes heal unavailable is not a fix** — this design already has a peer that bricks when
  nobody can answer, and question 4.1 exists because of it.
- **A member removed AFTER the requester went away IS in the requester's stale tree**, and a strict
  check accepts them. So the stale tree does not fully exclude the attacker it is meant to exclude.

**Report which attacker classes remain open after your fix.** Enumerate them: never-a-member;
removed-before-the-requester-left; removed-after; current member. Say plainly which are closed, which
are not, and what would close the rest. **An honest account of the residual is worth more than a claim
of completeness** — and if closing the removed-after case needs a design change (a freshness proof, an
epoch binding, a responder token scoped to the current epoch), **that is a `BLOCKED` finding and you
must not invent the design.**

Consider — and evaluate, do not merely adopt — whether the offered GroupInfo's **`ledger_head` must
extend the ledger head the requester already holds**. The head chain is append-only, so a genesis head
cannot extend a non-empty one. Note the case that defeats it: the crashed-mid-rejoin peer holds an
**empty** ledger, and it is exactly the peer this path exists for.

## Step 3 — the doc comments are part of the defect

`recovery.ts:488`, `recovery.ts:592`, and the `GroupMLS` port docs in `packages/rpc/src/crypto.ts:178`
and `:211` all claim the AEAD proves a member sealed the bytes. The spec's D2 section says
`applyRecovery` returns `null` for **"hub-injected"** bytes. **All of these are false today.** Correct
every one of them to say exactly what the mechanism does prove, after your fix.

## ⚠️ Wrong-but-passing

- **A test where the forger is a real member of some other real group.** They hold group state, so
  several accidental checks may catch them. **The attacker in the red test must hold NO group state** —
  just the bytes off the wire.
- **Asserting the open throws.** Assert **what the victim believes** if it does not: the roster, the
  completeness invariant, the epoch secret. A hijack that raises no error is this design's signature
  failure and the assertion must name it.
- **Fixing (a) and declaring victory.** (a) is green against the never-member. The removed member walks
  straight through it.

## Definition of done

- The red, captured verbatim, with the victim's post-hijack beliefs printed.
- (a) and (b) both implemented, or (b) reported `BLOCKED` with the design question stated.
- **A mutation check on each**: revert the binding, show the test goes red; revert the responder check,
  show the removed-member test goes red. Report what else went red — **and what did not.**
- **The availability test**: an honest heal still works, including under the staleness the fix
  introduces. Say which honest responders your fix now refuses.
- The residual attacker classes, enumerated.
- Every false doc comment corrected, in **both** packages.
- `packages/mls/test/recovery.test.ts` and `recovery-ledger.test.ts` must stay green — if the wire
  format changes, they change with it, but **no assertion may be weakened.**

## Conventions

`type` not `interface`; `Array<T>` not `T[]`; never `any`; capital `ID`/`HTTP`/`JWT`/`DID`; ES
`#fields`, never `private`/`readonly`. pnpm only. **Never edit generated `lib/`.**

**Code, comments, and test names never reference plan questions, decision numbers, or phase labels.**
State the invariant directly.

Verify from the repo root — **an `rtk` shim intercepts bare `pnpm run`**:

```
rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test
```

## Stop conditions

- **The attack does not reproduce → `BLOCKED`**, with what stopped it.
- **Closing an attacker class needs a design change → `BLOCKED`.** State the question; do not answer it.
- **Do not commit.**

## Report contract

Write `docs/superpowers/probes/question-5.1-report.md`: the red (with the victim's beliefs), the fix,
both mutation checks, the availability analysis, the enumerated residual attackers, the corrected doc
comments, and the full verify output. Return only: status, a one-line test summary, and concerns.
