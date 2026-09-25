# Commit strand and recovery lifecycle — Implementation Plan

**Stage:** executing
**Mode:** tasks

> **For agentic workers:** Implement task by task, TDD. Steps use checkbox (`- [ ]`) syntax. Tick each
> box as you finish it and commit the tick with the task.

**Goal:** `GroupPeerParams` gains `onStrand` and `onRecovery`; recovery becomes single-flight with one
owner for re-enact entries; two pre-existing gaps (handshake decode order, delayed bootstrap losing owed
entries) are fixed.

**Architecture:** All state lives in `createGroupPeer` (`packages/rpc/src/peer.ts`). Events are produced
into a per-peer outbox and flushed after the producing `runSerial` operation settles, through a
throw-safe `notifyHost`. A new `runRecovery(trigger)` replaces the body of `recover()` and the call in
`healIfRequested()`.

**Tech Stack:** TypeScript (strict), vitest, pnpm + turbo, biome.

**Spec:** `docs/superpowers/specs/2026-09-25-rpc-strand-observability-design.md` — authoritative. Read
it whole before Task 1. Where this plan and the spec disagree, the spec wins; note the deviation.

## Global Constraints

- pnpm only. Never edit `lib/`.
- `GroupMLS`, `GroupCrypto`, hub ports: unchanged.
- Observers never run while the commit mutex is held and never change a lane outcome.
- `recover()` keeps its signature `() => Promise<{ advanced: boolean; reenact: Array<string> }>` and its
  return/throw meanings (spec table "Typed rendezvous outcome").
- Code comments terse: non-obvious why only. Match surrounding style.
- Lint with `rtk proxy pnpm run lint` BEFORE `git add`.
- Gate: `pnpm exec turbo run test:types test:unit --force` (`Cached: 0`) and
  `pnpm exec vitest run --root tests/integration`. Never `pnpm test -- --force`.
- Per-package check while iterating: `pnpm --filter @kumiai/rpc exec vitest run <file>` and
  `pnpm --filter @kumiai/rpc run test:types`.
- Commits: Conventional Commits, ending `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
  Never commit to `main`, never push.
- Recovery/heal tests are timing-sensitive on CI: poll on post-heal state (e.g. `vi.waitFor`), never on
  fixed sleeps; cover the last-settling field.

## Review Focus

1. A strand producing many frames across several pulls must yield one observation per episode.
2. Two `recover()` calls issued before `ready` settles must start one attempt.
3. A failed bootstrap followed by a successful `replay()` must return the owed entries exactly once.
4. An observer calling `dispose()` must not change the in-flight operation's result.
5. A future handshake version with a kind this build does not know must heal, not be dropped.

---

### Task 1: Handshake decode reports an unsupported version before the kind

**Files:**
- Modify: `packages/rpc/src/handshake.ts` (`decodeHandshakeFrame`)
- Modify: `packages/rpc/src/peer.ts` (`walkCommits` unknown-version branch, only if the decode shape
  changes)
- Test: `packages/rpc/test/handshake.test.ts`, and a walk-level test in
  `packages/rpc/test/peer-failed-heal-strand.test.ts` (or the file that already drives an
  unknown-version commit frame; grep `UNKNOWN_FRAME_VERSION` in `test/`)

- [x] **Step 1: Failing tests.**
  - `decodeHandshakeFrame` on `[magic, HANDSHAKE_VERSION + 1, 0xEE, ...]` returns
    `{ version: HANDSHAKE_VERSION + 1, ... }` rather than throwing `unknown handshake kind`.
  - Current version with kind `0xEE` still throws `unknown handshake kind`.
  - Walk-level: a peer whose commit log holds a frame with a future version AND an unknown kind sets a
    heal (observe via an existing heal-signal hook in that test file, e.g. a recovery request published
    on the rendezvous topic).
- [x] **Step 2:** Run; expect the first and third to FAIL.
- [x] **Step 3: Implement.** In `decodeHandshakeFrame`, after reading `version` and `kind`: if
  `version !== HANDSHAKE_VERSION`, return `{ version, kind: kind as HandshakeKind, payload }` without
  validating the kind (the caller checks the version first and never reads `kind` for it — keep the
  existing comment in `walkCommits` true). Validate the kind only for the current version. Update the
  function's doc to say so.
- [x] **Step 4:** Run `handshake.test.ts` and the walk test; PASS. Run all rpc tests.
- [x] **Step 5:** Lint, commit `fix(rpc): classify an unsupported handshake version before its kind`.

### Task 2: Public types, outbox and `notifyHost`

**Files:**
- Create: `packages/rpc/src/host-notice.ts`
- Modify: `packages/rpc/src/peer.ts` (`GroupPeerParams`, `runSerial`), `packages/rpc/src/index.ts`
- Test: `packages/rpc/test/host-notice.test.ts`

**Interfaces — Produces:**
```ts
// host-notice.ts
export function notifyHost<T>(callback: ((value: T) => void | Promise<void>) | undefined, value: T): void

