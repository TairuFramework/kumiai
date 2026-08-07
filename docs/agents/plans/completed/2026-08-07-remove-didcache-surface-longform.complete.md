# Removing the inert `DIDCache`, surfacing `GroupMember.longForm`

**Status:** complete
**Date:** 2026-08-07
**Branch:** `remove-didcache-surface-longform`

## What this was

`GroupHandle` accepted a `DIDCache` and an optional `DIDResolver`, stored them, exposed them as
getters, and carried them onto every derived handle. Nothing in `packages/mls/src` ever read or
wrote either one. `populateCacheFromCredential` — the only function that would have written to the
cache — was exported from the package index with no caller in any repo. Every group entry point
(`createGroup`, `processWelcome`, `restoreGroup`) minted a fresh `createInMemoryDIDCache()` when the
caller supplied none, so a handle constructed a cache, handed it down through every epoch, and
nothing ever touched it.

The arrangement was not broken; it was over-declared. The failure mode was a consumer wiring a cache
in and assuming it worked, then getting a miss for a document it had been told would be there —
which kubun's `plugin-p2p` had already begun doing.

Meanwhile the thing a consumer actually needed was one field away and already computed.
`#iterateMembers` parses each leaf's credential identity, which carries the `did:peer:4` long form,
and threw that field away.

## The design decisions worth keeping

**Removal beat wiring it up, because every reachable DID document already lives in a signed
artifact.** A current member's is in that member's MLS leaf credential — signed, and never
rewritable, so it is the authenticated original. A ledger author's is in that author's own token:
`signLedgerEntry` passes `{ embedLongForm: true }` precisely so each entry is self-verifying
offline, and the handle retains those tokens. A cache beside those would be an unsigned second copy
of authenticated state, with a staleness surface. Wiring it up would also have meant writing from
inside `validateCredential`, whose `boolean` return to ts-mls means a `cache.set` rejection would
have to be swallowed silently.

The one DID a cache would cover that neither artifact does: a member who joined, never signed a
ledger entry, and was later removed. Accepted knowingly — nothing wants that.

**`verifyLedgerEntry` keeps calling `verifyToken(token)` with no options.** `VerifyTokenOptions`
accepts a cache and a resolver, and passing neither used to read as a gap. It is now consistent with
the package: every ledger token embeds its own long form, so verification never needed either.

**`GroupMember.longForm` is non-optional, and equals `id` for `did:key`.** The stack already defines
long form that way — `signToken({ embedLongForm })` is documented as a no-op for `did:key` because
long form *is* the id there. Making the field total means a consumer feeding `resolveX25519Key`
never writes `?? m.id`, and `undefined` from the lookup carries exactly one meaning: no such member.

**`findMemberLongForm` exists alongside the field rather than instead of it.** The field serves
enumeration — a consumer wrapping a credential for every recipient walks the tree once. The method
serves by-DID lookup, normalizing both sides exactly as `findMemberLeafIndex` does, so a caller may
pass either the short form or the long form and need not re-learn that a leaf's `id` is
un-normalized.

**The `?? parsed.id` fallback is unreachable for `did:peer:4` on the add and join paths, and both
gates are tested.** `makeMLSCredential` refuses to build a peer:4 identity without a long form
(`credential.test.ts:96`); `validateCredential` rejects any peer:4 leaf lacking one before it can
enter a ratchet tree (`authentication.test.ts:107`), and rejects one whose long form hashes to a
different id (`authentication.test.ts:119`). `restoreGroup` is the exception and the comment says
so: it takes a caller-supplied `ClientState`, and `decodeClientState` checks a version byte and
ts-mls decoding without re-running credential validation. That is the host's own persisted state, so
trusting it is correct — but neither gate runs on that path.

## What was built

- `GroupMember` gained `longForm: string`, filled in `#iterateMembers` as `parsed.longForm ??
  parsed.id`.
- `GroupHandle.findMemberLongForm(id: string): string | undefined`, beside `findMemberLeafIndex`.
- `GroupOptions.cache`/`.resolver`, `GroupHandleParams.cache`/`.resolver`, the `#cache`/`#resolver`
  fields, both getters, the `deriveGroup` passthrough, the four `createInMemoryDIDCache()` defaults,
  and `populateCacheFromCredential` with its index export: all gone. No file in `packages/mls/src`
  imports `DIDCache`, `DIDResolver`, or `createInMemoryDIDCache`.
- A changeset bumping all eleven publishable packages to `minor` — a breaking removal on a shared
  pre-1.0 band is a group act, and `scripts/check-versions.mjs` fails the release otherwise.

Tests: the deleted `populateCacheFromCredential` block was the redundant copy of a binding check
that survives at the stronger site (`authentication.test.ts:119`, which gates entry into the ratchet
tree rather than a cache write). Added: `packages/mls/test/member-long-form.test.ts`, seven tests,
including one that reads a peer:4 long form off a leaf the local device did not write — two
identities through `createInvite` → `commitInvite` → `processWelcome`, asserting both directions and
`listMembers()` on the joiner. Every new test was mutation-checked: the guard broken, the test
confirmed red, then restored.

## Cross-repo consequence

kubun's `plugin-p2p` threaded a cache into group options through
`...(params.cache != null ? { cache: params.cache } : {})`. **TypeScript does not
excess-property-check spreads**, so kubun compiles green against a `GroupOptions` that no longer
declares the field — the break is silent, and no build reports it. The cleanup covers eight source
sites in `plugin-p2p` plus two test files, including a doc comment on
`RestoreMLSGroupHandleParams.cache` reading "Omitting it does not disable caching — `@kumiai/mls`
mints a fresh in-memory cache per handle instead", which this change makes false and which does not
turn up in a grep for `DIDCache`. kubun took that cleanup on its own side as this landed; because
`GroupOptions.cache` was optional, passing nothing compiles against both the previous release and
this change.

`DIDCache` itself is not orphaned — it keeps real consumers in `kokuin/token`, `kokuin/capability`,
and `enkaku/server`.

Downstream, a hypothetical peer:4 short form escaping as a `longForm` is fail-closed rather than a
mis-wrap: kokuin's `resolveX25519Key` refuses a peer:4 short form outright at JWE encrypt time, so
it surfaces as a hard error, not a credential wrapped to a key nobody holds.
