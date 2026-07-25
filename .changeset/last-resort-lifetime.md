---
'@kumiai/mls': minor
---

Give last-resort key packages a 90-day lifetime instead of ts-mls's ~15-day default.

`createLastResortKeyPackageBundle` set no `lifetime`, so ts-mls applied `defaultLifetime()` —
about 15 days. That is right for a single-use package and wrong for a standing availability floor:
the package stopped being addable a fortnight after upload.

The failure was worse than an empty slot. An inviter validates the lifetime when building the Add
(`sentByClient`), so the refusal happens at the far end with `Current time not within Lifetime`,
while the hub — which stores opaque bytes and cannot see an expiry — went on reporting the slot as
full and serving the dead package. The availability floor read healthy while every join through it
failed.

Last-resort bundles now carry an explicit 90-day lifetime, back-dated a day for clock skew as
ts-mls's own default is, exported as `LAST_RESORT_LIFETIME_DAYS` so a host can schedule rotation
against it. It sits under the 4-month `maximumTotalLifetime` ts-mls declares (currently unenforced).
Ordinary key packages are untouched and keep the ts-mls default.

This is a rotation deadline, not a fix for rotation: a host must re-upload before the window
elapses. Automatic provisioning and rotation remain unbuilt.
