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
Unadopted legacy records stop unchanged until manual recovery. Custom recovery secrets require equivalent retained-trust derivation at construction.
Origin-authorised removed signers retain attestation authority. Busy responders can cause accepted-unadoptable churn.
Fork detection remains deferred to out-of-band peer checkpoints. Full registry crypto, leases and batching remain 2.3.
Real-MLS memory reconstruction and sensitivity witnesses provide phase-2 evidence. Phase-6 child-process SIGKILL evidence remains outstanding.
Restart frozen-settlement publication under safety remains a 2.3 obligation. A crash before durable writing can still lose volatile host evidence.

Hosts derive Welcome admission's `held.forkHalted` from `forkHalt` alone.
A recovery-unavailable field permits otherwise admissible readmission with valid retained trust. Missing, unreadable or empty-spent trust refuses seed without reconstruction.
Manual recovery remains unavailable until 2.2e. Manual re-invite after lost spent trust requires a new successor group with a new groupID.
