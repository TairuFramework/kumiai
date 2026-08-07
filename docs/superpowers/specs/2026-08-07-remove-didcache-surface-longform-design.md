# Remove `DIDCache` from `GroupHandle`, surface `longForm` on `GroupMember`

**Date:** 2026-08-07
**Package:** `@kumiai/mls`
**Supersedes:** `docs/agents/plans/next/2026-08-07-didcache-inert-end-to-end.md` (the fork that
document left open is decided here)

## Problem

`GroupHandle` accepts a `DIDCache` and a `DIDResolver`, stores them, exposes them as getters, and
carries them onto every derived handle. Nothing in `packages/mls/src` ever reads or writes either.
`populateCacheFromCredential` — the only function that would write to the cache — is exported from
the package index and has no caller in any repo. `verifyLedgerEntry` calls `verifyToken(token)` with
neither, though `VerifyTokenOptions` accepts both.

The arrangement is not broken; it is over-declared. The failure mode is a consumer wiring a cache in
and assuming it works, then getting a miss for a document it was told would be there. kubun's
`plugin-p2p` has already threaded a cache through `MLSGroupHandleParams` and `GroupHandleRegistry`
on exactly that assumption.

Meanwhile the thing a consumer actually needs is one field away and already computed. kubun's
credential store encrypts to a recipient's X25519 key, and `resolveX25519Key`
(`kokuin/packages/token/src/jwe.ts:136`) refuses a `did:peer:4` short form — the document lives in
the long form. `GroupHandle.#iterateMembers` parses each leaf's identity, which carries that long
form, and discards it: `GroupMember` is `{ leafIndex, id }`.

## Why no cache is the right answer

Every DID document a consumer can reach is already inside a signed artifact:

- A **current member's** document is in that member's MLS leaf credential. The leaf is signed and
  can never be rewritten, so it is the authenticated original.
- A **ledger author's** document is in that author's signed token. `signLedgerEntry` passes
  `{ embedLongForm: true }` (`ledger.ts:63`) precisely so each entry is self-verifying offline, and
  `GroupHandle` retains those tokens.

The only DID a cache would cover that neither of these does is a member who joined, never signed a
ledger entry, and was later removed. Nothing wants that today.

A cache would therefore be an unsigned second copy of state that is already authenticated — with a
staleness surface and, if written from inside `validateCredential`, a `cache.set` rejection that a
`boolean`-returning ts-mls callback would have to swallow silently.

## Design

### Removals

| Location | Removed |
| --- | --- |
| `types.ts:56-59` | `GroupOptions.cache`, `GroupOptions.resolver`, and the `DIDCache`/`DIDResolver` import |
| `group-handle.ts:250-251` | `GroupHandleParams.cache`, `.resolver` |
| `group-handle.ts:265-266,284-285` | `#cache` / `#resolver` fields and their assignment |
| `group-handle.ts:328-334` | `get cache()`, `get resolver()` |
| `group-handle.ts:1059-1060` | `deriveGroup` passthrough |
| `group-create.ts:28,101` | `createInMemoryDIDCache()` defaults |
| `group-create.ts:82-83,108-109` | `cache` / `resolver` arguments to `new GroupHandle` |
| `group-welcome.ts:49,212` | `createInMemoryDIDCache()` defaults in `processWelcome` and `restoreGroup` |
| `group-welcome.ts:101-102,267-268` | `cache` / `resolver` arguments to `new GroupHandle` |
| `credential.ts:79-90` | `populateCacheFromCredential` |
| `index.ts:35` | its export |

After this, no file in `packages/mls/src` imports `DIDCache`, `DIDResolver`, or
`createInMemoryDIDCache`.

`verifyLedgerEntry` continues to call `verifyToken(token)` with no options. That is now consistent
with the package rather than a gap in it: every ledger token embeds its own long form.

`populateCacheFromCredential` goes with the rest. A host that wants its own cache has the decoded
input from `GroupMember.longForm` and can call `decodePeer4` plus `cache.set` in two lines; leaving
an exported cache-writer in a package with no cache re-invites the assumption this work removes.

### Additions

```ts
export type GroupMember = {
  /** MLS leaf index (ratchet-tree array position / 2, matching findMemberLeafIndex). */
  leafIndex: number
  /** DID parsed from the leaf's MLS credential identity. */
  id: string
  /** Resolvable form of `id`: the leaf's `longForm` for did:peer:4, `id` itself for did:key. */
  longForm: string
}
```

