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

Add transactional memory persistence and lossless MLS/recovery v2 storage codecs; refuse ambiguous v1 snapshots.

Run memory group and device persistence through the D8 FIFO ownership queues and phase-bound capabilities. Remove the public GroupMutationGate and MemoryDatabase.mutationGate APIs.

Capture host effects before finalise to preserve getter errors and avoid unhandled fail-stop rejections. Keep non-mutating store refusals separate from fatal seal and required-open failures. Ownership is runtime-neutral with an optional ownershipContext port.
Ignore revoked attempts' late failures, reject roots invoked by argument getters, roll back admitted required-read failures, and promptly reject failed Reads.

MLS, broadcast and rpc runtime code no longer needs structuredClone, String.isWellFormed or AbortSignal.throwIfAborted; Hermes hosts need Web Crypto and TextEncoder polyfills.

Persist one private control build per source epoch. Validate checkpoint-bound first-valid acceptance before adoption or Welcome delivery. Retain source slots across deadlines and outcome acknowledgement.

Add an @kumiai/rpc/testing entry point for deterministic control-step tests.

Add registry core with validated ownership on the shared database binding, retire hooks, committed runtime snapshots and accepted-journal candidate binding. Seed uses its normative signature and retained-entry proof; superseded marker resolution may be uncertain. Switch replay uses retained adopted rejoin evidence.

After drainage, fail every uncertified old entry with incarnation-abandoned events and preserve certified settlement. Retain adopted bootstrap/reenact continuation for 2.2d. Require explicit simple-access keys and normative spent-first Welcome judgment.

Core switch currently uses restricted RegistrySwitchWrite; 2.2d reconciles AdoptionWrite and wires consumers. Leases, batching, package burn/receipt, full factory parameters and crypto/settlement adapters follow in 2.3. `@kumiai/mls` exports its lapse/membership rule as a pure helper.

Add `GroupSafety` and immutable incarnation-scoped `forkHalt`/`recoveryUnavailable` fields with atomic durable safety events.
Retain old-incarnation evidence through retirement and deletion. Event acknowledgement never clears safety fields or recreates acknowledged events on identical reapplication.
`GroupSafety.events` includes host/registry evidence. Peer `onSafetyEvent` reports only its matching proven commit, at most once without replay.

Halt past-epoch commit-digest divergence on either classifier branch before authentication, with observed `fork-losing` or `fork-winning` evidence.
Safety gates refuse sends, opens, control and recovery while preserving opened delivery, stored outcomes/events, committed Welcomes and live certified settlement.
Peers observe registry/host safety on control refresh or restart. Immediate consumer wiring and authenticated `captureHead` remain 2.2d work.
Until then, a stale-GroupInfo external recovery commit after an applied commit halts the survivor.
Restart frozen-settlement publication under safety remains a 2.3 obligation. A crash before durable writing can still lose one-shot or host-reported evidence.

Hosts derive Welcome admission's `held.forkHalted` from `forkHalt` alone.
A recovery-unavailable field permits otherwise admissible readmission with valid retained trust. Missing, unreadable or empty-spent trust refuses seed without reconstruction.
Manual recovery remains unavailable until 2.2e. Manual re-invite after lost spent trust requires a new successor group with a new groupID.
