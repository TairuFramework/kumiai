# @kumiai/rpc-conformance

The contract suite for the two consumer ports of `@kumiai/rpc`: `GroupCrypto` and `GroupMLS`. Two
vitest suites, run against `@kumiai/rpc`'s own test doubles and against `@kumiai/mls-rpc`'s real
implementation over live MLS.

## The rule

**Every implementation of these ports passes this suite, and so does every double that stands in for
one.** Not a nicety — it is why the package exists. A double that answers where its real port
refuses hides a production defect behind a green suite: the code under test is exercised against a
world that is more permissive than the one it will run in, so the bug it has cannot fail.

That is not hypothetical here. Six defects in one session had exactly that root cause, and the worst
two made the app lane fail to deliver a single message over real MLS while 288 tests stayed green —
the fake's `unwrap` was a pure XOR where the real one spends a ratchet key. Every clause in this
package is one of those, or something found by running the two implementations against each other. A
clause only one side can pass is a divergence, and finding one is the point.

## Exports

- `testGroupCryptoConformance({ label, createGroup })`
- `testGroupMLSConformance({ label, createGroup })`

`label` prefixes the describe block, so a failure names the implementation it came from.
`createGroup(size, id)` is called once per case, with a unique `id` so an implementation keyed by
group id gets a clean one.

`vitest` is a peer dependency: the suites call `describe`/`test`/`expect` directly, so they run
inside the caller's own vitest run.

## Both suites take a harness, not an implementation

A `GroupCrypto` on its own cannot be asked what happens at another epoch — moving between epochs is
`GroupMLS`'s job, and on a real handle it is a whole MLS commit. So each suite asks for a *group* it
can rotate. The `GroupCrypto` harness returns the members plus `advance()` (every member moves one
epoch) and `removeMember(index)` (everyone moves but the one dropped, which holds its last epoch for
life) — the removal boundary *is* the epoch boundary this port is asked about, which is why it is a
separate operation from a bare advance. The `GroupMLS` harness returns the members plus a
`committerDID` outside them and a `buildCommit()` that frames at the current epoch and advances only
the author, so `processCommit` is only ever asked about a *received* commit — the case the port's
contract is about, and the one the memory double got wrong. `buildExternalCommit` is optional: an
implementation with no way to build a rejoin says so by omitting it, and the two external clauses
are skipped rather than faked.

```ts
import { testGroupCryptoConformance } from '@kumiai/rpc-conformance'

testGroupCryptoConformance({
  label: 'createGroupCrypto over a real GroupHandle',
  createGroup: async (size, id) => {
    /* ... */
  },
})
```

## The port shapes are re-declared structurally, on purpose

`ConformanceGroupCrypto` and `ConformanceGroupMLS` are written out here rather than imported from
`@kumiai/rpc`, because `@kumiai/rpc`'s own suite runs this over its doubles and the import would put
a cycle in the package graph. Structural typing means a real port satisfies them without a cast.

What keeps the copies honest is a pair of assignments in each caller's test file, checked by the
compiler rather than by eye — and they run **both ways**:

```ts
const _mlsIsAPort = (mls: GroupMLS): ConformanceMLSMember['mls'] => mls
const _mlsCoversPort = (mls: ConformanceMLSMember['mls']): GroupMLS => mls
```

The first says the suite asks for nothing the port lacks. The second is the tripwire: it fails to
compile the moment a port grows a member the conformance shape does not carry. Without it the gap is
invisible by construction — a port member with no clause produces no failure — and it was real:
eight of `GroupMLS`'s twelve members had no contract at all, across the recovery and ledger lanes,
which carry the group's whole authority state.
