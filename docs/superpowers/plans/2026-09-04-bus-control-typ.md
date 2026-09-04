# Bus control-frame `typ` discriminator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** finishing
**Mode:** tasks

**Goal:** Move broadcast-bus control frames off `typ:'event'`/`data.kind` onto a distinct
`typ:'ctrl'` so an app event whose `data.kind` is `'req'`/`'res'` is no longer misclassified as a
control frame and dropped.

**Architecture:** Control frames (request/reply) gain their own top-level `payload.typ === 'ctrl'`,
keeping their existing inner `kind: 'req' | 'res'` sub-discriminator. App events keep
`typ: 'event'`. Every classifier switches on `payload.typ` alone and reads `data.kind` only after
`typ === 'ctrl'`, so `payload.data` becomes app-exclusive. Wire version `BROADCAST_VERSION` bumps
`1 → 2`. The two interim "same-door" drop-classifications (`app-lane.ts` control-shape drop,
responder malformed-control fallthrough) become dead and are deleted.

**Tech Stack:** TypeScript, vitest, `@sozai/*`, `@enkaku/transport`, turbo, biome, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-04-bus-control-typ-design.md`

## Global Constraints

- pnpm only. Do not edit generated files (`lib/`).
- Lint via `rtk proxy pnpm run lint` (a local `rtk` shim fakes `pnpm run lint` / `pnpm exec biome`
  and gives wrong output otherwise). Run it before staging.
- Run vitest directly per package (`pnpm --filter <pkg> exec vitest run [file]`); `pnpm test`
  reports cached turbo results.
- Typecheck repo-wide with `turbo run test:types` — never a single-package filter (a consumer
  package can hide un-migrated sites).
- `vitest` strips types; a green vitest run proves nothing about type correctness. Pair every
  behavioural change with a `test:types` run.
- Wire shape (verbatim from spec):
  - app event: `{ typ: 'event', prc, data }` — `data` is arbitrary app payload, `kind` free.
  - request: `{ typ: 'ctrl', prc, data: { kind: 'req', rid, prm, gather? } }`
  - reply: `{ typ: 'ctrl', prc, data: { kind: 'res', rid, ok?, err? } }`
- Record a `pnpm change` `minor` intent for `@kumiai/broadcast` and `@kumiai/rpc` as the work lands
  (breaking wire change; 0.x → `minor`).

---

### Task 1: Transport — wire version bump and control-typ allow-list

**Files:**
- Modify: `packages/broadcast/src/transport.ts` (`BROADCAST_VERSION`, writable `write()` guard)
- Test: `packages/broadcast/test/transport.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `BROADCAST_VERSION === 2`; the broadcast transport `write()` accepts a `payload.typ`
  of `'event'` or `'ctrl'` and rejects everything else.

- [ ] **Step 1: Write the failing tests**

Add to `packages/broadcast/test/transport.test.ts` (it already imports `createMemoryBus`,
`createBroadcastTransport`, `decodeFrame`, `encodeFrame`, `fromUTF`; add any missing import):

```ts
test('write() accepts a ctrl payload', async () => {
  const bus = createMemoryBus()
  const transport = createBroadcastTransport({ topicID: 'topic-x', bus })

  await expect(
    transport.write({ payload: { typ: 'ctrl', prc: 'x', data: { kind: 'req', rid: 'r', prm: {} } } }),
  ).resolves.toBeUndefined()

  await transport.dispose()
})

test('decodeFrame refuses a frame from an older wire version', () => {
  // A hand-built v1 frame: the version stamp this build no longer speaks.
  const v1 = fromUTF(JSON.stringify({ payload: { typ: 'event', prc: 'x', data: {} }, v: 1 }))
  expect(() => decodeFrame(v1)).toThrow(/version/i)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @kumiai/broadcast exec vitest run test/transport.test.ts`
