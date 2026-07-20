# Forward compatibility before the freeze

**Date:** 2026-07-20
**Status:** draft, awaiting review
**Lands in:** PR #7 (`feat/app-lane-delivery`), alongside the reserved-namespace rename.
**Evidence:** four parallel API-surface audits over all ten packages, 2026-07-20. Findings are not
restated here; this records decisions.

## Why these changes and not the other twenty

The audits found roughly thirty things that cannot be changed after 1.0 without breaking consumers.
Most are speculative — a third `GroupPermission`, leaf identity on `rosterDIDs`, a typed
`ProtocolSurface`, `HubStore` headroom. Those are deliberately **not** in scope. The ruling that
governs this spec: *do not pile up breaking changes with every follow-up doc; address necessary
changes as they are discovered.*

What separates the work below from that list is a sharper property than "expensive to defer":

> **For most of these, deferring does not make the later fix breaking. It makes it impossible.**

Each is a mechanism that must exist in the code that ships *before* the code that needs it. A version
byte only helps if old readers already know to respect it. An extension type only installs if every
existing leaf already advertises it.

**The gradation matters, and an earlier draft of this spec flattened it.** Three strengths, and each
item below says which it is:

- **Unreachable.** No later version of the change works. A3 (every existing leaf must already
  advertise the extension type), A2 and the commit frame in A4 (old readers must already know to
  fail correctly — a peer that silently mis-parses cannot be taught to stop).
- **Degraded.** Possible later, but permanently uglier: the fix must carry a sniffing or tolerance
  rule for the unversioned era. The client-state and credential-identity formats in A4.
- **Silent.** Possible later and it type-checks — which is the danger, because existing
  implementations satisfy the new signature while ignoring the new argument. B1 and B2.

An earlier draft claimed the hub's sealed request schemas were *unreachable*. They are not: adding a
**new procedure** to an enkaku protocol is additive, so the hub's forward-compat path already exists.
A1 was rewritten accordingly and is now the smallest item here, not the largest.

So this spec is not "the breaking changes we want". It is the escape hatches that make the ruling
above *possible*, by converting future changes from breaking to additive. Everything else waits until
something actually needs it, and takes its break then.

## Scope

Four groups. Group A is the escape hatches, B the ports whose later fix fails silently, C the two
already-agreed security items. Nothing else.

---

## A1. Regularise the hub procedure names — `hub/v1/*`

**Strength: cosmetic-but-permanent.** The weakest item here, and included only because its window
closes.

`packages/hub-protocol/src/protocol.ts` — seven procedures (`hub/publish`, `hub/subscribe`,
`hub/unsubscribe`, `hub/topic/fetch`, `hub/receive`, `hub/keypackage/upload`,
`hub/keypackage/fetch`), 17 `additionalProperties: false`, no version marker.

**Decision: keep every schema sealed. Rename the seven procedures to `hub/v1/*`. Change nothing
else.**

**Why the schemas stay sealed.** Enkaku validates `param` and channel `send` server-side, so a new
field sent to a deployed hub fails with `EK08 INVALID_MESSAGE`. That looks like a one-way door, and an
earlier draft treated it as one — wrongly. The evolution path is to **add a new procedure**, which is
additive: an old hub does not serve it, a new hub serves both, the client falls back. So sealed
schemas cost procedure proliferation, not impossibility, and the strict validation they buy is worth
keeping.

**Why rename now, then.** Only the *naming series* has a closing window. Left alone, the first change
to `hub/publish` must be called `hub/publish/v2` — an irregular series where v1 is unmarked and every
later version is. Starting at `hub/v1/publish` makes it regular forever. Renaming procedures is a wire
change, so it is free today only because nothing is deployed.

**Deliberately excluded:**

- **Opening the request schemas.** Rejected: it permanently trades away server-side rejection of
  unknown fields, and buys only convenience over the procedure-addition path that already works.
- **A `hub/hello` capability procedure.** Genuinely useful — capability discovery in one round trip
  instead of discovery-by-failure — but **additive at any later point**, so there is no argument for
  rushing it.

## A2. Make `HANDSHAKE_VERSION` usable

**Strength: unreachable.** There is no procedure-addition equivalent here — a peer meeting a frame it
cannot read does not fail loudly, it wedges silently at a dead epoch. Old readers must already know to
heal, and only today's code can be given that rule.

