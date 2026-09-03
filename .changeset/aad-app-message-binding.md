---
"@kumiai/mls": minor
"@kumiai/rpc": minor
"@kumiai/mls-rpc": minor
"@kumiai/rpc-conformance": minor
---

Add authenticated-data (AAD) binding to the group application-message cryptographic layer. The `GroupHandle.encrypt()` and `GroupHandle.decrypt()` methods now accept an optional AAD parameter, and the `@kumiai/rpc` `GroupCrypto` port's `wrap()` and `unwrap()` operations now accept AAD and `expectedAAD` respectively. Each application message and directed frame is now cryptographically bound to the topicID on which it is published; a frame sealed for one topic cannot be opened on another. The AAD comparison is performed before the message is decrypted, preventing a wrong-topic frame from consuming a ratchet generation.

**Breaking change:** Pre-upgrade retained application history is invalidated on upgrade. The upgrade drain now enforces the topic AAD constraint and advances the durable cursor past legacy empty-AAD frames. There is no legacy-acceptance code path for frames without AAD.

This change does not modify topic-ID derivation logic or the durable commit and recovery-topic infrastructure.
