# Question 5.1 — the sealed reply authenticates nobody, and a forged GroupInfo hijacks a healing peer

**Status: DONE_WITH_CONCERNS.** The full compromise is reproduced, then closed. Both mechanisms are
implemented and mutation-verified. Two attacker classes remain open by construction; closing them needs
a design change (a freshness / epoch binding) that this probe does not invent — that residual is stated,
not answered. The fix also introduces a bounded, honest availability regression, documented below.

Repo `/Users/paul/dev/yulsi/kumiai`, branch `feat/control-ledger-lane`. Tree was green at `7459db4`
(mls 294). After the fix: **mls 298 (24 files), rpc 162 + 1 skipped (27 files), whole monorepo green** —
`build && lint && test` output at the end.

---

## 1. The defect, confirmed

`packages/mls/src/crypto.ts:332` — the seal is HPKE **base mode** (`const mode = 0`). Base mode seals to
the recipient's **public** key alone. Every input to the reply's AAD and `info` — `groupID`, requester
DID, `requestID`, and the ephemeral **public** key — rides the request token in the clear, on a topic
the design itself calls *"public and secretless"*. So **anyone who observes one rendezvous request can
seal a reply that opens.**

The ledger path survives on its head check (`bootstrapLedger` re-derives every id and gates on the
MLS-authenticated `ledger_head`); only its doc comment overclaimed. **The GroupInfo path was a full
compromise:** `openSealedGroupInfo` validated only that the plaintext *parsed* as a framed
`MLSMessage(GroupInfo)`, and nothing bound that GroupInfo to the group being healed —
`joinGroupExternal` builds the returned handle from the **caller's** credential, so the handle reports
the expected group id whatever group it actually joined.

---

## 2. The red — before any fix (captured verbatim)

Test: an attacker holding **no state of the real group** builds its own MLS group under the real group
id (own genesis anchor, `ledger_head = genesisHead(groupID)`, the victim's genuine published KeyPackage
spliced in as a second leaf via a plain MLS Add so the head stays at genesis), exports a GroupInfo, and
seals it by calling `hpke.seal` **directly** over the AAD and `info` reconstructed from the public
request — exactly the negative-case construction `recovery-ledger.test.ts` already uses for the hub, but
here expected to **succeed**. The victim opens it, `joinGroupExternal`s it, and we print what it believes.

Pre-fix, `openSealedGroupInfo` **succeeded**, `joinGroupExternal` **succeeded**, and the victim's beliefs
printed verbatim:

```
VICTIM BELIEFS AFTER HIJACK:
{
  "handleReportsGroupID": "forgery-target",
  "realGroupID": "forgery-target",
  "groupIDMatchesExpectation": true,
  "roster": {
    "attacker(mallory)": "admin"
  },
  "attackerIsAdmin": true,
  "victimHasAnyRole": false,
  "realAdminAliceInRoster": false,
  "isLedgerComplete": true,
  "anchorCreatorDID": "attacker(mallory)"
}
```

And the epoch secret is one the attacker holds: the attacker advanced its own policy-free MLS client over
the victim's rejoin commit and **decrypted the victim's next application message in the clear** — that
assertion passed. So the victim believed it had healed into `forgery-target` with `isLedgerComplete()`
== `true` (its own completeness invariant certifying the hijack as healthy), the attacker as sole admin,
the real admin gone, and every subsequent message readable by the attacker.

The attack reproduced exactly as the reviewer walked it. No `BLOCKED` at Step 1.

---

## 3. The fix — two mechanisms, not alternatives

`packages/mls/src/recovery.ts`, `packages/mls/src/group.ts`.

### (a) Bind the reply to the group — zero availability cost

`openSealedGroupInfo` now byte-compares the offered GroupInfo's `groupContext.groupId` against
`group.groupID`, **and** its genesis-anchor extension data against the requester's own
(`readGroupAnchorExtension`, byte-for-byte — never a re-encode). A new `readGroupInfoBinding` in
`group.ts` reads those two fields structurally. `joinGroupExternal` additionally refuses a GroupInfo whose
group id does not equal `credential.groupID`, so a caller cannot join a group its own credential does not
name. The anchor is immutable for the group's whole life and the requester already holds it, so this is a
comparison, not a trust decision — **zero availability cost.**

### (b) Authenticate the responder — real hazard, reasoned below

