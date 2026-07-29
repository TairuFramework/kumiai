# Security Residuals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** executing
**Mode:** tasks
**Execution:** subagent-driven (`superpowers:subagent-driven-development`), a fresh subagent per task with review between. Approved 2026-07-29; no task started yet — begin at Task 1.

**Goal:** Close the two actionable items in `docs/agents/plans/next/2026-07-16-security-residuals.md` — pin the answer to the external-commit replay question with tests plus the hub clause it rests on, and state the `rpc-conformance` obligation where a host writes its own port.

**Architecture:** Four independent tasks. Task 1 adds one clause to both hub-conformance suites (the property the replay answer depends on, pinned at the layer that owns it). Task 2 adds the rpc-level replay tests that consume it. Task 3 is documentation on the port types and both READMEs. Task 4 moves the planning docs. Tasks 1 and 2 are ordered — 2's comments reference 1's clause by name — but 3 and 4 are independent of both.

**Tech Stack:** TypeScript, vitest, pnpm workspaces, turbo. Packages `@kumiai/rpc`, `@kumiai/hub-conformance`, `@kumiai/rpc-conformance`, `@kumiai/hub-server`.

**Spec:** `docs/superpowers/specs/2026-07-29-security-residuals-design.md`

## Global Constraints

- Branch is `chore/security-residuals`, already created. Do not create another.
- pnpm only. Do not edit generated files (`lib/`).
- Do **not** run `pnpm run lint` or `pnpm run test` directly — an `rtk` shim intercepts `pnpm run <script>` and redirects it. Use `rtk proxy pnpm run lint`, or invoke tools directly (`pnpm exec biome check`, `pnpm --filter <pkg> exec vitest run`).
- Changing a port or a contract suite means running **both** contract suites against the real implementation *and* the doubles (`AGENTS.md`). Task 1 changes `hub-conformance`, so it must go green against `@kumiai/hub-server`'s real stores and against `@kumiai/rpc`'s `FakeHub` double.
- No changes to the `kubun` repo. Its `GroupCrypto` is already conformant; that is a finding, not work.
- Commit at the end of each task. Do not squash tasks into one commit.

---

### Task 1: The hub-conformance clause the replay answer rests on

The `@kumiai/rpc` commit lane resolves two commits at one epoch by sequenceID order: the lower one stands (`branch: 'winning'`), the higher one heals (`branch: 'losing'`). A replayed commit frame is safe only because it lands *above* the frame a peer already applied. Nothing pinned that. This clause does, in both suites, mirroring how the existing `sequenceIDs are lexicographically ordered across the 9 to 10 boundary` clause is carried in both.

**Files:**
- Modify: `packages/hub-conformance/src/index.ts` — insert after the `a deduped publish reports deduped, appends nothing, and creates no new delivery` test (ends around line 505)
- Modify: `packages/hub-conformance/src/log-hub.ts` — insert after the `a replayed publishID returns the original sequenceID and appends nothing` test (ends line 329)

**Interfaces:**
- Consumes: existing suite helpers in each file — `createStore` / `createHub`, `ALICE`, `BOB`, `CAROL` (index.ts only), `TOPIC`, `payload(byte)`, `maxRetention`, `maxDepth`.
- Produces: nothing importable. Task 2's test comments reference this clause by its test name, verbatim: `a re-published payload under a fresh publishID never lands below the original`.

- [ ] **Step 1: Add the clause to the `HubStore` suite**

In `packages/hub-conformance/src/index.ts`, immediately after the `a deduped publish reports deduped, appends nothing, and creates no new delivery` test's closing `})`:

