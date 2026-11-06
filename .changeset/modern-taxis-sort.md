---
"@kumiai/mls": minor
---

Route MLS Ed25519 signing and verification through the kokuin provider (GroupOptions.crypto, or NobleCryptoProviderOptions.crypto). Verification is now strict on every backend, so small-order and non-canonical signatures that lenient noble accepted are refused.
