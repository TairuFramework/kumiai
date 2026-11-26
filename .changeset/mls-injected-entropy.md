---
"@kumiai/mls": patch
---

`createNobleCryptoProvider`'s `randomBytes` option now supplies every secret key, not only `rng.randomBytes`.
Ed25519 signature keygen, HPKE `generateKeyPair` and the HPKE seal ephemeral key draw 32 bytes from it.
Before, these three called noble's own `randomSecretKey()` and ignored the injected source.