```ts
    test('a re-published payload under a fresh publishID never lands below the original', async () => {
      const store = await createStore()
      await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })

      const { sequenceID: original } = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
        publishID: 'publish-original',
      })

      // A capture-and-replay, which is a different thing from the publishID replay above: the
      // same bytes handed back by somebody who merely OBSERVED them, under a publishID the
      // original publisher never used. The idempotency record cannot catch it — the replayer
      // picks the key — so the store alone decides what position the frame gets.
      const { sequenceID: replayed } = await store.publish({
        senderDID: CAROL,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
        publishID: 'publish-replay',
      })

      // A FLOOR, deliberately, not "strictly greater". A store that deduplicated on content would
      // hand back the original sequenceID, and that is equally safe for the reader described
      // below. What must never happen is a replay landing BELOW the original.
      expect(replayed >= original).toBe(true)

      // Why this is a security clause and not a tidiness one. `@kumiai/rpc`'s commit lane resolves
      // two commits at one epoch by sequenceID order: the lower one stands, the higher one is
      // stepped over. A replayed commit frame landing below the frame a peer already applied would
      // read as the LOSING side of a fork on every peer that applied the original, and each would
      // rejoin — a group-wide heal per replay, for bytes that were already delivered once.
    })
```

- [ ] **Step 2: Add the same clause to the `LogHub` suite**

In `packages/hub-conformance/src/log-hub.ts`, immediately after the `a replayed publishID returns the original sequenceID and appends nothing` test's closing `})` (line 329). Note this suite's hub is constructed per-case and `subscribe` is synchronous:

```ts
    test('a re-published payload under a fresh publishID never lands below the original', async () => {
      const hub = await createHub({ maxRetention, maxDepth })
      hub.subscribe(BOB, TOPIC)

      const { sequenceID: original } = await hub.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
        publishID: 'publish-original',
      })

      // A capture-and-replay, not a publishID replay: the same bytes re-sent by somebody who
      // observed them, under a key the original publisher never used. No expectedHead — the
      // replayer is not doing a compare-and-set, it is appending.
      const { sequenceID: replayed } = await hub.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
        publishID: 'publish-replay',
      })

      // A floor, not "strictly greater": content-deduplication handing back the original is
      // equally safe. `@kumiai/rpc`'s commit lane resolves two commits at one epoch by sequenceID
      // order — lower stands, higher is stepped over — so a replay landing BELOW an applied frame
      // would heal every peer that applied the original, once per replay.
      expect(replayed >= original).toBe(true)
    })
```

- [ ] **Step 3: Run it against the real stores**

Run: `pnpm --filter @kumiai/hub-server exec vitest run test/conformance.test.ts test/log-hub-conformance.test.ts`
Expected: PASS. `memoryStore`'s `formatSequenceID` zero-pads a monotonic counter, so the new clause is already satisfied.

- [ ] **Step 4: Run it against the double**

Run: `pnpm --filter @kumiai/rpc exec vitest run test/hub-conformance.test.ts`
Expected: PASS. `FakeHub` uses the same zero-padded counter.

- [ ] **Step 5: Prove the clause bites**

A clause that passes against a broken store proves nothing. Temporarily invert the counter in `packages/hub-server/src/memoryStore.ts` so later publishes sort lower:

```ts
function formatSequenceID(counter: number): string {
  return String(1_000_000 - counter).padStart(12, '0')
}
```

Run: `pnpm --filter @kumiai/hub-server exec vitest run test/conformance.test.ts -t 'never lands below the original'`
Expected: FAIL — `expect(replayed >= original).toBe(true)` receives `false`.

Then restore `formatSequenceID` to `String(counter).padStart(12, '0')` and re-run Step 3 to confirm green.

- [ ] **Step 6: Type-check and lint**

Run: `pnpm --filter @kumiai/hub-conformance exec tsc --noEmit --skipLibCheck -p tsconfig.json`
Run: `rtk proxy pnpm run lint`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add packages/hub-conformance/src/index.ts packages/hub-conformance/src/log-hub.ts
git commit -m "$(cat <<'EOF'
test(hub-conformance): a replayed payload never lands below the original