Expected: `write() accepts a ctrl payload` FAILS (current guard throws on non-`event`);
`decodeFrame refuses ... older wire version` FAILS (v1 currently equals `BROADCAST_VERSION`).

- [ ] **Step 3: Bump the version and widen the guard**

In `packages/broadcast/src/transport.ts`:

Change the constant:

```ts
export const BROADCAST_VERSION = 2
```

Update its doc comment to record that v2 reinterprets `typ` (control frames leave the `event` typ)
and removes `data.kind` from the app-data namespace; keep the existing explanation of why an
unrecognised version is refused rather than best-effort read.

Change the writable `write()` guard (currently rejects any `typ !== 'event'`):

```ts
    async write(value) {
      const typ = (value as BroadcastMessage | undefined)?.payload?.typ
      if (typ !== 'event' && typ !== 'ctrl') {
        throw new Error(
          `Broadcast transport only carries 'event' and 'ctrl' payloads; got '${typ ?? 'undefined'}'`,
        )
      }
      const bytes = await wrap(encodeFrame(value as BroadcastMessage))
      await bus.publish(topicID, bytes)
    },
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @kumiai/broadcast exec vitest run test/transport.test.ts`
Expected: PASS, including the existing `write() rejects non-event payloads` test (it writes
`typ: 'request'`, still rejected, error still matches `/event/i`).

- [ ] **Step 5: Commit**

```bash
git add packages/broadcast/src/transport.ts packages/broadcast/test/transport.test.ts
git commit -m "feat(broadcast)!: bump wire version to 2 and allow typ:'ctrl'

BREAKING CHANGE: BROADCAST_VERSION 1->2; the transport now carries typ:'ctrl'
control frames alongside typ:'event' app events.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ADEZXxrWej2sD65etgBZAr"
```

---

### Task 2: Broadcast control lane — responder and client speak `typ:'ctrl'`

**Files:**
- Modify: `packages/broadcast/src/responder.ts` (inbound classifier, reply write)
- Modify: `packages/broadcast/src/client.ts` (`#read` classifier, request/gather writes, type docs)
- Test: `packages/broadcast/test/responder.test.ts`, `packages/broadcast/test/client.test.ts`,
  `packages/broadcast/test/reply-identity.test.ts`, and any other broadcast test that hand-builds a
  control frame (see Step 1).

**Interfaces:**
- Consumes: Task 1's `typ:'ctrl'` allow-list.
- Produces: `BroadcastClient.request`/`gather` write `typ:'ctrl'` requests; the responder writes
  `typ:'ctrl'` replies; both classify inbound frames by `payload.typ`. An inbound `typ:'event'`
  frame is always an app event regardless of its `data` contents. `RequestData`/`ReplyData` are
  unchanged in shape (`kind` retained as a sub-discriminator scoped under `typ:'ctrl'`).

- [ ] **Step 1: Update every existing test that hand-builds a control frame**

These tests construct request/reply frames as `typ:'event'` and/or detect requests via
`typ !== 'event'`; they must move to `typ:'ctrl'` or they will break once the implementation
switches. This is a red→green enabling step, not the regression — the regression is Steps 2–3.

Find every site: `grep -rn "typ: *'event'\|typ !== 'event'\|typ === 'event'" packages/broadcast/test`
Known sites to change (verify each in context — leave genuine app-event `dispatch`/`buildEventMessage`
frames as `typ:'event'`; change only frames carrying `data.kind: 'req'|'res'` and the req-detection
guards on the hand-rolled responder doubles):

- `responder.test.ts:162` — injected error `res` frame: `typ: 'event'` → `typ: 'ctrl'`.
- `client.test.ts` fake responder (~`:20-33`): req-detection `msg.payload.typ !== 'event'` →
  `msg.payload.typ !== 'ctrl'`, and the reply write `typ: 'event'` → `typ: 'ctrl'`.
- `reply-identity.test.ts` responder doubles (`:60-67` and `~:140-152`): same two changes — req
  detection `typ !== 'event'` → `typ !== 'ctrl'`, reply write `typ: 'event'` → `typ: 'ctrl'`.
