# Probe report — Question 2.2

**Can GroupInfo be sealed to a requester-supplied ephemeral key, authorized by the roster? YES.**
All six clauses hold, over the X25519 HPKE already in `crypto.ts` and the `@kokuin/token` signature
scheme already used by the ledger. No second HPKE, no second signature scheme. The stranded
committer — the peer leaf-sealing cannot serve — recovers, rejoins, and resumes two-way traffic.

Three deviations from the spec's literal pseudo-signatures are forced and are argued below
(*Shape forced by the design*). The one that matters: **the recipient key is never a parameter** —
it lives inside the signed request, so the signature protects the only thing worth protecting.

## The primitives

`packages/mls/src/recovery.ts` (new, 401 lines). Exported from `packages/mls/src/index.ts`.

```ts
createRecoveryRequest({ group, identity, requestID })          // :254
  → { request: string; ephemeralPublicKey: Uint8Array; ephemeralPrivateKey: Uint8Array }

sealGroupInfo({ group, request })                              // :307
  → Promise<Uint8Array>            // throws RecoveryRequestError

openSealedGroupInfo({ group, sealed, requestID, ephemeralPrivateKey })   // :362
  → Promise<Uint8Array>            // the framed MLSMessage(GroupInfo); throws SealedGroupInfoError
```

Supporting: `RecoveryRequestError` (`:97`), `SealedGroupInfoError` (`:127`), `recoveryAAD` (`:170`,
internal), `verifyRecoveryRequest` (`:188`, internal).

### The signed request, on the wire

A `@kokuin/token` JWT — the same token type as a ledger entry, minted the same way
(`identity.signToken(payload, { embedLongForm: true })`, mirroring `signLedgerEntry`,
`ledger.ts:47`). Payload:

```json
{ "iss": "did:key:z6Mk…",            // the requester — the VERIFIED issuer, not a payload claim
  "type": "group.recovery-request",  // domain tag: a token minted for anything else is refused
  "groupID": "…",
  "requestID": "…",
  "ephemeralKey": "z6LS…" }          // multibase X25519 public key, minted per request
```

Two properties of this shape carry weight:

- **There is no `requesterDID` field.** The spec's prose says the request carries one; making it a
  field would create a claim that can disagree with the key that signed it. `requesterDID` is the
  verified `iss` — so "the DID the request names" and "the DID whose key signed it" cannot come
  apart, and no code has to remember to compare them.
- **`ephemeralKey` is inside the signature.** `sealGroupInfo` takes `{ group, request }` and
  **nothing else** — there is no `recipientKey` parameter for a caller to pass, so the "seal to the
  key alongside the request" bug is not merely avoided, it is unrepresentable.

`embedLongForm` makes the request self-verifying offline: a responder answers a peer it has never
resolved without a DID resolver, exactly as it folds a ledger entry.

### The sealed reply, on the wire

`[version: 1 byte][enc: 32 bytes][ct]` — X25519 is the only KEM the crypto provider supports
(`crypto.ts:235`), so `enc` is fixed-width and needs no length prefix.

- HPKE **info** = `kumiai/mls/recovery/v1` — separates this use of the group's HPKE from every use
  MLS itself makes of the same ciphersuite.
- HPKE **AAD** = `kumiai/mls/recovery-aad/v1 ‖ frame(groupID) ‖ frame(normalizeDID(requesterDID)) ‖
  frame(requestID)`, each field length-framed with a 4-byte big-endian prefix — the same
  domain-separator-plus-length-framing discipline as the ledger head (`head.ts:63`), so no two
  distinct field triples can encode to the same AAD.

## Shape forced by the design (three deviations, all deliberate)

