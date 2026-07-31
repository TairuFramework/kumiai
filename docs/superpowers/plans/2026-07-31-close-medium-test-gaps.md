# Close the Medium Test Gaps — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the Medium section of `docs/agents/plans/next/2026-07-07-test-gaps.md` — five audit entries, seven pieces of work — leaving each entry either a mutation-verified test or a recorded "already covered by X".

**Architecture:** Test-only branch. Each task follows the same three-beat protocol: probe (mutate the source, confirm the suite stays green, proving the gap is real), write (the test, against unmutated source), re-mutate (confirm the new test fails decisively, then restore). No source changes except the one conditional fix in Task 5, which only lands if its probe exposes a live defect.

**Tech Stack:** TypeScript, vitest, pnpm workspaces, turbo. Packages: `@kumiai/mls`, `@kumiai/hub-tunnel`, `@kumiai/rpc`, `@kumiai/integration-tests`.

**Spec:** `docs/superpowers/specs/2026-07-31-test-gaps-design.md`

**Branch:** `test/close-medium-test-gaps` (already created; the spec commit is `a172380`).

## Global Constraints

- **pnpm only.** Never `npm` or `yarn`.
- **Run vitest and tsc directly, not through `pnpm run`.** An `rtk` shim on this machine intercepts `pnpm run <script>` and redirects it to the wrong tool. Every command in this plan uses `pnpm --filter <pkg> exec <tool>`, which bypasses the shim. The one exception is lint, which must be run as `rtk proxy pnpm run lint`.
- **Every vitest step is paired with a typecheck step.** vitest strips types at transform time, so a green vitest run proves nothing about the types in code this plan wrote. `tsc --noEmit -p tsconfig.test.json` is the only thing that does.
- **Never edit `lib/`.** Generated output.
- **A mutation is temporary.** Every task that mutates source restores it with `git checkout -- <path>` before committing. A task must never commit a mutated source file. Verify with `git status` before every commit.
- **A probe that comes back RED is a valid, expected outcome.** It means the gap is already covered. Do not write the test. Record the covering test's `file:line` in the task's commit message and in the doc update (Task 8), and move on.
- **Test file naming:** kebab-case, `.test.ts`, in the package's `test/` directory.
- **Commit style:** conventional commits, `test:` prefix for test-only commits, `fix:` for the conditional Task 5 fix. End every commit message body with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

## File Structure

| File | Status | Responsibility |
|------|--------|----------------|
| `packages/mls/test/commit-rejected-payload.test.ts` | Create | Asserts `CommitRejectedError` carries the rejected commit's proposals and sender leaf index, on both the default-policy and caller-policy paths. |
| `packages/mls/test/handle-concurrency.test.ts` | Create | Asserts `GroupHandle` serializes `encrypt` against `processMessage` on one handle. |
| `packages/hub-tunnel/test/transport-teardown.test.ts` | Create | Asserts the local teardown path publishes `session-end` and calls `hub.unsubscribe`, on both the `dispose()` and abort-signal paths. |
| `packages/rpc/test/peer-dispose-race.test.ts` | Create | Asserts `dispose()` wins two races: against a queued commit-tail rebuild, and against an establishing directed `to()` session. |
| `tests/integration/test/hub-tunnel-echo.test.ts` | Modify | Re-homed from `createInMemoryHub()` onto the real hub-server wire. |
| `tests/integration/test/app-lane-delivery.test.ts` | Modify | Gains a test that a restored handle *seals* at the epoch it walked to. |
| `packages/rpc/src/peer.ts` | Modify (conditional) | A `disposed` check in `withReady` — only if Task 5's probe exposes the defect. |
| `docs/agents/plans/next/2026-07-07-test-gaps.md` | Modify | Medium section retired, each entry recorded with its outcome. |

New test files rather than growing existing ones: `group.test.ts` is over three thousand lines, and `transport-lifecycle.test.ts` covers interruption-raising, which is a different contract from teardown publication.

---

### Task 1: `CommitRejectedError` payload — default policy path

**Files:**
- Create: `packages/mls/test/commit-rejected-payload.test.ts`
- Probe target: `packages/mls/src/group-handle.ts:1003-1006`

**Interfaces:**
- Consumes: `createGroup`, `createInvite`, `createKeyPackageBundle`, `commitInvite`, `processWelcome`, `CommitRejectedError` from `../src/group.js`; `ledgerEntryDigest` from `../src/ledger.js`; `createCommit`, `defaultProposalTypes`, `encode`, `mlsMessageEncoder` from `ts-mls`.
- Produces: local helpers `twoMemberGroup(groupID)` and `addCommitBytes(group, keyPackage)` used again by Task 2 in the same file.

- [ ] **Step 1: Probe — mutate the throw site**

Edit `packages/mls/src/group-handle.ts:1003-1006`. Replace:

```typescript
        throw new CommitRejectedError(
          capture.rejected?.proposals ?? [],
          capture.rejected?.senderLeafIndex,
        )
```

with:

```typescript
        throw new CommitRejectedError([], undefined)
```

- [ ] **Step 2: Run the mls suite and confirm it stays green**

Run: `pnpm --filter @kumiai/mls exec vitest run`
Expected: PASS, all files. Green confirms the gap — no existing test reads a field off the caught error.

If it FAILS: the gap is already covered. Note which test failed, restore the source with `git checkout -- packages/mls/src/group-handle.ts`, skip to Step 8, and record "already covered by `<file:line>`" instead of writing the test.

- [ ] **Step 3: Restore the source**

Run: `git checkout -- packages/mls/src/group-handle.ts`
Then: `git status` — expected: clean.

- [ ] **Step 4: Write the test file**

Create `packages/mls/test/commit-rejected-payload.test.ts`:

