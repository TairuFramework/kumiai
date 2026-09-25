---
"@kumiai/mls": minor
---

**Breaking (types only):** `GroupHandle.processMessage` takes `Uint8Array | MlsFramedMessage`, and
`processWelcome`'s `welcome` and `welcomeKeyPackageRefs` take `Uint8Array | Welcome` (ts-mls types).
The old `Uint8Array | unknown` parameters collapsed to `unknown` and accepted anything at compile
time. Runtime behaviour is unchanged. Callers that pass wire bytes need no change; a caller holding
an untyped value (for example a Welcome decoded from JSON) must check it is a `Uint8Array` first.
