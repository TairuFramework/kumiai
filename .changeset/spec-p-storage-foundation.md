---
"@kumiai/mls": minor
"@kumiai/broadcast": minor
"@kumiai/hub-protocol": minor
"@kumiai/hub-client": minor
"@kumiai/hub-server": minor
"@kumiai/hub-store": minor
"@kumiai/hub-http": minor
"@kumiai/hub-tunnel": minor
"@kumiai/hub-wake": minor
"@kumiai/rpc": minor
"@kumiai/mls-rpc": minor
"@kumiai/mls-hub": minor
"@kumiai/rpc-conformance": minor
"@kumiai/hub-conformance": minor
---

Add transactional memory persistence, ClientState codec v2 and captured recovery candidate codec v3. Refuse ambiguous ClientState v1 snapshots.

Run memory group and device persistence through the D8 FIFO ownership queues and phase-bound capabilities. Remove the public GroupMutationGate and MemoryDatabase.mutationGate APIs.

Capture host effects before finalise to preserve getter errors and avoid unhandled fail-stop rejections. Keep non-mutating store refusals separate from fatal seal and required-open failures. Ownership is runtime-neutral with an optional ownershipContext port.
Ignore revoked attempts' late failures, reject roots invoked by argument getters, roll back admitted required-read failures, and promptly reject failed Reads.

MLS, broadcast and rpc runtime code no longer needs structuredClone, String.isWellFormed or AbortSignal.throwIfAborted; Hermes hosts need Web Crypto and TextEncoder polyfills.

Persist one private control build per source epoch. Validate checkpoint-bound first-valid acceptance before adoption or Welcome delivery. Retain source slots across deadlines and outcome acknowledgement.

Add an @kumiai/rpc/testing entry point for deterministic control-step tests.

Add registry core with validated ownership on the shared database binding, retire hooks, committed runtime snapshots and accepted-journal candidate binding. Seed uses its normative signature and retained-entry proof; superseded marker resolution may be uncertain. Switch replay uses retained adopted rejoin evidence.

After drainage, fail every uncertified old entry with incarnation-abandoned events and preserve certified settlement. Retain adopted bootstrap/reenact continuation in source storage across destination advancement and reconstruction. Require explicit simple-access keys and normative spent-first Welcome judgment.

Captured recovery maps AdoptionWrite into restricted RegistrySwitchWrite and drains source peers before switching. Leases, batching, package burn/receipt, full factory parameters and crypto/settlement adapters follow in 2.3. `@kumiai/mls` exports its lapse/membership rule as a pure helper.

Add `GroupSafety` and immutable incarnation-scoped `forkHalt`/`recoveryUnavailable` fields with atomic durable safety events.
Retain old-incarnation evidence through retirement and deletion. Event acknowledgement never clears safety fields or recreates acknowledged events on identical reapplication.
`GroupSafety.events` includes host/registry evidence. Peer `onSafetyEvent` reports only its matching proven commit, at most once without replay.

Treat hub delivery faults as non-delivery. Past-epoch divergence, signed CAS losers, own-copy contradictions and unknown versions diagnose and skip without new durable halts.
Recognise re-encoded no-entry commits and receiver-valid named-entry copies without changing saved digests. Blob-negative verdicts remain advisory through replay and caches.
Only refusal of an authenticated commit authorises negative verdicts. Host reports and genuine local storage invariants retain halt authority.
Safety sinks synchronously hold live consumers. Preserve stored outcomes, owed Welcomes, history and immutable historical safety.

Authenticate captureHead and the committed epoch authenticator in GroupInfo reply v2, with recovery/v2 and recovery-aad/v2 HPKE domains.
Persist candidate v3 with its authenticated reply and immutable source, target and search origin before publication.
Retry identical saved bytes at authenticated recaptured heads, including lower heads. Persist a monotone recovery epoch floor through settlement and restart.
Later exact fresh-leaf presence proves acceptance. Without bound confirmation, retain compact accepted-unadoptable facts and cumulative ledger obligations before replacing that leaf.
Unconfirmed later leaf absence records not-accepted provenance and carries obligations into the next attempt. Confirmed accepted facts survive later removal.

Export portable source/proof types, concrete registry source/write types, captured constructors, continuation and existing refusal errors.
Recover missing private state using retained trust. Complete source accepted operations idempotently after destination bootstrap.
Unadopted legacy records stop unchanged; successor retirement is their explicit exit. Custom recovery secrets require equivalent retained-trust derivation at construction.
Origin-authorised removed signers retain attestation authority. Busy responders can cause accepted-unadoptable churn.
Full registry crypto, leases and batching remain 2.3.
Real-MLS memory reconstruction and sensitivity witnesses provide phase-2 evidence. Phase-6 child-process SIGKILL evidence remains outstanding.
Restart frozen-settlement publication under safety remains a 2.3 obligation. A crash before durable writing can still lose volatile host evidence.

