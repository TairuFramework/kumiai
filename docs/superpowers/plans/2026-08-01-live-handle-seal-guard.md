# Live-handle seal guard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** executing
**Mode:** tasks

**Goal:** Turn the incidental guard on `GroupCrypto.wrap` following the live handle into a deliberate one, and cover restart-then-author against real MLS, which nothing does today.

**Architecture:** Two tests, no source changes. The first is a unit test in `packages/mls-rpc` that states the `wrap` property directly and is gated by a mutation. The second is an integration test in `tests/integration` that composes the real port, the real peer and a real restart on the author path.

**Tech Stack:** TypeScript, vitest, `@kumiai/mls` (real MLS over ts-mls), `@kumiai/mls-rpc`, `@kumiai/rpc`, the wire hub fixture in `tests/integration/test/log-hub-over-wire.ts`.

**Spec:** `docs/superpowers/specs/2026-08-01-live-handle-seal-guard-design.md`

## Global Constraints

- **No source changes.** `crypto.ts`, `mls.ts`, `peer.ts` and every other `src/` file are untouched by this branch. The only edits to source are temporary mutations that are reverted within the same task.
- **No changeset.** Test-only branch, no published behaviour changes.
- **The two incidental guards stay.** `crypto.test.ts`'s "unwrap refuses every epoch but the handle current one" (`:201`) and the `frameEpoch` test (`:317`) are not edited, renamed, or absorbed. Task 1 adds beside them.
- **`pnpm run <script>` is intercepted by a local shim on this machine.** Use the exact commands written in each step (`pnpm exec vitest`, `pnpm exec tsc`), never `pnpm run test`.
- **Record, never discard.** If a mutation gate does not bite, write down why in the plan file under the task and continue. Do not delete the test.
- `docs/agents/plans/next/2026-07-31-mls-rpc-author-path-stale-handle-reseal.md` is already deleted (commit `db57d4b`). The completed record carrying the probe table is the `kigu:complete` stage's job, not a task here.

---

### Task 1: Name the `wrap` guard in `packages/mls-rpc`

`wrap`'s staleness is currently caught only as a side effect of two tests named for other
properties. This task states the property.

**Files:**
- Modify: `packages/mls-rpc/test/crypto.test.ts` — extend the `twoMemberGroup` fixture (`:23-56`) to return `publish` and `resolveLedgerEntries`, add an `addMember` helper beside it, add one test
- Modify (temporarily, reverted in step 6): `packages/mls-rpc/src/crypto.ts:100`

**Interfaces:**
- Consumes: `cryptoOver(initial: GroupHandle)` (`crypto.test.ts:59-68`) returning `{ crypto, adopt, current }`; `twoMemberGroup(groupID: string)` returning `{ alice, bob, aliceGroup, bobGroup }`.
- Produces: nothing later tasks rely on. Task 2 is independent.

- [ ] **Step 1: Extend the fixture to expose what a third member needs**

`twoMemberGroup` keeps `tokens`, `publish` and `resolveLedgerEntries` local and returns none of
them. Change only its `return` statement (`crypto.test.ts:55`):

```ts
  return { alice, bob, aliceGroup: added.newGroup, bobGroup, publish, resolveLedgerEntries }
```

- [ ] **Step 2: Add the `addMember` helper**

Insert directly after `twoMemberGroup`'s closing brace, before `cryptoOver`. `OwnIdentity` is not
yet imported in this file — extend the existing `@kokuin/token` import on line 1 to
`import { type OwnIdentity, randomIdentity } from '@kokuin/token'`.