The commit lane resolves two commits at one epoch by sequenceID order —
lower stands, higher is stepped over. A capture-and-replay is safe only
because the log appends above the frame a peer already applied, and nothing
pinned that. Stated as a floor so a content-deduplicating store stays legal.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011fJhBCZQbHrPnrtcYn32ng
EOF
)"
```

---

### Task 2: The rpc replay tests

Answers section 2's open question in the residuals doc, and pins the answer. A genuine external commit re-published by the hub steers nothing: a peer that applied the original reads `fork`/`winning` and steps over it; a peer holding no record for that epoch reads `history`. Neither reaches `processCommit`, so `applied.advanced` stays false and the anchor rotation at `peer.ts:1240` never fires — **the app-lane topic does not move**, which is the steer that would have mattered.

New file rather than an addition to `peer-external-forgery.test.ts`: that file's subject is what a signature check does and does not assert, and a replay is explicitly *not* a forgery — same bytes, same key, same context.

**Files:**
- Create: `packages/rpc/test/peer-commit-log-replay.test.ts`
- Read for reference (do not modify): `packages/rpc/test/peer-external-forgery.test.ts`, `packages/rpc/test/fixtures/peer.ts`, `packages/rpc/test/fixtures/commits.ts`, `packages/rpc/test/fixtures/fake-hub.ts`

**Interfaces:**
- Consumes: `FakeHub` (class, with a public `published: Array<StoredMessage>` where each entry carries `sequenceID`, `topicID`, `senderDID`, `payload`); `makeMLSPeer(hub, localDID, recoverySecret, options)` returning `TestPeer` (`{ peer, crypto, mls, journal, anchorStore, appCursorStore, welcomes }`); `publishCommit(params)` returning `Promise<{ sequenceID: string }>`; `commitTopic(recoverySecret)`, `rendezvousTopic(recoverySecret)`; `decodeHandshakeFrame(payload)` and `HANDSHAKE_KIND`. On `TestPeer`: `peer.anchorEpoch()`, `peer.dispose()`, `mls.epoch()`, `mls.commits()`, `mls.rosterDIDs()` (async, unordered — compare as a sorted set).
- Produces: nothing importable. Test-only.

- [ ] **Step 1: Write the failing test file**

Create `packages/rpc/test/peer-commit-log-replay.test.ts`:

```ts
import { describe, expect, test } from 'vitest'

import { decodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import { commitTopic, rendezvousTopic } from '../src/topic.js'
import { publishCommit } from './fixtures/commits.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { makeMLSPeer } from './fixtures/peer.js'

const flush = (ms = 60) => new Promise((r) => setTimeout(r, ms))

/** Fast rendezvous, so a heal that is going to happen happens inside the test. */
const recovery = { timeoutMs: 120, getDelayMs: () => 5, deadlineMs: 600 }

/** Every recovery request this peer put on the wire — one per heal it asked for. */
function recoveryRequests(hub: FakeHub, rs: Uint8Array): Array<unknown> {
  const topic = rendezvousTopic(rs)
  return hub.published.filter((m) => {
    if (m.topicID !== topic) return false
    try {
      return decodeHandshakeFrame(m.payload).kind === HANDSHAKE_KIND.recoveryRequest
    } catch {
      return false
    }
  })
}

/**
 * Wake the commit lane without writing to the log: a mailbox frame on the commit topic is
 * delivered, never retained, and a delivery is only ever a wakeup. It is how a test says
 * "read your log again" — which is the whole question when asking whether the cursor moved.
 */
async function wakeLane(hub: FakeHub, rs: Uint8Array): Promise<void> {
  await hub.publish({ senderDID: 'zoe', topicID: commitTopic(rs), payload: new Uint8Array([0]) })
  await flush(80)
}

/**
 * The attack: an already-published commit frame, re-published BYTE FOR BYTE by somebody who
 * merely observed it. No key, no signature, no forged credential — a signature check proves
 * possession of a key, never authorization to use it, so these bytes verify exactly as they did
 * the first time. Returns the sequenceID the replay landed at.
 */
async function replayCommitFrame(hub: FakeHub, rs: Uint8Array, sequenceID: string): Promise<string> {
  const original = hub.published.find((m) => m.sequenceID === sequenceID)
  if (original == null) throw new Error(`no published frame at ${sequenceID}`)
  const result = await hub.publish({
    // The untrusted hub itself, or any removed member — both keep the topic forever.
    senderDID: 'mallory',
    topicID: commitTopic(rs),
    payload: original.payload,
    retain: 'log',
  })
  return result.sequenceID
}

describe('a genuine external commit re-published by the hub steers nothing', () => {
  test('a replay after the group moved on is stepped over, and the anchor does not follow it', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x81)

    const alice = makeMLSPeer(hub, 'alice', rs, {
      epoch: 1,
      members: ['alice', 'bob'],
      recovery,
    })
    await flush()

    // Bob genuinely rejoins at Alice's epoch: claimed author and signer agree. She applies it and
    // rotates the anchor, which is the baseline the replay is measured against.
    const { sequenceID: original } = await publishCommit({
      hub,
      senderDID: 'bob',
      recoverySecret: rs,
      epoch: 1,
      committerDID: 'bob',
      external: true,
    })
    await flush(200)

    expect(alice.mls.epoch()).toBe(2)
    expect(alice.mls.commits()).toBe(1)
    const anchorAfterRejoin = alice.peer.anchorEpoch()

    const replayed = await replayCommitFrame(hub, rs, original)
    // The whole conclusion rests on this one comparison. Alice recorded `appliedByEpoch[1] =
    // original`; the replay lands above it, so `sequenceID < applied ? 'losing' : 'winning'`
    // settles `winning` and the lane steps over it. Pinned at the hub layer by
    // `hub-conformance`'s clause "a re-published payload under a fresh publishID never lands
    // below the original".
    expect(replayed > original).toBe(true)
    await flush(200)

    // Not applied: the epoch is unmoved and the port was never handed the commit a second time.
    expect(alice.mls.epoch()).toBe(2)
    expect(alice.mls.commits()).toBe(1)
    expect([...(await alice.mls.rosterDIDs())].sort()).toEqual(['alice', 'bob'])
    // The steer that would have mattered. `advanceHandle` rotates the anchor on
    // `result.advanced && header.external === true`; a replay that never advances never rotates,
    // so the app-lane topic every member derives stays where it is.
    expect(alice.peer.anchorEpoch()).toBe(anchorAfterRejoin)
    // And no heal: `winning` sets neither `healRequested` nor `stranded`.
    expect(recoveryRequests(hub, rs)).toHaveLength(0)

    // The cursor moved PAST the replay rather than parking on it — a frame re-read on every pull
    // is the permanent heal loop the forged-rejoin fix closed, arriving by another door.
    await wakeLane(hub, rs)
    expect(alice.mls.epoch()).toBe(2)
    expect(alice.mls.commits()).toBe(1)
    expect(alice.peer.anchorEpoch()).toBe(anchorAfterRejoin)
    expect(recoveryRequests(hub, rs)).toHaveLength(0)

    await alice.peer.dispose()
  })

  test('a peer holding no record for that epoch reads both copies as history', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x82)

    // Both copies land before any peer exists, so nobody has recorded applying either.
    const { sequenceID: original } = await publishCommit({
      hub,
      senderDID: 'bob',
      recoverySecret: rs,
      epoch: 1,
      committerDID: 'bob',
      external: true,
    })
    const replayed = await replayCommitFrame(hub, rs, original)
    expect(replayed > original).toBe(true)

    // Carol is already at epoch 2 — restarted, re-seeded, or a late joiner. `appliedByEpoch` is
    // in-memory BY DESIGN, so she holds no record for epoch 1: both frames are below her epoch
    // with nothing to compare against, which is `history`, not a fork she would invent.
    const carol = makeMLSPeer(hub, 'carol', rs, {
      epoch: 2,
      members: ['alice', 'bob', 'carol'],
      recovery,
    })
    await flush(200)

    expect(carol.mls.epoch()).toBe(2)
    expect(carol.mls.commits()).toBe(0)
    expect(recoveryRequests(hub, rs)).toHaveLength(0)

    // Stepped over for good, not re-read: history advances the cursor like every other row.
    await wakeLane(hub, rs)
    expect(carol.mls.epoch()).toBe(2)
    expect(carol.mls.commits()).toBe(0)
    expect(recoveryRequests(hub, rs)).toHaveLength(0)

    await carol.peer.dispose()
  })
})
```

- [ ] **Step 2: Run the tests**

Run: `pnpm --filter @kumiai/rpc exec vitest run test/peer-commit-log-replay.test.ts`
Expected: PASS on both. This is a characterisation test of behaviour the code already has — the point is to pin it, not to change it.

If either fails, **stop and report** rather than adjusting the assertions to match. A failure here means the residuals doc's open question has a different answer than the design concluded, and that is a finding, not a test bug.

- [ ] **Step 3: Prove the tests bite**

Temporarily invert the fork branch comparison in `packages/rpc/src/classify.ts` — find:

```ts
      branch: sequenceID < applied ? 'losing' : 'winning',
