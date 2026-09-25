# Expose commit strand and recovery lifecycle to the host

**Origin:** backlog item `2026-09-25-rpc-strand-recovery-observability.md`. Consumer: Kubun
`GroupHealthMonitor` (`../kubun/packages/plugin-p2p/src/groups/group-health-monitor.ts:61-115`), which
also calls `GroupPeer.recover()` itself (`../kubun/packages/plugin-p2p/src/groups/group-peer-manager.ts:770-792`).

## Goal

1. Tell the host, once per distinct incident, why the commit lane decided this peer is stranded, with
   an honest statement of how strong that evidence is.
2. Tell the host when a recovery attempt starts and how it ends, with success meaning the rejoin
   landed **and** the ledger bootstrapped.
3. Make automatic healing and consumer `recover()` single-flight, with one owner for `reenact` entries.

A host observer must never change the commit walk or the recovery outcome.

## API

Two optional fields on `GroupPeerParams` (`packages/rpc/src/peer.ts`), exported types from the package:

```ts
onStrand?: (observation: StrandObservation) => void | Promise<void>
onRecovery?: (event: RecoveryEvent) => void | Promise<void>

export type StrandKind = 'own-unmerged' | 'fork-losing' | 'ahead' | 'unknown-version'
export type StrandConfidence = 'authenticated' | 'observed' | 'claimed'

export type StrandObservation = {
  /** The peer's stable commit topic ID, as `AppWindowPruned.groupID`. */
  groupID: string
  /** Commit-log sequenceID of the frame that raised the incident. */
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
export type RecoveryFailureReason = 'no-responder' | 'bootstrap-failed' | 'deadline' | 'error'

export type RecoveryEvent =
  | { phase: 'started'; groupID: string; attemptID: string; trigger: RecoveryTrigger }
  | { phase: 'succeeded'; groupID: string; attemptID: string; trigger: RecoveryTrigger }
  | {
      phase: 'failed'
      groupID: string
      attemptID: string
      trigger: RecoveryTrigger
      reason: RecoveryFailureReason
      /** Present for `reason: 'error'`: what the attempt threw. */
      error?: unknown
    }
```

## Evidence kinds and confidence

The mapping is fixed and documented on the types:

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

Observations fire exactly where the walk today sets `stranded = true` for these four cases, and nowhere
else. `fork` on the winning branch, `history`, `poison` and `apply` never fire.

## Deduplication

- The peer keeps an in-memory `reportedIncidents: Set<string>`.
- Incident key: `commitDigest` when present, otherwise the fixed key `'unknown-version'`. All
  digest-less frames therefore coalesce into one incident until re-armed.
- An observation fires only if its key is not in the set; the key is then added.
- Consequences: a replayed commit at another position (same digest) is silent; a duplicate pull is
  silent; an `own-unmerged` frame the walk stops on and re-reads every pull is silent after the first.
- **Re-arm:** the set is cleared when a recovery attempt emits `succeeded`. A failed attempt does not
  clear it: the incident is still open.
- In memory only. A restarted peer may report an incident again; that is the safe direction.

## Recovery lifecycle and single-flight

A new internal `runRecovery(trigger)` owns every attempt. `recover()` calls it with `'consumer'`;
`healIfRequested()` calls it with `'automatic'`. The existing `healing` flag is replaced by the
`activeRecovery` state below.

**State:**
- `activeRecovery: Promise<{ advanced: boolean }> | null` — the attempt currently running.
- `recoveryGeneration: number` — incremented when an attempt emits `succeeded`.

**Join.** A call made while `activeRecovery` is non-null awaits that promise. It emits no events and
starts nothing. The attempt's trigger stays the one that started it.

**Recheck.** A call records `recoveryGeneration` on entry. When its attempt body finally runs inside
`runSerial` (it may have queued behind a `commit()` or another lane operation), if the generation has
moved **and** the peer is neither `stranded` nor has `healRequested`, it returns `{ advanced: true }`
without starting an attempt and without events. Otherwise a direct `recover()` rejoins as today, even
on a peer that is not stranded.