```ts
/**
 * Add a third member to a live group, the way {@link twoMemberGroup} adds the second. Returns
 * both sides of the add: the admin's post-commit handle, which it must adopt, and the joiner's,
 * which starts life AT the new epoch and holds no key material below it.
 */
async function addMember(params: {
  group: GroupHandle
  admin: OwnIdentity
  invitee: OwnIdentity
  publish: (invite: Invite) => void
  resolveLedgerEntries: (ids: Array<string>) => Promise<Array<string>>
}): Promise<{ adminGroup: GroupHandle; joinedGroup: GroupHandle }> {
  const { invite } = await createInvite({
    group: params.group,
    identity: params.admin,
    recipientDID: params.invitee.id,
    permission: 'member',
  })
  params.publish(invite)
  const bundle = await createKeyPackageBundle(params.invitee)
  const added = await commitInvite(params.group, bundle.publicPackage, invite)
  const { group: joinedGroup } = await processWelcome({
    identity: params.invitee,
    invite,
    welcome: added.welcomeMessage,
    keyPackageBundle: bundle,
    ratchetTree: added.newGroup.state.ratchetTree,
    options: { resolveLedgerEntries: params.resolveLedgerEntries },
  })
  return { adminGroup: added.newGroup, joinedGroup }
}
```

Every symbol it uses (`createInvite`, `createKeyPackageBundle`, `commitInvite`, `processWelcome`,
`GroupHandle`, `Invite`) is already imported at the top of the file.

- [ ] **Step 3: Write the test**

Add it inside the `describe('createGroupCrypto', ...)` block, immediately after the
`'wrap and unwrap round-trip and name the authenticated sender'` test (`:128-139`).

```ts
  /**
   * `wrap` reads the handle FRESH on every call, and this is the only test that says so.
   *
   * The defect it excludes is the one `GroupCryptoParams.handle`'s doc comment names: a `wrap`
   * that captured `handle()`'s return once would keep sealing against the pre-commit epoch's
   * secrets forever, and nothing about a successful seal reveals which epoch it targeted.
   *
   * CAROL, not a Bob who applied the same commit, is what makes the assertion decisive. `unwrap`
   * opens a bounded window BELOW the live epoch out of ts-mls's retained key material — this
   * port's own documented divergence from the fake (see the header comment in `../src/crypto.ts`)
   * — so a member who walked from 1 to 2 might still open an epoch-1 frame and let a stale seal
   * pass. Carol starts at epoch 2 and holds nothing below it, so her open is possible only if the
   * seal really targeted the epoch Alice adopted.
   */
  test('wrap seals at the LIVE handle: a member that adopted seals at the epoch it adopted', async () => {
    const {
      alice: aliceID,
      aliceGroup,
      bobGroup,
      publish,
      resolveLedgerEntries,
    } = await twoMemberGroup('ports-wrap-live-handle')
    const alice = cryptoOver(aliceGroup)
    const bob = cryptoOver(bobGroup)
    expect(alice.crypto.epoch()).toBe(1)

    const { adminGroup, joinedGroup } = await addMember({
      group: aliceGroup,
      admin: aliceID,
      invitee: randomIdentity(),
      publish,
      resolveLedgerEntries,
    })
    alice.adopt(adminGroup)
    const carol = cryptoOver(joinedGroup)
    expect(alice.crypto.epoch()).toBe(2)
    expect(carol.crypto.epoch()).toBe(2)

    const sealed = await alice.crypto.wrap(utf8.encode('after the adopt'))

    const opened = await carol.crypto.unwrap(sealed)
    expect(new TextDecoder().decode(opened.payload)).toBe('after the adopt')
    expect(opened.senderDID).toBe(aliceID.id)

    // And Bob, who never applied the add, is left below it — the frame is not readable by the
    // epoch the stale handle would have sealed at either.
    expect(bob.crypto.epoch()).toBe(1)
    await expect(bob.crypto.unwrap(sealed)).rejects.toThrow()
  })
```

- [ ] **Step 4: Run the test and the type check**

```bash
cd packages/mls-rpc
pnpm exec vitest run test/crypto.test.ts -t 'wrap seals at the LIVE handle'
pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json
```

Expected: PASS, and the type check silent. This is a guard on behaviour that is already correct,
so a pass here proves nothing yet — step 5 is what earns the test.

