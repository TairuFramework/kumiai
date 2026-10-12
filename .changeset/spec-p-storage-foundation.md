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
