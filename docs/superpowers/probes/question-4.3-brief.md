# Question 4.3 — does the ledger gather leak the ledger to the relay?

Repo `/Users/paul/dev/yulsi/kumiai`, branch `feat/control-ledger-lane`. **Tree is green and committed at
`762e047`** (rpc 155 + 1 skipped, mls 287, 27/27). This question was **added by question 4.2**, which
found the hole while auditing the acceptance list.

Read first: `packages/rpc/src/recovery.ts` (the frame codecs), `packages/rpc/src/peer.ts`
(`handleLedgerRequest` ~568, `ensureLedger` ~1035, `handleRecoveryRequest` ~510, `recover()` ~1300),
`packages/rpc/src/crypto.ts` (the `GroupMLS` port: `createRecoveryRequest`, `sealGroupInfo`,
`applyRecovery`, `isLedgerComplete`, `getLedger`, `bootstrapLedger`), `packages/mls/src/recovery.ts`
(`createRecoveryRequest`, `sealGroupInfo`, `openSealedGroupInfo`, `recoveryAAD`),
`packages/rpc/src/memory-group-mls.ts`, and `packages/mls/test/recovery.test.ts` — **that last one is
the model for the test you must write.**

---

## The defect

`handleLedgerRequest` answers a bootstrap gather with:

```ts
encodeHandshakeFrame(
  HANDSHAKE_KIND.ledgerReply,
  encodeLedgerReply(request.requestID, await port.getLedger()),
)
```

**`encodeLedgerReply` does not seal.** The signed entry tokens go onto the rendezvous topic in
**plaintext**. Question 4.2 confirmed it empirically: in a heal where the ledger holds
`role:carol=admin`, that exact string appears in the clear in `hub.published`.

**And it is worse than a passive leak.** `encodeLedgerRequest(requestID)` carries an **empty payload** —
no requester identity, no key, nothing. The rendezvous topic is **public and secretless by design**
(`topic.ts`). So *any* party that knows the topic — the hub, a removed member, a stranger — can publish
a ledger request, and **every complete member will answer with the group's whole ordered authority
state, in the clear.** Every role, every promotion, every demotion, in order.

These are the **same bodies** the commit frame goes out of its way to seal under the epoch secret, and
that `peer-ledger-bodies.test.ts` asserts the hub never sees (`leakedBody === false`). The commit lane
protects them and the heal lane hands them over on request.

## The approved fix: mirror D2

D2 already solved this problem **for GroupInfo**, and the ledger gather is the same rendezvous in the
other direction. It never got the same treatment.

1. **The ledger request carries the port's signed request blob**, exactly as the recovery request does —
   `encodeLedgerRequest(requestID, request)`. The requester's DID and its ephemeral public key live
   **inside the signature**, where the responder can trust them. `recovery.ts`'s own header comment
   already states the rule: *"a peer that put the DID in a field of its own beside the token would be
   offering the responder an unsigned one to seal against."* Do not invent a second request format —
   `createRecoveryRequest(requestID)` mints exactly this and retains the private half keyed by
   `requestID`.
2. **The responder authorizes against the roster and seals to the ephemeral key.** `sealGroupInfo`'s
   authorization is *roster-intrinsic* — `group.findMemberLeafIndex(verified.requesterDID) ===
   undefined` → throw, stay silent. The ledger seal must use the identical check. **A removed member,
   and the hub, must get nothing.**
3. **The requester opens it with the key minted for that `requestID`**, and `bootstrapLedger` verifies
   the head exactly as it does today. **The head check does not change and must not be weakened** — a
   responder can still withhold, never rewrite.

### Why NOT the epoch secret — this is the wrong-but-passing fix, and it is the obvious one

Wrapping the reply under the responder's current epoch secret is what the commit frame does, it is a
smaller diff, and **it is green in every test where nobody is behind.**

At the seed, `ensureLedger` runs **BEFORE** `pullCommits` (`peer.ts` ~882: `replayJournal` →
`ensureLedger` → `pullCommits`). So the requester — a peer that crashed between its rejoin and its
bootstrap — may be at an **older epoch than the responder**. A reply sealed at the responder's current
epoch is then **unopenable by the very peer that asked for it**, and ts-mls retains only 4 epochs, which
at this design's commit volume is under an hour. The group heals, the hub sees nothing, and the peer is
stranded with an empty ledger **reporting itself healthy.** It also does nothing whatever about the
anonymous request.

The ephemeral seal is **epoch-independent**, which is precisely why D2 chose it. **Prove that property
holds here**: a test in which the requester is at an *older epoch* than the responder and still
bootstraps.

## What to build, and where

- **`packages/mls/src/recovery.ts`** — `sealGroupInfo` currently calls `exportGroupInfo` internally, so
  the seal is welded to its payload. Factor the HPKE seal/open out so the same verified-request →
  sealed-bytes machinery can carry the ledger, and have `sealGroupInfo` delegate to it. **Do not change
  `sealGroupInfo`'s behaviour or its wire format** — `packages/mls/test/recovery.test.ts` must stay
  green, untouched.