```typescript
import { normalizeDID, randomIdentity } from '@kokuin/token'
import { createCommit, defaultProposalTypes, encode, mlsMessageEncoder } from 'ts-mls'
import { describe, expect, test } from 'vitest'

import {
  CommitRejectedError,
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  processWelcome,
} from '../src/group.js'
import { ledgerEntryDigest } from '../src/ledger.js'
import type { Invite } from '../src/types.js'

/**
 * Alice (admin) plus bob (member), sharing a ledger-entry resolver. The same shape
 * `app-message.test.ts` uses — repeated rather than shared, because a helper that grows a
 * parameter for every caller is worse than two short ones.
 */
async function twoMemberGroup(groupID: string) {
  const alice = randomIdentity()
  const bob = randomIdentity()
  const tokens = new Map<string, string>()
  const resolveLedgerEntries = async (ids: Array<string>) =>
    ids.map((id) => {
      const token = tokens.get(id)
      if (token == null) throw new Error(`unknown ledger entry ${id}`)
      return token
    })
  const publish = (invite: Invite) => {
    for (const token of invite.ledgerEntries) tokens.set(ledgerEntryDigest(token), token)
  }

  const { group: created } = await createGroup(alice, groupID, { resolveLedgerEntries })
  const { invite } = await createInvite({
    group: created,
    identity: alice,
    recipientDID: bob.id,
    permission: 'member',
  })
  publish(invite)
  const bundle = await createKeyPackageBundle(bob)
  const added = await commitInvite(created, bundle.publicPackage, invite)
  const { group: bobGroup } = await processWelcome({
    identity: bob,
    invite,
    welcome: added.welcomeMessage,
    keyPackageBundle: bundle,
    ratchetTree: added.newGroup.state.ratchetTree,
    options: { resolveLedgerEntries },
  })
  return { alice, bob, aliceGroup: added.newGroup, bobGroup, resolveLedgerEntries }
}

/**
 * A raw Add commit, built past `commitInvite`'s admin guard — it stands in for a client that
 * skipped that guard, so the RECEIVING side has to reject it on its own.
 */
async function addCommitBytes(
  group: { context: unknown; state: unknown },
  keyPackage: unknown,
): Promise<Uint8Array> {
  const result = await createCommit({
    context: group.context as Parameters<typeof createCommit>[0]['context'],
    state: group.state as Parameters<typeof createCommit>[0]['state'],
    extraProposals: [
      {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: keyPackage as never },
      },
    ] as Parameters<typeof createCommit>[0]['extraProposals'],
  })
  return encode(mlsMessageEncoder, result.commit)
}

/**
 * Every other CommitRejectedError test in this package asserts `instanceof` or `toThrow`, so
 * nothing reads a field off the caught error and the capture could regress to an empty object
 * undetected. These two read the fields.
 */
describe('CommitRejectedError carries the rejected commit', () => {
  test('the default policy path captures proposals and the sender leaf index', async () => {
    const { bob, aliceGroup, bobGroup } = await twoMemberGroup('rejected-payload-default')
    const carol = randomIdentity()
    const carolKP = await createKeyPackageBundle(carol)
    const bobCommit = await addCommitBytes(bobGroup, carolKP.publicPackage)

    // `rejects.toThrow` cannot reach the fields — the whole point here is the caught object.
    expect.assertions(4)
    try {
      await aliceGroup.processMessage(bobCommit)
    } catch (error) {
      expect(error).toBeInstanceOf(CommitRejectedError)
      const rejected = error as CommitRejectedError
      expect(rejected.proposals).toHaveLength(1)
      expect(rejected.proposals[0]?.proposal.proposalType).toBe('add')
      // Bob is the second leaf: alice created the group, bob was added to it.
      expect(rejected.senderLeafIndex).toBe(1)
    }
    // Silences the unused-binding lint on `bob` while asserting the fixture is what it claims.
    expect(normalizeDID(bob.id)).toBeTypeOf('string')
  })
})
```

Note on `rejected.proposals[0]?.proposal.proposalType`: `ProposalWithSender` is a ts-mls type. If the shape turns out to be `proposals[0].proposalType` or the value a numeric enum rather than the string `'add'`, adjust the assertion to whatever the run reports — but assert the *specific* proposal type, never just `toBeDefined()`. A field asserted only as "present" is the regression this test exists to catch.

Note on `expect.assertions(4)`: raise it to 5 to account for the trailing `normalizeDID` assertion if you keep that line; drop the line and leave it at 4 if `bob` is otherwise used. Whichever you pick, the count must match the assertions actually reached, or the guard is decorative.

- [ ] **Step 5: Run the new test and confirm it passes**

Run: `pnpm --filter @kumiai/mls exec vitest run test/commit-rejected-payload.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @kumiai/mls exec tsc --noEmit --skipLibCheck -p tsconfig.test.json`
Expected: no output, exit 0.

- [ ] **Step 7: Re-mutate and confirm the new test bites**

Apply the Step 1 mutation again, then run:
`pnpm --filter @kumiai/mls exec vitest run test/commit-rejected-payload.test.ts`
Expected: FAIL, with a message naming the payload — e.g. `expected [] to have a length of 1 but got 0`.

A failure message that does not name the payload means the test is failing for the wrong reason. Investigate before continuing.

Then restore: `git checkout -- packages/mls/src/group-handle.ts`, re-run, expected: PASS.

- [ ] **Step 8: Commit**

