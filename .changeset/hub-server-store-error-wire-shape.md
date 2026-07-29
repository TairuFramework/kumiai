---
'@kumiai/hub-server': minor
---

Every `HubStore` call in the hub's handlers now either fails the request with a coded wire shape or
is reported through `onStoreError`. Two did neither.

A failed subscriber read during publish fan-out no longer fails the publish. The append and its
delivery rows were already committed when that read runs, so the frame stays pending in the store
and every subscriber still receives it on its next reconnect — while failing the request lost the
live push permanently, because the caller's `publishID` retry dedups and skips fan-out entirely.
The failure is now reported as `{ method: 'getSubscribers', topicID, error }`.

A store failure during `hub/v1/unsubscribe` now crosses the wire with its hub error code, like
every other store failure, instead of propagating raw.

**Breaking:** `HubStoreErrorEvent` is a discriminated union on `method` rather than a flat
`{ method; did?; error }`. Each variant carries the subject its site has — `did` for `ack` and
`fetchLastResortKeyPackage`, `topicID` for the new `getSubscribers`, neither for `purge`. A hook
that read `event.did` unconditionally must narrow on `event.method` first.