If the run fails, do not weaken the assertions. Read the failure: an epoch that is not 2 means the
fixture's group is not where this plan assumes, and that is worth reporting rather than patching
around.

- [ ] **Step 5: Apply the mutation and watch it bite**

Edit `packages/mls-rpc/src/crypto.ts:100` from:

```ts
    wrap: (bytes) => handle().encrypt(bytes),
```

to:

```ts
    wrap: ((stale) => (bytes: Uint8Array) => stale.encrypt(bytes))(handle()),
```

Then:

```bash
pnpm exec vitest run test/crypto.test.ts -t 'wrap seals at the LIVE handle'
```

Expected: FAIL. Carol cannot open a frame sealed at epoch 1.

If it PASSES, the test does not guard what it claims — stop, and report that rather than
continuing. (The whole-file run will also show two pre-existing failures under this mutation, at
`:201` and `:317`; those are expected and are not this test.)

- [ ] **Step 6: Revert the mutation and confirm green**

```bash
git checkout packages/mls-rpc/src/crypto.ts
git status --short   # must show no change under packages/mls-rpc/src/
pnpm exec vitest run
pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json
```

Expected: whole `mls-rpc` suite passes, type check silent.

- [ ] **Step 7: Lint and commit**

```bash
cd ../..
pnpm exec biome check --write ./packages/mls-rpc
git add packages/mls-rpc/test/crypto.test.ts
git commit -m "test(mls-rpc): wrap seals at the live handle, said out loud

The property was guarded only as a side effect of two tests named for other
things — unwrap's epoch refusal and frameEpoch reading cleartext — so an edit
preserving either one's stated intent could have dropped it silently.

Carol rather than a Bob who applied the same commit: unwrap opens a bounded
window below the live epoch out of ts-mls's retained key material, so a member
who walked from 1 to 2 might still open an epoch-1 frame. Carol starts at 2 and
holds nothing below it."
```

Verify the commit touched only `packages/mls-rpc/test/crypto.test.ts`:

```bash
git show --stat HEAD
```

---

### Task 2: Restart-then-author against real MLS

Every restart-then-author test in the repo runs against the doubles
(`packages/rpc/test/peer-first-commit-crash.test.ts:168`). Nothing exercises the path through
`createGroupCrypto` and a live `GroupHandle`.

**Files:**
- Modify: `tests/integration/test/app-lane-delivery.test.ts` — one test appended inside the existing `describe('app-lane delivery across a roster rotation, end to end', ...)` block, after the mid-walk restart test that ends at `:635`
- Modify (temporarily, reverted in step 5): `packages/mls-rpc/src/crypto.ts:100`

**Interfaces:**
- Consumes, all from `./app-lane-e2e.js` and already imported at the top of the file (`:4-19`): `buildLedgerCommit(member: Member, identity: OwnIdentity, subject: string, value: string)`, `createEntryBodies()`, `createFoundingGroup(identity, groupID, entrySlot)`, `joinFromWelcome({identity, invite, welcome, bundle, ratchetTree, entrySlot})`, `makeMember({hub, identity, group, entrySlot, handlers?, restartOf?})`, `mintInvite({admin, adminIdentity, invitee, bodies})`, `newIdentity()`, `restoreMemberHandle(member, entrySlot)`, and `type Member`. `createWireHub()` comes from `./log-hub-over-wire.js`. `flush(ms = 120)` is defined at `:19`.
- Produces: nothing.

- [ ] **Step 1: Write the test**

