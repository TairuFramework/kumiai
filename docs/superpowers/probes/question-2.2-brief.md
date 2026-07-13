# Probe brief — Question 2.2

## The question

**Can GroupInfo be sealed to a requester-supplied ephemeral key, authorized by the roster?**

- **Assumption:** `sealGroupInfo` / `openSealedGroupInfo`, over the **X25519 HPKE already in
  `packages/mls/src/crypto.ts`** (no second HPKE), with a signed request carrying the requester's
  ephemeral public key.
- **⚠️ Wrong-but-passing:** **sealing to the requester's MLS leaf key.** It passes a three-member
  happy-path recovery test and fails only for the two peers that actually *need* heal — a design
  that survived three revisions of the spec for exactly that reason. Question 2.1 pinned why
  (`packages/mls/test/leaf-key-rotation.test.ts`): a commit rotates its author's leaf key, so a peer
  whose commit the hub **accepted** and which then died before adopting the result holds only the
  **stale** private key, while every responder sees the **new** public one. It cannot open its own
  rescue.

**This is the security question of Phase 2.** A wrong answer hands group state — the full ratchet
tree and `external_pub` — to the wrong party. The refusals carry the weight here, not the happy path.

## Scope

**In scope:** the two `mls` primitives and their tests. Nothing else.

**Out of scope:** the `GroupMLS` port in `@kumiai/rpc` (`createRecoveryRequest` / `exportGroupInfo` /
`applyRecovery`), the rendezvous lane, responder jitter, storm collapse. Those are later phases. Do
not build them. If a primitive's shape is forced by something in that port, note it in the report
rather than reaching for it.

## Done when — five clauses, four of them refusals

1. **It works.** The reply opens for the requester, and the plaintext is the framed
   `MLSMessage(GroupInfo)` that feeds the existing `joinGroupExternal` **unchanged**.
2. **It fails to open for everyone else** — every other member of the group, and the hub. Assert
   this, do not assume it from "HPKE is HPKE".
3. **The AAD binds `groupID` + `requesterDID` + `requestID`.** A reply **replayed at another
   member, or against another request**, is **rejected**. Assert both replays separately.
4. **A requester DID with no leaf in the current ratchet tree is refused.** `sealGroupInfo` throws.
   This is where authorization actually lives — it is roster-intrinsic, so there is no policy check
   a host can forget. A **removed** member must get nothing.
5. **A request with a bad signature is refused.**

And the one that justifies the whole design:

6. **The recovery test: a peer whose own commit was accepted and then lost recovers.** Build the
   state question 2.1 built (commit, hub accepts, committer never adopts the returned handle), have
   a responder seal to the **ephemeral** key, and show the stranded peer opens it — the case
   leaf-sealing cannot serve.

## Spec excerpt (verbatim — this is the contract)

> **So the reply is sealed to an ephemeral key the requester mints, and authorization stays on
> the roster.** The requester generates an HPKE keypair per `recover()` call and puts the
> public half in the rendezvous request, signed by its DID identity key. The responder:
>
> 1. verifies the request signature against the DID it names;
> 2. checks that DID has a leaf in the **current ratchet tree** — authorization remains
>    intrinsic and roster-based, the property D2 refuses to give up: a removed member gets
>    nothing, with no policy check a host could forget;
> 3. seals the framed `MLSMessage(GroupInfo)` to the **ephemeral** public key, AAD binding
>    `groupID`, `requesterDID`, and `requestID` exactly as before.
>
> This keeps every property the leaf-sealing argument was defending, and drops the one
> assumption that fails. It also still answers the objection that killed DID-key sealing — a
> stolen DID key would let an attacker *ask*, but the reply is sealed to an ephemeral public
> key the attacker does not hold, so a stolen identity key alone buys nothing readable.
>
> The request is now **signed**, which changes the replay analysis: a replayed request re-seals
> GroupInfo to the same ephemeral key only its original minter can open, so replay buys
> amplification and nothing else… A *forged* request now fails signature verification
> outright, where previously it was merely useless.
>
> **mls grows two primitives**, over the X25519 HPKE already in `mls/crypto.ts`:
>
> ```ts
> sealGroupInfo({ group, requesterDID, requestID, recipientKey }): Promise<Uint8Array>
> openSealedGroupInfo({ sealed, requesterDID, requestID, privateKey }): Promise<Uint8Array>
> ```
>
> `sealGroupInfo` throws if `requesterDID` has no leaf in the current tree. `openSealedGroupInfo`
> returns the framed `MLSMessage(GroupInfo)`, which feeds the existing `joinGroupExternal`
> unchanged, and rejects anything whose AAD does not bind the caller's own DID and request.

## The approved approach

