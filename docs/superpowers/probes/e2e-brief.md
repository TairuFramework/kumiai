# Probe brief — prove the branch's thesis against real crypto and a real hub, or find out why it cannot

Implementation probe in `/Users/paul/dev/yulsi/kumiai`, branch `feat/app-lane-delivery`. Do NOT switch
branches, do NOT commit. Leave changes uncommitted.

**Never run `git checkout`, `git restore`, or `git stash` on a file with uncommitted work.**

## Why this exists

This branch exists to stop app messages being silently lost to a member who was away. It has 288 tests
and **not one of them runs against real crypto or a real hub.** No integration test touches
`createGroupPeer` at all; every rpc test uses a fake crypto, a memory MLS, and a fake hub.

That is not an oversight. `GroupCrypto` (`packages/rpc/src/crypto.ts`) **has no implementation anywhere
in this repo and cannot have one**: `exportSecret` needs the MLS per-epoch exporter secret (RFC 9420
§8.5), and `@kumiai/mls` exposes none. The `exportSecret` at `packages/mls/src/crypto.ts:443` is an HPKE
primitive, not the group exporter. `GroupMLSHandle` has no exporter method. Filed at
`docs/agents/plans/next/2026-07-16-exporter-secret-surface.md` — **read it first.**

So no host can wire this branch today, and nothing has ever exercised it for real.

## The work, in order

### 1. Expose the exporter secret from `@kumiai/mls`

The MLS exporter (RFC 9420 §8.5) derives a secret from the epoch's exporter secret, a label, and a
context. ts-mls implements it; find its surface rather than reimplementing the KDF. Expose it on
`GroupMLSHandle` and from the package index.

Two properties are the whole point, and both need a test:
- **It is per-epoch.** The same label and context at two epochs give different secrets. This is the only
  thing that cuts a removed member off, since a removed member keeps the lifelong recovery secret and
  can enumerate epoch numbers.
- **Every member at an epoch derives the same value**, and a member at a different epoch does not.

### 2. A real `GroupCrypto` over `@kumiai/mls`

Implement the port for real: `epoch`, `exportSecret`, `wrap`, `unwrap`, `frameEpoch`. `GroupMLSHandle`
already has `encrypt` (`group-handle.ts:560`); find or add its counterpart. Where the real
implementation must diverge from the fake's documented behaviour, **say so** — the fake's `unwrap`
deliberately refuses every epoch but the live one, which is stricter than real MLS's four-epoch window,
and the architecture doc states rpc reads at the sealing epoch regardless.

Decide and argue where this lives. It is a real implementation, not a fixture: if it belongs in `rpc/src`
as the default, say why; if it belongs in a separate package, say why.

### 3. The end-to-end test — the actual deliverable

In `tests/integration/`, against the **real** `hub-server`, **real** `@kumiai/mls` handles, and the real
`GroupCrypto` from step 2 — the branch's thesis, start to finish:

1. Three members in a group. One goes offline.
2. The others exchange logged app messages, then change the roster (an add AND a remove — both rotate the
   anchor, for different reasons).
3. More logged messages on the new segment.
4. The absent member comes back, walks the commit log, and **receives every message it missed, in order,
   exactly once** — across the rotation, opening each at the epoch it was sealed at.
5. A removed member cannot derive the group's new topic. This is the claim the XOR fake structurally
   could not carry; here it can be real.

Then, still end to end: a peer restarting mid-walk does not lose or duplicate; the durable cursor
survives a restart; a frame published mid-walk is delivered.

## Expect to find things

Four defects this session came from doubles diverging from their ports, and this is the first time the
real ports run. **Every divergence you hit is a finding worth more than the test** — report it, do not
work around it. If the real crypto or the real hub contradicts something the suite asserts, that is the
most valuable output this probe can produce.

If step 1 or 2 turns out to be genuinely blocked, **STOP and report BLOCKED** with what you found. A
clear account of why the branch cannot be wired is worth more than a test that fakes its way past it. Do
NOT substitute a double at any layer to make the test pass — that would recreate the exact problem this
probe exists to escape.

## Done when

1. The exporter secret is exposed and its per-epoch property tested.
2. A real `GroupCrypto` exists, with its divergences from the fake documented.
3. The end-to-end scenario above passes against real crypto, real MLS, and a real hub.
4. Any divergence found between a double and its port is reported.
5. Whole suite green (rpc 277+, mls 311+, `turbo run test:types test:unit --force` 30/30, integration
   23+). Do not weaken an existing test.

**Every new test must be watched failing first where it can be** (a scenario test may pass on first
write — say so honestly rather than manufacturing a red). Five tests this session passed for reasons
unrelated to what they claimed; one was written by the reviewer.

## Scope boundary

`packages/mls/`, `tests/integration/`, and wherever the real `GroupCrypto` lands. Do not change app-lane
behaviour in `packages/rpc/src/peer.ts`, `classify.ts`, or the hub packages — if the end-to-end run shows
one of them is wrong, that is a finding to report, not to fix here.

## Conventions

`kigu:conventions` + repo `AGENTS.md`/`CLAUDE.md`. `type` not `interface`; `Array<T>`; no `any`; capital
`ID`; `#fields`; never edit `lib/`.

## Verify (repo root, paste real output)

`pnpm run build && rtk proxy pnpm run lint && pnpm exec turbo run test:types test:unit --force`
(`pnpm test` alone reports cached results — force it.)

## Report contract

Full report → `docs/superpowers/probes/e2e-report.md`. Return ONLY: status, uncommitted-changes note,
one-line test summary, every divergence found between a double and its real port, and concerns.