// peer.ts, exported via index.ts
export type StrandKind = 'own-unmerged' | 'fork-losing' | 'ahead' | 'unknown-version'
export type StrandConfidence = 'authenticated' | 'observed' | 'claimed'
export type StrandObservation = { groupID: string; position: string; commitDigest: string | null; localEpoch: number; claimedEpoch: number | null; kind: StrandKind; confidence: StrandConfidence }
export type RecoveryTrigger = 'automatic' | 'consumer'
export type RecoveryFailureReason = 'no-responder' | 'bootstrap-failed' | 'deadline' | 'disposed' | 'error'
export type RecoveryEvent = /* exactly as in the spec "API" section */
// GroupPeerParams
onStrand?: (observation: StrandObservation) => void | Promise<void>
onRecovery?: (event: RecoveryEvent) => void | Promise<void>
```
Place the types where the other host-callback types live (next to `AppWindowPruned` usage in
`GroupPeerParams`); a new `src/lifecycle.ts` for the types is fine if `peer.ts` imports it.

- [x] **Step 1: Failing tests** for `notifyHost`: undefined callback is a no-op; a synchronous throw is
  swallowed; a rejected promise produces no unhandled rejection (listen on `process` for
  `unhandledRejection` in the test, fail if fired); the callback is called synchronously (the outbox
  decides timing, not this helper).
- [x] **Step 2:** FAIL.
- [x] **Step 3: Implement** `notifyHost`:
  ```ts
  export function notifyHost<T>(
    callback: ((value: T) => void | Promise<void>) | undefined,
    value: T,
  ): void {
    if (callback == null) return
    try {
      const result = callback(value)
      if (result != null && typeof (result as Promise<void>).then === 'function') {
        ;(result as Promise<void>).then(undefined, () => {})
      }
    } catch {
      // A host observer never changes a lane outcome.
    }
  }
  ```
  In `peer.ts`: add the params, the outbox, and the flush in `runSerial`:
  ```ts
  type HostNotice = () => void
  let hostOutbox: Array<HostNotice> = []
  const emitStrand = (o: StrandObservation): void => {
    hostOutbox.push(() => notifyHost(params.onStrand, o))
  }
  const emitRecovery = (e: RecoveryEvent): void => {
    hostOutbox.push(() => notifyHost(params.onRecovery, e))
  }
  const flushHostOutbox = (): void => {
    const batch = hostOutbox
    hostOutbox = []
    for (const notice of batch) notice()
  }
  ```
  `runSerial`: after `op` settles, flush — `op.then(flushHostOutbox, flushHostOutbox)` chained so the
  flush runs after the task settled (the tail is already released by then because `commitTail` is the
  settled `op`). Keep `runSerial`'s return value and rejection unchanged.
- [x] **Step 4:** PASS; rpc `test:types` PASS.
- [x] **Step 5:** Lint, commit `feat(rpc): host lifecycle types and a lane-safe notice outbox`.

### Task 3: Strand observations and episodes

**Files:**
- Modify: `packages/rpc/src/peer.ts` (`walkCommits`, the four `stranded = true` sites)
- Test: `packages/rpc/test/peer-strand-observation.test.ts` (create). Reuse the fixtures of
  `peer-failed-heal-strand.test.ts` / `commit-classify.test.ts` for building frames of each row.

**Interfaces — Consumes:** `emitStrand`, types from Task 2.

- [x] **Step 1: Failing tests** (spec "Tests" list, strand part):
  - each kind once with mapped `confidence`, `claimedEpoch`, `commitDigest`, `groupID` = the peer's
    commit topic ID, `position` = the frame's sequenceID, `localEpoch`;
  - one strand with several `ahead` frames across two pulls: one observation;
  - episode upgrade: `ahead` then `own-unmerged`: two; `ahead` then another `ahead`: one;
  - replay of the same commit at another position, duplicate pull, `own-unmerged` re-read: silent;
  - winning fork, history, poison, apply: none;
  - callbacks run after the walk's `runSerial` op settled: record `stranded`/cursor state inside the
    callback via an exposed getter the tests already use, or assert ordering with a flag set by the
    test after awaiting the lane op.
- [x] **Step 2:** FAIL.
- [x] **Step 3: Implement.**
  ```ts
  const CONFIDENCE_RANK: Record<StrandConfidence, number> = { claimed: 0, observed: 1, authenticated: 2 }
  let episode: { strongest: StrandConfidence } | null = null
  const observeStrand = (o: Omit<StrandObservation, 'groupID' | 'localEpoch'>): void => {
    if (commitTopicID == null) return
    if (episode != null && CONFIDENCE_RANK[o.confidence] <= CONFIDENCE_RANK[episode.strongest]) return
    episode = { strongest: o.confidence }
    emitStrand({ ...o, groupID: commitTopicID, localEpoch: crypto.epoch() })
  }
  const closeEpisode = (): void => { episode = null }
  ```
  Call `observeStrand` at each site that sets `stranded = true`, per the spec's mapping table:
  - unknown handshake version and unsupported commit-frame version: `kind: 'unknown-version'`,
    `confidence: 'claimed'`, `claimedEpoch: null`, `commitDigest: null`;
  - `own-unmerged`: `'authenticated'`, `claimedEpoch: header.epoch`, digest;
  - `ahead`: `'claimed'`, header epoch, digest;
  - `fork` losing: `'observed'`, header epoch, digest.
  Use `crypto.epoch()` captured before the frame's processing (the same value passed to
  `classifyCommit`) for `localEpoch`; adjust `observeStrand` to take it explicitly if simpler.
  A strand transition also clears `bootstrapHealRequested` (introduced in Task 6; add the variable now
  as `let bootstrapHealRequested = false` so this call site is final).
- [x] **Step 4:** PASS; all rpc tests PASS.
- [x] **Step 5:** Lint, commit `feat(rpc): report commit strand episodes with evidence confidence`.

### Task 4: Typed rendezvous outcome

**Files:**
- Modify: `packages/rpc/src/peer.ts` (`requestGroupInfo`, `recoveryWaiters` resolve sites, `dispose`
  drain of waiters, `recover` step 3)
- Test: extend `packages/rpc/test/peer-recover-lane.test.ts` or create
  `packages/rpc/test/rendezvous-outcome.test.ts`

**Interfaces — Produces (internal):**
```ts
type RendezvousOutcome =
  | { kind: 'reply'; sealed: Uint8Array }
  | { kind: 'timeout'; atDeadline: boolean }
  | { kind: 'disposed' }
  | { kind: 'publish-failed'; error: unknown }