- **Domain separation is a requirement, not a nicety.** A sealed ledger reply and a sealed GroupInfo
  must not be interchangeable. In practice the two use different `requestID`s so the AAD already
  differs — **but do not rely on that.** Give the ledger seal a distinct label in its `HPKE_INFO` or
  AAD, and **write the test that a GroupInfo reply does not open as a ledger and vice versa.**
- **`packages/rpc/src/crypto.ts`** — the `GroupMLS` port gains the two methods, documented in the same
  register as their neighbours (state the invariant, not the mechanism).
- **`packages/rpc/src/recovery.ts`** — `encodeLedgerRequest` gains the signed blob; `encodeLedgerReply`
  carries sealed bytes. Wire-format break; pre-1.0, no compatibility shim.
- **`packages/rpc/src/memory-group-mls.ts`** — the double implements both. **The double must be able to
  refuse**: a request from a DID with no leaf must throw, or the authorization test cannot fail. The
  standing lesson of this plan is that *a test double that cannot lie is not a test.*
- **`packages/rpc/src/peer.ts`** — `handleLedgerRequest` seals; `ensureLedger` mints a request and
  opens the reply. The `isLedgerComplete()` responder guard stays. The multi-responder logic stays: a
  reply that fails the head check is dropped and the next one is folded.

## The tests — and the standard is bullet 6's test, not a round-trip

`packages/mls/test/recovery.test.ts › a sealed reply does not open for another member, or for a
non-member holding the bytes` is the model, and question 4.2 called it the strongest test in the suite.
**It does not round-trip.** It models the hub as the attacker, **grants it every input it could actually
have** (the request rides the wire in the clear, so it reconstructs the exact AAD), and it includes a
**positive control** proving the failure is the missing key and not a wrong AAD that would fail against
any input. Match that standard.

Required:

1. **The hub sees nothing.** A heal that gathers a ledger holding a known entry body leaves **no
   plaintext of it anywhere in `hub.published`** — the same assertion `leakedBody()` already makes of
   the commit frame. **Capture the RED first, against today's code**, and put it in the report.
2. **A non-member gets nothing.** A DID with no leaf publishes a ledger request; every responder stays
   silent. **Today it gets the whole ledger** — so this test also goes red before the fix.
3. **A removed member gets nothing** from a responder that has applied its removal.
4. **The requester behind the responder still bootstraps** — the epoch-skew case the epoch-secret fix
   would have broken. State in the report what epoch each side was at.
5. **Domain separation**: a sealed GroupInfo does not open as a ledger reply.
6. **The head check still bites**: a responder that withholds an entry is still rejected, and the next
   honest reply is still folded. This must not regress — it is the only thing standing between a
   bootstrap and a lying member.

**Mutation-check every one.** Break the mechanism, show the test goes red, revert, report the red
output and **what else went red — and what did not.**

## ⚠️ Wrong-but-passing

- **A round-trip test.** Responder seals, requester opens, green. It proves nothing about the hub and
  nothing about authorization. **Assert the bytes are absent from the wire, and assert the refusal.**
- **Sealing but not authorizing.** The reply is unreadable by the hub, and any stranger who mints a
  request still gets the whole ledger sealed neatly to their own ephemeral key. **The seal without the
  roster check is not a fix.**
- **Asserting "no error was raised."** Question 4.1 established that `recover()` with no responder
  resolves `{ advanced: false }` without throwing. Assert **moved state**: the ledger present in the
  requester's handle, the fold correct, the roster right.

## Conventions

`type` not `interface`; `Array<T>` not `T[]`; never `any`; capital `ID`/`HTTP`/`JWT`/`DID`; ES
`#fields`, never `private`/`readonly`. pnpm only. **Never edit generated `lib/`.**

**Code, comments, and test names never reference plan questions, decision numbers, or phase labels** —
no `// Q4.3:`, no `// D2`. State the invariant directly.

Verify from the repo root — **an `rtk` shim intercepts bare `pnpm run`**:

```
rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test
```

## Stop conditions

- **If the ephemeral seal cannot carry the ledger without changing `sealGroupInfo`'s wire format or
  weakening the head check → `BLOCKED`.** Do not invent an alternative. Every probe in this plan that
  reported `BLOCKED` was right to.
- **Do not build the trim-strand heal trigger.** Out of scope, again.
- **Do not commit.**

## Report contract

Write `docs/superpowers/probes/question-4.3-report.md`: the red output before the fix (both the leak and
the anonymous-request hole), the factoring of the seal, the domain separation, the six tests, the
mutation check for each, the epoch-skew evidence, and the full verify output. Return only: status, a
one-line test summary, and concerns.
