# rpc: split the recovery and commit lane out of `peer.ts`

**Priority:** backlog. A legibility refactor with no behaviour change.

`createGroupPeer` is one large closure. Its types and the epoch runtime now live in `peer-types.ts` and
`peer-epoch.ts`. Two large concerns remain inline:

- **Recovery** (about 900 lines): the rendezvous handlers, `requestGroupInfo`, `attemptBody`,
  `runRecovery`, `recover`, and the waiter, timer and verdict caches.
- **Commit lane** (about 1,000 lines): `walkCommits`, `pullCommits`, `reconcileCommits`, commit
  delivery, `initControlLanes`, `commit` and `commitHeld`, `replayJournal`, `ensureLedger` and
  `finalizeBootstrap`.

Both read and write most of the closure's mutable state: strand and episode state, `pendingRecovery`,
the anchor, the floor and the runtimes. Extract each one behind a factory with a state context, the
same pattern as `createAppLane` and `createLogDelivery`.

WARNING: keep await order and microtask hops identical. Tests catch a dropped call, but they can miss
an ordering change.

Do each extraction in its own PR, with the full rpc and integration suites between them.