1. **Read what already exists before designing anything.** `exportGroupInfo`
   (`packages/mls/src/group.ts:1435`) already produces the framed `MLSMessage(GroupInfo)` with
   `external_pub` + ratchet tree; `inspectGroupInfo` (`:1388`) reads one back. `crypto.ts` holds the
   X25519 HPKE (`nobleCryptoProvider`) and whatever seal/open + AAD conventions the repo already
   uses — **follow them**, do not invent a parallel scheme. `roster.ts` is likely where "does this
   DID have a leaf in the current tree" already lives, or belongs. The signed-request signature
   should use the repo's existing DID identity-key verification (`authentication.ts` / `credential.ts`
   / `@kokuin/token` — find it) rather than a new one.

2. **The request is a signed object carrying the ephemeral public key.** The requester mints an HPKE
   keypair **per request** and signs `{ groupID, requesterDID, requestID, ephemeralPublicKey }` with
   its DID identity key. `sealGroupInfo` takes that request, verifies the signature, checks the
   roster, and seals to the key inside it. **The recipient key is the one inside the signed request
   — never a key passed alongside it**, or the signature protects nothing that matters.

3. **The AAD is the binding, and it is what makes clauses 3 and 5 real.** `groupID`, `requesterDID`,
   `requestID`. `openSealedGroupInfo` reconstructs the AAD from **its own** DID and request, so a
   reply minted for another member or another request fails to open **as an AEAD failure**, not as a
   field comparison after decryption. Say in the report which of the two you built and why.

4. **Refusal semantics.** Spec: `sealGroupInfo` **throws** if the DID has no leaf. (The *port* later
   turns that into "return null and stay silent" — that is the port's job, not the primitive's. Do
   not build the port.) `openSealedGroupInfo` **rejects** anything it cannot open or whose AAD does
   not bind the caller. Name the errors; a caller must be able to tell "not for me" from "corrupt".

5. **The recovery test (clause 6) is the deliverable.** Everything else can pass with leaf-sealing.
   This one cannot.

## Two traps, both found in question 2.1 — read these before writing a recovery test

- **The first rejection you hit is the wrong one.** Feeding a commit back to a handle that has no
  `resolveLedgerEntries` resolver fails at the **ledger policy** ("ledger entries could not be
  resolved") long *before* MLS is reached. Question 2.1's first draft "passed" for exactly that
  shallow reason and caught itself. Provision the resolver so the throw you assert is the genuine
  one. **A green recovery test that never reached the crypto is worse than a red one.**
- **A stale committer cannot even apply its own commit.** ts-mls *throws* — `No overlap between
  provided private keys and update path` — because the author's own subtree is excluded from every
  path secret's recipient set. There is no "just re-feed it the commit it sent" fallback anywhere in
  this design. A fresh leaf is the only way back, which is what the sealed GroupInfo bootstraps.

## Rules

- **BLOCKED on the first failure of the approach.** Do not try alternatives without asking.
- **No second HPKE, no second signature scheme.** Reuse what `crypto.ts` and the auth modules have.
- Do not build the `GroupMLS` port. Do not touch `@kumiai/rpc`.
- Everything currently green stays green.

## Conventions

`kigu:conventions` skill and the repo's `AGENTS.md`. `type` not `interface`; `Array<T>`; never
`any`; capital `ID`; ES `#fields`. **Code, comments and test names never reference plan questions,
phase labels, or G-numbers** — state the invariant directly ("a reply sealed for one request does
not open for another").

## Verify

```
rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test
```

from the repo root (`rtk proxy` prefix required). Include the output. Note: `ledger.test.ts:175`
flakes about once per full run under parallel load and does not reproduce in isolation. If you see
it, re-run `mls` alone and report both results rather than investigating.

## Report contract

Write to `docs/superpowers/probes/question-2.2-report.md`:

- The two primitives: signature, where they live, `file:line`. What the signed request looks like on
  the wire.
- **Each of the six clauses, with the test that proves it and its pasted output.** For the four
  refusals, say *how* the refusal is enforced — AEAD failure, signature check, roster check — and be
  explicit about which failures are cryptographic and which are comparisons in code.
- **The roster check: where does "has a leaf in the current tree" come from, and can it go stale?**
  A responder at epoch N sealing to a member removed at epoch N+1 is the interesting case. Say what
  happens.
- Whether the recovery test genuinely reached the crypto, and how you know it did not stop at the
  ledger policy.
- Anything a caller could hold wrong that the type system does not prevent — especially around the
  ephemeral private key's lifetime (it is retained by the host, keyed by `requestID`, until the
  recovery is applied).
- The full verify output.

**Return to the caller only:** status, a one-line test summary, concerns. Do not commit.
