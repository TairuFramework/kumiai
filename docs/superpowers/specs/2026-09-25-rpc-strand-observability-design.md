# Expose commit strand and recovery lifecycle to the host

**Origin:** backlog item `2026-09-25-rpc-strand-recovery-observability.md`. Consumer: Kubun
`GroupHealthMonitor` (`../kubun/packages/plugin-p2p/src/groups/group-health-monitor.ts:61-115`), which
also calls `GroupPeer.recover()` itself (`../kubun/packages/plugin-p2p/src/groups/group-peer-manager.ts:770-792`).

## Goal

1. Tell the host, once per stranded **episode**, why the commit lane decided this peer is stranded, with
   an honest statement of how strong that evidence is — and again only if stronger evidence arrives.
2. Tell the host when a recovery attempt starts and how it ends. Success means the rejoin landed **and**
   the ledger bootstrapped; a bootstrap that completes later is reported too.
3. Make automatic healing and consumer `recover()` single-flight, with one owner for `reenact` entries,
   and stop losing owed entries when bootstrap completes after the attempt.
4. Fix two pre-existing gaps the design depends on: an unsupported handshake version with an unknown
   kind is dropped as malformed, and `requestGroupInfo` conflates its failure causes.

A host observer must never change the commit walk or the recovery outcome.

## API

Two optional fields on `GroupPeerParams` (`packages/rpc/src/peer.ts`), types exported from the package:

```ts
onStrand?: (observation: StrandObservation) => void | Promise<void>
onRecovery?: (event: RecoveryEvent) => void | Promise<void>

export type StrandKind = 'own-unmerged' | 'fork-losing' | 'ahead' | 'unknown-version'
export type StrandConfidence = 'authenticated' | 'observed' | 'claimed'

export type StrandObservation = {
  /** The peer's stable commit topic ID, as `AppWindowPruned.groupID`. */
  groupID: string
  /** Commit-log sequenceID of the frame that raised this observation. */
  position: string
  /** `digestAppliedCommit` of the frame's commit bytes; `null` when they were never extracted. */
  commitDigest: string | null
  /** This peer's epoch when the frame was classified. */
  localEpoch: number
  /** The epoch the frame claims (cleartext header); `null` for `unknown-version`. */
  claimedEpoch: number | null
  kind: StrandKind
  confidence: StrandConfidence
}

export type RecoveryTrigger = 'automatic' | 'consumer'
export type RecoveryFailureReason =
  | 'no-responder'
  | 'bootstrap-failed'
  | 'deadline'
  | 'disposed'
  | 'error'

type RecoveryEventBase = { groupID: string; attemptID: string; trigger: RecoveryTrigger }

export type RecoveryEvent =
  | (RecoveryEventBase & { phase: 'started' })
  | (RecoveryEventBase & { phase: 'succeeded' })
  | (RecoveryEventBase & {
      phase: 'failed'
      reason: RecoveryFailureReason
      /** Present for `reason: 'error'`: what the attempt threw. */
      error?: unknown
    })
  /**
   * A rejoin whose attempt ended `failed` / `bootstrap-failed` has now bootstrapped (a later lane
   * operation's `ensureLedger` succeeded). Same `attemptID` as that attempt. Ends the episode.
   */
  | (RecoveryEventBase & { phase: 'bootstrapped' })
```

## Evidence kinds and confidence

| Walk site (`peer.ts` `walkCommits`) | `kind` | `confidence` | `claimedEpoch` | `commitDigest` |
|---|---|---|---|---|
| `disposition.row === 'own-unmerged'` | `own-unmerged` | `authenticated` | header epoch | digest |
| `disposition.row === 'fork'`, `branch === 'losing'` | `fork-losing` | `observed` | header epoch | digest |
| `disposition.row === 'ahead'` (readable frame) | `ahead` | `claimed` | header epoch | digest |
| unknown handshake version, or unsupported commit-frame version, classified `ahead` | `unknown-version` | `claimed` | `null` | `null` |

- **`authenticated`:** the committer is MLS-authenticated as this peer (`classify.ts` `own-unmerged`).
- **`observed`:** this peer holds different commit bytes at an epoch it enacted. The conflict is real
  bytes, but the other commit is not authenticated and the tiebreak position is the hub's. A hub serving
  divergent logs, or a forged frame, can produce it.
- **`claimed`:** a cleartext epoch or an unreadable frame. Any commit-topic publisher can forge it.

Strength order: `claimed` < `observed` < `authenticated`.

Observations are considered exactly where the walk today sets `stranded = true` for these four cases.
`fork` on the winning branch, `history`, `poison` and `apply` never produce one.

