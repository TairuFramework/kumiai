# Probe brief — an external commit's committer is returned unverified, and it steers healing

SECURITY fix in `/Users/paul/dev/yulsi/kumiai`, branch `feat/app-lane-delivery`. Do NOT switch branches,
do NOT commit. Leave changes uncommitted.

**Never run `git checkout`, `git restore`, or `git stash` on a file with uncommitted work.**

## The defect

`readExternalCommit` (`packages/mls/src/group-handle.ts:178-199`) is a purely **structural** read. It
checks the wireformat, the sender type, the content type, and pulls a DID out of the UpdatePath leaf's
credential. **It verifies no signature.** `readCommitHeader:768` returns that as a valid header with
`external: true`, and a PublicMessage's epoch is **cleartext**.

Anyone who can publish to the commit topic — including the untrusted hub, which sees every topic ID in
the clear — can forge a frame that is accepted as a genuine external commit by any member, carrying an
arbitrary DID and an arbitrary epoch.

**Confirmed reachable today**, independent of this branch: a forged external commit claiming a high
epoch classifies as `ahead` and drives an honest peer to heal (rejoin). One hostile publish, M peers
heal, M group-wide epoch advances.

The bound that keeps it survivable — one heal per frame, no loop, lane not wedged — is now pinned by a
test. That is a bound, not a fix.

## Approved approach (follow it; BLOCKED if it fights the code — do not redesign)

**Verify the external commit's own signature before returning a committer.** An external commit is
self-signed by the joining leaf's key, and that key is in the UpdatePath leaf the DID was read from — so
the signature is checkable with nothing but the frame itself, no group secret and no tree. Check it, and
return `null` (not a header) when it does not verify.

Be precise in the doc comment about what this does and does not buy, because the difference matters:

- **It stops forgery by a party holding no key** — the hub, a network attacker, any non-member. That is
  the exposure above, and it closes.
- **It does not prove authorization.** A verified signature says "whoever made this holds that leaf
  key", not "this member may rejoin". A genuine external commit **replayed** by the hub still verifies.
  State both. If either needs a bound that is not in scope here, file it rather than half-building it.

**Then re-examine `classify`'s `external` handling with that in hand** (`classify.ts`, and the double's
exemption at `memory-group-mls.ts:534-537` which says "`external` is exempt and must stay so"). The
exemption is correct in shape — an external commit genuinely needs no epoch secret — but it was written
assuming the header could be trusted. Decide what it should say once the signature is checked, and make
the double match the port exactly. The double must not verify less than the port does.

## Done when (all required)

1. **A forged external commit is refused.** A structurally valid frame with a bogus or absent signature
   yields no header, classifies as poison, and heals nobody. Must fail against today's code.
2. **A genuine external commit still works end to end** — a real rejoin still rotates the anchor and the
   stranded peer still heals. Do not close the hole by breaking the feature.
3. **The double matches the port.** `memory-group-mls`'s external path refuses what the real one
   refuses.
4. **Mutation check (required, paste it):** drop the signature check → (1) goes red. Invert by hand.
5. Whole suite green (rpc, mls, 30/30 turbo). Do not weaken an existing test.

## Also required

File what you could not close at `docs/agents/plans/next/2026-07-18-external-commit-amplification.md`:
the replay question, and the amplification (1 hostile publish → M heals → M epoch advances), which
belongs to whoever gates publishing to the commit topic and is not closable in `classify.ts`.

## Scope boundary

`readExternalCommit`, `readCommitHeader`'s external path, `classify`'s external handling, and their
doubles/tests ONLY. **Out of scope:** the app-lane drain, the anchor seam, `hub-mux`, the encrypted
transport (two other probes are working those concurrently — do not touch `packages/rpc/src/hub-mux.ts`,
`packages/rpc/src/peer.ts`, or anything under `packages/hub-tunnel/`).

## Conventions

`kigu:conventions` + repo `AGENTS.md`/`CLAUDE.md`. `type` not `interface`; `Array<T>`; no `any`; capital
`ID`; `#fields`; never edit `lib/`. Comments state the invariant, never a finding or phase number.

## Verify (repo root, paste real output)

`pnpm run build && rtk proxy pnpm run lint && pnpm test`

## Report contract

Full report → `docs/superpowers/probes/sec-1-report.md`. Return ONLY: status, uncommitted-changes note,
one-line test summary, and specifically **what an attacker can still do after your fix**. No full diff.