- `ack.test.ts`, `sender.test.ts` — inspect; change only control-frame constructions, not app events.

Leave `responder.test.ts:177-202` (`dispatches a fire-and-forget event`) as `typ:'event'` — it is a
genuine app event.

- [ ] **Step 2: Write the failing regression test (the collision fix)**

Replace `responder.test.ts`'s `drops a malformed control frame instead of forwarding it to events`
test (`:204-231`) with these two tests — the first is the regression that pins the fix, the second
preserves the malformed-drop guarantee at its new `typ`:

```ts
test('delivers an app event whose data is shaped like a control frame', async () => {
  const bus = createMemoryBus()
  const events = new EventEmitter<{ note: { data: unknown; senderDID?: string } }>()
  const received: Array<{ data: unknown; senderDID?: string }> = []
  events.on('note', (e) => {
    received.push(e)
  })
  const responder = createBroadcastResponder({
    transport: createBroadcastTransport({ topicID: TOPIC, bus }),
    from: 'peer-1',
    requestHandlers: {},
    events,
  })

  // An app event (typ:'event') whose OWN data legitimately carries kind:'req'. This is app data,
  // not a control frame, and must reach the event listener — the collision this change fixes.
  bus.publish(
    TOPIC,
    encodeFrame({
      payload: { typ: 'event', prc: 'note', data: { kind: 'req', rid: 'x', hello: 'world' } },
    }),
  )
  await new Promise<void>((resolve) => setTimeout(resolve, 10))

  expect(received).toHaveLength(1)
  expect(received[0]?.data).toEqual({ kind: 'req', rid: 'x', hello: 'world' })

  await responder.dispose()
})

test('drops a malformed ctrl frame instead of forwarding it to events', async () => {
  const bus = createMemoryBus()
  const events = new EventEmitter<{ note: { data: unknown; senderDID?: string } }>()
  const received: Array<{ data: unknown; senderDID?: string }> = []
  events.on('note', (e) => {
    received.push(e)
  })
  const responder = createBroadcastResponder({
    transport: createBroadcastTransport({ topicID: TOPIC, bus }),
    from: 'peer-1',
    requestHandlers: {},
    events,
  })

  // A control frame (typ:'ctrl', kind:'req') whose rid is not a string fails the req guard. It is
  // control, so it is NEVER forwarded to the events emitter regardless.
  bus.publish(
    TOPIC,
    encodeFrame({
      payload: { typ: 'ctrl', prc: 'note', data: { kind: 'req', rid: 123, prm: {} } },
    }),
  )
  await new Promise<void>((resolve) => setTimeout(resolve, 10))

  expect(received).toHaveLength(0)

  await responder.dispose()
})
```

- [ ] **Step 3: Run to verify the regression fails**

Run: `pnpm --filter @kumiai/broadcast exec vitest run test/responder.test.ts`
Expected: `delivers an app event whose data is shaped like a control frame` FAILS — today the
responder classifies on `data.kind` and drops it as a control frame (`received` length 0, not 1).

- [ ] **Step 4: Implement the responder classifier and reply write**

In `packages/broadcast/src/responder.ts`, replace the inbound loop body's classification (the block
from `if (payload?.typ !== 'event')` through the `void events?.emit(...)` call) with:

