---
'@kumiai/mls': minor
'@kumiai/mls-rpc': minor
'@kumiai/rpc': minor
'@kumiai/broadcast': minor
'@kumiai/hub-protocol': minor
'@kumiai/hub-server': minor
'@kumiai/hub-client': minor
'@kumiai/rpc-conformance': minor
---

Forward-compatibility machinery across the group stack, taken now because each mechanism only
works if it ships *before* the thing that needs it. A version byte only helps a reader that
already knows to respect it; an MLS extension type only installs in a group whose members
already advertise it. Wait for the feature that needs one of these and taking it is no longer a
breaking change — it is impossible, because the readers that would have to tolerate it are
already deployed on code that predates it. Most of what is in this release has no user-visible
behavior on its own; it is the toolbox, not a feature.

Three groups of change:

**Escape hatches with a closing window.** `@kumiai/mls` reserves and advertises a third
GroupContext extension type, `0xf102` — every member leaf already advertises it, so a future
control extension can be installed into a live group without re-admitting every member.
`@kumiai/hub-protocol`'s seven procedures move to `hub/v1/*` (`@kumiai/hub-client` and
`@kumiai/hub-server` move with it), so the first real revision of any of them is `hub/v1/publish`
rather than an irregular `hub/publish/v2` with an unmarked predecessor. `@kumiai/rpc`'s handshake
frame already carried a version byte (behind its two-byte magic) and it stops being fatal; the
commit frame and the ledger-entries blob each gain one, leading. The part that makes those bytes
more than decorative: an unrecognised version on the commit topic now HEALS instead of being filed
as poison — for the handshake header and for the commit frame alike (see `handshake-version-heal.md` in this same release: the
old behaviour let a peer step over its entire future and report itself reconciled at a dead
epoch). `@kumiai/mls`'s client-state blob and credential-identity format are versioned the same
way: an unknown client-state version now THROWS a descriptive error rather than returning
`undefined` indistinguishably from a truncated read, and an absent credential-identity `v` is
read as `1` **permanently** — a credential is baked into a leaf and covered by its signature, so
identities written before this release live in leaves that can never be rewritten.

**Ports whose later fix would type-check silently.** `GroupCrypto.exportSecret` now REQUIRES a
`label` (`exportSecret(label: string, length?: number)`). An optional label type-checks against
every implementation shipped before this release, and each one ignores it and returns identical
bytes for every purpose that calls it — silent cross-domain key reuse. Required is the only shape
that fails loudly instead of quietly. `GroupCrypto.unwrap` now returns rpc's OWN
`GroupUnwrapResult`, whose `senderDID` is required rather than the optional one inherited from
`@kumiai/broadcast`'s `UnwrapResult` — rpc's app lane is always MLS-sealed, so there was never an
identity-less case for it to accommodate, only a hole an implementation could silently return
through. **The context/AAD half of this change did not ship.** It was investigated and dropped:
`@kumiai/mls`'s `GroupHandle.encrypt`/`decrypt` take no AAD parameter, so binding rpc's sealed
bytes to the topic or segment they were sealed for needs a change in that package first, and a
structural arity mismatch in `directed.ts`'s and `open-once.ts`'s transport glue (both typed
against broadcast's crypto-agnostic `Unwrap`) stands in the way on the rpc side too. Recorded in
`docs/agents/plans/next/2026-07-20-deferred-api-findings.md`.

**Already-agreed security fixes.** `@kumiai/hub-server`'s `AuthorizeHook` now takes one
discriminated `AuthorizeRequest` (six actions: `publish`, `subscribe`, `unsubscribe`,
`topic/fetch`, `keypackage/upload`, `keypackage/fetch`) and returns a richer `AuthorizeDecision`
— surface only, no new enforcement. Of those six actions only `publish` and `subscribe` are
dispatched to the hook today; the other four are named by the type but never asked about, so a
hook that does not handle them changes nothing, exactly as before this release.
`@kumiai/broadcast`'s `GatheredReply.from` is renamed `senderDID` and is now the AUTHENTICATED
sender rather than a self-asserted wire field, closing a forgery that could suppress or duplicate
a member's reply in a quorum (see `broadcast-reply-identity.md` in this same release for the
detail).

## What a consumer will actually hit

- `GroupCrypto.exportSecret(label, length?)` — `label` is no longer optional. Every call site
  must name the domain it derives into, and a `GroupCrypto` you maintain must derive different
  bytes for different labels: `@kumiai/rpc-conformance`'s suite now checks it.
- `GroupCrypto.unwrap` returns `{ payload, senderDID: string }` (`GroupUnwrapResult`, exported
  from `@kumiai/rpc`) — `senderDID` is no longer optional. An implementation with no sender to
  give must throw rather than return the field missing; the conformance suite now checks this
  bidirectionally too.
- `GatheredReply.from` is now `GatheredReply.senderDID`, and it is the authenticated sender, not
  whatever the reply's own bytes claimed.
- Every hub procedure moved: `hub/publish` -> `hub/v1/publish`, and the same for `subscribe`,
  `unsubscribe`, `topic/fetch`, `receive`, `keypackage/upload`, `keypackage/fetch`. A client on
  a pre-release build cannot talk to a hub on this one, and the reverse — deploy the hub and
  every `@kumiai/hub-client` consumer together. `@kumiai/hub-tunnel` names no procedure directly
  and is unaffected.
- `AuthorizeHook` takes one discriminated `AuthorizeRequest` instead of positional arguments, and
  returns `AuthorizeDecision` (`boolean | { allow, reason?, code?, retryAfterMs? }`) instead of a
  bare `boolean`. `code` and `retryAfterMs` are accepted today but not yet wired to a caller.
- `decodeClientState` throws a message-bearing error for an unknown version instead of returning
  `undefined`; other decode failures (malformed or truncated bytes) are unchanged.
- `MLSCredentialIdentity` gains `v?: 1`; a credential encoded before this release has no `v` and
  keeps parsing, permanently.
- `GroupCryptoParams.label` is **deleted** (`@kumiai/mls-rpc`'s `createGroupCrypto`); the
  per-purpose label now comes from the `exportSecret(label, …)` call itself, and the only override
  left is `entryLabel`, which names just the ledger-entry seal. Passing `label` in an object
  literal is an excess-property error and fails loudly — but passing a loosely-typed variable
  compiles, is silently ignored, and **changes every derived topic ID**, because the app topic is
  derived under `APP_TOPIC_LABEL` regardless of what you meant to override. Audit `createGroupCrypto`
  call sites by hand rather than trusting the compiler.
- `@kumiai/mls-rpc` no longer exports `APP_TOPIC_LABEL`; import it from `@kumiai/rpc`.
- `@kumiai/hub-server` no longer exports the `AuthorizeAction` type. The actions are now the
  `action` discriminant of `AuthorizeRequest`; a consumer that named the old type should narrow on
  `AuthorizeRequest` instead, or use `AuthorizeRequest['action']`.

**Deploy together, not gradually.** The commit-frame, ledger-entries and handshake-frame version
bytes, the broadcast wire version, and the `hub/v1/*` rename are each wire changes: a peer, hub,
or client running before this release cannot talk to one running after it on the affected lane.
None of this branch's test or dev groups need to survive the upgrade, which is what makes taking
all of it in one release acceptable — a group with something to lose would need every member
upgraded in the same window.
