# App-lane delivery — a member that was away receives what it missed

**Status:** complete. Landed on `feat/app-lane-delivery` (PR #7).

## Goal

App messages were push-only and dropped if nobody was listening. A member that closed the app, lost
its connection, or joined late never saw them. Logged app events are now durable and pullable, and a
returning peer drains what it missed without the host asking.

## The discovery that shaped the design

The work was filed as "publish `retain: 'log'`" — a one-line flag. It was not. App frames never went
through `mux.publish`: they flowed through `BroadcastClient` over a `BroadcastBus`, whose `publish`
hardcoded mailbox class with no retention and offered no pull at all. The commit lane bypassed the
bus deliberately. Making app frames log-class and pullable was an integration change across the
retention model, the topic model, and the peer's drain — not a flag.

Validating against the real host settled the shape further: the host's peer is eager, has no
`ready()`, and drives no app catch-up — there is no host call to hang a drain on. **So the drain had
to be peer-internal**, running automatically when the peer comes up. That is also the better
behaviour: the user reopens the app and the messages are there.

## Key design decisions

**Retention is a per-procedure property, and only events may be logged.** Declared in the protocol
definition, enforced at definition time, not chosen per call. Correlation traffic (requests and
replies) is always ephemeral — retaining it would let a returning member re-fire handlers out of the
log. The send API stayed a single `dispatch`.

**The app topic derives from an anchor at the last ROSTER CHANGE — an Add or a Remove — not the last
Remove.** This was corrected mid-implementation, and the correction is the load-bearing part. Two
constraints intersect at exactly one epoch: the anchor epoch must be one *every current member holds
the secret for* (so ≥ the newest member's join epoch, since MLS ratchets forward and a member cannot
export a secret from before it joined), and it must move on every removal (below). Their intersection
is `max(last add, last remove)`. Binding the topic to the last Remove instead silently partitions the
group — a member added afterwards can never derive the topic, and no seeding trick recovers it,
because the secret is simply gone forward.

The anchor is **durably persisted**. Announcing it in Welcome or GroupInfo was rejected: it would
still need persistence, could not use a public GroupContext extension without defeating the property
below, and leaks pre-join metadata to joiners.

**Load-bearing: the anchor feeds the per-epoch `exportSecret()`, never the lifelong recovery
secret.** A removed member keeps the recovery secret for life and can enumerate epoch numbers, so a
topic derived from it would cut nobody off. The per-epoch export is the only thing that makes a
removed member blind to the new topic — content was always MLS-locked; this closes the metadata
channel too.

**A roster change is detected by diffing the member DID set around the apply**, using set
*inequality* rather than set difference, so an Add rotates as an Add-plus-Remove does (a count check
would miss the latter). Diffing occupied leaf indices was rejected on evidence — blind to a resync
rejoin and to a same-commit Remove+Add. Leaf keys are the opposite failure: an Update rotates them on
routine commits. A DID-set diff cannot see a rejoin by construction, so a rejoin is caught by an
explicit external-commit signal instead; the lane rotates on either.

**The pruned-window signal is an event, not a return value** — forced by the host's eager-peer model,
and shaped to feed a host health condition. It reports only *that* a gap exists; the host renders the
date range from its own clock, since an epoch number means nothing to it.

## What was built

Per-procedure retention and its definition-time enforcement; the anchor topic model with durable
persistence and roster-change rotation; the peer-internal returning-member drain, interleaved with
the commit walk and running ahead of each apply; a durable per-topic app cursor with the rule that it
may only pass a frame that is delivered or dead; and the pruned-window event. Retention defaults
moved to 28 days, two days under the reference ceiling so a documented per-member override has
somewhere to go.

## Notable defects found and fixed along the way

Directed RPC opened every frame twice — the acceptor and every directed client each held an `unwrap`
on one inbox topic and raced for a single per-message key, so a directed request was never answered
over real MLS. One open-once path per topic now serves both lanes.

A second `hub/receive` for a DID used to be refused, when a client reconnects precisely *because* its
connection broke. The reconnect now takes the lane, and a lane that ends unasked is reported rather
than swallowed.

A swallowed subscribe failure left a phantom refcount claiming a topic was held, so every later fetch
failed forever into callers written to swallow. The refusal now latches: every publish and fetch on a
refused topic throws the hub's own error, so a peer that cannot receive cannot go on transmitting as
though it were whole.

## Accepted residuals

A member away longer than the retention window loses those messages — bounded, and surfaced as the
pruned-window event rather than lost silently. The drain is at-least-once against the live path. A
fresh joiner's key window is empty by construction. `oldest > cursor` over-reports a pruned window on
an honest prune. The `processCommit`-to-anchor-save crash window, and the laggard publisher, both
stand.

Follow-on work filed separately in `next/` — the commit-topic storm, external-commit replay, and the
conformance-suite coverage gap.
