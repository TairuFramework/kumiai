# AAD on the group application-message crypto, bound to topic context

**Created:** 2026-09-02. Milestone item [pre-1.0 breaking API surface](../../agents/plans/milestones/pre-1.0-breaking-api.md): "AAD on `GroupHandle.encrypt`/`decrypt` — **blocks** the rpc-side AAD binding; this is the change that must come first." This spec takes both halves: the mls enablement and the rpc-side binding.

**Scope note (this is Spec A of three).** Four blind Codex review rounds grew an earlier draft from "AAD on encrypt/decrypt" into a durable-topic migration, a `deriveTopicID` injectivity re-encode, a DID-normalization sweep, and a seal-race fix. Those are separable projects and are split out:

- **This spec (A)** — the AAD binding itself. It binds each app frame to the topicID it is already published on. It does **not** rotate any topic ID, change `deriveTopicID`, or change inbox derivation, so none of the migration/injectivity/DID/seal-race findings apply to it.
- **[Spec B — `deriveTopicID` injectivity](../../agents/plans/next/2026-09-02-derivetopicid-injectivity.md)** — the open NUL-injectivity item, done by re-encoding, plus durable-topic migration and WTF-8 handling.
- **[Spec C — per-protocol inbox + protocol isolation](../../agents/plans/next/2026-09-02-per-protocol-inbox.md)** — per-protocol inbox topics (depends on B), `normalizeDID` across topic/equality/cache keys, the `sealForSegment` anchor race, and the subscription budget.

## Problem

`@kumiai/mls`'s `GroupHandle.encrypt`/`decrypt` seal and open application messages but thread no MLS `authenticated_data` (AAD). ts-mls supports it — `createApplicationMessage` accepts `authenticatedData?: Uint8Array` and `processMessage` returns `aad: Uint8Array` — so the capability is present but unused.

A sealed frame therefore carries no cryptographic binding to *where* it belongs: a frame sealed for one topic is, as bytes, openable on any topic the same group serves at the same epoch. A frame captured on topic A and replayed onto topic B opens cleanly. Binding the topicID as AAD closes that. Note the mechanism precisely: ts-mls reconstructs the AEAD's AAD from the frame's *own* carried `authenticatedData` (`messageProtection.js:108`), so a byte-for-byte replay still opens cryptographically — the topic binding is enforced by the *receiver* comparing the frame's carried AAD against the topic it expects, before opening. The carried AAD is what the sender bound and the AEAD authenticates; the expected-topic comparison is what rejects it here.

Binding to the topicID gives cross-topic replay protection. It does **not** by itself separate protocols that share one inbox topic — that is Spec C, which makes inbox topics per-protocol so the topicID (and thus this AAD) carries protocol identity.

## Scope

1. `@kumiai/mls` — `GroupHandle.encrypt`/`decrypt` gain AAD; `readPrivateFrame` surfaces `authenticatedData` for the pre-open compare.
2. `@kumiai/rpc` `GroupCrypto` port — `wrap`/`unwrap` gain AAD.
3. `@kumiai/rpc` `peer.ts` / `directed.ts` / `app-lane.ts` — the wrap/unwrap call sites bind the topicID they already use (no derivation change).
4. `@kumiai/mls-rpc` — the real port implementation delegates AAD to the handle.
5. Doubles — `packages/rpc/test/fixtures/fake-crypto.ts`.
6. `@kumiai/rpc-conformance` — new AAD clauses, run against the real implementation and the double.

**Untouched.** `@kumiai/broadcast` (generic fan-out; the directed sites already hold the destination topic) and its `deriveTopicID` (Spec B). Inbox derivation and DID handling (Spec C). `@kumiai/hub-conformance` (no `wrap`/`unwrap`). `GroupMLS` (seals no app frames).

Breaking change to two public ports at 0.x → a `minor` bump across the band.

## Design

### mls signatures

```ts
encrypt(plaintext: Uint8Array, opts?: { AAD?: Uint8Array }): Promise<Uint8Array>
decrypt(
  message: Uint8Array,
  opts?: { expectedAAD?: Uint8Array },
): Promise<{ payload: Uint8Array; senderDID?: string; AAD: Uint8Array }>
```

