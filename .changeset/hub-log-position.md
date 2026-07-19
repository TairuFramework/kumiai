---
'@kumiai/hub-protocol': minor
'@kumiai/hub-tunnel': minor
---

`StoredMessage.logPosition` — the place a log-class frame occupies in its topic's log, carried
on the push as well as the pull.

A delivery position and a log position are different sequences and must never be crossed: a
delivery position runs across all of a recipient's subscribed topics and skips its own frames.
Without this field a live push could not advance a durable read position at all, which is why
the app-lane drain previously had to re-pull whole segments. Absent on mailbox frames, which
have no place in any log — read the absence, not a falsy value.