```bash
git status   # confirm packages/mls/src/group-handle.ts is NOT modified
git add packages/mls/test/commit-rejected-payload.test.ts
git commit -m "$(cat <<'EOF'
test(mls): assert CommitRejectedError carries the rejected commit

Every existing use is instanceof or toThrow, so nothing read a field off
the caught error and the capture could have regressed to an empty object
undetected. Mutation-verified: throwing CommitRejectedError([], undefined)
fails this test and nothing else in the suite.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `CommitRejectedError` payload — caller policy path

**Files:**
- Modify: `packages/mls/test/commit-rejected-payload.test.ts` (append a second test to the existing describe)
- Probe target: `packages/mls/src/group-handle.ts:100-114` (`wrapCommitPolicy`)

**Interfaces:**
- Consumes: `twoMemberGroup` and `addCommitBytes` from Task 1, same file. `GroupOptions.commitPolicy` from `../src/types.js:40`.
- Produces: nothing later tasks depend on.

Task 1 covers the default-policy path. This covers the caller-policy path — `wrapCommitPolicy` at `group-handle.ts:816` wraps the combined default-plus-caller callback, and a regression that only broke the caller's `'reject'` branch would slip past Task 1.

- [ ] **Step 1: Probe — mutate the capture**

Edit `packages/mls/src/group-handle.ts`, inside `wrapCommitPolicy`. Replace:

```typescript
    if (action === 'reject' && incoming.kind === 'commit') {
```

with:

```typescript
    if (false && action === 'reject' && incoming.kind === 'commit') {
```

(Biome will object to the constant condition; that is fine for a probe that is about to be reverted. If it blocks the run outright, use `if (action === 'REJECT_NEVER_MATCHES' && incoming.kind === 'commit') {` instead.)

- [ ] **Step 2: Run the mls suite excluding Task 1's file**

Run: `pnpm --filter @kumiai/mls exec vitest run --exclude test/commit-rejected-payload.test.ts`
Expected: PASS. Task 1's file is excluded because it already covers this seam via the default path — the question here is whether anything *else* did.

If it FAILS: record the covering test, restore, skip to Step 7.

- [ ] **Step 3: Restore the source**

Run: `git checkout -- packages/mls/src/group-handle.ts`, then `git status` — expected: clean.

- [ ] **Step 4: Append the second test**

Add to `packages/mls/test/commit-rejected-payload.test.ts`, inside the existing `describe` block, after the first test:

```typescript
  test('a caller commit policy rejecting captures the same payload', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const tokens = new Map<string, string>()
    const resolveLedgerEntries = async (ids: Array<string>) =>
      ids.map((id) => {
        const token = tokens.get(id)
        if (token == null) throw new Error(`unknown ledger entry ${id}`)
        return token
      })

    // A policy that refuses every incoming commit. It replaces nothing: `wrapCommitPolicy`
    // wraps the COMBINED default-plus-caller callback, so this exercises the caller branch of
    // the same capture the default path uses.
    const commitPolicy = () => 'reject' as const

    const { group: created } = await createGroup(alice, 'rejected-payload-caller', {
      resolveLedgerEntries,
    })
    const { invite } = await createInvite({
      group: created,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    for (const token of invite.ledgerEntries) tokens.set(ledgerEntryDigest(token), token)
    const bundle = await createKeyPackageBundle(bob)
    const added = await commitInvite(created, bundle.publicPackage, invite)
    // Bob joins with the refusing policy in place, so HIS handle rejects what alice commits.
    const { group: bobGroup } = await processWelcome({
      identity: bob,
      invite,
      welcome: added.welcomeMessage,
      keyPackageBundle: bundle,
      ratchetTree: added.newGroup.state.ratchetTree,
      options: { resolveLedgerEntries, commitPolicy },
    })

    const carol = randomIdentity()
    const carolKP = await createKeyPackageBundle(carol)
    // Alice is admin, so this commit is valid — only the caller policy stands against it.
    const aliceCommit = await addCommitBytes(added.newGroup, carolKP.publicPackage)

    expect.assertions(4)
    try {
      await bobGroup.processMessage(aliceCommit)
    } catch (error) {
      expect(error).toBeInstanceOf(CommitRejectedError)
      const rejected = error as CommitRejectedError
      expect(rejected.proposals).toHaveLength(1)
      expect(rejected.proposals[0]?.proposal.proposalType).toBe('add')
      // Alice is the first leaf: she created the group.
      expect(rejected.senderLeafIndex).toBe(0)
    }
  })
```

If `GroupOptions.commitPolicy` is not accepted in `processWelcome`'s `options` (check `../src/types.js`), pass it wherever that package threads a `GroupOptions` — the requirement is a *caller-supplied* policy reaching `wrapCommitPolicy`, not a specific call site.

- [ ] **Step 5: Run and typecheck**

Run: `pnpm --filter @kumiai/mls exec vitest run test/commit-rejected-payload.test.ts`
Expected: PASS, 2 tests.

Run: `pnpm --filter @kumiai/mls exec tsc --noEmit --skipLibCheck -p tsconfig.test.json`
Expected: no output, exit 0.

- [ ] **Step 6: Re-mutate and confirm it bites**

Apply the Step 1 mutation, run the file, expected: FAIL on the new test with a payload-naming message. Restore with `git checkout --`, re-run, expected: PASS, 2 tests.

- [ ] **Step 7: Commit**

```bash
git status   # confirm no src file is modified
git add packages/mls/test/commit-rejected-payload.test.ts
git commit -m "$(cat <<'EOF'
test(mls): cover the caller-policy branch of the commit capture

wrapCommitPolicy wraps the combined default-plus-caller callback, so a
regression confined to the caller's reject branch would slip past the
default-path test. Mutation-verified against the capture guard.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Interleaved `encrypt` and `processMessage` on one `GroupHandle`

**Files:**
- Create: `packages/mls/test/handle-concurrency.test.ts`
- Probe target: `packages/mls/src/group-handle.ts:617-620` (`encrypt`'s `mutexFor(this).run`)

**Interfaces:**
- Consumes: the same `twoMemberGroup` shape as Task 1 (repeated in this file — do not import across test files). `GroupHandle.encrypt`, `GroupHandle.decrypt`, `GroupHandle.processMessage`, `GroupHandle.epoch`.
- Produces: nothing later tasks depend on.

`mutex.test.ts` covers the mutex in isolation. Nothing covers the handle that depends on it.

**This task has a documented abort condition.** `encrypt`'s body may not await between reading `#state` and using it, in which case removing the mutex is unobservable from outside and Step 6 cannot make the test bite. If that happens, the honest outcome is no test — see Step 6.

- [ ] **Step 1: Probe — remove the mutex from `encrypt`**

Edit `packages/mls/src/group-handle.ts:617-620`. The current shape is:

```typescript
  async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
    return mutexFor(this).run(async () => {
```

Change it to run the body unserialized:

```typescript
  async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
    return (async () => {
```

and adjust the matching closing `})` to `})()`. Read the whole method first so the brace edit is exact.

- [ ] **Step 2: Run the mls suite and confirm it stays green**

Run: `pnpm --filter @kumiai/mls exec vitest run`
Expected: PASS. Green confirms the gap.

If it FAILS: already covered. Record, restore, skip to Step 7.

- [ ] **Step 3: Restore the source**

Run: `git checkout -- packages/mls/src/group-handle.ts`, then `git status` — expected: clean.

- [ ] **Step 4: Write the test**

Create `packages/mls/test/handle-concurrency.test.ts`:

```typescript
import { randomIdentity } from '@kokuin/token'
import { describe, expect, test } from 'vitest'

import {
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  processWelcome,
  removeMember,
} from '../src/group.js'
import { ledgerEntryDigest } from '../src/ledger.js'
import type { Invite } from '../src/types.js'

const utf8 = new TextEncoder()

async function threeMemberGroup(groupID: string) {
  const alice = randomIdentity()
  const bob = randomIdentity()
  const carol = randomIdentity()
  const tokens = new Map<string, string>()
  const resolveLedgerEntries = async (ids: Array<string>) =>
    ids.map((id) => {
      const token = tokens.get(id)
      if (token == null) throw new Error(`unknown ledger entry ${id}`)
      return token
    })
  const publish = (invite: Invite) => {
    for (const token of invite.ledgerEntries) tokens.set(ledgerEntryDigest(token), token)
  }

  const { group: created } = await createGroup(alice, groupID, { resolveLedgerEntries })
  let aliceGroup = created

  const join = async (identity: ReturnType<typeof randomIdentity>) => {
    const { invite } = await createInvite({
      group: aliceGroup,
      identity: alice,
      recipientDID: identity.id,
      permission: 'member',
    })
    publish(invite)
    const bundle = await createKeyPackageBundle(identity)
    const added = await commitInvite(aliceGroup, bundle.publicPackage, invite)
    const { group } = await processWelcome({
      identity,
      invite,
      welcome: added.welcomeMessage,
      keyPackageBundle: bundle,
      ratchetTree: added.newGroup.state.ratchetTree,
      options: { resolveLedgerEntries },
    })
    aliceGroup = added.newGroup
    return { group, commit: added }
  }

  const bobJoined = await join(bob)
  const carolJoined = await join(carol)
  // Bob joined before carol, so bob's handle has not seen carol's add commit yet.
  await bobJoined.group.processMessage(carolJoined.commit.commitMessage)

  return {
    alice,
    bob,
    carol,
    aliceGroup,
    bobGroup: bobJoined.group,
    carolGroup: carolJoined.group,
  }
}

/**
 * `mutex.test.ts` covers the mutex in isolation. This covers the handle that depends on it:
 * an `encrypt` fired against an in-flight `processMessage` must see one epoch's state, not a
 * half-swapped one.
 */
describe('GroupHandle serializes concurrent operations', () => {
  test('an encrypt racing an inbound commit seals at exactly one epoch', async () => {
    const { aliceGroup, bobGroup, carolGroup } = await threeMemberGroup('handle-concurrency')

    // Alice removes carol: a commit that advances bob's epoch when he applies it.
    const removal = await removeMember(aliceGroup, carolGroup.identityOf?.(0) ?? '')
    const epochBefore = bobGroup.epoch

    // Both fired against ONE handle with no await between them. Serialized, the encrypt runs
    // wholly before or wholly after the commit applies, and either way seals under one epoch's
    // secrets. Unserialized, it can read `#state` on one side of the swap and use it on the other.
    const applying = bobGroup.processMessage(removal.commitMessage)
    const sealing = bobGroup.encrypt(utf8.encode('racing the commit'))
    const [, sealed] = await Promise.all([applying, sealing])

    expect(bobGroup.epoch).toBe(epochBefore + 1n)

    // The decisive assertion: alice can open it. A frame sealed across a torn state opens under
    // neither epoch, so this fails loudly rather than merely reporting an odd epoch number.
    const opened = await aliceGroup.decrypt(sealed)
    expect(new TextDecoder().decode(opened.message ?? opened)).toBe('racing the commit')
  })
})
```

Three things to adjust against reality when you run it:

- `removeMember`'s signature — read it in `../src/group.js` and pass carol's DID however it wants (the `carolGroup.identityOf?.(0) ?? ''` above is a placeholder for "carol's DID"; use the `carol` identity the fixture already returns: `normalizeDID(carol.id)`).
- `aliceGroup` must have applied the removal itself before it can open bob's post-commit frame. If `removeMember` returns a `newGroup`, use that for the decrypt.
- `decrypt`'s return shape — `app-message.test.ts:56` shows the real one; match it rather than the `opened.message ?? opened` hedge above.

- [ ] **Step 5: Run and typecheck**

Run: `pnpm --filter @kumiai/mls exec vitest run test/handle-concurrency.test.ts`
Expected: PASS, 1 test.

Run: `pnpm --filter @kumiai/mls exec tsc --noEmit --skipLibCheck -p tsconfig.test.json`
Expected: no output, exit 0.

- [ ] **Step 6: Re-mutate and confirm it bites — or abort**

Apply the Step 1 mutation, run the file.

**Expected: FAIL.** Restore with `git checkout --`, re-run, expected: PASS. Continue to Step 7.

**If it PASSES with the mutex removed:** the serialization is not observable at this seam, and the test proves nothing. Do not keep it. Delete `packages/mls/test/handle-concurrency.test.ts`, restore the source, and record the outcome for Task 8 as: *"interleaved encrypt/processMessage — no test. Removing `encrypt`'s mutex is unobservable from outside the handle: the body does not await between reading `#state` and using it, so there is no window to tear. Recorded rather than covered by a test that cannot fail."* Then commit nothing for this task and move to Task 4.

- [ ] **Step 7: Commit**

```bash
git status   # confirm no src file is modified
git add packages/mls/test/handle-concurrency.test.ts
git commit -m "$(cat <<'EOF'
test(mls): assert the handle serializes encrypt against an inbound commit

mutex.test.ts covers the mutex in isolation; nothing covered the handle
that depends on it. Mutation-verified: running encrypt's body off the
mutex fails this test.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: hub-tunnel teardown publishes `session-end` and unsubscribes

**Files:**
- Create: `packages/hub-tunnel/test/transport-teardown.test.ts`
- Probe target: `packages/hub-tunnel/src/transport.ts:271-277` (the `sendSessionEnd()` and `hub.unsubscribe` calls in `teardown`)

**Interfaces:**
- Consumes: `createHubTunnelTransport` from `../src/transport.js`; `decodeFrame`/`HubFrame` from `../src/frame.js`; `FakeHub` from `./fixtures/fake-hub.js`.
- Produces: nothing later tasks depend on.

The original entry claimed three uncovered things. One of them — `onSessionEnd` firing on a peer's frame — is already covered at `transport-ack.test.ts:301`. What remains is the *local* teardown path.

- [ ] **Step 1: Probe — delete both teardown effects**

Edit `packages/hub-tunnel/src/transport.ts`, inside `teardown`. Comment out these two:

```typescript
    sendSessionEnd()
    try {
      void Promise.resolve(hub.unsubscribe?.(localDID, receiveTopicID)).catch(() => {})
    } catch {
      // ignore
    }
```

- [ ] **Step 2: Run the hub-tunnel suite and confirm it stays green**

Run: `pnpm --filter @kumiai/hub-tunnel exec vitest run`
Expected: PASS.

Some ack/lifecycle tests assert `hub.subscriberCount(localDID)` drops to 0 after teardown — if those fail, they are covering the unsubscribe half. In that case narrow the mutation: restore `hub.unsubscribe`, keep only `sendSessionEnd()` commented, re-run, and cover only the half that survives green. Record which half was already covered.

- [ ] **Step 3: Restore the source**

Run: `git checkout -- packages/hub-tunnel/src/transport.ts`, then `git status` — expected: clean.

- [ ] **Step 4: Write the test**

Create `packages/hub-tunnel/test/transport-teardown.test.ts`:

```typescript
import { describe, expect, test } from 'vitest'

import { decodeFrame, type HubFrame } from '../src/frame.js'
import type { HubPublishParams, HubSubscribeOptions, MailboxHub } from '../src/transport.js'
import { createHubTunnelTransport } from '../src/transport.js'
import { FakeHub } from './fixtures/fake-hub.js'

const flush = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

type Recorder = {
  hub: MailboxHub
  published: Array<HubPublishParams>
  unsubscribed: Array<[string, string]>
}

/**
 * FakeHub with the two teardown effects recorded. Wrapping rather than reading FakeHub's
 * internals: the contract is what the transport CALLS, and a recorder states that directly.
 */
function recordingHub(): Recorder {
  const fake = new FakeHub()
  const published: Array<HubPublishParams> = []
  const unsubscribed: Array<[string, string]> = []
  const hub: MailboxHub = {
    publish: (params) => {
      published.push(params)
      return fake.publish(params)
    },
    subscribe: (subscriberDID: string, topicID: string, options?: HubSubscribeOptions) =>
      fake.subscribe(subscriberDID, topicID, options),
    unsubscribe: (subscriberDID: string, topicID: string) => {
      unsubscribed.push([subscriberDID, topicID])
      return fake.unsubscribe(subscriberDID, topicID)
    },
    receive: (subscriberDID: string) => fake.receive(subscriberDID),
  }
  return { hub, published, unsubscribed }
}

/**
 * The LOCAL teardown path. `transport-ack.test.ts:301` already covers a PEER's session-end
 * reaching `onSessionEnd`; nothing covered this side of it — that tearing down announces
 * itself and releases the subscription.
 */
describe('createHubTunnelTransport teardown', () => {
  test('dispose publishes a session-end frame and unsubscribes', async () => {
    const { hub, published, unsubscribed } = recordingHub()
    // A STRING sessionID, so `lockedSessionID` is set at construction: `sendSessionEnd` returns
    // early on a null session ID, and a transport that has seen no traffic would publish
    // nothing at all — the test would then assert against a vacuum and pass for the wrong reason.
    const transport = createHubTunnelTransport({
      hub,
      sessionID: 'teardown-dispose',
      localDID: 'did:key:local',
      sendTopicID: 'topic:out',
      receiveTopicID: 'topic:in',
    })
    await flush()

    await transport.dispose()
    await flush()

    const endFrames = published
      .filter((params) => params.topicID === 'topic:out')
      .map((params) => decodeFrame(params.payload) as HubFrame)
      .filter((frame) => frame.kind === 'session-end')
    expect(endFrames).toHaveLength(1)
    expect(endFrames[0]?.sessionID).toBe('teardown-dispose')

    expect(unsubscribed).toContainEqual(['did:key:local', 'topic:in'])
  })

  test('an aborted signal takes the same teardown path', async () => {
    const { hub, published, unsubscribed } = recordingHub()
    const controller = new AbortController()
    const transport = createHubTunnelTransport({
      hub,
      sessionID: 'teardown-abort',
      localDID: 'did:key:local',
      sendTopicID: 'topic:out',
      receiveTopicID: 'topic:in',
      signal: controller.signal,
    })
    await flush()

    controller.abort(new Error('user cancel'))
    await flush()

    const endFrames = published
      .filter((params) => params.topicID === 'topic:out')
      .map((params) => decodeFrame(params.payload) as HubFrame)
      .filter((frame) => frame.kind === 'session-end')
    expect(endFrames).toHaveLength(1)
    expect(unsubscribed).toContainEqual(['did:key:local', 'topic:in'])

    // Teardown is once-only (`torndown`), so disposing after an abort must not publish a second.
    await transport.dispose().catch(() => {})
    await flush()
    expect(
      published
        .filter((params) => params.topicID === 'topic:out')
        .map((params) => decodeFrame(params.payload) as HubFrame)
        .filter((frame) => frame.kind === 'session-end'),
    ).toHaveLength(1)
  })
})
```

If `decodeFrame` is not the exported name, read `../src/frame.js` and use whatever decodes a payload — `frame.test.ts` shows the round-trip.

- [ ] **Step 5: Run and typecheck**

Run: `pnpm --filter @kumiai/hub-tunnel exec vitest run test/transport-teardown.test.ts`
Expected: PASS, 2 tests.

Run: `pnpm --filter @kumiai/hub-tunnel exec tsc --noEmit -p tsconfig.test.json`
Expected: no output, exit 0.

- [ ] **Step 6: Re-mutate and confirm it bites**

Apply the Step 1 mutation, run the file. Expected: FAIL on both tests — `expected [] to have a length of 1 but got 0`. Restore, re-run, expected: PASS, 2 tests.

- [ ] **Step 7: Commit**

```bash
git status   # confirm no src file is modified
git add packages/hub-tunnel/test/transport-teardown.test.ts
git commit -m "$(cat <<'EOF'
test(hub-tunnel): assert teardown announces itself and unsubscribes

transport-ack.test.ts:301 already covers a peer's session-end reaching
onSessionEnd. This is the other side: dispose and abort both publish a
session-end and release the subscription, exactly once.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `dispose()` against an establishing directed `to()`

**Files:**
- Create: `packages/rpc/test/peer-dispose-race.test.ts`
- Modify (conditional): `packages/rpc/src/peer.ts:1981-1984` (`withReady`)

**Interfaces:**
- Consumes: `makeMLSPeer` from `./fixtures/peer.js`; `FakeHub` from `./fixtures/fake-hub.js`.
- Produces: the file Task 6 appends its test to.

This task comes before Task 6 because it is the one likely to change source. `withReady` (`peer.ts:1981`) awaits `ready` and has no disposed check, and `dispose()` awaits the same promise — so a `to()` queued before init settles can register a directed client into a runtime that teardown is about to walk.

- [ ] **Step 1: Probe — no mutation; ask what happens today**

Write a scratch test at `packages/rpc/test/peer-dispose-race.test.ts`:

```typescript
import { describe, expect, test } from 'vitest'

import { FakeHub } from './fixtures/fake-hub.js'
import { makeMLSPeer } from './fixtures/peer.js'

const flush = (ms = 40) => new Promise((r) => setTimeout(r, ms))
const members = ['alice', 'bob']

describe('dispose against an establishing directed session', () => {
  test('probe: what does to() do when dispose wins the race', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x81)
    const alice = makeMLSPeer(hub, 'alice', rs, { epoch: 1, members })

    // NOT awaited and NOT flushed: `to()` is queued behind `ready`, which has not settled.
    const pending = alice.peer.protocol('chat').to('bob')
    await alice.peer.dispose()

    const outcome = await pending.then(
      () => 'resolved',
      (error) => `rejected: ${(error as Error).message}`,
    )
    console.log('OUTCOME:', outcome)
    expect(outcome).toBeTypeOf('string')
  })
})
```

Run: `pnpm --filter @kumiai/rpc exec vitest run test/peer-dispose-race.test.ts`

Read the logged `OUTCOME` and note whether the process leaves anything behind (vitest reporting a hanging handle, an unhandled rejection, or an open subscription).

- [ ] **Step 2: Decide which branch this task takes**

- **If `to()` rejects** (e.g. "Peer is not started"), the contract already holds. Go to Step 3A.
- **If `to()` resolves a client** while the peer is disposed, that client is registered into a torn-down runtime and holds a mux retain nothing will release. That is the defect. Go to Step 3B.

- [ ] **Step 3A: Contract already holds — pin it**

Replace the probe test with:

```typescript
  test('to() queued behind init rejects once dispose has run', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x81)
    const alice = makeMLSPeer(hub, 'alice', rs, { epoch: 1, members })

    // Queued behind `ready` and never flushed: dispose wins the race to the continuation.
    const pending = alice.peer.protocol('chat').to('bob')
    await alice.peer.dispose()

    // A directed client handed back after teardown would hold a mux retain nothing releases.
    await expect(pending).rejects.toThrow()
  })
```

Run: `pnpm --filter @kumiai/rpc exec vitest run test/peer-dispose-race.test.ts` — expected: PASS.

Then verify it bites: comment out the `if (lane == null) throw new Error('Peer is not started')` guard at `peer.ts:688`, re-run, expected: FAIL. Restore with `git checkout -- packages/rpc/src/peer.ts`, re-run, expected: PASS. Skip to Step 4.

- [ ] **Step 3B: Defect confirmed — write the failing test, then fix**

Replace the probe test with:

```typescript
  test('to() queued behind init does not hand back a client after dispose', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x81)
    const alice = makeMLSPeer(hub, 'alice', rs, { epoch: 1, members })

    // Queued behind `ready` and never flushed: dispose wins the race to the continuation.
    // `withReady` awaits the same promise `dispose()` does, so without a disposed check the
    // continuation registers a directed client into a runtime teardown has already walked —
    // a mux retain nothing will ever release.
    const pending = alice.peer.protocol('chat').to('bob')
    await alice.peer.dispose()

    await expect(pending).rejects.toThrow(/disposed/i)
  })
```

Run it — expected: FAIL (it resolves instead of rejecting). This is the red phase.

Now fix `packages/rpc/src/peer.ts`. Add a disposed flag near the other peer-level state and set it at the top of `dispose()`, then check it in `withReady`:

```typescript
  let disposed = false
  const withReady = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    await ready
    // `dispose()` awaits the same promise, so a call queued before init settles resumes into a
    // runtime teardown has already walked. Refuse rather than hand back a client holding a mux
    // retain nothing will release.
    if (disposed) throw new Error('Peer is disposed')
    return fn()
  }
```

and in `dispose()`, as its first statement — before `await settled`:

```typescript
    dispose: async () => {
      disposed = true
      // Tear down even a peer whose init failed — it still holds a hub drain.
      await settled
```

Re-run: expected PASS.

Then run the whole rpc suite: `pnpm --filter @kumiai/rpc exec vitest run` — expected: PASS, no regressions. A disposed peer now rejects every `withReady` call after dispose, which is the intent; if an existing test depended on a post-dispose call resolving, read it before changing anything — it may be asserting the very behaviour being fixed.

Verify the fix bites: revert only the `if (disposed) throw` line, re-run the new test, expected FAIL. Restore it, expected PASS.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @kumiai/rpc exec tsc --noEmit --skipLibCheck -p tsconfig.test.json`
Expected: no output, exit 0.

- [ ] **Step 5: Commit**

If Step 3A (no source change):

```bash
git add packages/rpc/test/peer-dispose-race.test.ts
git commit -m "$(cat <<'EOF'
test(rpc): pin to() rejecting when dispose wins the init race

withReady awaits the same promise dispose does, so a to() queued before
init settles resumes after teardown. The lane guard already refuses it;
nothing asserted that. Mutation-verified against that guard.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

If Step 3B (source changed):

```bash
git add packages/rpc/test/peer-dispose-race.test.ts packages/rpc/src/peer.ts
git commit -m "$(cat <<'EOF'
fix(rpc): refuse a withReady call that resumes after dispose

withReady awaits the same promise dispose() does, so a to() queued before
init settles resumed into a runtime teardown had already walked, handing
back a directed client holding a mux retain nothing would release. A
disposed flag, set first thing in dispose(), refuses it instead.

Found writing the test for the "dispose during an in-flight handshake"
gap, which named a handshakeTail that no longer exists.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `dispose()` against a queued commit-tail rebuild

**Files:**
- Modify: `packages/rpc/test/peer-dispose-race.test.ts` (append a second describe)
- Probe target: `packages/rpc/src/hub-mux.ts:337,341,357` (the `disposed` early-returns)

**Interfaces:**
- Consumes: `makeMLSPeer`, `buildLedgerCommit` from `./fixtures/peer.js`; `FakeHub` from `./fixtures/fake-hub.js`; `LogHub` from `@kumiai/hub-tunnel`.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Probe — remove the mux's disposed guards**

Edit `packages/rpc/src/hub-mux.ts`. At lines 337, 341, and 357, comment out each `if (disposed) return`.

- [ ] **Step 2: Run the rpc suite and confirm it stays green**

Run: `pnpm --filter @kumiai/rpc exec vitest run`
Expected: PASS. Green confirms the gap — the guards are deliberate but unasserted.

If it FAILS: the guards already have teeth. Record which test caught it, restore, and skip to Step 6, recording "already covered by `<file:line>`".

- [ ] **Step 3: Restore the source**

Run: `git checkout -- packages/rpc/src/hub-mux.ts`, then `git status` — expected: clean.

- [ ] **Step 4: Append the test**

Add to `packages/rpc/test/peer-dispose-race.test.ts`:

```typescript
import { buildLedgerCommit } from './fixtures/peer.js'
import type { LogHub } from '@kumiai/hub-tunnel'

describe('dispose against a queued commit-tail rebuild', () => {
  test('nothing subscribes after dispose has returned', async () => {
    const fake = new FakeHub()
    const rs = new Uint8Array(32).fill(0x82)

    // A plain counter cannot answer the question: it cannot tell "subscribed during init" from
    // "subscribed after teardown", and only the second is a defect. The marker splits them.
    let disposeReturned = false
    const lateSubscribes: Array<string> = []
    const hub = new Proxy(fake, {
      get(target, property, receiver) {
        if (property === 'subscribe') {
          return (subscriberDID: string, topicID: string, options?: unknown) => {
            if (disposeReturned) lateSubscribes.push(topicID)
            return (target.subscribe as never as (...args: Array<unknown>) => unknown)(
              subscriberDID,
              topicID,
              options,
            )
          }
        }
        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as unknown as LogHub

    const members = ['alice', 'bob']
    const alice = makeMLSPeer(hub, 'alice', rs, { epoch: 1, members })
    const bob = makeMLSPeer(hub, 'bob', rs, { epoch: 1, members })
    await flush()

    // Alice commits: an inbound Commit for bob, whose apply queues a rebuildEpoch — and a
    // rebuild re-subscribes every per-epoch topic. Dispose lands while it is queued.
    void alice.peer.commit(buildLedgerCommit(alice, ['role:carol=admin']))
    await bob.peer.dispose()
    disposeReturned = true

    // Long enough for a queued rebuild to have run had nothing stopped it.
    await flush(200)

    expect(lateSubscribes).toEqual([])

    await alice.peer.dispose()
  })
})
```

Two things to adjust against reality:

- `buildLedgerCommit`'s signature differs between the rpc fixtures and the integration fixtures. Read `packages/rpc/test/fixtures/peer.ts:181` and match it — `peer-dispose-heal.test.ts:75` shows the rpc form.
- The Proxy must forward every `LogHub` method. If the peer calls a method the Proxy mangles, the test fails during setup rather than at the assertion — if that happens, replace the Proxy with an explicit object literal spelling out `publish`, `subscribe`, `unsubscribe`, `receive`, and `fetchTopic`, each delegating to `fake`.

- [ ] **Step 5: Run, typecheck, re-mutate**

Run: `pnpm --filter @kumiai/rpc exec vitest run test/peer-dispose-race.test.ts`
Expected: PASS, 2 tests.

Run: `pnpm --filter @kumiai/rpc exec tsc --noEmit --skipLibCheck -p tsconfig.test.json`
Expected: no output, exit 0.

Apply the Step 1 mutation, re-run the file. Expected: FAIL with a non-empty `lateSubscribes` array. Restore with `git checkout -- packages/rpc/src/hub-mux.ts`, re-run, expected: PASS.

If it PASSES with the guards removed, the test is not reaching the race. Lengthen the window: `await flush()` between `alice.peer.commit(...)` and `bob.peer.dispose()` so the commit is genuinely in bob's tail when dispose fires. Do not commit a test that survives its own mutation.

- [ ] **Step 6: Commit**

```bash
git status   # confirm no src file is modified beyond Task 5's conditional fix
git add packages/rpc/test/peer-dispose-race.test.ts
git commit -m "$(cat <<'EOF'
test(rpc): assert dispose beats a queued commit-tail rebuild

hub-mux's disposed guards are deliberate but were unasserted: removing all
three left the whole rpc suite green. A rebuild that re-subscribes after
teardown returns is the leak they exist to stop.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: The echo test on the real hub

**Files:**
- Modify: `tests/integration/test/hub-tunnel-echo.test.ts:141` and the two transport constructions at `:145,156`

**Interfaces:**
- Consumes: `createWireHub` from `./log-hub-over-wire.js` (see `wire-hub-smoke.test.ts:4` for the import and `:13-16` for the `connect(identity)` shape); `randomIdentity` from `@kokuin/token`.
- Produces: nothing later tasks depend on.

No probe step: this is a harness re-home, not an assertion gap. The existing assertions stay exactly as they are — the point is the transport crossing the real hub-server wire instead of an in-memory double.

- [ ] **Step 1: Read both files first**

Read `tests/integration/test/hub-tunnel-echo.test.ts` in full and `tests/integration/test/log-hub-over-wire.ts` for `createWireHub`'s exports and `WireConnection`'s surface. `wire-hub-smoke.test.ts` is the worked example of driving it.

- [ ] **Step 2: Swap the hub**

Replace `const hub = createInMemoryHub()` with:

```typescript
    const hub = createWireHub()
    const clientID = randomIdentity()
    const serverID = randomIdentity()
    const clientHub = hub.connect(clientID)
    const serverHub = hub.connect(serverID)
```

Then in the two `createHubTunnelTransport` calls, pass `hub: clientHub` / `hub: serverHub`, and replace the `localDID: 'client'` / `localDID: 'server'` strings with `localDID: clientID.id` / `localDID: serverID.id`.

Remove the now-unused `createInMemoryHub` import. Add `import { randomIdentity } from '@kokuin/token'` and the `createWireHub` import.

- [ ] **Step 3: Dispose the hub at the end of the test**

Add `await hub.dispose()` at the end of the test body, after the existing teardown. A wire hub holds a server; leaving it up hangs the vitest process.

- [ ] **Step 4: Run it**

Run: `pnpm --filter @kumiai/integration-tests exec vitest run test/hub-tunnel-echo.test.ts`
Expected: PASS, 1 test.

**If it fails, do not adjust the assertions.** A failure here is a finding about real-hub semantics the in-memory double was hiding, which is the entire reason for the change. Read the failure, work out which semantic differs, and report it — the assertions only change if the *test's* expectation was wrong, not if the hub's behaviour is surprising. Real-hub tests need generous flushes (`wire-hub-smoke.test.ts` uses `flush(120)`); a timing failure is likely a too-short flush, which is a test bug and may be fixed.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @kumiai/integration-tests exec tsc --noEmit --skipLibCheck`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add tests/integration/test/hub-tunnel-echo.test.ts
git commit -m "$(cat <<'EOF'
test(integration): drive the echo test over the real hub wire

Every other file in tests/integration drives a real createHub; this one
built its transports against an in-memory double, so tunnel-specific
real-hub semantics went untested. Assertions unchanged.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: A restored handle seals at the epoch it walked to

**Files:**
- Modify: `tests/integration/test/app-lane-delivery.test.ts` (append a test to the describe holding the restore test at `:604`)

**Interfaces:**
- Consumes: `makeMember`, `restoreMemberHandle`, `buildLedgerCommit`, `joinFromWelcome`, `Member` from `./app-lane-e2e.js`; the same `createWireHub`/identity setup the existing test uses.
- Produces: nothing later tasks depend on.

The test at `:604` proves a restored handle can *decrypt* frames sealed at epochs it had not itself reached. Nothing proves it can *seal* at the epoch it walked to — the other half of the persist/restore contract.

- [ ] **Step 1: Read the existing test in full**

Read `tests/integration/test/app-lane-delivery.test.ts` from the start of the describe containing line 604 to its end. The new test reuses its exact setup shape.

- [ ] **Step 2: Probe — is the seal path already covered?**

Search the integration suite for any restored member that dispatches:

Run: `grep -n "restoreMemberHandle" tests/integration/test/*.ts`

Read each hit. If any of them has the restored member call `.dispatch(` after the restore, the gap is closed — record the `file:line` and skip to Step 7.

- [ ] **Step 3: Write the test**

Append to the same describe block. Copy the existing test's setup verbatim (group creation, `bobSlot`/`aliceSlot`, `joinFromWelcome`, the three-epoch backlog, the `dying` handler, the restore) with exactly three changes:

1. **Alice gets handlers**, so she can receive. Where the existing test builds alice as
   `makeMember({ hub, identity: aliceID, group: aliceHandle, entrySlot: aliceSlot })`, build her as:

```typescript
    const aliceSeen: Array<unknown> = []
    const alice = makeMember({
      hub,
      identity: aliceID,
      group: aliceHandle,
      entrySlot: aliceSlot,
      handlers: {
        'chat/posted': async (ctx: { data: unknown }) => {
          aliceSeen.push(ctx.data)
        },
      },
    })
```

2. **After the restored bob reaches epoch 3, bob seals.** Where the existing test ends with its
   `expect(seen).toEqual([...])`, continue with:

```typescript
    // The half the restore test above does not reach. It proves a restored handle can OPEN
    // frames sealed at epochs it never itself reached; this proves it can SEAL at the epoch it
    // walked to — a handle that restored its state but not its ratchet position would produce
    // something alice cannot open.
    expect(bob.handle().epoch).toBe(3n)
    aliceSeen.length = 0
    await bob.peer.protocol('chat').dispatch('chat/posted', { text: 'sealed after the walk' })
    await flush(400)

    expect(aliceSeen).toEqual([{ text: 'sealed after the walk' }])
```

3. **The test name**: `'a restored handle seals at the epoch it walked to'`.

- [ ] **Step 4: Run it**

Run: `pnpm --filter @kumiai/integration-tests exec vitest run test/app-lane-delivery.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @kumiai/integration-tests exec tsc --noEmit --skipLibCheck`
Expected: no output, exit 0.

- [ ] **Step 6: Mutate and confirm it bites**

The mutation is on the fixture, not on shipped source: in `tests/integration/test/app-lane-e2e.ts`, make the restored member seal against a stale handle. The simplest form is inside `restoreMemberHandle` — return the handle *without* whatever walks it to the current epoch, so the seal happens at the pre-restore epoch.

Read `restoreMemberHandle` at `app-lane-e2e.ts:227` and pick the smallest edit that makes the restored handle seal at the wrong epoch.

Run the file. Expected: FAIL with `expected [] to deeply equal [ { text: 'sealed after the walk' } ]`.

Restore with `git checkout -- tests/integration/test/app-lane-e2e.ts`, re-run, expected: PASS.

If no fixture edit makes it fail, the assertion is not testing the seal epoch. Say so rather than committing it — see the Task 3 abort pattern.

- [ ] **Step 7: Commit**

```bash
git status   # confirm app-lane-e2e.ts is NOT modified
git add tests/integration/test/app-lane-delivery.test.ts
git commit -m "$(cat <<'EOF'
test(integration): a restored handle seals at the epoch it walked to

The restore test beside it proves a restored handle can open frames sealed
at epochs it never reached. This is the other half: that it can seal at
the epoch it walked to, and a peer can open what it produces.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Retire the doc and run the full gate

**Files:**
- Modify: `docs/agents/plans/next/2026-07-07-test-gaps.md`

**Interfaces:**
- Consumes: the recorded outcome of every task above — each is either a test file path, or an "already covered by `<file:line>`" note, or Task 3's possible "not observably distinguishable" note.
- Produces: nothing.

- [ ] **Step 1: Run the full unit gate, forced**

Run: `pnpm exec turbo run test:types test:unit --force`

Expected: all tasks successful, and **`Cached: 0`** in the summary. A run reporting cached results proves nothing — if the summary shows any cache hits, the `--force` did not take; re-run before continuing.

- [ ] **Step 2: Run the integration suite**

Run: `pnpm --filter @kumiai/integration-tests exec vitest run`
Expected: PASS, all files. Local `pnpm test` does not include this suite — CI does, so a failure here is a failure that would land in CI.

- [ ] **Step 3: Lint**

Run: `rtk proxy pnpm run lint`
Expected: no errors. (`pnpm run lint` alone is intercepted by the rtk shim and reports on the wrong tool.)

- [ ] **Step 4: Confirm no source file is left mutated**

Run: `git status` and `git diff main --stat`

Expected: only test files, the doc, and — if and only if Task 5 took branch 3B — `packages/rpc/src/peer.ts`. Any other `src/` file in the diff is a mutation someone forgot to restore. Restore it and re-run Steps 1–3.

- [ ] **Step 5: Update the doc**

Edit `docs/agents/plans/next/2026-07-07-test-gaps.md`:

- Delete the `## Medium` section entirely.
- Under `## What was verified closed and deleted`, add one bullet per entry, each naming the test that now covers it or the reason it needed none. Follow the existing bullets' style — they name `file:line`, not prose. For example:

```markdown
- `CommitRejectedError`'s captured payload — closed by
  `mls/test/commit-rejected-payload.test.ts`, both the default-policy and caller-policy paths,
  mutation-verified 2026-07-31.
- `hub-tunnel` teardown — the `onSessionEnd` half was already covered by
  `transport-ack.test.ts:301`; the local half (publish `session-end`, call `hub.unsubscribe`) is
  closed by `hub-tunnel/test/transport-teardown.test.ts`.
```

- Update the header block: change `**Re-verified 2026-07-28**` to note the 2026-07-31 pass and what it retired.
- If Task 5 took branch 3B, add a line pointing at the `withReady` fix commit, and remove the corresponding line from `backlog/2026-07-07-rpc-peer-lifecycle-hardening.md`'s "Test hooks" section (it names `dispose()` during an in-flight handshake as still open).

If the whole Medium section is now empty and nothing else in the file is open, say so at the top rather than leaving a file that looks live.

- [ ] **Step 6: Commit**

```bash
git add docs/agents/plans/next/2026-07-07-test-gaps.md docs/agents/plans/backlog/2026-07-07-rpc-peer-lifecycle-hardening.md
git commit -m "$(cat <<'EOF'
docs: retire the medium test gaps

Each entry closed by a mutation-verified test or recorded with the test
that already covered it. Two of the five had drifted since the 2026-07-28
pass and are noted as such.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: contract 1 → Tasks 1 and 2 (split, because the two policy paths carry separate probes); contract 2 → Task 4; contract 3 → Task 6; contract 4 → Task 5; contract 5 → Task 3; contract 6 → Task 7; contract 7 → Task 8. The spec's "Verification before completion" is Task 9. The spec's per-test protocol appears as Steps 1–3 and the re-mutate step in every task that has a mutation target.

**Task order differs from the spec's** in one place: the spec ordered rpc as "3 then 4" (commit tail, then directed `to()`); this plan runs `to()` first, as Task 5, because it is the one that may change source and everything downstream should build on the settled version of `peer.ts`.

**Placeholders.** None. Every code step carries real code. Three tasks carry explicit "adjust against reality" notes where a ts-mls or fixture signature could not be pinned from reading alone — each names the file to read and what the assertion must still prove, rather than leaving the choice open.

**Abort conditions are deliberate, not placeholders.** Tasks 1, 2, 3, 4, 6, and 8 each name what to do if the probe comes back red or the mutation fails to bite. A task that ends in "recorded, no test" is a completed task.

**Type consistency.** `twoMemberGroup` and `addCommitBytes` are defined in Task 1 and reused by Task 2 in the same file; Task 3 defines its own `threeMemberGroup` rather than importing across test files. `recordingHub()` is local to Task 4. `flush` is redefined per file, matching the repo's existing habit.
