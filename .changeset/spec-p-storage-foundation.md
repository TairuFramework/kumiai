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

Run memory group persistence through FIFO ownership queues and phase-bound capabilities. Remove the public GroupMutationGate and MemoryDatabase.mutationGate APIs.