`packages/rpc/src/handshake.ts:31,75`; consumed at `packages/rpc/src/peer.ts:1667-1673`.

The frame carries a version byte that the constant's own doc forbids ever bumping — and the code
proves the doc right. On the commit lane an unreadable frame is caught and stepped over before
`classifyCommit` sees it, so a peer meeting a v2 frame never reaches the `ahead` row, never heals,
walks to the end of the log, and reports itself fully reconciled at a dead epoch. Silently, and not
fixable by restart.

**Decision:** `decodeHandshakeFrame` returns the version rather than throwing on an unknown one. The
commit lane treats an unknown-version frame **on the commit topic** as evidence the group moved on —
classify `ahead`, heal — rather than as poison.

This is the truest last-chance item in the spec: the peers that must tolerate a v2 frame are the ones
running today's code. Ship v1 without this rule and the version byte is decorative for the life of
the protocol.

**Note the asymmetry that makes this safe.** An attacker who forges an unknown-version frame can only
*trigger* a heal, never suppress one — the same argument `classify.ts` already makes for the `ahead`
row on a cleartext epoch. Treating it as poison is the dangerous direction, not this one.

## A3. Reserve the third GroupContext extension type

**Strength: unreachable, and the most literally so in this spec.** RFC 9420 requires every member leaf
to advertise each custom GroupContext extension type. Leaves cannot be rewritten, so the only later
remedy is re-admitting every member of every group.

`packages/mls/src/anchor.ts:11,19,106`.

`controlCapabilities()` advertises exactly `0xf100` (anchor) and `0xf101` (ledger head). RFC 9420
requires every member leaf to advertise each custom GroupContext extension type, so a third added
post-1.0 cannot be installed in any existing group — every member's leaf predates it and
`commitInvite` rejects leaves that do not advertise.

The repo already knows this. `anchor.ts:15-18` documents reserving the head's type *before it carried
data* "so an anchored group can later grow a head without every member's leaf being rejected", and
`:100` names the cost of skipping it: re-admitting members. The trick was applied once and not
repeated. The next planned feature needs it — `docs/agents/plans/backlog/mls-capability-revocation.md`
designs 2 and 3 both put revocation state in a GroupContext extension.

**Decision:** reserve `0xf102` and advertise it in `controlCapabilities()`.

**And the half that is easy to miss:** `packages/mls/src/policy.ts:92-125` pins the extension list
positionally — a group-context-extensions proposal must equal the current list, same length, same
types, byte-identical data, with only `ledger_head` permitted to differ. So a commit that *installs* a
reserved-but-empty type is rejected by every peer running today's policy. Reserving the type is
necessary but not sufficient; the policy must also permit installing a reserved type. **Both halves
land or the reservation is worthless.**

## A4. Version bytes on the formats that lack them

Every format gets a leading version byte and a distinguishable rejection on mismatch. Several formats
in the repo already do this correctly — `ControlEnvelope.v`, the ledger head, the anchor, `sealEntries`'
blob, the sealed reply frames — so this is applying an established local pattern to the five places it
was not applied.

| Format | File | Strength | Note |
| --- | --- | --- | --- |
| Commit frame | `packages/rpc/src/commit-frame.ts:30,43` | **unreachable** | A v2 frame decodes v1-*successfully*, with any new section silently swallowed into `sealedEntries`. A reader that accepts corrupt input cannot later be taught to reject it — only today's code can be given the rule. |
| Ledger entries | `packages/rpc/src/ledger-entries.ts:21,37` | **unreachable** | Degrades better only by accident: the resolver's `catch` turns a mis-parse into poison rather than corruption. Accident is not a contract. |
| Client state | `packages/mls/src/codec.ts:12-18` | degraded | The host's durable on-disk format, and the one codec kumiai does not own. Addable later, but every stored blob is then unversioned and must be sniffed forever. |
| Credential identity | `packages/mls/src/credential.ts:20` | degraded | The most immutable format in the system — baked into a leaf, covered by its signature. Additive fields are already safe, so this only unlocks *interpretive* change; and absent-`v`-means-1 must be tolerated permanently either way. |
| Broadcast wire | `packages/broadcast/src/client.ts:8-9`, `event-frame.ts:8-23` | degraded | Loose JSON, so unknown fields already survive — additions are safe today. What a version buys is the ability to *remove* or *reinterpret*, which is exactly what C2 does. |