The GroupInfo reply now carries a **membership attestation**: the responder signs a token
(`group.recovery-groupinfo`, `embedLongForm` so it verifies offline) binding the group, the request, and
a SHA-256 digest of the exact GroupInfo bytes, with its DID identity key. `sealGroupInfo` gained an
`identity` parameter (the responder's own signing identity) and frames `[len][attestation][GroupInfo]`
inside the AEAD. `openSealedGroupInfo` verifies that signature, checks the bindings, and requires the
signer to hold a leaf in the **requester's own last-known ratchet tree** (`findMemberLeafIndex`) — the
exact mirror of the roster check `sealToRequest` makes on the ask direction. This makes the rendezvous
roster-intrinsic in **both** directions.

The `SealedGroupInfoRejection` type gained `'unauthenticated'` (bad/absent attestation, wrong bindings,
or signer not in the requester's tree) and `'group-mismatch'` (wrong group id or anchor).

**The hazard, reasoned explicitly.** The requester's tree is stale *by construction* — that is why it is
healing — so a strict check against it cuts both ways, and I did not assume it away:

- A responder who joined **after** the requester's last-known epoch is not in that tree, and is refused
  even when perfectly honest (see the availability analysis).
- A member removed **after** the requester's last-known epoch is still in that tree, and is accepted.

I did **not** additionally require the offered `ledger_head` to extend the requester's head. Evaluated and
rejected: a head is a hash chain, so "extends" is not locally verifiable from two endpoints without the
intermediate entry ids — the requester would have to gather the ledger delta first, coupling the two
rendezvous. The only locally-checkable special case ("offered head is genesis while the requester's own
head is non-genesis → reject") does nothing for the peer this path exists for — the crashed-mid-rejoin
peer holds an **empty** ledger at genesis, so every forged genesis head trivially clears it. The check
would add cost without protecting the target, so it is not adopted.

---

## 4. Mutation checks — each mechanism is load-bearing

Reverting one check and re-running `recovery-forgery.test.ts` + the two existing recovery suites:

**Revert (a)** (comment out `assertGroupInfoBoundToGroup`): **1 failed, 19 passed.** The one that went
red is *"a current member cannot redirect a healer to a different group"* — a member (Carol, in Bob's
tree, so she passes (b)) offering a same-id but wrong-anchor forged group. Her reply now **resolved
instead of rejecting**. The never-member and removed-member tests stayed **green** — (b) still catches
them. So (a) is the sole guard against an *authenticated* member steering a healer onto a fabricated
group.

**Revert (b)** (comment out `assertResponderIsMember`): **3 failed, 17 passed.**
- *"a removed member cannot answer, even holding the real anchor"* — **resolved instead of rejecting**:
  the removed member holds the real anchor, so (a) passes; (b) was the only thing refusing her. This is
  the clean (b) owner.
- *"an honest heal … names the responders the fix now refuses"* — the post-join responder's reply now
  **opened**, confirming (b) was what refused her.
- *"an observer with no group state cannot answer"* — did **not** open; it stayed refused, but the reason
  flipped from `unauthenticated` to `group-mismatch` (the never-member's own anchor still fails (a)), so
  the reason assertion went red. **The never-member is caught by both checks; neither alone lets it
  through** — reported here as "what did not go red."

The two existing recovery suites (`recovery.test.ts`, `recovery-ledger.test.ts`) stayed green under both
mutations — no assertion in them was weakened; they were updated only to pass the responder `identity`
the new wire format requires.

---

## 5. Availability — an honest heal still works, and which honest responders it now refuses

Test *"an honest heal still works, and names the responders the fix now refuses"*:

- **Honest heal succeeds.** A responder present in the requester's last-known tree (Alice) seals; the
  requester opens, `joinGroupExternal`s, and traffic flows both ways — **even though the responder's own
  tree has since moved on** (she added a new member after the request). The check is against the
  requester's tree, and Alice is in it, so staleness on the *responder's* side does not break heal.
- **The residual availability cost, named.** A responder who joined **after** the requester's last-known
  epoch (Dave) is **not** in the requester's stale tree, so the fix refuses his honest reply
  (`unauthenticated`). In a group whose only online member joined after the requester left, heal is
  unavailable until a still-known member comes online. This is a real regression against a design that
  already bricks when nobody can answer (question 4.1's territory). It is the unavoidable price of a
  stale-tree responder check; removing it would reopen the removed-member hole.

---

## 6. Residual attacker classes — enumerated

After (a) [group-id + anchor byte-binding] and (b) [DID-signed attestation + signer in the requester's
last-known tree]:

| Class | Status | By what |
| --- | --- | --- |
| **Never a member** | **Closed** | (b) unconditionally — the observer holds no leaf in the requester's tree. Also (a) *when the anchor carries a secret* (Kubun stores a recovery seed in the anchor's `app` field; an observer cannot reproduce the bytes). If the anchor were fully public, (a) alone would not exclude an observer who knows the creator DID and rebuilds the anchor — **(b) is the reliable closer.** |
| **Removed before the requester's last-known epoch** | **Closed** | (b) — the removal already took their leaf out of the requester's stale tree. (a) does not catch them: they hold the real anchor. |
| **Removed after the requester's last-known epoch** | **OPEN** | Still in the requester's stale tree, so (b) accepts them; they hold the real anchor, so (a) accepts them. |
| **Current member** | **OPEN** | An authorized responder. (a)+(b) bind the reply to a *real, current* member and a *correctly-anchored* group, but do not bind the offered GroupInfo to the group's actual current state (epoch, tree, head). A malicious current member can still present a fabricated-but-correctly-anchored GroupInfo (e.g. genesis head, spliced tree), and the requester's completeness invariant reads it healthy because an empty ledger matches a genesis head. |

**Severity after the fix:** the novel escalation — *any observer* achieving full compromise, including the
epoch secret — is closed. What remains is narrower: a current or recently-removed member can present a
fork. A current member already holds the epoch secret, so "reads the traffic" is not new for them; the
residual is a roster/epoch downgrade and a fork, not a new key-compromise vector. A correctly-anchored
forged group also cannot promote the attacker — the roster seeds from the real anchor, whose creator the
attacker's key does not control.

### The `BLOCKED` sub-finding — stated, not answered

**Closing the removed-after and current-member classes needs a design change this probe must not invent.**
The stale tree cannot distinguish "removed after the requester left" from "still a member," and it cannot
bind the offered GroupInfo to the group's *current* epoch. Fully closing these requires a **freshness
proof** on the reply — an epoch binding, or a responder token scoped to the current epoch, that a
crashed-at-an-older-epoch requester can still verify without being able to fetch the current epoch first.
That is a protocol design question (it interacts directly with the epoch-independence the rendezvous
depends on, and with question 4.1's availability floor), and it is left open here rather than answered.

---

## 7. Doc comments corrected (both packages)

Every comment that claimed the AEAD proves a member sealed the bytes was false and is corrected:

- `packages/mls/src/recovery.ts` — `openSealedGroupInfo` (was the "The AEAD proves a group member sealed
  these bytes" comment): now states the seal is base mode and proves only ephemeral-key possession; the
  attestation and the anchor binding are what make the reply roster-intrinsic.
- `packages/mls/src/recovery.ts` — `openSealedLedger`: now states opening proves **nothing** about who
  sealed the tokens (an observer can forge a ledger reply that opens); the bound is `bootstrapLedger`'s
  head check — withhold, never rewrite — and a forged reply that merely decrypts is a DoS, not a
  compromise.
- `packages/rpc/src/crypto.ts` — `sealGroupInfo` port doc: now states the reply carries a DID-signed
  membership attestation the requester verifies, because the base-mode seal authenticates no one.
- `packages/rpc/src/crypto.ts` — `applyRecovery` port doc: `null` is not the seal's doing; a hub-injected
  reply may decrypt, and it is the responder attestation + anchor binding that refuse it.
- `packages/rpc/src/crypto.ts` — `openSealedLedger` port doc: opening proves nothing about the sealer;
  the head check is the bound.

---

## 8. Files touched

- `packages/mls/src/recovery.ts` — attestation type + framing; `sealGroupInfo(identity)`;
  `openSealedGroupInfo` responder-auth + group-binding; extended rejection type; corrected docs.
- `packages/mls/src/group.ts` — `readGroupInfoBinding`; `joinGroupExternal` group-id guard.
- `packages/rpc/src/crypto.ts` — corrected port docs (doc-only; the rpc port is a mock in tests and does
  not call the mls implementation, so behavior is unchanged).
- `packages/mls/test/recovery-forgery.test.ts` — new: never-member refused (b), member-wrong-anchor
  refused (a), removed-member refused (b), honest-heal + availability residual.
- `packages/mls/test/recovery.test.ts`, `packages/mls/test/recovery-ledger.test.ts` — pass the responder
  `identity` the new wire format requires; no assertion weakened.

Nothing committed.

---

## 9. Verify output (repo root, `rtk proxy`)

```
$ rtk proxy pnpm run build
 Tasks:    7 successful, 7 total
Cached:    3 cached, 7 total
  Time:    1.892s

$ rtk proxy pnpm run lint
$ biome check --write ./packages ./tests
Checked 193 files in 210ms. Fixed 3 files.   # formatting only

$ rtk proxy pnpm test
@kumiai/mls:test:unit:  Test Files  24 passed (24)
@kumiai/mls:test:unit:       Tests  298 passed (298)
@kumiai/rpc:test:unit:  Test Files  27 passed (27)
@kumiai/rpc:test:unit:       Tests  162 passed | 1 skipped (163)
 Tasks:    27 successful, 27 total
Cached:    12 cached, 27 total
  Time:    10.131s
```