`longForm` is non-optional. For `did:key` it equals `id`, matching how the stack already defines it
— `signToken({ embedLongForm })` is documented as a no-op for `did:key` because long form *is* the
id there. A consumer feeding `resolveX25519Key` never writes `?? m.id`.

Populated in `#iterateMembers` (`group-handle.ts:526-543`) as `parsed.longForm ?? parsed.id`. The
fallback is unreachable for `did:peer:4`: `makeMLSCredential` refuses to build a peer:4 identity
without a long form, and `validateCredential` (`authentication.ts:41`) rejects any peer:4 leaf
lacking one before it can enter a ratchet tree. Both gates are on the signed side. The fallback
exists for `did:key`.

```ts
findMemberLongForm(id: string): string | undefined
```

Placed beside `findMemberLeafIndex` on `GroupHandle` and normalizing both sides with `normalizeDID`
exactly as that method does, so a caller may pass either the short form or the long form. Returning
`undefined` means no such member, and only that — it never means "this member has no long form".

The method exists alongside the field rather than instead of it: the field serves enumeration (a
consumer wrapping a credential for every recipient walks the tree once), the method serves by-DID
lookup without each consumer re-learning that a leaf's `id` is un-normalized.

### Where the rationale lives

The doc comment on `GroupMember.longForm` states why `@kumiai/mls` holds no DID cache: every
document a consumer can reach is already in a signed artifact — a current member's in their leaf, a
ledger author's in their token — so a cache would be an unsigned second copy of authenticated state.
This is the note that stops the next reader re-deriving why a cache would sit next to an artifact
carrying its own long form.

## Cross-repo consequence

kubun's `plugin-p2p` already threads a cache, contrary to the superseded plan document's claim that
kubun passes none:

- `MLSGroupHandleParams.cache` (`kubun/packages/plugin-p2p/src/groups/mls-group-handle.ts:37`),
  spread into group options at `:61`
- `GroupHandleRegistry.#didCache` (`.../groups/group-handle-registry.ts:106,137`) and its
  `didCache` getter (`:146`)

The spread is `...(params.cache != null ? { cache: params.cache } : {})`. TypeScript does not
excess-property-check spreads, so kubun will keep compiling green against a `GroupOptions` that no
longer declares the field. **It must be removed in kubun deliberately — a build will not report
it.** kubun's credential store then reads `findMemberLongForm` instead.

`RestoreMLSGroupHandleParams.cache`'s doc comment
(`kubun/packages/plugin-p2p/src/groups/mls-group-handle.ts:33-35`) also needs to go: "Omitting it
does not disable caching — `@kumiai/mls` mints a fresh in-memory cache per handle instead, so…"
becomes false with this change, and it will not turn up when someone greps kubun for `DIDCache`.

That cleanup is kubun's own change, tracked from kubun's credential-store spec
(`kubun/docs/superpowers/specs/2026-08-07-credential-store-design.md`). This spec covers kumiai only.

## Versioning

Removing public fields is breaking. kumiai is pre-1.0 with eleven packages on one shared version
band, so this is a minor bump taken as a group act. Record the `pnpm change` intent as the work
lands rather than at release time.

## Testing

Removed:

- the `populateCacheFromCredential` describe block in `packages/mls/test/credential.test.ts`
- the `cache` parameter and arguments in `packages/mls/test/recovery-forgery.test.ts`
  (`:259,265,297,345,407`), which constructs a `GroupHandle` directly

Added:

- `listMembers()` reports `longForm` equal to the identity's long form for a `did:peer:4` member
- `listMembers()` reports `longForm` equal to `id` for a `did:key` member
- `findMemberLongForm` resolves a member given their short form
- `findMemberLongForm` resolves the same member given their long form
- `findMemberLongForm` returns `undefined` for a DID that is not a member

Each new test gets a mutation check before it is considered done: break the guard it covers, confirm
the test goes red, restore. A test that passes against a broken implementation proves nothing.

## Done when

- `DIDCache` and `DIDResolver` no longer appear anywhere in `packages/mls/src`.
- `GroupMember.longForm` and `GroupHandle.findMemberLongForm` are on the public surface and covered
  by mutation-checked tests.
- The `embedLongForm` relationship is stated on `GroupMember.longForm`.
- `docs/agents/plans/next/2026-08-07-didcache-inert-end-to-end.md` is deleted, not archived — it
  posed a question this spec answers, and nothing in it survives the answer.
- A changeset records the breaking removal.