```ts
      const payload = msg?.payload
      const typ = payload?.typ
      if (typ !== 'event' && typ !== 'ctrl') {
        continue
      }
      if (typ === 'ctrl') {
        const data = payload.data as InboundData | undefined
        if (data?.kind === 'res' && typeof data.rid === 'string') {
          // Only a peer's SUCCESS suppresses us; its error frame must not.
          if (data.err == null) {
            markReplied(data.rid, DEFAULT_SUPPRESS_TTL_MS)
          }
          continue
        }
        if (data?.kind === 'req' && typeof data.rid === 'string' && typeof payload.prc === 'string') {
          const handler = requestHandlers[payload.prc]
          if (handler != null) {
            void handleRequest(payload.prc, data as RequestData, handler, msg.senderDID)
          }
        }
        // Any other ctrl frame is malformed control; drop it. It is never an app event.
        continue
      }
      // typ === 'event': a genuine fire-and-forget app event. Its data.kind, if present, is app
      // data and is never inspected here.
      if (typeof payload.prc !== 'string') {
        continue
      }
      void events
        ?.emit(payload.prc, { data: payload.data, senderDID: msg.senderDID })
        .catch(() => {})
```

This deletes the old malformed-control fallthrough (`if (data?.kind === 'req' || data?.kind === 'res')`)
— it is unreachable now that control is identified by `typ`.

Change the reply write (currently `payload: { typ: 'event', prc, data: reply }`):

```ts
    await transport
      .write({ payload: { typ: 'ctrl', prc, data: reply }, senderDID: from })
      .catch(() => {})
```

- [ ] **Step 5: Implement the client classifier, writes, and doc updates**

In `packages/broadcast/src/client.ts`:

`#read` — replies now arrive as `typ:'ctrl'`:

```ts
      const payload = msg?.payload
      if (payload?.typ !== 'ctrl') {
        continue
      }
      const data = payload.data as Partial<ReplyData> | undefined
      if (data?.kind !== 'res' || typeof data.rid !== 'string') {
        continue
      }
```

(leave the rest of `#read` — the `senderDID` attribution guard and `collect` call — unchanged.)

Request write in `request` (currently `typ: 'event'`):

```ts
      this.#transport
        .write({ payload: { typ: 'ctrl', prc, data: { kind: 'req', rid, prm } } })
```

Gather write in `gather` (currently `typ: 'event'`):

```ts
      this.#transport
        .write({ payload: { typ: 'ctrl', prc, data: { kind: 'req', rid, prm, gather: true } } })
```

Leave `dispatch` unchanged — it uses `buildEventMessage`, which is an app event (`typ:'event'`).

Update the `RequestData` and `ReplyData` doc comments to state that `kind` is a sub-discriminator
scoped under `typ:'ctrl'` and no longer shares the app-data namespace.

- [ ] **Step 6: Run the broadcast suite**

Run: `pnpm --filter @kumiai/broadcast exec vitest run`
Then: `pnpm --filter @kumiai/broadcast exec vitest run` a second time is not needed; instead run the
type check now: `pnpm --filter @kumiai/broadcast run test:types`
Expected: all broadcast vitest tests PASS (including the new regression and the updated doubles),
and `test:types` clean.

- [ ] **Step 7: Commit**

```bash
git add packages/broadcast/src/responder.ts packages/broadcast/src/client.ts packages/broadcast/test
git commit -m "feat(broadcast)!: carry control frames on typ:'ctrl', freeing app data.kind

BREAKING CHANGE: requests/replies now ride typ:'ctrl'. App events keep typ:'event'
and may use kind:'req'|'res' as an event-data key. Classification keys on payload.typ.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ADEZXxrWej2sD65etgBZAr"
```

---

### Task 3: RPC app-lane drain — delete the interim control-shape drop

**Files:**
- Modify: `packages/rpc/src/app-lane.ts` (delete the `data.kind` control-shape drop, `:460-471`)
- Test: `packages/rpc/test/peer-app-drain-integrity.test.ts` (invert the collision test)

**Interfaces:**
- Consumes: Task 2's rule that a `typ:'event'` frame is always an app event.
- Produces: the drain classifies retained frames by `payload.typ === 'event'` only; a retained app
  event whose `data.kind` is `'req'`/`'res'` is delivered, matching the live push path.

- [ ] **Step 1: Invert the collision test to assert delivery**