```

- [x] **Step 1: Failing tests** — through `recover()` with fixtures: publish that rejects surfaces as a
  thrown error from `recover()` (today it is swallowed and waits out the timer — confirm by reading the
  existing behaviour; if an existing test pins the old swallow, update it and note it); dispose during
  the wait makes `recover()` reject with `PeerDisposedError`; no-responder and deadline still return
  `{ advanced: false }`.
- [x] **Step 2:** FAIL.
- [x] **Step 3: Implement.** `wait = Math.max(0, Math.min(recoveryTimeoutMs, deadline - Date.now()))`;
  `atDeadline = deadline - Date.now() <= recoveryTimeoutMs` at computation. Waiters resolve with
  `RendezvousOutcome`; the reply handler resolves `{ kind: 'reply', sealed }`; the timer
  `{ kind: 'timeout', atDeadline }`; `dispose()`'s drain `{ kind: 'disposed' }`; publish rejection
  clears the timer/waiter and resolves `{ kind: 'publish-failed', error }`. In `recover` step 3: `reply`
  continues; `timeout`/`!atDeadline` breaks as no-responder; `timeout`/`atDeadline` breaks as deadline;
  `disposed` throws `new PeerDisposedError('Peer is disposed')`; `publish-failed` throws its error. Keep
  a local `failure: RecoveryFailureReason | null` in the body for Task 5 to read.
- [x] **Step 4:** PASS; all rpc tests PASS.
- [x] **Step 5:** Lint, commit `refactor(rpc): typed rendezvous outcome for recovery`.

### Task 5: Single-flight `runRecovery`, recovery events, stash ownership

**Files:**
- Modify: `packages/rpc/src/peer.ts` (`recover`, `healIfRequested`, remove `healing`, `pendingReenact`
  handling)
- Test: `packages/rpc/test/peer-recovery-lifecycle.test.ts` (create)

**Interfaces — Consumes:** `emitRecovery`, `closeEpisode`, `RendezvousOutcome`.

- [x] **Step 1: Failing tests** (spec "Tests", recovery part): automatic heal `started`→`succeeded`
  with `trigger: 'automatic'` and a new episode opening on the next strand; no-responder; deadline;
  dispose mid-attempt (`failed`/`disposed`, `recover()` rejects `PeerDisposedError`); bootstrap failure
  (`failed`/`bootstrap-failed`); thrown attempt (`failed`/`error` with the error); two `recover()` calls
  before `ready` → one `started`; consumer `recover()` overlapping an automatic heal → one `started`,
  one terminal, joined caller gets the shared `advanced`; re-enact entries come out exactly once across
  `recover()`, `commit()`, `replay()`; queued `recover()` after a success meanwhile → `{ advanced: true }`,
  no events; observers throwing / rejecting / calling `dispose()` (with a real intervening await) do not
  change results.
- [x] **Step 2:** FAIL.
- [x] **Step 3: Implement.**
  ```ts
  let activeRecovery: Promise<{ advanced: boolean }> | null = null
  let recoveryGeneration = 0

  const runRecovery = (trigger: RecoveryTrigger): Promise<{ advanced: boolean }> => {
    if (activeRecovery != null) return activeRecovery
    const attempt: Promise<{ advanced: boolean }> = (async () => {
      const generation = recoveryGeneration
      await ready
      assertLive()
      if (mls == null || commitTopicID == null || rendezvousTopicID == null) return { advanced: false }
      return runSerial(() => attemptBody(trigger, generation))
    })()
    activeRecovery = attempt
    void attempt.then(
      () => { if (activeRecovery === attempt) activeRecovery = null },
      () => { if (activeRecovery === attempt) activeRecovery = null },
    )
    return attempt
  }
  ```
  `attemptBody` = today's `recover` `runSerial` body, changed as follows:
  - first: `if (disposed) throw new PeerDisposedError('Peer is disposed')`; then the recheck —
    `if (recoveryGeneration !== generation && !stranded && !healRequested) return { advanced: true }`;
  - `const attemptID = newPublishID()`; `emitRecovery({ phase: 'started', groupID: commitTopicID, attemptID, trigger })`;
  - wrap the rest in `try { ... } catch (error) { emit failed (disposed if error is PeerDisposedError or disposed is set, else error with error); throw error }`;
  - every return maps to exactly one terminal event per the spec table;
  - on success: append the filtered `reenact` to `pendingReenact`, `recoveryGeneration += 1`,
    `closeEpisode()`, emit `succeeded`, return `{ advanced: true }`.
  `recover` becomes:
  ```ts
  const recover = async () => {
    const { advanced } = await runRecovery('consumer')
    const reenact = pendingReenact
    pendingReenact = []
    return { advanced, reenact }
  }
  ```
  `healIfRequested`: `if (!healRequested || activeRecovery != null) return; healRequested = false;`
  then `await runRecovery('automatic').catch(() => {})`. Remove `healing`. Keep the existing comments'
  substance where the code they describe survives.
- [x] **Step 4:** PASS; all rpc tests PASS (existing recover/heal tests must stay green; if one pins the
  old "direct recover returns only its own entries" behaviour, update it and note it — that is the
  documented behaviour change).
- [x] **Step 5:** Lint, commit `feat(rpc): single-flight recovery with lifecycle events`.

### Task 6: Delayed bootstrap and one snapshot owner

**Files:**
- Modify: `packages/rpc/src/peer.ts` (`inFlightEntries`, recover step 5/8/9, `ensureLedger` call sites
  in `replay`, `commit`, wakeup, recover step 0)
- Test: `packages/rpc/test/peer-delayed-bootstrap.test.ts` (create). Start from the existing test at
  `peer-recover-lane.test.ts` that shows a later `replay()` completing a failed bootstrap.

- [x] **Step 1: Failing tests:** failed bootstrap → `replay()` with a responder → `bootstrapped` with the
  same `attemptID`, owed entries out of `replay()` exactly once; failed bootstrap → second `recover()`
  whose step-0 gather fails and whose own rejoin later bootstraps → entries exactly once, only the newest
  attempt gets events, the first never gets `bootstrapped`; delayed bootstrap during a wakeup → no extra
  rejoin afterwards (count rendezvous requests); a strand raised in the same operation as a delayed
  bootstrap still heals.
- [x] **Step 2:** FAIL.
- [x] **Step 3: Implement.**
  ```ts
  let awaitingBootstrap: { attemptID: string; trigger: RecoveryTrigger; entries: Array<string> } | null = null
  const finalizeBootstrap = async (port: GroupMLS): Promise<void> => {
    if (awaitingBootstrap == null) return
    const { attemptID, trigger, entries } = awaitingBootstrap
    const held = new Set(await port.getLedger())
    const owed = entries.filter((token) => !held.has(token))
    if (owed.length > 0) pendingReenact = [...pendingReenact, ...owed]
    awaitingBootstrap = null
    if (bootstrapHealRequested) {
      healRequested = false
      bootstrapHealRequested = false
    }
    recoveryGeneration += 1
    closeEpisode()
    emitRecovery({ phase: 'bootstrapped', groupID: commitTopicID as string, attemptID, trigger })
  }
  ```
  - Recover step 5: `inFlightEntries ??= awaitingBootstrap?.entries ?? (await port.getLedger())`.
  - Step 8 failure: `awaitingBootstrap = { attemptID, trigger, entries: inFlight }`,
    `healRequested = true`, `bootstrapHealRequested = true`, emit `failed`/`bootstrap-failed`.
  - Step 9 success: filter `inFlight`, clear `inFlightEntries` and `awaitingBootstrap` (superseded: no
    `bootstrapped` event).
  - Every other site where `ensureLedger(...)` returns `true` inside `runSerial` (replay, commit, wakeup,
    recover step 0 — find them with grep): `if (await ensureLedger(d)) await finalizeBootstrap(mls)`.
    Ensure it runs at most once per op and inside the same mutex hold.
- [x] **Step 4:** PASS; all rpc tests PASS.
- [x] **Step 5:** Lint, commit `fix(rpc): finalize owed re-enact entries when bootstrap completes late`.

### Task 7: Docs, release intent, full gate

**Files:** `packages/rpc/README.md`, `.changeset/strand-observability.md`

- [ ] **Step 1: README** — host callbacks section: `onStrand` (episode semantics, the three confidence
  levels and what each proves, one observation = one strand), `onRecovery` (phases, reasons, one
  terminal per attempt, `bootstrapped`), `recover()` single-flight and stash drain (may return entries
  an earlier automatic heal stashed). Surface only.
- [ ] **Step 2: Change intent** `.changeset/strand-observability.md` (`"@kumiai/rpc": minor`): additive
  callbacks; `recover()` single-flight and stash behaviour change; handshake unknown-version fix; late
  bootstrap re-enact fix; publish failure during recovery now throws instead of timing out (if Task 4
  changed that).
- [ ] **Step 3: Gate:** `pnpm exec turbo run test:types test:unit --force` (quote `Cached: 0`) and
  `pnpm exec vitest run --root tests/integration`.
- [ ] **Step 4:** Lint, commit `docs(rpc): document strand and recovery lifecycle callbacks`.
