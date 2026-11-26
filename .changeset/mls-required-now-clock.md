---
"@kumiai/mls": patch
"@kumiai/mls-rpc": patch
"@kumiai/mls-hub": patch
"@kumiai/hub-server": patch
"@kumiai/hub-store": patch
"@kumiai/hub-tunnel": patch
---

Require an injected `now: Now` clock (from `@sozai/runtime`) wherever MLS and key-package APIs read the current time; none falls back to `Date.now()` or `createRuntime()`.
`createGroup`, `joinGroupExternal`, `renewLeaf`, `commitInvite`, `addDevice`, `assertRecoveryBinding`, `createKeyPackageBundle`, `createLastResortKeyPackageBundle`, `mintLeafCapability`, `mintTrustedGrant`, `attestTreeTime` and `recoverySignerEligible` take `now`, and so do the mls-hub key-package pool and last-resort provisioner.
`recoverySignerEligible` takes a millisecond clock instead of seconds, `attestTreeTime` takes `now` instead of `time`, and `assertBindingAuthorTime` takes a `{ controller, nowSeconds }` object.
mls-rpc `createRecoveryBindingState` and `createVerdictJudge` take a required clock.
hub-store, hub-tunnel and hub-server no longer export their own `Now` aliases and use the one from `@sozai/runtime`.