In `packages/rpc/test/peer-app-drain-integrity.test.ts`, rewrite the test
`a retained event frame whose data is shaped like a control frame is not delivered` (`:406-450`).
Rename it and flip the assertion — the same-door invariant now means the frame is delivered on both
paths, so the drain must deliver it:

```ts
  /**
   * A retained frame whose decrypted payload DATA happens to be shaped like a control frame
   * (`{ kind: 'req' | 'res', ... }`). Control frames now ride typ:'ctrl'; a typ:'event' frame is an
   * app event whatever its data contains. The live-push responder delivers it to the event
   * listener, so the drain must deliver it too — the "same door" invariant, at the polarity the
   * typ discriminator establishes.
   */
  test('a retained event frame whose data is shaped like a control frame is delivered', async () => {
    const hub = new DurableFakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x98)
    const posted: Array<unknown> = []
    const handlers = { 'chat/posted': (ctx: { data: unknown }) => void posted.push(ctx.data) }
    const topicID = protocolTopic(fakeEpochSecret(1, APP_TOPIC_LABEL), 1, 'chat')

    const alice = makeMLSPeer(hub, 'alice', recoverySecret, { epoch: 1 })
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { epoch: 1, handlers })
    await flush()
    await bob.peer.dispose()
    hub.detach('bob')

    // An app payload under `chat/posted` (schema `{type:'object'}`, permissive) that happens to
    // carry a top-level `kind: 'req'` — legitimate app data, delivered like any other event.
    const atOne = createFakeCrypto({ epoch: 1, localDID: 'alice' })
    await hub.publish({
      senderDID: 'alice',
      topicID,
      retain: 'log',
      payload: await atOne.wrap(encodeEventFrame('chat/posted', { kind: 'req', rid: 'x' })),
    })
    await flush()

    const restarted = makeMLSPeer(hub, 'bob', recoverySecret, { restartOf: bob, handlers })
    hub.reattach('bob')
    await flush()

    expect(posted).toEqual([{ kind: 'req', rid: 'x' }])

    // Consumed rather than left to be re-offered.
    const frames = hub.published.filter((m) => m.topicID === topicID)
    expect(frames).toHaveLength(1)
    expect(bob.appCursorStore.stored(topicID)).toBe(frames[0]?.sequenceID)

    await alice.peer.dispose()
    await restarted.peer.dispose()
  })
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @kumiai/rpc exec vitest run test/peer-app-drain-integrity.test.ts`
Expected: FAIL — today the drain drops the frame at the `data.kind` check, so `posted` is `[]`, not
`[{ kind: 'req', rid: 'x' }]`.

- [ ] **Step 3: Delete the interim control-shape drop**

In `packages/rpc/src/app-lane.ts`, delete the block that drops a retained frame whose `data.kind` is
`'req'`/`'res'` (currently `:460-471`, the comment `// Same door as the live push: a payload shaped
like a control frame ...` through the closing `}` of that `if`). Keep the preceding
`if (message.payload?.typ !== 'event' || typeof prc !== 'string') continue` guard (`:459`) and the
following `retentionOf(...) !== 'log'` guard untouched.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @kumiai/rpc exec vitest run test/peer-app-drain-integrity.test.ts`
Then: `pnpm --filter @kumiai/rpc run test:types`
Expected: the inverted test PASSES; `test:types` clean.

- [ ] **Step 5: Commit**

```bash
git add packages/rpc/src/app-lane.ts packages/rpc/test/peer-app-drain-integrity.test.ts
git commit -m "feat(rpc)!: drain classifies retained frames by typ, not data.kind