- `encrypt` passes `opts.AAD` (default: empty `Uint8Array`, matching ts-mls's own default) as `authenticatedData` to `createApplicationMessage`.
- `decrypt`, when `opts.expectedAAD` is supplied, compares it against the frame's **cleartext** `authenticatedData` — read from the decoded `PrivateMessage` **before** `mlsProcessMessage` runs — and throws on mismatch with the ratchet untouched. MLS authenticates the AAD carried inside the frame, but `processMessage` accepts no externally-expected AAD, so a comparison done *after* the open would still have consumed a ratchet generation and mutated handle state — a wrong-topic frame would be a ratchet-burning denial of service rather than a cheap reject. The pre-open compare joins the existing pattern in `decrypt` that reads the sender leaf index before opening precisely "so a frame that then fails to open has cost nothing" (`group-handle.ts:802-808`).
- `readPrivateFrame` returns a `PrivateCommitFrame` (`sender-data.ts:14`) that has no `authenticatedData`, and narrows it out (`group-handle.ts:180-208`). It must surface `authenticatedData` — widen that type or give the helper a local return type. (Confirmed safe: `readSenderLeafIndex` ignores extra fields and commit processing uses `readPrivateCommit`, so widening the frame does not affect commit handling.)
- The AAD is not secret (it travels in the frame cleartext, only authenticated), so the compare need not be constant-time. The AEAD is still the integrity guarantee: a frame whose cleartext AAD is forged to match `expectedAAD` fails at open, because the tag was sealed under the sender's real AAD. The pre-open compare is the no-cost guard against honest cross-topic replay.
- `decrypt` **always returns** the frame's `AAD` (from `processMessage`'s result on a successful open), whether or not `expectedAAD` was given.
- The mismatch throw is distinguishable from the "not my epoch" throw by message text.

### rpc `GroupCrypto` port

```ts
wrap(bytes: Uint8Array, opts?: { AAD?: Uint8Array }): Uint8Array | Promise<Uint8Array>
unwrap(
  bytes: Uint8Array,
  opts?: { expectedAAD?: Uint8Array },
): GroupUnwrapResult | Promise<GroupUnwrapResult>
```

`GroupUnwrapResult` stays `{ payload, senderDID }` — **verify-only**. rpc enforces the binding by passing `expectedAAD` at every unwrap site; no caller needs the AAD echoed back, and widening this type would break every double and contradict its "never widen, no optional" doctrine. The mls layer still returns `AAD`; the rpc port does not surface it.

`wrap` was typed as broadcast's `ByteTransform`; it gains a second optional argument, so it is no longer literally `ByteTransform`. Fixed-topic lanes adapt it to a `ByteTransform` closure for broadcast; directed lanes call the two-argument form directly.

### The bound value and the wrap↔unwrap pairs

The AAD at each site is **the topicID the frame is actually published on** — the ID as derived today, encoded to bytes. No derivation changes. Each pair must bind the same topicID:

| Lane | seal (AAD) | open (expectedAAD) | shared topic |
|---|---|---|---|
| app live | `sealForSegment` (`peer.ts:660`) | live open-once path | `protocolTopic(anchor.secret, anchor.epoch, name)` — build the topic **before** wrapping, bind those exact bytes |
| app retained | same seal | drain `app-lane.ts:431` | the cursor's authoritative `topicID` (`app-lane.ts:226`), not the current MLS epoch |
| directed request | client publish `directed.ts:98` | recipient inbox path | client `sendTopicID` == recipient's `inboxTopic` |
| directed reply | acceptor publish `directed.ts:207` | requester inbox path | `publishParams.topicID` (from `resolveSendTopic(senderDID)`) == requester's `inboxTopic` |

`handshake.ts` is excluded — raw, un-`wrap`ped MLS control traffic. The two open paths are the live open-once path and the `app-lane.ts` drain; there is no separate `openSegment`.

The inbox lanes here bind the **existing single shared inbox topic**. That gives cross-topic replay protection but not protocol separation; Spec C's per-protocol inbox is what makes this AAD also separate protocols.

### Wiring — two patterns

**Fixed-topic lanes** (app live/retained, inbox receive) know their topic when the lane is built, so rpc hands broadcast a topic-bound adapter and broadcast stays generic:

```ts
const unwrapForTopic: Unwrap = (bytes) => crypto.unwrap(bytes, { expectedAAD: topicBytes })
```

