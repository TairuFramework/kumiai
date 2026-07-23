# Defining a group protocol

## Procedure kind × retention

Retention is declared **per procedure, in the protocol definition** — not chosen per call. The send
API stays one `dispatch(prc, data)`, routing by the declaration.

```ts
const room = defineGroupProtocol({
  'room/posted': { type: 'event', retain: 'log', data: { type: 'object' } },       // drainable history
  'room/said':   { type: 'event', retain: 'ephemeral', data: { type: 'object' } }, // ephemeral, said
  'room/typing': { type: 'event', data: { type: 'object' } },                      // ephemeral, default
  'room/roster': { type: 'request', param: {}, result: {} },                       // always ephemeral
})
```

**Only events may be `log`.** `request` / `gather` / `reply` are always ephemeral. Retaining a
correlated procedure would re-fire responders on drain, against an `rid` whose requester and timeout
died long ago.

`retain: 'ephemeral'` is legal on **every** kind, and means exactly what omitting it means — it
exists so a definition can state its choice rather than leave it to a default, which is worth having
where the choice was deliberate rather than unconsidered. `'log'` is the value correlated kinds do
not have: the guardrail is the `type` discriminant in `GroupProcedureDefinition`, each member
carrying the retention its kind allows, so a retained request matches no member. `defineGroupProtocol`
also throws on one at definition time, for the caller who reached it with types erased.

> The guardrail was a mapped type over the helper's parameter until it was found rejecting every
> retain-free `request` — the mapped type named the type parameter it constrained, so it was read
> mid-inference and treated every procedure as a non-event. Prefer a constraint the discriminant can
> enforce over a rule applied on top of one.

See [lanes and retention](./lanes-and-retention.md) for what `log` and ephemeral mean at the hub,
and [reserved namespaces](./reserved-namespaces.md) for the prefixes a procedure name may not use.