BREAKING CHANGE: rides the broadcast typ:'ctrl' change. The interim same-door
control-shape drop is deleted; a retained typ:'event' app event whose data.kind is
'req'/'res' is now delivered on replay, matching live push.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ADEZXxrWej2sD65etgBZAr"
```

---

### Task 4: Full gate — repo-wide typecheck, lint, conformance, changeset, milestone

**Files:**
- Create: a `pnpm change` intent file (path chosen by the tool).
- Modify: `docs/agents/plans/milestones/pre-1.0-breaking-api.md` (mark the item taken).
- Test: no new tests; this task runs the whole verification surface.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: a green repo (types, lint, unit, both conformance suites real + doubles), a recorded
  `minor` intent, and the milestone item recorded as taken.

- [ ] **Step 1: Repo-wide typecheck**

Run: `turbo run test:types`
Expected: all packages PASS. If any consumer package fails, migrate it here (do not scope the fix to
one filter).

- [ ] **Step 2: Lint**

Run: `rtk proxy pnpm run lint`
Expected: clean. Fix anything reported, re-run.

- [ ] **Step 3: Unit + conformance, uncached, real ports AND doubles**

Run each and confirm the run is not replayed from cache:

```bash
pnpm --filter @kumiai/broadcast exec vitest run
pnpm --filter @kumiai/rpc exec vitest run
pnpm --filter @kumiai/hub-tunnel exec vitest run
pnpm --filter @kumiai/mls-rpc exec vitest run
pnpm --filter @kumiai/rpc-conformance exec vitest run
pnpm --filter @kumiai/hub-conformance exec vitest run
```

Expected: all PASS. The `rpc` suite includes the bus contract exercised against the real
implementation and the doubles; `rpc-conformance`/`hub-conformance` re-assert the ports. If a bus
double anywhere still constructs a `typ:'event'` control frame or classifies on `data.kind`, fix it
to `typ:'ctrl'` (a double may be stricter than its port but must speak the same wire).

- [ ] **Step 4: Record the changeset intent**

Run: `pnpm change`
Choose `@kumiai/broadcast` and `@kumiai/rpc`, bump `minor`, summary describing the wire break
(`typ:'ctrl'` control frames; `BROADCAST_VERSION` 2; app `data.kind` freed). Do not publish.

- [ ] **Step 5: Mark the milestone item taken**

In `docs/agents/plans/milestones/pre-1.0-breaking-api.md`, strike through the
`Bus control-frame kind discriminator shares the app-data namespace` bullet under `@kumiai/rpc` and
append a `*Taken 2026-09-04:*` note: control frames moved to `typ:'ctrl'`, `data.kind` freed for
apps, `BROADCAST_VERSION` 1→2, and both interim drop-classifications deleted. Reference this plan and
the spec.

- [ ] **Step 6: Commit**

```bash
git add .changes docs/agents/plans/milestones/pre-1.0-breaking-api.md
git commit -m "chore: changeset + milestone record for bus control-typ break

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ADEZXxrWej2sD65etgBZAr"
```

---

## Self-Review

**Spec coverage:**
- Wire v2 + guard → Task 1. Responder/client classifier + writes + type docs → Task 2. Responder
  malformed-control fallthrough deleted → Task 2 Step 4. Drain control-shape drop deleted → Task 3.
  `event-frame.ts` unchanged → not touched (correct). Regression (colliding app event delivered live
  + replayed) → Task 2 Steps 2–4 (live) and Task 3 (replay). Conformance real+doubles → Task 4.
  Changeset + milestone → Task 4. All spec sections map to a task.
- The spec's "no drain version gate" decision needs no task (it is a deliberate non-change); the
  `decodeFrame` v2 refusal is covered by Task 1 Step 1's second test.

**Placeholder scan:** no TBD/TODO; every code step shows the actual before/after. The one grep-driven
step (Task 2 Step 1, Task 4 Step 3) lists the known sites explicitly and gives the exact command to
catch any straggler — concrete, not a placeholder.

**Type consistency:** `typ:'ctrl'`, `kind:'req'|'res'`, `RequestData`/`ReplyData` (shape unchanged),
`BROADCAST_VERSION`, `payload.typ`, `payload.data` used identically across all tasks. Classifiers
key on `payload.typ` everywhere; `data.kind` read only under `typ==='ctrl'`.