Alice is the member that restarts, not Bob. Only an admin may author a ledger or remove commit
(`tests/integration/test/mls-permissions.test.ts:215-222` — "commitWithEntries requires the
committer be an admin"), and Bob holds `member`. Alice is the founding admin.

```ts
  /**
   * A RESTARTED member that AUTHORS, over real MLS: the admin dies, comes back over its persisted
   * state, and the first thing the second process does is commit — rather than only catching up on
   * somebody else's commits, which is every other restart test in this file.
   *
   * The distinction is not cosmetic. A received commit is applied by `processMessage`, which
   * mutates the handle IN PLACE; an authored one produces a NEW handle object that the peer swaps
   * in from `onAccepted`. Only the second path replaces the reference `createGroupCrypto` reads,
   * which is the event `GroupCryptoParams.handle` is a function to survive. Nothing else in the
   * repo reaches it against a real ratchet.
   *
   * A LEDGER commit, so the roster does not change and the app-lane anchor does not rotate: the
   * group stays on one topic across the epoch change, and what is under test is the seal, not the
   * topic derivation (which `peer-anchor-*` already covers).
   */
  test('a restarted admin authors its own commit and seals at the epoch it adopted', async () => {
    const hub = createWireHub()
    const bodies = createEntryBodies()
    const { createLedgerEntrySlot } = await import('@kumiai/mls-rpc')
    const { commitInvite } = await import('@kumiai/mls')

    const aliceID = newIdentity()
    const bobID = newIdentity()
    const aliceSlot = createLedgerEntrySlot()
    const bobSlot = createLedgerEntrySlot()
    for (const slot of [aliceSlot, bobSlot]) {
      slot.install(async (ids) =>
        ids.map((id) => {
          const token = bodies.get(id)
          if (token == null) throw new Error(`unknown ledger entry ${id}`)
          return token
        }),
      )
    }

    let aliceHandle = await createFoundingGroup(aliceID, 'restart-then-author-e2e', aliceSlot)
    const material = await mintInvite({
      admin: aliceHandle,
      adminIdentity: aliceID,
      invitee: bobID,
      bodies,
    })
    const added = await commitInvite(aliceHandle, material.bundle.publicPackage, material.invite)
    aliceHandle = added.newGroup
    const bobHandle = await joinFromWelcome({
      identity: bobID,
      invite: material.invite,
      welcome: added.welcomeMessage,
      bundle: material.bundle,
      ratchetTree: aliceHandle.state.ratchetTree,
      entrySlot: bobSlot,
    })

    const seen: Array<unknown> = []
    const bob = makeMember({
      hub,
      identity: bobID,
      group: bobHandle,
      entrySlot: bobSlot,
      handlers: {
        'chat/posted': (ctx: { data: unknown }) => void seen.push(ctx.data),
      },
    })
    let alice: Member = makeMember({
      hub,
      identity: aliceID,
      group: aliceHandle,
      entrySlot: aliceSlot,
    })
    await flush()
    expect(alice.handle().epoch).toBe(1n)

    // The process dies: the peer stops and the socket goes with it.
    await alice.peer.dispose()
    await alice.disconnect()

    const restoredHandle = await restoreMemberHandle(alice, aliceSlot)
    alice = makeMember({
      hub,
      identity: aliceID,
      group: restoredHandle,
      entrySlot: aliceSlot,
      restartOf: alice,
    })
    await flush()
    expect(alice.handle().epoch).toBe(1n)

    // The second process's FIRST act is to author, not to catch up.
    const result = await alice.peer.commit(
      buildLedgerCommit(alice, aliceID, 'did:key:subject-after-restart', 'member'),
    )
    expect(result.lost).toBeUndefined()
    await flush()
    expect(alice.handle().epoch).toBe(2n)

    // And it seals at the epoch it just adopted: Bob, who applied the same commit, opens it.
    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'authored after a restart' })
    await flush(400)

    expect(bob.handle().epoch).toBe(2n)
    expect(seen).toEqual([{ text: 'authored after a restart' }])

    await alice.peer.dispose()
    await bob.peer.dispose()
    await hub.dispose()
  })
```

- [ ] **Step 2: Run it**

```bash
cd tests/integration
pnpm exec vitest run test/app-lane-delivery.test.ts -t 'a restarted admin authors its own commit'
```

Expected: PASS.

If it fails on `seen` being empty while every epoch assertion holds, the frame needs longer than
`flush(400)` on this machine — raise that single wait and note the value used. Do not relax the
`toEqual` into a `toContain` or drop an epoch assertion to make it green: an empty `seen` with the
epochs right is a delivery-timing failure, and an epoch that is not `2n` is not.

- [ ] **Step 3: Type check**

```bash
pnpm exec tsc --noEmit --skipLibCheck
```

Expected: silent.

- [ ] **Step 4: Run the whole integration suite**

```bash
pnpm exec vitest run
```

Expected: all pass. This test shares a hub fixture family with its neighbours, so a green single
test and a red suite is the interesting failure.

- [ ] **Step 5: Attempt the mutation, and record the outcome either way**

The spec expects this test to bite on no mutation — the `wrap` snapshot already fails two OTHER
tests in this same file. Attempt it anyway; the point is the recorded answer, not the pass.

Apply the same mutation as Task 1 step 5 to `packages/mls-rpc/src/crypto.ts:100`, then rebuild
(the integration suite imports `@kumiai/mls-rpc` from `lib/`, not `src/`) and run:

```bash
cd ../../packages/mls-rpc && pnpm exec swc src -d ./lib --config-file ../../node_modules/@kigu/dev/swc.json --strip-leading-paths
cd ../../tests/integration && pnpm exec vitest run test/app-lane-delivery.test.ts
```

Then revert and rebuild from clean source:

```bash
cd ../.. && git checkout packages/mls-rpc/src/crypto.ts
cd packages/mls-rpc && pnpm exec swc src -d ./lib --config-file ../../node_modules/@kigu/dev/swc.json --strip-leading-paths
cd ../.. && git status --short   # must show no change under packages/
```

Write the outcome into this plan file, under this step, in one of these two forms:

- "Mutation caught by the new test as well as the two pre-existing ones (N failures). The new
  test's failure is not evidence of anything it uniquely guards."
- "Mutation caught only by the pre-existing tests at `:5xx`/`:6xx`; the new test passed under it.
  Kept per the spec: its value is composing the real port, the real peer and a real restart on the
  author path, which nothing else does."

**Recorded result:** Mutation caught by the new test as well as the two pre-existing ones (3
failures). The new test's failure is not evidence of anything it uniquely guards.

- [ ] **Step 6: Lint and commit**

```bash
cd /Users/paul/dev/yulsi/kumiai
pnpm exec biome check --write ./tests
git add tests/integration/test/app-lane-delivery.test.ts docs/superpowers/plans/2026-08-01-live-handle-seal-guard.md
git commit -m "test(integration): a restarted admin authors, and seals where it landed

Every restart-then-author test in the repo runs against the doubles. This walks
it through createGroupCrypto and a live GroupHandle: the admin dies, restores,
and the second process's first act is a commit rather than a catch-up.

A received commit is applied in place; an authored one produces a new handle the
peer swaps in from onAccepted, which is the event GroupCryptoParams.handle is a
function to survive. A ledger commit keeps the roster still, so the anchor does
not rotate and the seal is what is under test."
```

Verify the commit touched no source:

```bash
git show --stat HEAD
```

---

## Verification before review

```bash
cd /Users/paul/dev/yulsi/kumiai
git diff main --stat            # tests and docs only, no packages/*/src/
pnpm exec biome check ./packages ./tests
pnpm exec turbo run test:types test:unit --force
cd tests/integration && pnpm exec vitest run
```

`--force` matters: a cached turbo result reports green without running anything. Confirm the
summary line reads `Cached: 0`.

## Notes for the completing stage

The completed record must carry section 1 of the spec — the probe table, the two incidental guards
it found, and `peer-first-commit-crash.test.ts:168` — plus Task 2 step 5's recorded result, so the
next reader who wonders about stale handles finds the answer instead of re-running the probes.