**Events.** `started` fires when an attempt's body enters the commit mutex and is about to run step 0.
Exactly one terminal event follows:

| Outcome (current `recover` code path) | Event |
|---|---|
| Rejoin landed and `ensureLedger` succeeded (step 9 return) | `succeeded` |
| `sealed == null` (step 3 break) | `failed`, `no-responder` |
| Rejoin landed, `ensureLedger` failed (step 8 return) | `failed`, `bootstrap-failed` |
| Loop exhausted `recoveryDeadlineMs` via lost races or unopenable replies | `failed`, `deadline` |
| Any throw inside the attempt, including dispose mid-attempt | `failed`, `error`, `error` set |

The early return when `mls`, `commitTopicID` or `rendezvousTopicID` is null is not an attempt: no events.
`attemptID` is a fresh ID per attempt (`newPublishID()` or the runtime random ID).

The attempt's return value and thrown error are unchanged by the events: `recover()` still resolves
`{ advanced, reenact }` or rejects with the same error.

## `reenact` ownership

One owner: the `pendingReenact` stash.

- Every attempt appends its re-enact entries to `pendingReenact` instead of returning them.
- `recover()` returns `reenact` by draining `pendingReenact` after its (own or joined) attempt settles.
- `commit()` and `replay()` keep draining it through `takeLost`.
- The first drain wins; nothing is dropped and nothing is handed out twice.
- Behaviour change to document: a direct `recover()` may now return entries an earlier automatic heal
  left in the stash. Those entries are owed, so handing them out is correct.

## Observer safety

A shared helper `notifyHost(callback, value)` in `packages/rpc/src/`:

- calls the callback synchronously inside `try/catch`;
- if it returns a thenable, attaches a no-op rejection handler;
- never awaits it.

Not awaited, unlike `reportPrunedWindow` (`app-lane.ts:196-209`): strand observations fire inside the
commit mutex, and a host that awaited back into `recover()` or `commit()` from its callback would
deadlock on the non-reentrant mutex. The durable app-delivery work reuses this helper.

## Out of scope

- `onAppWindowPruned` is unchanged. It stays an app-history notice with its documented over-report
  caveat, not strand evidence.
- Durable incident dedupe across restarts.
- Fork resolution.

## Ports and conformance

`GroupMLS`, `GroupCrypto` and the hub ports are unchanged. Run the full repo test and `test:types` gates
(contract suites run as regression).

## Tests (`packages/rpc/test/`)

- Each kind fires once with the mapped `confidence`, `claimedEpoch` and `commitDigest`.
- Replay of the same commit at another position: no second observation.
- Duplicate pull, and an `own-unmerged` frame re-read across pulls: one observation.
- Two unknown-version frames: one observation until a successful recovery; after it, a new one fires.
- Winning fork, history, poison, apply: no observation.
- Successful automatic heal: `started` then `succeeded`, `trigger: 'automatic'`; dedupe re-armed.
- No responder: `failed` / `no-responder`, `recover()` returns `{ advanced: false }`.
- Failed bootstrap: `failed` / `bootstrap-failed`.
- Thrown attempt: `failed` / `error` with the error; `recover()` rejects with the same error.
- Overlapping consumer `recover()` during an automatic heal: one `started`, one terminal event; the
  re-enact entries are returned exactly once across `recover()`, `commit()` and `replay()`.
- Queued `recover()` behind a lane operation, where a recovery succeeded meanwhile: returns
  `{ advanced: true }`, no new attempt, no events.
- Throwing and rejecting observers: walk outcome, cursor, `stranded`, and recovery result unchanged.

## Release

`pnpm change` intent for `@kumiai/rpc`: additive, within the 0.5 band. Note the `recover()` stash
behaviour change. Update the rpc README host-callback section.
