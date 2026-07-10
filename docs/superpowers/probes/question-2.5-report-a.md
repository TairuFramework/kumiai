# Question 2.5 — Report A: What does the capability chain establish, and can `processWelcome` fold instead?

**Status: DONE_WITH_CONCERNS.** Everything asked was settled by reading. Two items carry a
concern rather than a clean answer: (A1) the `aud` binding the chain is supposed to establish is
*not actually checked* against the joiner in today's code, and (A2) the anchor is readable only
*after* `mlsJoinGroup`, not before — the Welcome's GroupInfo is encrypted and the decrypt helpers
are not publicly exported by ts-mls.

Scope note: none of `anchor.ts`, `ledger.ts`, `roster.ts`, `fold.ts`, `envelope.ts`, `policy.ts`
exist in `packages/mls/src/` yet (verified: directory listing shows no such files). The roster /
ledger / anchor are entirely prospective. This report reasons about the *current* capability chain
and what a fold would have to reproduce.

---

## A1. What `validateGroupCapability` actually establishes

`validateGroupCapability` (`packages/mls/src/capability.ts:93-124`) does exactly four things:

1. **Verifies the leaf token** — `verifyToken` (`capability.ts:97-100`) checks the signature and,
   via `assertTimeClaimsValid` (`@kokuin/token/lib/token.js:116` and `:157`), the leaf's `exp`/`nbf`
   *if present*.
2. **Asserts it is a capability** — `assertCapabilityToken` (`capability.ts:101`) requires
   `iss`, `aud`, `sub` strings and `act`/`res` string-or-array
   (`@kokuin/capability/lib/index.js:69-97`).
3. **Matches the resource to the group** — `capability.ts:106-114`: some `res` equals
   `group/<groupID>/*`, or `startsWith('group/<groupID>/')`, or is the global `'*'`.
4. **Validates the delegation chain** — if a chain is supplied, `checkDelegationChain`
   (`capability.ts:117-118`); otherwise it requires `iss === sub`, i.e. a self-issued root
   (`capability.ts:119-121`).

`checkDelegationChain` (`@kokuin/capability/lib/index.js:221-253`) walks parent→child: for each
ancestor it re-verifies the token (`index.js:239`), runs the optional `verifyToken` hook
(`index.js:245-247`), and calls `assertValidDelegation` (`index.js:248`). The base case
(`index.js:227-234`) requires the root's `iss === sub` and checks the root's `exp`/`iat`.
`assertValidDelegation` (`index.js:207-220`) enforces, per link: `to.iss === from.aud`,
`to.sub === from.sub`, `from` not expired, `from.iat` not future, and `hasPermission(to, from)`
(the child cannot exceed the parent).

The tokens themselves are minted by `createGroupCapability` (`capability.ts:22-32`: root, with
`sub === aud === identity.id`, `act: '*'`, `res: ['group/<id>/*']`) and `delegateGroupMembership`
(`capability.ts:47-69`: `sub` = grantor identity, `aud` = `recipientDID`, `act: [permission]`,
`res: ['group/<id>/*']`, optional `exp`, `parentCapability`).

### Property-by-property

