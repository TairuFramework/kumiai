---
"@kumiai/hub-protocol": patch
"@kumiai/hub-server": patch
"@kumiai/mls-hub": patch
---

The hub refuses a request over its per-DID or per-topic rate limit with `HUB_RATE_LIMITED` instead of enkaku's generic `EK01`, so a client can tell a transient refusal from any other handler error. `hub-protocol` exports `RateLimitedError`, rebuilt by `hubErrorFromCode`. `mls-hub` classifies it as retryable. A client matching `EK01` for rate limits must also accept `HUB_RATE_LIMITED`.