1. **A third exported primitive, `createRecoveryRequest`.** The brief says two. But if `mls` only
   exports seal/open, then the *request format* — the AAD's field set, the multibase key encoding,
   the `type` tag, the "no self-asserted DID" rule — would have to be reimplemented by the `rpc`
   port, and `sealGroupInfo` would be verifying a format it does not define. The minting of the
   ephemeral keypair belongs with the format that carries its public half. The port's
   `createRecoveryRequest(requestID)` is then a two-liner that calls this and retains
   `ephemeralPrivateKey` under `requestID`. **The port is not built; nothing in `@kumiai/rpc` was
   touched.**

2. **All three primitives take a `GroupHandle`.** The spec's `openSealedGroupInfo({ sealed,
   requesterDID, requestID, privateKey })` cannot rebuild the AAD — it has no `groupID` — and would
   have to take the requester's own DID as a *parameter*, which is a parameter a caller can get
   wrong. Taking the handle instead means `openSealedGroupInfo` derives group id and DID from the
   caller's own state: **there is no DID to pass, so there is no wrong DID to pass.** This is what
   makes clause 3 airtight rather than merely tested. The cost is that a peer with no handle at all
   cannot open a reply — acceptable, because such a peer cannot call `joinGroupExternal` either (it
   needs its `MemberCredential`), so it has no route back regardless.

3. **`sealGroupInfo` also refuses a request naming another group** (`group-mismatch`). Not in the
   spec's list. Without it, a responder that is a member of two groups would seal *this* group's
   state in answer to a request authorized against *another* — the signature and the ephemeral key
   would both check out. It is a comparison in code, and it is load-bearing.

## The six clauses

`packages/mls/test/recovery.test.ts` (new). Nine tests, all green:

```
$ rtk proxy pnpm exec vitest run test/recovery.test.ts --reporter=verbose

 ✓ a sealed reply opens for its requester and feeds joinGroupExternal unchanged 155ms
 ✓ a sealed reply does not open for another member, or for a non-member holding the bytes 90ms
 ✓ a reply replayed at another member does not open, even with the ephemeral key 73ms
 ✓ a reply sealed for one request does not open for another 78ms
 ✓ a request signed for another group is refused 71ms
 ✓ a requester with no leaf in the current tree is refused 87ms
 ✓ a request with a bad signature is refused 72ms
 ✓ a truncated or unversioned reply is malformed, not silently ignored 69ms
 ✓ a peer whose own commit was accepted and then lost recovers from a sealed reply 86ms

 Test Files  1 passed (1)
      Tests  9 passed (9)