**Decision on rejection behaviour, and it differs by format.** On the commit lane an unknown version
must route to **heal**, per A2 — it means the group moved on. Everywhere else an unknown version is a
distinguishable error, never a silent mis-parse: the value is diagnosis, not compatibility, which is
the argument `mls-rpc/crypto.ts:41-61` already makes for the sealed blob.

For `MLSCredentialIdentity`, absent `v` reads as `1` during the pre-1.0 window — old leaves cannot be
rewritten, so tolerance is mandatory rather than a courtesy.

---

## B1. `GroupCrypto.exportSecret` takes the label it already wraps

**Strength: silent.** The later fix type-checks against every existing implementation — and those
implementations ignore the new argument. That is worse than a break, because nothing reports it.

`packages/rpc/src/crypto.ts:36`; implemented at `packages/mls-rpc/src/crypto.ts:126` over
`GroupHandle.exportSecret(label, context, length)` — RFC 9420 §8.5, natively parameterised.

The port narrows a three-argument keyed derivation to zero arguments by closing over a fixed label. So
rpc can obtain exactly one epoch-bound secret from a host, forever, and every future derivation domain
must share those bytes.

**Decision:** `exportSecret(label: string, length?: number)`. `label` is **required**.

**Why required rather than optional, and why this cannot wait.** Adding an optional `label` later
type-checks against every existing implementation — and those implementations ignore it, returning the
same bytes for every label. The failure is silent cross-domain key reuse, in the method whose own plan
doc (`docs/agents/plans/next/2026-07-16-exporter-secret-surface.md`) calls it "the one method in it
whose only failure mode is silent." A required parameter is the only shape that fails loudly, and a
required parameter is breaking. This is the whole argument for doing it now.

Free today: `mls-rpc` already holds the label and merely closes over it.

## B2. `wrap`/`unwrap`: bind context, require the sender

**Strength: silent**, same shape as B1.

`packages/rpc/src/crypto.ts:37-38`, over `UnwrapResult = { payload, senderDID? }`
(`packages/broadcast/src/transport.ts:16`).

Two narrownesses, same silent-fix shape as B1:

- **No AAD parameter.** Nothing rpc seals is bound to the topic, protocol, or segment it was sealed
  for. Adding the parameter later type-checks while implementations ignore it and bind nothing.
- **`senderDID` is optional**, so rpc can never *require* an authenticated sender on the app lane —
  any future rpc-level authorization has no non-breaking foundation. rpc's app lane is always
  MLS-sealed; there is no identity-less case for it to accommodate.

**Decision:** an rpc-owned unwrap result with a **required** `senderDID`, rather than reusing
broadcast's optional-sender type, plus a context argument on both halves.

**Judgement call, flagged for review.** The AAD half is the most speculative thing in this spec — no
filed item needs it. It is included only because it shares B1's silent-failure shape and rides the
same signature change, so excluding it means paying the same break twice. Say the word and it comes
out, leaving the required-`senderDID` half.

---

## C1. `AuthorizeHook` — one widening, six actions

`packages/hub-server/src/handlers.ts:14-20`, exported. Called at exactly two sites; `unsubscribe`,
`topic/fetch`, `keypackage/upload` and `keypackage/fetch` are ungated today.

Two filed items need it and neither fits: key-package quotas need authorization scoped to a **target
DID, not a topic** (`next/2026-07-07-hub-keypackage-subscribe-caps.md`), and the commit-topic
amplification bound "belongs to whoever gates publish authorization on the commit topic"
(`next/2026-07-18-external-commit-amplification.md` §1).

**Decision:** a discriminated request object with a rich decision.

```ts
export type AuthorizeRequest =
  | { action: 'publish'; did: string; topicID: string; retain: 'log' | 'mailbox'; payloadSize: number }
  | { action: 'subscribe'; did: string; topicID: string; retention?: number }
  | { action: 'unsubscribe'; did: string; topicID: string }
  | { action: 'topic/fetch'; did: string; topicID: string }
  | { action: 'keypackage/upload'; did: string; count: number }
  | { action: 'keypackage/fetch'; did: string; targetDID: string; count: number }

export type AuthorizeDecision =
  | boolean
  | { allow: boolean; reason?: string; code?: string; retryAfterMs?: number }

export type AuthorizeHook = (req: AuthorizeRequest) => AuthorizeDecision | Promise<AuthorizeDecision>
```