Hosts derive Welcome admission's `held.forkHalted` from `forkHalt` alone.
A recovery-unavailable field permits otherwise admissible readmission with valid retained trust. Missing, unreadable or empty-spent trust refuses seed without reconstruction.
After lost spent trust, successor retirement (new groupID) is the exit; total key and database loss takes a fresh invite into the same group.

Detect forks with member-signed checkpoints on a recovery-secret topic; the hub `authorize` hook must gate it like the commit topic.
Frames carry key hashes, not DIDs. Conflicts open durable fork notices with at-risk own messages and coverage; notices never halt, switch or rank branches.
Notices coalesce to one update per 30 s and close after 24 h of single-branch quiet, on local clocks. Evidence keeps the 256-installation / seven-day bounds.
Export, import and standalone verification keep checkpoints portable.
Report `branch-abandoned` with own message IDs, others' counts, membership delta and coverage; the app resends its own messages.
With fork evidence and a transcript-checked lineage, one recovery attempt may adopt the hub's branch below the epoch floor; the ordinary floor never changes.
Expired evidence stays target-behind until manual resync. Coherent fake GroupInfo plus checkpoint chains remain an accepted insider residual.
Surface non-terminal `not-member` (distinct responder DIDs and count, optional pendingReason) and `spent-set-corrupt` conditions through status and events; `SpentSetCorruptError` is one class, re-exported by mls-rpc.
Add manual recovery: resync to a registered or call-time target (current move or rejoin) and successor retirement with an app-clearable tombstone.
A current move resets app-topic cursors with its other hub positions. `clearHold` lifts only app-reported halts.
Phase-2.3 crypto, batching, leases, package burn and restore, phase-3 providers and child-process SIGKILL evidence remain excluded.

Phase 2.3a adds exact CAS for every MLS state write, with pending, poison and app-cursor metadata off the version clock. App-cursor writes no longer notify registry listeners. Own-commit adoption and build retry use journal compatibility over referenced proposals, allowing retained-history eviction. Skipped-key and retained-tuple guards enforce configurable epoch retention (default 4, range 1–32), including past-epoch opens. Registry `openBatch`/`pending` and `createGroupCrypto` atomically persist durable opens, refuse occurrences at or before the durable cursor and reject `frame.id !== frameID(topicID, ciphertext)`. Opened results carry `handleEpoch`, and `GroupUnwrapResult.epoch` reports that locked epoch while pending records keep the seal epoch. App work leaves the commit queue, with notices and delivery starts sharing one self-draining FIFO independent of `runSerial`, bounded pulls, durable departing topics, one code-unit position comparator and `idle`/`drained` completion ordering. Departing-topic expiry settles stalls through optional `AppDeliveryResumed.settlement: 'expired'`. Cleanups release a proven ambiguous clear-hold latch, keep unresolved switch proof visibly pending without a bound, and diagnose spent-set corruption before moving current.

- `@kumiai/mls` behaviour change: private commit builders and `proposeSelfRemoval` permanently throw `CommitAuthoringRefusedError` on access-issued or mls-rpc-issued handles and their derivatives, including a host handle once `simpleHandleAccess` issues it. Bare handles are unchanged. New exports: `CommitAuthoringRefusedError`, `CommitReceipt`, `restrictCommitAuthoring`, `withCommitPermit`. `authorPrivateCommit` is internal and no longer exported. The permit receipt binds the commit, candidate and Welcome.
- `@kumiai/mls-rpc` breaking change: `buildRevokeProofOperation` requires the control-build callback's `group` handle. `createControlBuildPort` requires `restoreCandidate`, accepts optional `restoreSource`, and builds on a handle restored from journal `sourceState`. `prepareBuild` rejects host commit bytes differing from the permit receipt. Undecodable candidates throw exported `InvalidCandidateError`, while other restore faults propagate. Null-state control adoption fails with `ControlAdoptionMovedError` (registry `adopt` reports `'moved'`) instead of `GroupStateConflictError`. Registry durable unwrap maps non-safety availability failures, including `RegistryRetiringError`, to retryable `AppFrameStorageError`.
- Frames older than key retention can be refused without notice when a peer catches up across more than `retainKeysForEpochs` commits.
- Deferred/residual: 2.3c supplies resync/retirement opened-record drain, `drainOpened` and `switch-blocked`. Opened retired records stay durable and undelivered. Out-of-scope crypto obligations remain ts-mls skipped-cache chain secrets and retained spent own handshake secrets from private Commit creation. Other known residuals: hub response decoding in hub-protocol/hub-client remains unbounded by rpc, pull rate limiting remains outstanding, and `mux.retainTopic`/durable cursor rows grow per rotation. A forged future-epoch old-topic frame can delay a newer segment up to 32 epochs. Raw-key holders can restore unrestricted handles through journal `sourceState`/`GroupHandle.state` (trusted-code exception Q3). The sealed-memory double's control-validation path and shared memory model do not authenticate commits (test-only follow-up).