```

### 1. It works — *a sealed reply opens for its requester and feeds joinGroupExternal unchanged*

The plaintext is asserted **byte-identical** to `exportGroupInfo({ group: responder }).groupInfo`,
its `inspectGroupInfo` epoch/treeHash equal the responder's, and it is fed to `joinGroupExternal`
**unchanged** — producing an external commit the responder accepts, after which an application
message round-trips at the new epoch. Not "it decodes"; it heals.

### 2. It fails to open for everyone else — *…does not open for another member, or for a non-member*

Every refusal below is an **AEAD failure** (`SealedGroupInfoError`, reason `not-for-me`), asserted,
not assumed:

| Who | What they hold | Result |
|---|---|---|
| another member (Carol) | her own handle + her MLS leaf private key | rejects |
| the responder itself (Alice) | the handle it sealed from + its leaf key | rejects |
| the requester (Bob) | **his own MLS leaf private key** — the key a leaf-sealing design would have used | rejects |
| the hub | no handle at all | rejects |

The hub cannot even form the API call, so it is attacked at the raw HPKE — and **every input it
could possibly have is granted to it**: the request rides the wire in the clear, so the test rebuilds
the exact AAD (group id, requester DID, request id) and info the responder used, and gives the hub a
key of its own. It still fails. A **positive control** in the same test then opens that same
ciphertext with that same reconstructed AAD and the real ephemeral private key — so the hub's failure
is provably the missing key, not a test that reconstructed the wrong AAD and would have "passed"
against any input at all.

### 3. The AAD binds `groupID` + `requesterDID` + `requestID` — two replays, asserted separately

**I built the AEAD form, not the compare-after-decrypt form**, and it is the reason clause 3 is real.
`openSealedGroupInfo` rebuilds the AAD from the caller's *own* handle and *own* request id, so:

- **Replayed at another member** — Carol is handed **the ephemeral private key itself** (the
  strongest possible form of the replay: assume the requester's key leaked). The AAD binds Bob's
  DID, which her handle cannot reproduce → `not-for-me`. Had the binding been a field compared after
  decryption, she would have *decrypted the ratchet tree* and then been told not to look.
- **Replayed against another request** — same member, same group, same ephemeral key, only
  `requestID` differs → `not-for-me`. And the *other* request's key does not open the first reply.
  Both requests still work on their own terms.

### 4. A requester with no leaf in the current ratchet tree is refused

`sealGroupInfo` throws `RecoveryRequestError` with reason `not-a-member`. Two cases, both asserted
**by reason** (which proves the signature verified first — the refusal is the roster, not a signature
failure standing in for one):

- **Never a member.** An outsider signs a well-formed request for this group id. Signature good;
  no leaf; refused.
- **A removed member gets nothing.** Carol is removed; the responder that applied the removal
  refuses her request.

### 5. A request with a bad signature is refused

`RecoveryRequestError`, reason `unverified` — a **cryptographic** failure, in `verifyToken`. Four
sub-cases:

- payload rewritten (request id changed) → `unverified`;
- **the ephemeral key substituted** for the attacker's own in a genuine member's request — the attack
  the signature exists to stop, and the reason the recipient key must come from *inside* the signed
  payload → `unverified`;
- **impersonation**: an outsider signs its own request, then rewrites `iss` to a real member's DID —
  so the payload names a DID that *does* have a leaf, and only the signature stands between it and
  the group's state → `unverified`, and the roster check is never reached;
- garbage → `unverified`, not a crash.

(The tamper helper asserts the payload bytes actually changed, so a rewrite that happened to be a
no-op cannot masquerade as a forgery the verifier caught.)

### 6. The recovery test — a peer whose own commit was accepted and then lost recovers

The state from question 2.1, rebuilt: Alice commits (adding Dave), the hub accepts it, Bob applies
it, **Alice never adopts the returned handle**. Her leaf in the tree every responder sees is not the
leaf whose private half she holds — asserted. Then:

- she mints an ephemeral keypair and signs a request with the **DID identity key her crash did not
  touch**;
- Bob seals to that key;
- **the stale leaf key she still holds opens nothing** (`not-for-me`) — the contrast that justifies
  the whole design, asserted inside the recovery test itself;
- **the ephemeral key does.** She gets the GroupInfo at the epoch her own lost commit produced,
  rejoins with a fresh leaf via `joinGroupExternal`, Bob accepts the external commit
  (`epoch 3`, `treeHash` equal), and **traffic flows both ways**.

### Refusals: cryptographic vs. comparison in code

| Refusal | Enforced by | Kind |
|---|---|---|
| bad / forged / unsigned request | `verifyToken` (Ed25519) | **cryptographic** |
| reply for another member | HPKE AAD | **cryptographic** (AEAD) |
| reply for another request | HPKE AAD | **cryptographic** (AEAD) |
| reply sealed to another key | HPKE KEM | **cryptographic** (AEAD) |
| requester has no leaf | `group.findMemberLeafIndex` over the ratchet tree | comparison in code |
| request names another group | `request.groupID !== group.groupID` | comparison in code |
| malformed payload / bad ephemeral key length | field checks | comparison in code |
| truncated / unknown-version frame | length + version byte | comparison in code |

## Did the tests pass for the right reason? (mutation-checked)

The brief's central worry — a test that passes shallowly — was checked by breaking the
implementation and confirming the tests notice:

- **Roster check removed** (`if (group.findMemberLeafIndex(...) === undefined)` → `if (false)`):
  *"a requester with no leaf in the current tree is refused"* **FAILS** — `promise resolved
  "Uint8Array[…]" instead of rejecting`. The check is load-bearing and the test bites.
- **AAD stripped of DID + request id** (leaving only the group): **3 tests FAIL**, including both
  replay tests — the replayed reply *opens*. So the binding is doing the work, and the tests would
  catch its loss.

Both mutations were reverted; the file is back to its committed content.

## The roster check: where it comes from, and how it goes stale

**Where.** `GroupHandle.findMemberLeafIndex` (`group.ts:478`) — a normalized-DID scan of
`#iterateMembers()` over `state.ratchetTree` leaf credentials. Note the naming trap: `roster.ts` is
**not** this. `roster.ts` folds the *ledger* into `group.role` permissions (a DID-keyed map that can
hold a role for a DID with no MLS membership at all — `roster.ts:20`). The authorization D2 wants is
the **MLS ratchet tree**, not the ledger roster, and the ratchet tree is what `sealGroupInfo`
consults. Using the ledger roster instead would have answered a demoted-but-present member and,
worse, a DID granted a role who was never added.