| Property | How the chain establishes it | Does the roster carry it? |
|---|---|---|
| **`aud` binding** (names the joiner) | Structurally the leaf's `aud` is `recipientDID` (`capability.ts:54`), and each link is bound `to.iss === from.aud` (`index.js:209`). **But `validateGroupCapability` never checks the leaf's `aud` against the joining identity**, and today's `processWelcome` does not either — it uses `invite.permission` verbatim (`group.ts:616-622`) and performs no `aud === identity.id` assertion. So the *token contains* an audience; nothing today binds it to the actual joiner. | A signed `group.role` entry has `subject` = grantee and `iss` = admin grantor (spec §"Roster and authority rules", `2026-07-09-...design.md:201-204`). That is **the same binding strength** as `aud`, and the fold seeds `subject`→role. The gap the chain leaves (aud vs. joiner) is exactly the hardening the spec adds anyway (`design.md:325-326`). **Roster carries it, equally.** |
| **`res` / `act` scoping** | `res: ['group/<id>/*']` (`capability.ts:30`, `:57`) plus the `startsWith` match (`capability.ts:106-114`); `act` is `'*'`/`[permission]`, narrowed down-chain by `hasPermission` (`index.js:217`). Beyond membership, a group capability authorizes **nothing else in kumiai** — `validateGroupCapability` only ever tests `res` against `group/<groupID>/` (`capability.ts:106`). It is a pure membership/permission proof here. (Whether any `document/*` grant chains from it is Part B's question.) | The role entry is `{type:'group.role', groupID, subject, value:'admin'|'member'}` (`design.md:201`). `groupID` replaces `res` scoping; `value` replaces `act`. `foldLedger` drops entries whose `groupID` mismatches (`design.md:165-167`), which is *stronger* than the `res.startsWith` prefix match that the spec itself flags as a confusion vector (`design.md:327-329`). **Roster carries it.** |
| **`exp` (expiry)** | Supported per-link (`index.js:215`, `:231`) and on the leaf (`token.js:116`). **But no group capability sets `exp` today**: `createGroupCapability` never sets it (`capability.ts:26-31`), `delegateGroupMembership` only if a caller passes `expiration` (`capability.ts:59-61`), and `createInvite` passes none (`group.ts:484-490`). So expiry is *enforced-if-present but never present*. | Role entries have no `exp` and the spec puts capability expiry **out of scope** (`design.md:407`). Since the chain never sets `exp` in practice, dropping it loses **nothing that is exercised today**. Tenable — with the caveat that the *ability* to time-box a grant disappears; revocation would have to be an explicit demotion entry (a `value:'member'` demotion, `design.md:206`), not a TTL. **Not currently used; losable, but the capability to expire is lost.** |
| **`jti` / revocation** | `CapabilityPayload.jti` is optional (`@kokuin/capability/lib/index.d.ts:50`) and `@kokuin/capability` ships a jti-based revocation backend (`revocation.d.ts:3-15`) wired through the `verifyToken` hook (`DelegationChainOptions.verifyToken`, `index.d.ts:24-25`). **None of it is used**: kumiai's mint sites never set `jti` (`capability.ts:26-31`, `:53-58`), and `validateGroupCapability` / `processWelcome` never pass a `verifyToken` hook — `processWelcome` passes `options: {cache, resolver}` only (`group.ts:592`). So the chain establishes **no revocation today**. | The roster *is* the revocation primitive: a later admin-signed demotion, folded against state-so-far (`design.md:204-206`), removes authority. This is what the chain lacks (brief lines 20-21). **Roster carries revocation the chain never had.** |
| **Signature / authenticity** | Every token's signature is verified (`token.js:107-116`, `:148-157`; each ancestor at `index.js:239`). | Ledger entries are `signLedgerEntry`/`verifyLedgerEntry`, issuer = verified `iss` (`design.md:49-51`, `:74`). **Roster carries it.** |
| **Root anchoring** | The chain roots at a self-issued token (`iss === sub`, `index.js:228`), but *which* self-issued identity is only tied to the group by the `res` prefix — nothing binds the root to the MLS group's creator. | The roster seeds `{creatorDID:'admin'}` from the anchor baked in the GroupContext and authenticated by the GroupInfo signature (`design.md:193-199`). This is a **stronger** root binding than the chain's `res` prefix. **Roster carries it, better.** |
| **Total order / bounded depth** | The chain has neither: `assertValidDelegation` imposes only a partial parent→child order, and depth is capped only by `maxDepth` (default 20, `index.js:15`, `:222-225`). | The fold is a total order (epoch chain then envelope position, `design.md:106-118`), bounded by membership size. **Roster is strictly better on both** — this is the brief's core claim (lines 18-21). |

**A1 summary:** every property the chain *actually exercises today* (signature, group-scoped
membership, permission level, root-from-creator) is carried by a signed `group.role` entry at equal
or greater strength. The `aud`-to-joiner binding the chain is *supposed* to give is not checked in
current code at all — so it is not lost by dropping the chain; it is added by the hardening
regardless (`design.md:325-326`). The only genuinely chain-only capabilities are `exp` (supported,
never used, spec-out-of-scope) and jti revocation (supported in the dependency, never wired, and
inferior to the roster's demotion primitive).

---

## A2. Can `processWelcome` fold a roster before it trusts anything?

**Finding: the anchor is readable only *after* `mlsJoinGroup`, not before — at least without
deep-importing ts-mls internals and re-implementing signature verification `mlsJoinGroup` already
does.**

The Welcome carries the GroupInfo **encrypted**: `Welcome = { cipherSuite, secrets,
encryptedGroupInfo }` (`ts-mls/dist/src/welcome.d.ts:16-20`). The anchor lives in
`GroupContext.extensions` (`groupContext.d.ts:7-15`; spec `design.md:73`, `:193-199`), and the
GroupContext is inside that encrypted GroupInfo.

To read it you must decrypt, and decryption is a two-step chain that requires the **joiner's key
package private key**:

1. `decryptGroupSecrets(initPrivateKey, keyPackageRef, welcome, hpke)` yields `joinerSecret`
   (`welcome.d.ts:29`; called at `clientState.js:538-539`).
2. `decryptGroupInfo(welcome, joinerSecret, pskSecret, cs)` yields the GroupInfo — and thus
   `gi.groupContext.extensions` (`welcome.d.ts:24`; `clientState.js:544`).

Two facts make "read the anchor before `mlsJoinGroup`" unavailable through the public API:

- **The decrypt helpers are not exported.** `ts-mls`'s index re-exports only the *types*
  `Welcome` / `EncryptedGroupSecrets` from `welcome.js` (`index.d.ts:53`), and `createGroup` /
  `joinGroup` / `joinGroupWithExtensions` from `clientState.js` (`index.d.ts:2`).
  `decryptGroupInfo` and `decryptGroupSecrets` are **not** in the public surface — reaching them
  means a deep import into `ts-mls/dist/src/welcome.js`.
- **`inspectGroupInfo` cannot help.** The existing helper (`group.ts:739-751`) decodes an
  *unencrypted* framed `MLSMessage(GroupInfo)` — the kind `exportGroupInfo` produces
  (`group.ts:784-798`), used for external rejoin. Its test only ever feeds it exported GroupInfo
  bytes (`test/inspect-group-info.test.ts:21`, `:33`, `:75-83`). It calls `decode(...)` with no
  key material (`group.ts:740`); it **cannot** decrypt a Welcome's `encryptedGroupInfo`. So it is
  not a pre-join anchor reader.
- **`joinGroupWithExtensions` returns the wrong extensions.** It surfaces `groupInfoExtensions:
  gi.extensions` (`clientState.js:623`, `:627-629`) — the GroupInfo's *own* extensions, not
  `gi.groupContext.extensions` where the anchor is baked. The anchor is only reachable via the
  returned `state.groupContext.extensions` (`clientState.js:610-611`).

So the clean, public-API path to the anchor is: **call `mlsJoinGroup`, then read
`state.groupContext.extensions`** (the spec's prospective `readGroupAnchor(handle)`,
`design.md:271-272`). That is strictly *after* the Welcome is applied.

Today `processWelcome` validates the capability chain (`group.ts:587-593`) *before* `mlsJoinGroup`
(`group.ts:606-614`). If the chain is dropped, the "assert I was invited" step must move to
*after* `mlsJoinGroup` (fold the roster from `Invite.ledgerEntries` seeded by the now-readable
anchor, then assert the joiner's DID appears in it).

### What that costs — and why it is bounded

The joiner would apply the Welcome before confirming it was legitimately invited. **This is
acceptable given the Welcome is itself authenticated**, and the evidence is concrete:
`joinGroupInternal` (which `joinGroup` wraps, `clientState.js:522-524`) already verifies, before
returning any state:

- the signer's leaf **credential** (`clientState.js:582-584`),
- the **GroupInfo signature** (`clientState.js:585-587`) — this is precisely the signature the
  spec says authenticates the anchor (`design.md:47-48`, `:193-199`),
- the **ratchet tree** against `groupContext.treeHash` (`clientState.js:591`),
- the **confirmation tag** (`clientState.js:604-606`).

So `mlsJoinGroup` never returns unauthenticated state: by the time the anchor is readable it has
already been proven to come from a genuine group member's signed GroupInfo. Applying the Welcome
"before verifying I was invited" is therefore applying *authenticated* data; the residual gap is
purely authorization (was the adder an admin?), which the fold answers a few lines later, and which
every *other* peer independently enforces via the receiving-side commit policy (`add` requires
`admin`, `design.md:213`). The joiner rejecting itself post-fold costs one wasted `mlsJoinGroup`
and a discarded handle — no key material leaks, because MLS membership *is* holding the epoch
secret and the adder already put the joiner in the tree.

**Concern (not a blocker):** if the team wants the pre-join check preserved literally (verify
before applying), that requires either (a) deep-importing `decryptGroupSecrets` /
`decryptGroupInfo` from `ts-mls/dist/src/welcome.js` **and** re-verifying the GroupInfo signature
by hand (re-deriving `keyPackageRef`, locating the signer leaf in a ratchet tree the joiner does
not yet trust) — duplicating `clientState.js:537-587` — or (b) asking ts-mls to export a
"decrypt-and-verify GroupInfo without building ClientState" helper. Neither is available today.
**UNRESOLVED at the API level:** whether ts-mls will export such a helper; settling it means either
a ts-mls feature request or accepting the post-join fold. The post-join fold is fully supported by
the current public API and is safe for the reasons above.

---

## A3. If the chain stays, where does a depth cap go?

**kumiai can enforce a depth cap today, without changing `@kokuin/capability`.**
`checkDelegationChain` already takes `maxDepth` via `DelegationChainOptions`
(`@kokuin/capability/lib/index.d.ts:19-30`) and throws when `capabilities.length > maxDepth`
(`index.js:222-225`). `validateGroupCapability` passes its `options` straight through
(`capability.ts:75` types it as `DelegationChainOptions`; `capability.ts:118` forwards it). So a
cap is just a matter of setting `options.maxDepth` at the call site.

- **A cap already exists implicitly.** No caller sets `maxDepth`, so the dependency default of
  **20** applies (`DEFAULT_MAX_DELEGATION_DEPTH = 20`, `index.js:15`; used at `index.js:222`).
  `processWelcome` today passes `options: {cache, resolver}` (`group.ts:592`) with no `maxDepth`,
  so relay chains deeper than 20 links *already* fail validation.
- **To lower it**, `processWelcome` would set `options.maxDepth` explicitly when constructing the
  options it hands to `validateGroupCapability` (`group.ts:592`). No dependency edit needed.
- **What the cap counts.** `capabilities` is the `delegationChain` argument, which
  `processWelcome` passes as `invite.capabilityChain.slice(0, -1)` (`group.ts:590-591`) — i.e.
  the ancestors, one added per relay hop (brief line 20). So `maxDepth = N` permits `N` ancestor
  links, i.e. `N` relay hops from the root.

**Defensible maximum and what breaks at it:** the brief states the chain grows one link per relay
hop. A cap of `N` means the `(N+1)`-th relayed joiner's invite fails `checkDelegationChain`
(`index.js:224`) → `validateGroupCapability` throws → `processWelcome` throws → that member cannot
join, even though they were legitimately relayed. There is no partial-accept: it is a hard reject
of the whole join. A small cap (e.g. single digits) bounds the unbounded-depth problem the brief
names, at the cost of capping how far an invite may be relayed before a fresh direct (admin-issued)
invite is required. **UNRESOLVED (a design choice, not a code fact):** the exact numeric value —
the code supports any `maxDepth`; picking it is a policy decision about maximum relay depth, and the
current de-facto answer is 20.

---

## Things that surprised me

- The `aud`-to-joiner binding — the property the brief leads with — is **not enforced anywhere in
  current code**. `validateGroupCapability` never inspects `aud` (`capability.ts:93-124`), and
  `processWelcome` copies `invite.permission` verbatim without an `aud` check (`group.ts:616-622`).
  The chain *carries* an audience; nothing binds it to the joining identity. So "the chain proves
  the invite names the joiner" is only true structurally, not operationally, today.
- A depth cap needs **zero** changes to `@kokuin/capability` — `maxDepth` is already plumbed, and
  an implicit cap of 20 is already in force.
- `inspectGroupInfo` looks like the pre-join anchor reader the brief hints at, but it only decodes
  *unencrypted* exported GroupInfo; a Welcome's GroupInfo is encrypted and its decrypt helpers are
  not on ts-mls's public surface, so the anchor is genuinely a post-`mlsJoinGroup` read.
