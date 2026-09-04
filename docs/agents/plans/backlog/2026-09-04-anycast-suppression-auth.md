# Anycast suppression observe-path is unauthenticated

**Priority:** backlog — a pre-existing anycast soundness concern, surfaced (not introduced) by the
final whole-branch review of `feat/bus-control-typ`
(`../../plans/../superpowers/plans/2026-09-04-bus-control-typ.md`), 2026-09-04. No fix on that branch;
it left the observe path exactly as it found it.

## The concern

`@kumiai/broadcast`'s responder suppresses a healthy responder when it observes another responder's
*success* reply for the same request id: `createBroadcastResponder`'s inbound loop calls
`markReplied(data.rid, ...)` on an observed `res` frame gated only on `data.err == null`
(`packages/broadcast/src/responder.ts`, the `typ === 'ctrl'` / `kind === 'res'` branch). That branch
keys on `rid` alone — it does **not** consult the transport-level `senderDID`.

So on an authenticating transport, a peer can suppress a healthy responder for a chosen `rid` by
writing a forged success `res` under that `rid`: the healthy responder observes it and marks the rid
replied, and stays silent. The client's *collect* path is not the weak point — `BroadcastClient`
already drops replies the transport cannot attribute (`client.ts`, the `senderDID` guard) — the
weakness is that a responder's decision to stay quiet is driven by an unauthenticated observation.

The `feat/bus-control-typ` branch **narrowed** the exposure: before it, the observe branch ran on any
`typ:'event'` frame, so an ordinary app event whose `data` happened to be `{kind:'res', rid, err:null}`
could poison the suppression map with no adversary at all. Moving control frames to `typ:'ctrl'`
means only a frame deliberately shaped as a control reply reaches `markReplied`. What remains is the
deliberate-forgery case above.

## Why it may or may not matter

- Suppression is a storm-collapse optimization, not a correctness mechanism: a suppressed healthy
  responder means the client may receive the forged answer, or fall to timeout, rather than the real
  one. Whether that is exploitable depends on the threat model of the bus the responder runs on.
- Cross-epoch forgery is already blocked by key rotation; this is a same-epoch lever, like the
  directed-lane session-replay item.

## Possible directions (decide during design)

- Authenticate the observe: only a `res` from an attributed `senderDID` (recovered by `unwrap`)
  suppresses, mirroring the client collect path. Needs the responder to see the transport-level
  `senderDID` on observed frames — it already receives `msg.senderDID` for `req` dispatch, so the
  wiring is present.
- Or accept it explicitly as within the bus's threat model and record why, alongside the anycast
  soundness reasoning in `../completed/2026-07-24-anycast-soundness.complete.md`.

## Scope

`@kumiai/broadcast` (`responder.ts` observe branch), plus a test that a `res` under a forged/absent
sender does not suppress a healthy responder. No wire-format change.