```

and change it to:

```ts
      branch: sequenceID > applied ? 'losing' : 'winning',
```

Run: `pnpm --filter @kumiai/rpc exec vitest run test/peer-commit-log-replay.test.ts`
Expected: the first test FAILS — the replay now reads as `losing`, `healRequested` is set, and `recoveryRequests(hub, rs)` is no longer empty.

Then restore the original comparison and re-run Step 2 to confirm green. Also confirm `packages/rpc/test/commit-classify.test.ts` is green — it already pins both branches directly at line 48, and the restore must put them back.

- [ ] **Step 4: Type-check the test file**

Run: `pnpm --filter @kumiai/rpc exec tsc --noEmit --skipLibCheck -p tsconfig.test.json`
Expected: clean. vitest strips types, so a green run proves nothing about the types in a file this plan wrote.

- [ ] **Step 5: Lint**

Run: `rtk proxy pnpm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/rpc/test/peer-commit-log-replay.test.ts
git commit -m "$(cat <<'EOF'
test(rpc): a replayed external commit is stepped over, anchor unmoved

Answers the question left open in the residuals doc. A peer that applied the
original reads the replay as fork/winning; one holding no record for that
epoch reads history. Neither reaches processCommit, so the rejoin rotation
never fires and the app-lane topic stays put — the steer that would matter.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011fJhBCZQbHrPnrtcYn32ng
EOF
)"
```

---

### Task 3: State the conformance obligation where a port is written

Both READMEs already name the suite as mandatory. What is missing is narrower: neither port *type* says it, and `exportSecret`'s TSDoc never says its failure mode is silent. A host writing its own `GroupCrypto` is reading `packages/rpc/src/crypto.ts`, not a README.

**Files:**
- Modify: `packages/rpc/src/crypto.ts` — the `GroupCrypto` TSDoc block above line 27, the `exportSecret` TSDoc, and the `GroupMLS` TSDoc block above line 226
- Modify: `packages/rpc/README.md` — the "The two consumer ports" section
- Modify: `packages/rpc-conformance/README.md` — after "The rule"

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. Documentation only — no type or signature changes, so no other task depends on it.

- [ ] **Step 1: Add the obligation to the `GroupCrypto` TSDoc**

In `packages/rpc/src/crypto.ts`, at the end of the doc block that ends just above `export type GroupCrypto = {` (line 27) — after the paragraph beginning "`unwrap` throwing is ORDINARY CONTROL FLOW" — add a final paragraph:

```
 * IMPLEMENTING THIS PORT OBLIGES RUNNING `@kumiai/rpc-conformance` AGAINST THE IMPLEMENTATION.
 * Not a recommendation: the suite is where this port's contract actually lives, and the clauses
 * exist because implementations got them wrong. A host that writes its own `GroupCrypto` and does
 * not run the suite has an untested crypto boundary, whatever else it tests.
```

- [ ] **Step 2: Say that `exportSecret`'s failure mode is silent**

In the same file, at the end of `exportSecret`'s TSDoc — after the paragraph about `length` and RFC 9420 §8.5 — add:

```
   * THE ONE METHOD HERE WHOSE ONLY FAILURE MODE IS SILENT. Derive these bytes from anything a
   * removed member keeps — a lifelong recovery secret, a group id, a constant — and nothing
   * fails: the group works, members talk, removals remove, the roster and epoch are right, the
   * health monitor is quiet. The single symptom is that an evicted member can still name and read
   * the app topic, because the topic derives from this. That is why the conformance clause
   * "is PER-EPOCH: the group rotates onto a different secret and the removed member keeps the
   * old one" is not optional for a hand-rolled implementation.
```

- [ ] **Step 3: Add the obligation to the `GroupMLS` TSDoc**

In the same file, at the end of the doc block above `export type GroupMLS = {` (line 226) — after "the consumer owns MLS state and any storage/atomicity below this interface" — add:

```
 * Like {@link GroupCrypto}, implementing this port obliges running `@kumiai/rpc-conformance`
 * against the implementation. Eight of this port's members once had no clause at all, across the
 * recovery and ledger lanes, which carry the group's whole authority state — the gap was invisible
 * until the suite was made to cover the shape rather than a sample of it.
```

- [ ] **Step 4: Update `@kumiai/rpc`'s README**

In `packages/rpc/README.md`, replace this line in "The two consumer ports":

```markdown
`@kumiai/mls-rpc` implements both over a live `@kumiai/mls` handle. `@kumiai/rpc-conformance` is the
contract every implementation and every double must pass.
```

with:

```markdown
`@kumiai/mls-rpc` implements both over a live `@kumiai/mls` handle. `@kumiai/rpc-conformance` is the
contract every implementation and every double must pass.

**Taking these ports means running that suite against your implementation.** A host that uses
`@kumiai/mls-rpc` gets both ports right by construction and inherits its conformance run. A host
that writes its own does not, and one method makes that expensive: `exportSecret` is the only member
of either port whose failure mode is silent. Derive its bytes from anything a removed member keeps
and nothing breaks — the group works, removals remove, the health monitor is quiet — while an
evicted member can still name and read the app topic, which derives from it.
```

- [ ] **Step 5: Update `@kumiai/rpc-conformance`'s README**

In `packages/rpc-conformance/README.md`, at the end of the "## The rule" section (after the paragraph ending "A clause only one side can pass is a divergence, and finding one is the point."), add:

```markdown
The ports are `GroupCrypto` and `GroupMLS`, both declared in `packages/rpc/src/crypto.ts`, and both
say there that implementing them obliges running this suite. If you arrived here from those types,
"Exports" and "Both suites take a harness" below are what you need to wire it.
```

- [ ] **Step 6: Type-check and lint**

Run: `pnpm --filter @kumiai/rpc exec tsc --noEmit --skipLibCheck -p tsconfig.json`
Run: `rtk proxy pnpm run lint`
Expected: both clean. Comment-only changes to `crypto.ts` must not shift any behaviour.

- [ ] **Step 7: Confirm nothing moved**

Run: `pnpm --filter @kumiai/rpc exec vitest run`
Expected: PASS, unchanged from before this task.

- [ ] **Step 8: Commit**

```bash
git add packages/rpc/src/crypto.ts packages/rpc/README.md packages/rpc-conformance/README.md
git commit -m "$(cat <<'EOF'
docs(rpc): running the conformance suite is an obligation of the ports

Both READMEs already named the suite; neither port type did, and a host
writing its own GroupCrypto reads the type. Adds the obligation to both port
docs and names exportSecret as the one member whose failure is silent — an
evicted member that can still read the app topic, with nothing else wrong.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011fJhBCZQbHrPnrtcYn32ng
EOF
)"
```

---

### Task 4: Dispose of the planning docs

Three closures recorded, one open item carried forward rather than buried in a completed file.

**Files:**
- Create: `docs/agents/plans/completed/2026-07-29-security-residuals.complete.md`
- Create: `docs/agents/plans/backlog/2026-07-29-commit-lane-ahead-storm.md`
- Delete: `docs/agents/plans/next/2026-07-16-security-residuals.md`

**Interfaces:**
- Consumes: the content of `docs/agents/plans/next/2026-07-16-security-residuals.md`, which is deleted at the end of this task. Read it before deleting.
- Produces: nothing.

- [ ] **Step 1: Write the completed record**

Create `docs/agents/plans/completed/2026-07-29-security-residuals.complete.md`:

```markdown
# Security residuals: the two actionable items, closed

**Closed 2026-07-29** on `chore/security-residuals`. Supersedes
`next/2026-07-16-security-residuals.md`, which is deleted. The one item that stayed open moved to
`backlog/2026-07-29-commit-lane-ahead-storm.md` rather than ending here — it is live work, just not
work this repo can do.

## 1. Kubun's `exportSecret`, checked

Kubun hand-rolls the port rather than delegating: `kubun/packages/plugin-p2p/src/groups/group-crypto.ts`
exports its own `createGroupCrypto` over `mlsExporter`. It is nonetheless covered, which is why this
is prevention and not a live defect:

- It runs the suite — `testGroupCryptoConformance` at
  `kubun/packages/plugin-p2p/test/group-crypto-conformance.test.ts:215`, `testGroupMLSConformance` in
  the sibling file.
- Its `exportSecret` passes the caller's `label` and `length` straight to `mlsExporter`, and refuses
  `ENTRY_SEAL_LABEL` — the same refusal `@kumiai/mls-rpc` makes, with its own test.
- `test/group-crypto.test.ts` runs a differential against `createReferenceGroupCrypto` from
  `@kumiai/mls-rpc`, so a divergence between the two implementations fails there.

No changes were made to Kubun.

## 2. The obligation, stated where a port is written

Both READMEs already named the suite as mandatory. The gap was narrower than the residuals doc
implied: neither port TYPE said it, and a host writing its own `GroupCrypto` reads
`packages/rpc/src/crypto.ts`, not a README. The obligation now sits on the `GroupCrypto` and
`GroupMLS` doc blocks, `exportSecret` states that its only failure mode is silent, and the two
READMEs point at each other.

## 3. The replay question, answered

**A genuine external commit captured and re-published steers nothing.** The residuals doc guessed
the right conclusion from the wrong row — it expected "classifies as history and is stepped over".
Recording the mechanism, because it is the part that was guessed wrong and would be guessed wrong
again:

`sequenceID` is hub-assigned and strictly increasing, and idempotency keys on `publishID`, which the
replayer supplies. So a replay is APPENDED with a greater sequenceID rather than folded onto the
original. A peer that applied the original holds `appliedByEpoch[E]`, so the replay is
`fork`/**`winning`** — `peer.ts:1199` steps over it, and only `losing` heals. A peer holding no
record for E (restarted, re-seeded, late joiner) reads `history`. Neither reaches `processCommit`,
so `applied.advanced` stays false and the rejoin rotation at `peer.ts:1240` never fires: **the
app-lane topic does not move**. That was the steer that would have mattered.

It rests on one property — a replay never lands BELOW the original — which is now a clause in both
hub-conformance suites (`a re-published payload under a fresh publishID never lands below the
original`), so Kubun's sqlite and postgres stores inherit it. `packages/rpc/test/peer-commit-log-replay.test.ts`
pins the rpc half, and `commit-classify.test.ts:48` already pinned both fork branches.

Freshness and publish-side duplicate refusal were considered and are not needed: the bound the
residuals doc would have reached for only matters if the replay could steer, and it cannot.
```

- [ ] **Step 2: Write the backlog entry for what stays open**

Create `docs/agents/plans/backlog/2026-07-29-commit-lane-ahead-storm.md`. Copy the substance of section 2's `STILL OPEN — the ahead storm` and its `Adjacent` subsection out of `docs/agents/plans/next/2026-07-16-security-residuals.md` (read it first), preserving: the bare `PrivateMessage` with a rewritten cleartext epoch; the cheaper unknown-frame-version trigger at `packages/rpc/src/classify.ts:235` and why that trade was taken knowingly; why no signature check helps (an ahead-framed commit is at an epoch this peer holds no context for); why the row cannot simply refuse (a peer filing ahead-frames as poison reports itself reconciled at a dead epoch); where the bound belongs (whoever gates publish authorization on the commit topic); and the adjacent per-drain `justifiedEpochCeiling` commit-log walk on the app lane. Head it:

```markdown
# Commit-lane `ahead` storm: bounding who may publish to the commit topic

**Priority:** medium — not closable inside `@kumiai/rpc`, which is why it is backlog rather than
next. **Carried forward 2026-07-29** from `next/2026-07-16-security-residuals.md`, whose other two
items closed (see `completed/2026-07-29-security-residuals.complete.md`). Nothing here is new; it is
preserved so the analysis is not buried in a completed file.
```

- [ ] **Step 3: Delete the superseded item**

```bash
git rm docs/agents/plans/next/2026-07-16-security-residuals.md
```

- [ ] **Step 4: Check the record reads honestly**

Re-read the completed file against what the branch actually did. Every claim in it must name something that exists: the two test files, the two conformance clauses, the doc changes. If a task was skipped or changed shape, fix the record rather than the memory of it.

- [ ] **Step 5: Commit**

```bash
git add docs/agents/plans/completed/2026-07-29-security-residuals.complete.md docs/agents/plans/backlog/2026-07-29-commit-lane-ahead-storm.md
git commit -m "$(cat <<'EOF'
docs: close the security residuals, carry the ahead storm forward

Records the replay mechanism, since the wrong row was guessed once and would
be guessed again. The ahead storm gets its own backlog entry rather than being
buried in a completed file — it is live work, just not work this repo can do.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011fJhBCZQbHrPnrtcYn32ng
EOF
)"
```

---

## Final verification

- [ ] **Whole-repo test run, cache forced off**

Run: `pnpm exec turbo run test:types test:unit --force`
Expected: all packages green, and the summary line reads `Cached: 0`. A run reporting cached results proves nothing about this branch — check the number, don't skim the colour.

- [ ] **Lint**

Run: `rtk proxy pnpm run lint`
Expected: clean.

- [ ] **Both contract suites, both sides**

`AGENTS.md` requires it whenever a suite changes. Task 1's Steps 3 and 4 covered `hub-conformance` against `@kumiai/hub-server`'s real stores and `@kumiai/rpc`'s `FakeHub`; the full run above covers `rpc-conformance` against `@kumiai/mls-rpc`'s real implementation and `@kumiai/rpc`'s doubles. Confirm all four appeared in the run rather than assuming they did.

- [ ] **Changeset**

This branch changes `@kumiai/hub-conformance` (a new clause every implementation must now pass) and `@kumiai/rpc` (documentation only). Add a changeset for `@kumiai/hub-conformance` — a consumer bumping into a new mandatory clause needs to see it in the changelog. `@kumiai/rpc`'s change is comments and README, so no changeset unless the repo's convention says otherwise; check `docs/agents/` or recent changesets before deciding.