All six variants ship now even though only `publish` and `subscribe` are enforced — the union is
itself an exhaustive-switch surface, so adding a variant later is the break this exists to avoid.

**Judgement call, flagged for review.** An unknown action **defaults to allow**. This keeps the hub a
blind relay by default and means a host's existing hook does not silently begin refusing procedures
that were previously ungated. The opposite default is more secure and more surprising; I chose
compatibility because the hub is explicitly untrusted and authorization is the host's opt-in.

**Enforcement is out of scope.** Per the earlier ruling: the surface lands now, the quotas and the
publish gate land afterwards without another break.

## C2. Broadcast reply identity

`packages/broadcast/src/client.ts:9,13,130-134`; `packages/broadcast/src/responder.ts:27,75,80`; and
the hand-copied duplicate at `packages/rpc/src/bus-server.ts:14,19`.

`ReplyData.from` is stamped by the responder and trusted by the client, while the MLS-authenticated
`senderDID` is already on the message one variable away and is discarded. Two consequences, not one:
attribution is attacker-chosen, **and** `seen` is keyed on `from`, so one member can suppress
another's real reply by racing a forgery under that DID, or inflate a quorum by replying N times under
N names. The `quorum` option is not a quorum of members.

**Decision:**

- Drop `from` from `ReplyData` → `{ kind: 'res'; rid: string; ok?: unknown; err?: string }`.
- `GatheredReply` becomes `{ senderDID: string; value: unknown }` — **rename, do not redefine.**
  Keeping the name and changing its meaning from asserted to authenticated would let every consumer
  compile while none is told the semantics moved. The rename is what makes the break loud, which is
  the point of doing it now.
- Client keys `seen` on `msg.senderDID`; a reply with no `senderDID` is dropped on an authenticating
  transport.
- `BroadcastResponderParams.from` survives only for buses with no authenticated sender (the memory
  bus), and feeds the transport-level `senderDID` rather than the reply body.
- The duplicate in `rpc/src/bus-server.ts` changes with it.

No new plumbing: `createBroadcastTransport` already attaches `senderDID` from `crypto.unwrap`.

---

## Verification

- Every change is covered by the existing suites plus new tests per item; the version-byte work needs
  a rejection test each, and A2 needs a test proving an unknown-version frame on the commit topic
  **heals** rather than poisoning.
- C2 needs a test proving a forged `from` can no longer displace a real reply in `seen` — the dedup
  half, not just the attribution half, since that is the one that silently corrupts a quorum.
- A3 needs a test proving a commit installing a reserved-but-empty extension type is accepted by the
  policy. Reserving without the policy rule passes a naive test and is worthless.
- Full gate: `pnpm exec turbo run test:types test:unit --force` (confirm `Cached: 0`),
  `pnpm exec vitest run --root tests/integration`, `rtk proxy pnpm run lint`.

## Release

Breaking changesets for `@kumiai/mls`, `@kumiai/mls-rpc`, `@kumiai/rpc`, `@kumiai/broadcast`,
`@kumiai/hub-protocol`, `@kumiai/hub-server`. All packages are 0.x, so `minor` is the breaking bump.

The changeset must say plainly that most of this is *not* a feature — it is forward-compatibility
machinery, and the reason to take the break now is that these mechanisms only work if they ship before
the things that need them.

## Explicitly out of scope

Recorded in the backlog, fixed when something needs them, taking a break then: a third
`GroupPermission`; leaf identity on `rosterDIDs`; a typed `ProtocolSurface`; `HubStore` method
headroom and its positional `unsubscribe`/`fetchKeyPackages`; `deduped`/`head` on the publish result;
`KeyPackageLimits` renaming; nested `HubRateLimits`; hub port types moving out of `hub-tunnel`;
`urn:enkaku:` schema `$id`s; `deriveTopicID` NUL-injectivity; the dead `GroupSyncScope` export; union
members not yet needed; `hub-client`'s `rawClient` leak and pre-base64 `payload`.

Several of these are cheap and worth doing opportunistically — but none of them becomes *impossible*
later, which is the line this spec draws.