**Can it go stale? Yes — and the window is inherent, not a bug.** A responder's tree is as fresh as
the last commit it applied. The interesting case is asserted explicitly in the test:

> Alice removes Carol at epoch N+1. Alice refuses Carol. **Bob, who has not yet applied the removal,
> still answers her.** The moment Bob processes the removal commit, he refuses her too.

So a removed member can be served by any responder lagging the removal — for as long as that
responder lags. Three things bound it: the window is one commit's propagation delay; the reply is
sealed to Carol's ephemeral key, so only *Carol* benefits (not an eavesdropper); and what she gets is
a GroupInfo at an epoch she cannot use to rejoin — `joinGroupExternal`'s resync requires a prior leaf
in the resynced tree (`group.ts:1483-1488`), and the *removing* commit took it away. She can read
the tree and `external_pub` of the epoch **before** her removal, which she was entitled to as a
member anyway. **This is a liveness/PCS property, not a confidentiality hole** — but it should be
stated in the spec rather than discovered later. The removal is the security event; the seal is not.

## Did the recovery test reach the crypto, or stop at the ledger policy?

**It reached the crypto**, and here is how that is knowable rather than hoped:

The 2.1 trap is a *green test that never got past the ledger pre-pass*. That trap can only bite a
test whose assertion is a **throw** — where an early, wrong rejection is indistinguishable from the
right one. The recovery test's assertions are **positive and terminal**: Bob applies Alice's external
commit and reaches epoch 3; her handle's `treeHash` equals his; and then an application message
encrypted by Bob **decrypts in Alice's rejoined handle**, and one of hers decrypts in his. No
ledger-policy short-circuit produces a shared epoch secret. The fixture also provisions
`resolveLedgerEntries` on every handle (Bob needs it to apply the commit that adds Dave, whose role
token he does not hold), so no `MissingLedgerEntriesError` is lurking in the path.

The one *negative* assertion in the recovery test (the stale leaf key opening nothing) is asserted
**by reason** — `{ reason: 'not-for-me' }` — so it cannot be satisfied by an unrelated throw.

## What a caller can hold wrong that the types do not prevent

1. **The ephemeral private key's lifetime is the whole ballgame, and nothing enforces it.**
   `createRecoveryRequest` hands back a raw `Uint8Array` the host must retain, keyed by `requestID`,
   until the recovery is applied — across a crash, in the general case, which is exactly when
   recovery matters. Nothing here zeroes it, expires it, or stops it being reused for a second
   request. Two hazards for the port: (a) **retaining it forever** turns a per-request secret into a
   long-lived one; the host must drop it when `applyRecovery` consumes it or the request is
   abandoned. (b) **Persisting it to disk** to survive the crash it exists to recover from is
   probably necessary and definitely a new secret at rest. The spec should say which.