### Pre-existing fix: version before kind

`decodeHandshakeFrame` (`packages/rpc/src/handshake.ts`) validates the kind byte before the caller can
see the version, so a future-version frame with a new kind throws and `walkCommits` steps over it as
malformed: no heal, no observation. Change the decode order: after magic and length, an unsupported
version is returned (or signalled distinctly) **before** the kind is validated, so the walk's existing
unknown-version branch classifies it. A current-version frame with an unknown kind stays malformed.

## Episodes (deduplication)

An **episode** is one stranded period of this peer:

- It **opens** at the first observation-eligible stranded transition while no episode is open. That
  observation fires.
- While open, a further eligible transition fires **only if its confidence is strictly stronger** than
  the strongest already reported in the episode. Everything else is silent: more `ahead` frames from the
  same strand, a replay at another position, a duplicate pull, an `own-unmerged` frame re-read every
  pull, further unreadable frames.
- It **closes** when a recovery attempt emits `succeeded`, or when a delayed bootstrap emits
  `bootstrapped`. The next eligible transition opens a new episode.
- A `failed` attempt does not close it.
- In memory only. A restarted peer may open a new episode for the same strand: the safe direction.

State: `episode: { strongest: StrandConfidence } | null`.

## Recovery lifecycle and single-flight

A new internal `runRecovery(trigger)` owns every attempt. `recover()` calls it with `'consumer'`;
`healIfRequested()` calls it with `'automatic'`. The existing `healing` flag is replaced by:

- `activeRecovery: Promise<void> | null` — the attempt in flight, from call to settlement.
- `recoveryGeneration: number` — incremented when an attempt emits `succeeded`.

**Installation.** `runRecovery` installs `activeRecovery` **synchronously, before its first `await`**
(including the `await ready`), so two calls made before `ready` settles, or an automatic heal racing a
consumer call, cannot both start attempts. It clears it in `finally`, **by identity** (only if it still
holds this attempt's promise).

**Join.** A call made while `activeRecovery` is non-null awaits it. It emits no events and starts
nothing; the trigger stays the one that started the attempt.

**Recheck.** A new attempt records `recoveryGeneration` on entry. When its body finally runs inside
`runSerial`, if the generation has moved **and** the peer is neither `stranded` nor has
`healRequested`, it returns `{ advanced: true }` without events. Otherwise a direct `recover()` rejoins
as today, even on a peer that is not stranded.

**Disposal.** Inside the mutex, before emitting `started`, check `disposed`; if set, throw
`PeerDisposedError` as `assertLive` does, with no events.

**Events.** `started` fires when the attempt body is inside the mutex and about to run step 0. The whole
body after `started` is wrapped so that **every** exit, including a throw, emits exactly one terminal
event.

### Typed rendezvous outcome

`requestGroupInfo` returns `null` today when its reply timer expires, when `dispose()` drains its
waiter, and (swallowed) when the request publish fails. Replace the `null` with:

```ts
type RendezvousOutcome =
  | { kind: 'reply'; sealed: Uint8Array }
  | { kind: 'timeout'; atDeadline: boolean } // atDeadline: the timer was clamped to the attempt deadline
  | { kind: 'disposed' }
  | { kind: 'publish-failed'; error: unknown }
```

The attempt body maps it:

| Outcome | Terminal event |
|---|---|
| Rejoin landed and `ensureLedger` succeeded | `succeeded` |
| `timeout`, `atDeadline: false` | `failed`, `no-responder` |
| `timeout`, `atDeadline: true`, or loop exhausted the deadline via lost races / unopenable replies | `failed`, `deadline` |
| `disposed`, or `disposed` observed after any await in the body | `failed`, `disposed` |
| `publish-failed` | `failed`, `error`, with the error (the attempt ends; it does not loop on it) |
| Rejoin landed, `ensureLedger` failed | `failed`, `bootstrap-failed` |
| Any other throw | `failed`, `error`, with the error |

`recover()`'s return and thrown errors keep their current meaning: `{ advanced: false }` for
`no-responder`, `deadline` and `bootstrap-failed`; a throw for `error`; `disposed` throws
`PeerDisposedError`. The early return when `mls`, `commitTopicID` or `rendezvousTopicID` is null is
not an attempt: no events. `attemptID` comes from `newPublishID()`.

## `reenact` ownership

One owner: the `pendingReenact` stash.

- A successful attempt appends its filtered entries to `pendingReenact` instead of returning them.
- `recover()` returns `reenact` by draining `pendingReenact` after its own or joined attempt settles.
- `commit()` and `replay()` keep draining it through `takeLost`.
- The first drain wins: nothing is dropped, nothing is handed out twice.
- Behaviour change to document: a direct `recover()` may return entries an earlier automatic heal
  stashed. Those entries are owed.

### Delayed bootstrap

A rejoin that lands but fails `ensureLedger` keeps its snapshot in a new state,
`awaitingBootstrap: { attemptID: string; trigger: RecoveryTrigger; entries: Array<string> } | null`,
replacing the bare `inFlightEntries` use for this case. A snapshot from an attempt whose rejoin did
**not** land (lost race, no responder) is never finalized this way; it stays the retry snapshot as
today.

When any later lane operation's `ensureLedger` succeeds while `awaitingBootstrap` is set (`replay()`,
`commit()`, a wakeup, or a new recovery attempt's step 0), in that same mutex hold:

1. filter `entries` against the now-complete ledger, by membership, as step 9 does;
2. append the difference to `pendingReenact`;
3. clear `awaitingBootstrap`;
4. increment `recoveryGeneration`, close the episode;
5. emit `bootstrapped` with the stored `attemptID` and `trigger`.

Exactly once: steps 1–5 run in one mutex hold and step 3 prevents a second pass.

## Observer safety

A shared helper `notifyHost(callback, value)` in `packages/rpc/src/`:

- schedules the call with `queueMicrotask`, so it never runs inside the walk or the attempt body;
- catches a synchronous throw;
- attaches a no-op rejection handler to a returned thenable;
- never awaits.

Guarantee, stated precisely: a throwing or rejecting observer changes nothing. An observer that calls
peer methods (for example `dispose()`) acts after the lane step that produced the event has returned,
like any other host call; it cannot re-enter the step itself. Events are emitted in the order produced.

Differs from `reportPrunedWindow` (`app-lane.ts:196-209`), which awaits its callback: strand and
recovery events are produced inside the non-reentrant commit mutex. `onAppWindowPruned` is unchanged.
The durable app-delivery work reuses `notifyHost`.

## Kubun mapping (documentation)

Kubun's `GroupHealthMonitor` currently counts three `epoch-stale` signals before `degraded`. With
episodes, one observation means one strand. The rpc README states this; Kubun's adoption (a follow-up in
the kubun repo) maps an observation directly rather than counting.

