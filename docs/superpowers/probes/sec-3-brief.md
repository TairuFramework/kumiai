# Probe brief — cross-group isolation rests on one throw, and no test can see it

Implementation probe in `/Users/paul/dev/yulsi/kumiai`, branch `feat/app-lane-delivery`. Do NOT switch
branches, do NOT commit. Leave changes uncommitted.

**Never run `git checkout`, `git restore`, or `git stash` on a file with uncommitted work.**

## The defect

`createEncryptedHubTunnelTransport` stamps `groupID` into the envelope on publish
(`packages/hub-tunnel/src/encrypted-transport.ts:42-51`) and **never checks it on receive** (`:75-101`).
So cross-group and cross-key isolation rests **entirely** on `decrypt` throwing for a foreign key.

That is load-bearing behaviour with no test behind it. `FakeEncryptor`
(`packages/hub-tunnel/test/fixtures/fake-encryptor.ts:48-68`) accepts any ciphertext ending in the
constants `0xaa 0x55` (`:5-6`) — **the tag is not derived from the key** — so bytes encrypted under a
DIFFERENT key pass the check and XOR out to garbage that is returned as plaintext. Every
encrypted-transport test wires both sides with the same `SHARED_KEY`, and the two negative tests use the
explicit `failNextDecrypts` / `corruptNextCiphertexts` controls rather than a genuinely foreign key.

**Consequence:** swapping the production encryptor for a non-authenticating cipher (CTR/CBC, no tag)
would keep the whole suite green while foreign-group frames were accepted as authenticated plaintext.
The suite cannot tell an AEAD from a stream cipher.

## Approved approach (follow it; BLOCKED if it fights the code — do not redesign)

1. **Make the fake's tag key-dependent.** Derive it from the key so a wrong-key ciphertext fails the
   check, the way an AEAD refuses. The fake must be at least as strict as the port — stricter is fine,
   more permissive is the defect.
2. **Test with a genuinely foreign key**, not with the failure-injection controls. A frame encrypted
   under a different key must be rejected, and the existing `failNextDecrypts` /
   `corruptNextCiphertexts` tests stay as they are — they test a different thing.
3. **Check `groupID` on receive.** It is already in the envelope and already stamped on publish; a
   receiver that ignores it is trusting the cipher for something the envelope states outright. Defence
   in depth: a frame whose `groupID` is not this transport's is dropped, whether or not it decrypts.
   Argue in the comment what this catches that the AEAD does not — a same-key cross-group misroute, a
   configuration error — and be honest if the answer is "little, but it is free".

If the receive path's shape makes (3) awkward, say so and do (1) and (2) — those are the ones that stop
the suite lying. Do not restructure the transport to fit.

## Done when (all required)

1. **A foreign-key frame is rejected** by the fake, on the transport's real receive path. Must fail
   against today's fake.
2. **A wrong-`groupID` frame is dropped** even when it decrypts cleanly.
3. **The existing encrypted-transport tests still pass unchanged**, including both negative ones.
4. **Mutation checks (required, paste each):** revert the fake's tag to key-independent → (1) goes red;
   remove the `groupID` check → (2) goes red. Invert by hand.
5. Whole suite green (30/30 turbo). Do not weaken an existing test.

## Scope boundary

`packages/hub-tunnel/` ONLY — the encryptor fake, the encrypted transport, and their tests. **Out of
scope, being worked concurrently by other probes: do not touch** `packages/rpc/src/hub-mux.ts`,
`packages/rpc/src/peer.ts`, `packages/rpc/src/classify.ts`, `packages/mls/src/group-handle.ts`, or the
rpc fixtures.

`hub-tunnel/test/fixtures/fake-hub.ts` has two known lesser divergences (it echoes to the sender, and
mints unpadded sequenceIDs where the real store zero-pads to 12 digits — a bare decimal breaks `>` at
the 9→10 boundary). Fix them **only** if it is genuinely small; otherwise leave them and say so, and
they will be filed.

## Conventions

`kigu:conventions` + repo `AGENTS.md`/`CLAUDE.md`. `type` not `interface`; `Array<T>`; no `any`; capital
`ID`; `#fields`; never edit `lib/`.

## Verify (repo root, paste real output)

`pnpm run build && rtk proxy pnpm run lint && pnpm test`

## Report contract

Full report → `docs/superpowers/probes/sec-3-report.md`. Return ONLY: status, uncommitted-changes note,
one-line test summary, concerns. No full diff.