2. **`requestID` uniqueness is unchecked.** Reusing one for two `recover()` calls makes two replies
   mutually openable (same AAD), collapsing the per-request binding. It is a correlation id, so a
   host may reasonably think it can be a counter. Mint it randomly.

3. **`sealGroupInfo` throws; a silent responder must catch.** The spec's port returns `null` and
   stays quiet. A responder that forgets the try/catch turns a non-member's probe into an exception
   in its own message loop. That is the port's job and is flagged, not built.

4. **A responder seals from whatever handle it is given.** Pass a stale handle and you seal a stale
   GroupInfo — the requester's external commit will then lose the CAS. Harmless (it retries), but
   the type system will not stop you handing `sealGroupInfo` a superseded handle.

5. **`verifyRecoveryRequest` is internal.** The rendezvous lane will need the verified
   `requesterDID` / `requestID` to *route* the reply, and re-parsing the token by hand to get them
   would be a footgun. It is one export away; left unexported to keep this probe's surface minimal.

## Verify

```
$ rtk proxy pnpm run build
 Tasks:    7 successful, 7 total
Cached:    4 cached, 7 total
  Time:    1.288s

$ rtk proxy pnpm run lint
$ biome check --write ./packages ./tests
Checked 170 files in 146ms. Fixed 1 file.

$ rtk proxy pnpm test
@kumiai/hub-protocol:test:unit:  Test Files  1 passed (1)
@kumiai/broadcast:test:unit:     Test Files  8 passed (8)
@kumiai/hub-tunnel:test:unit:    Test Files  20 passed (20)
@kumiai/hub-server:test:unit:    Test Files  5 passed (5)
@kumiai/rpc:test:unit:           Test Files  16 passed (16)
@kumiai/hub-client:test:unit:    Test Files  1 passed (1)
@kumiai/mls:test:unit:           Test Files  20 passed (20)   /  Tests  276 passed (276)

 Tasks:    27 successful, 27 total
```

Everything that was green stays green. `mls` grew one test file (20 files / 276 tests, up from
19 / 267).

### The `ledger.test.ts` flake is not a flake, and the brief's diagnosis of it is wrong

It appeared on the first full run, as predicted. But the brief says it "does not reproduce in
isolation" — **it does**, on a **clean tree with none of this probe's changes** (`git stash -u`):

```
$ rtk proxy pnpm exec vitest run test/ledger.test.ts   # x6, clean tree
Tests  12 passed (12)   ×5
Tests  1 failed | 11 passed (12)   ×1
```

It is **not** load-related; it is a nondeterministic bug in the test itself, and it will bite CI at
some rate forever. `test/ledger.test.ts:169-172` flips **the last character of the base64url
signature**. An Ed25519 signature is 64 bytes = 512 bits; base64url encodes it in 86 chars = 516
bits, so **the final character carries 2 significant bits and 4 padding bits**. When the flip lands
only in the padding (e.g. `'A'` → `'B'`), the decoder yields **the identical signature bytes**,
verification legitimately succeeds, and `verifyLedgerEntry` correctly returns non-null. The test's
premise — "flipping one character changes the signature" — is false for ~1 token in 4.

Out of scope for this probe and untouched, but it is a **one-line fix** (flip a character in the
*payload* segment, or a non-final signature character) and it is worth doing before it wastes
someone's afternoon. Per the brief it was not investigated further.

## Files

- `/Users/paul/dev/yulsi/kumiai/packages/mls/src/recovery.ts` — new; the three primitives.
- `/Users/paul/dev/yulsi/kumiai/packages/mls/src/index.ts` — modified; exports only.
- `/Users/paul/dev/yulsi/kumiai/packages/mls/test/recovery.test.ts` — new; nine tests.

Nothing committed. No `lib/` touched. No `@kumiai/rpc` change.
