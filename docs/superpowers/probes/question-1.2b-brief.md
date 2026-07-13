# Probe brief — Question 1.2 (continued)

The first pass of question 1.2 landed the log/delivery split and hit its prediction exactly
(5 passed / 5 failed). Its report is at `docs/superpowers/probes/question-1.2-report.md` — **read
it first**; it maps the storage model you are extending, and you wrote it.

Two of the concerns you raised were taken, and the design spec changed (revision 17) in
consequence. This pass folds those changes in. Everything already on disk stays; nothing is
reverted.

## What changed in the design, and why

Your §6.1 was right that something was contradictory, but the resolution went the other way from
the brief you were given. **Uniform log retention for every topic is wrong.** It would leave app
ciphertext on the hub for 30 days after every recipient had acked it, and it would throw away the
mailbox's ack-driven GC, which is *correct* for a mailbox.

The two lifetimes answer different questions, and the reason is sharper than "some peers are
offline":

> **Ack GC asks "has everyone read this?" — and on the commit topic, the reader may not exist
> yet.** A member invited tomorrow must read frames published today. At publish time an invitee is
> not a subscriber, not a member, not anything, so **no refcount over current subscribers can ever
> account for it.** The last existing member acks, the frame dies, and the member that needed it
> had not been born.

That is why the commit log's retention cannot be delivery-derived *even with a complete and
correct refcount* — and equally why the mailbox may keep its refcount, because there the reader
set really is known at publish time.

So retention splits into a **class** (who may delete a frame) and a **duration** (how long),
which are independent.

## The four changes

### 1. Retention class, declared at publish

```ts
export type PublishParams = {
  // ...existing
  /**
   * Retention class. 'mailbox' (default): today's semantics — the frame is removed once every
   * delivery is acked, or when it ages out. 'log': the frame is retained unconditionally and
   * removed only by trim, because a future subscriber may need it.
   */
  retain?: 'log' | 'mailbox'
}
```

- `'mailbox'` is the **default**, and it means **exactly what the store did before this question
  began** — including the refcount GC you deleted. Bring it back, but only for this class. A
  mailbox frame dies on last ack, or on age.
- `'log'` is what you built in the first pass: retained regardless of subscribers, removed only by
  `trim`, never by `ack` and never by `unsubscribe`.
- The store still cannot read payloads and still does not know what a commit is. It is told the
  class; it does not infer it. Do not add a per-topic "is this a log topic?" flag.

### 2. Retention duration, requested at subscribe, bounded by the hub

```ts
export type SubscribeParams = {
  subscriberDID: string
  topicID: string
  /**
   * Requested retention in seconds for this subscriber's view of the topic. Absent: the hub's
   * default. Above the hub's maximum: RetentionExceededError, at subscribe time — never a silent
   * downgrade to the max, which would strand a peer that believed it had asked for more.
   */
  retention?: number
}
```

- **A topic's frames live for the longest retention any of its subscribers asked for**, floored at
  the hub's default. For a mailbox topic that bound sits *alongside* ack GC — whichever frees the
  frame first wins, and for a mailbox the ack usually does. For a log topic it is the only bound.
- The store is constructed with `{ default, max }` retention (seconds). `subscribe` raises
  **`RetentionExceededError`** (new, in `hub-protocol/src/errors.ts`, same pattern as the other
  two) when the request exceeds `max`. Do not clamp.
- `subscribe`'s existing signature is positional (`subscribe(subscriberDID, topicID)`). Moving it
  to a params object is the cleaner shape and matches the rest of the contract; if that cascades
  further than `hub-server` and its tests, say so in the report rather than fighting it.
- `hub-server`'s scheduled purge (`hub.ts:85-93`) becomes the age enforcement for both classes. Its
  `olderThan` default of 7 days is now the **hub's default retention**, and the hub gains a **max**
  alongside it. Both configurable — that is the point.

### 3. Trim cascades to deliveries

Your §6.4 finding, taken as written. It is now in the contract: *removing a log entry removes the
deliveries that pointed at it.* You already implemented this; now it gets a conformance clause so a
SQL host without an `ON DELETE CASCADE` fails loudly instead of leaking rows silently.

### 4. `purge`'s doc comment

Your §6.1: the stale line at `packages/hub-protocol/src/types.ts:91-92` said `purge` governs
delivery rows, not the log. Rewrite it to match what `purge` now is — the **age enforcement for
both classes**, honouring the same invariants as `trim` (never touches `head`, never removes a
dedup record).

## You may now edit the conformance suite

The previous brief forbade it. That restriction is lifted **for these clauses only** — they are
contract additions I have already signed off, and they are in the spec:

- **The class pair (the load-bearing one).** Publish two frames to the same topic, one
  `retain: 'mailbox'` and one `retain: 'log'`, with the same subscribers, and have every subscriber
  ack both. The mailbox frame is **gone**; the log frame is **still there**, readable via
  `fetchTopic`, and still `head`. **A store that treats `retain` as a no-op passes every other
  clause in the suite and fails this one** — that is why the two publishes must be otherwise
  identical.
- **A trimmed entry leaves no pending delivery behind.**
- **Retention duration:** a subscribe above the hub's max raises `RetentionExceededError` rather
  than clamping; a topic's frames survive as long as the longest retention any subscriber asked
  for.

Do not touch any other clause. The five CAS/dedup failures must stay failing — CAS and idempotency
are still the next question's work, and implementing them here would hide whether the retention
model is sound on its own.

## Expected outcome

Conformance: the five log/read/class clauses plus the new ones pass; the five CAS/dedup clauses
still fail. Say what the new count is and why it is what it is. **Do not chase a full pass.**

`hub.test.ts` must still pass. If the mailbox class is implemented correctly it will, because
mailbox class *is* today's behaviour — that is the regression check, and it is now a sharper one
than it was: if `hub.test.ts` breaks, the mailbox default is not actually the old behaviour.

The three tests you rewrote in `memoryStore.test.ts` need revisiting: two of them
(zero-subscriber-retained, last-ack-leaves-the-log-entry) are now assertions about the **log
class** specifically and must publish with `retain: 'log'` to mean what they say. The mailbox
behaviours they used to assert are *back*, for the mailbox class — so add the mirror assertions
rather than deleting them. The store now does both things, and the test file should say so.

## Rules

- **BLOCKED on the first failure of this approach.** Do not try alternatives without asking.
- Do not implement CAS or `publishID` dedup.
- Do not weaken a test to make something pass. If `hub.test.ts` breaks, that is a finding.

## Conventions

`kigu:conventions` skill and the repo's `AGENTS.md`. `type` not `interface`; `Array<T>`; never
`any`; capital `ID`; ES `#fields`. **Code, comments and test names never reference plan questions,
phase labels, or G-numbers** — state the invariant directly ("the commit log's reader may not exist
at publish time, so no refcount can free its frames").

## Verify

```
rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test
```

from the repo root (`rtk proxy` prefix is required). Include the output.

## Report contract

Append to `docs/superpowers/probes/question-1.2-report.md` under a new `## Part 2` heading:

- The retention model as it now stands: what each class means, what each deleter may touch, and
  where duration is enforced. `file:line`.
- The conformance suite's pasted output and the new pass/fail count.
- Whether `subscribe`'s move to a params object cascaded, and how far.
- Confirmation that `hub.test.ts` still passes — and if it did *not* at first, exactly what broke,
  because that tells us the mailbox default was not really the old behaviour.
- What surprised you.

**Return to the caller only:** status, a one-line test summary, concerns. Do not commit.