For the app lanes the seal side is `sealForSegment`, which computes the segment/anchor topic first and binds those exact bytes as `AAD` (the drain's `expectedAAD` is the cursor topic).

**Directed lanes** publish to a destination chosen per call (`resolveSendTopic(senderDID)`), so a statically-bound adapter would seal to the wrong topic. The destination is in scope as `publishParams.topicID` at the call sites (`directed.ts:96,98` and `:205,207`), which call the two-argument `crypto.wrap` directly:

```ts
payload: await wrap(publishParams.payload, { AAD: fromUTF(publishParams.topicID) })
```

`directed.ts`'s `wrap` parameter type widens from `ByteTransform` to the AAD-aware `GroupCrypto['wrap']`. broadcast is not involved.

### Implementations

- **`mls-rpc/src/crypto.ts`** — `wrap: (bytes, opts) => handle().encrypt(bytes, opts)`; `unwrap: async (bytes, opts) => { const { payload, senderDID } = await handle().decrypt(bytes, opts); … }` (existing senderDID-required guard retained; the returned `AAD` is dropped, per verify-only).
- **`fake-crypto.ts`** — the app frame is currently epoch + XOR with no integrity tag (`fake-crypto.ts:152`). The plan must give it a carried-AAD encoding plus a tag that covers the AAD, adjust `frameEpoch` for the new layout, verify that tag on `unwrap` **even when no `expectedAAD` is given** (so the carried AAD is authenticated like the real AEAD), and compare `expectedAAD` **before** the `spent.add` point (`fake-crypto.ts:231`) so it models pre-open rejection. The double must be **at least as strict** as the port, never more permissive (per the test-doubles strictness rule).

## Rollout (mixed version) — retained history invalidated on upgrade

AAD lives in the frame, not the topic, so no topic rotation. Cryptographically (confirmed): an un-upgraded reader opens a post-upgrade AAD-bearing frame fine (ts-mls uses the frame's own carried AAD for the AEAD); an upgraded reader passing `expectedAAD` rejects a pre-upgrade empty-AAD frame *before* consuming the ratchet.

The durable consequence, and a deliberate decision for this spec: the app **retained** log is durable, and a pre-upgrade retained frame has empty AAD. An upgraded drain enforcing `expectedAAD` unconditionally rejects it at `app-lane.ts:431`, marks it dead at `:435`, and permanently advances the durable cursor past it at `:474`. **Pre-upgrade retained app history is therefore dropped when a reader upgrades.** This is accepted (pre-1.0, chosen over a compatibility window or coordinated retention-expiry): enforcement is unconditional, the code carries no legacy empty-AAD path, and the changeset must call the invalidation out prominently for operators. Live (ephemeral) frames see the same rejection transiently until senders upgrade. The commit/recovery plane is untouched (that is Spec B).

## Testing

TDD throughout. New `rpc-conformance` clauses in `group-crypto.ts` under `wrap / unwrap`, run against the real implementation **and** the double:

1. **AAD round-trip** — wrap with an `AAD`, unwrap with matching `expectedAAD`; payload and sender recovered.
2. **Verify throws on mismatch** — wrap with topic A's AAD, unwrap with topic B's `expectedAAD`, throws; distinguishable from the not-my-epoch throw.
3. **Pre-open rejection preserves the ratchet** — take one ciphertext `X`, unwrap with the **wrong** `expectedAAD` (rejected), then unwrap the **same** `X` with the **correct** `expectedAAD` and confirm it opens. Succeeds only if the compare happened before consumption. (Opening the *next* frame instead is a false positive — sequential generations open regardless.) Write as a mutation check: move the compare below the open and confirm this test goes red.
4. **No-AAD back-compat** — wrap and unwrap with no opts still round-trips (empty-AAD default; ts-mls encodes an omitted `authenticatedData` as a zero-length field).
5. **Per-lane cross-topic rejection** (rpc integration) — a frame sealed on one lane's topic does not open on another's.

mls-package unit tests for `GroupHandle.encrypt`/`decrypt`: `AAD` returned on decrypt, `expectedAAD` verify-throws, empty default, and the pre-open ratchet-preservation form at the handle level.

Because vitest strips types, every red/green step is paired with `test:types` (per the plan-code-needs-typecheck rule).

## Non-goals (in this spec)

- Per-protocol inbox topics / protocol isolation — Spec C.
- Any change to `deriveTopicID`, topic-ID injectivity, or topic rotation/migration — Spec B.
- DID normalization of topic/equality/cache keys — Spec C.
- The `sealForSegment` anchor/epoch seal race — pre-existing; Spec C.
- Widening `GroupUnwrapResult` to echo `AAD`.
- `GroupMLS` lifecycle methods.

## Exit criteria

- Both ports carry AAD; the mls layer returns it and rejects `expectedAAD` mismatches pre-open; the rpc port verifies at every site.
- Every wrap↔unwrap pair binds the same (existing) topicID; directed lanes bind `publishParams.topicID`.
- `rpc-conformance` green against the real implementation **and** the double.
- `test:types` green alongside every vitest run.
- The pre-1.0 AAD milestone item moves to `completed/`; the downstream "rpc-side AAD binding" note is discharged. Specs B and C are filed in `next/`.