## Out of scope

- `onAppWindowPruned` changes.
- Durable episode state across restarts.
- Fork resolution.

## Ports and conformance

`GroupMLS`, `GroupCrypto` and the hub ports are unchanged. `handshake.ts` decode order is internal.
Run the full repo test and `test:types` gates and the integration suite.

## Tests (`packages/rpc/test/`)

- Each kind produces an observation with the mapped `confidence`, `claimedEpoch` and `commitDigest`.
- Future handshake version with an unknown kind byte: `unknown-version` observation and a heal (fails
  on main today).
- Current version with an unknown kind: still malformed, no observation.
- One strand producing several `ahead` frames: one observation.
- Episode upgrade: `ahead` then `own-unmerged` in one episode: two observations; `ahead` then another
  `ahead`: one.
- Replay at another position, duplicate pull, `own-unmerged` re-read across pulls: silent.
- Winning fork, history, poison, apply: no observation.
- Successful automatic heal: `started` then `succeeded`, `trigger: 'automatic'`; next strand opens a new
  episode.
- No responder: `failed` / `no-responder`; `recover()` returns `{ advanced: false }`.
- Deadline: `failed` / `deadline`.
- Dispose during an attempt: `failed` / `disposed`; `recover()` rejects with `PeerDisposedError`.
- Failed bootstrap: `failed` / `bootstrap-failed`; then `replay()` with a responder completes the
  ledger: `bootstrapped` with the same `attemptID`, and the owed entries come out of `replay()` exactly
  once.
- Thrown attempt: `failed` / `error` with the error; `recover()` rejects with it.
- Two `recover()` calls before `ready`: one attempt, one `started`, one terminal.
- Consumer `recover()` overlapping an automatic heal: one `started`, one terminal; re-enact entries
  returned exactly once across `recover()`, `commit()` and `replay()`.
- Queued `recover()` behind a lane operation, recovery succeeded meanwhile: `{ advanced: true }`, no new
  attempt, no events.
- Throwing, rejecting, and `dispose()`-calling observers: walk outcome, cursor, `stranded` and recovery
  result unchanged; callbacks run after the step returns.

## Release

`pnpm change` intent for `@kumiai/rpc`: minor within the 0.5 band (additive API). Note the `recover()`
stash behaviour change and the handshake decode fix. Update the rpc README host-callback section.
