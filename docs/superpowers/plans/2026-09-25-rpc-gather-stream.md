# Stream gathered replies and cancel a gather — Implementation Plan

**Stage:** executing
**Mode:** tasks

> **For agentic workers:** Implement task by task, TDD. Steps use checkbox (`- [ ]`) syntax for tracking.
> Tick each box in this file as you finish it and commit the tick with the task.

**Goal:** `gather` gains a per-reply `onReply` hook and a per-call `AbortSignal`, through
`@kumiai/broadcast` and the `@kumiai/rpc` protocol surface.

**Architecture:** All per-call state stays in `BroadcastClient.gather`; one guarded `settle` owns every
exit. The rpc surface forwards the new options and races `ready` against the signal.

**Tech Stack:** TypeScript (strict), vitest, pnpm + turbo, biome.

**Spec:** `docs/superpowers/specs/2026-09-25-rpc-gather-stream-design.md` — read it first; it is the
authority for every behaviour below.

## Global Constraints

- pnpm only. Never edit `lib/` (generated).
- `onReply` is declared with METHOD syntax (`onReply?(reply: GatheredReply<T>): void`), never as an
  arrow-typed property.
- Keep the hoisted `protocolMethod` in `peer.ts` (TS2589 guard).
- Do not add `signal` to `request()` or `dispatch()`.
- `senderDID` passed to `onReply` is exactly the transport's; broadcast does no normalization.
- Code comments terse: keep the non-obvious why only.
- Lint with `rtk proxy pnpm run lint` BEFORE `git add` (the plain command is shimmed and lies).
- Verification gate: `pnpm exec turbo run test:types test:unit --force` and confirm `Cached: 0`.
  Never `pnpm test -- --force`.
- Commit messages: Conventional Commits, ending with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Never commit to `main`.

## Review Focus

1. A long-lived `AbortSignal` shared by hundreds of settled gathers must hold zero listeners.
2. `onReply` that aborts its own signal or disposes the client mid-callback must settle once.
3. A transport `write` that throws synchronously must not leak the pending entry or timer.
4. A reply arriving after abort must neither fire `onReply` nor change the resolved array.
5. An abort on a peer still waiting on `ready` must return promptly, and still throw if disposed.

---

### Task 1: `BroadcastClient.gather` — onReply, signal, single settlement

**Files:**
- Modify: `packages/broadcast/src/client.ts` (`GatherOptions`, `gather`)
- Create: `packages/broadcast/test/gather-stream.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type GatherOptions<T = unknown> = {
    quorum?: number
    timeoutMs?: number
    onReply?(reply: GatheredReply<T>): void
    signal?: AbortSignal
  }
  gather(prc: string, prm?: unknown, options?: GatherOptions): Promise<Array<GatheredReply>>
  ```

- [x] **Step 1: Write the failing tests** in `packages/broadcast/test/gather-stream.test.ts`. Reuse the
  `startResponder` helper pattern from `client.test.ts` (copy it; tests files stay self-contained). For
  write-failure cases build a minimal fake transport object implementing `TransportType`'s
  `write`/`dispose`/async-iterator. Cover:

  ```ts
  test('onReply fires once per accepted reply with the authenticated sender', async () => {
    const bus = createMemoryBus()
    const r1 = startResponder(bus, 'did:a', () => ({ ok: 1 }))
    const r2 = startResponder(bus, 'did:b', () => ({ ok: 2 }))
    const rErr = startResponder(bus, 'did:c', () => ({ err: 'x' }))
    const client = new BroadcastClient({ transport: createBroadcastTransport({ topicID: TOPIC, bus }) })
    const seen: Array<GatheredReply> = []
    const replies = await client.gather('census', {}, {
      quorum: 2, timeoutMs: 1000, onReply: (r) => seen.push(r),
    })
    expect(seen.map((r) => r.senderDID).sort()).toEqual(['did:a', 'did:b'])
    expect(seen[0]).toBe(replies.find((r) => r.senderDID === seen[0]?.senderDID)) // same object
    await Promise.all([client.dispose(), r1.dispose(), r2.dispose(), rErr.dispose()])
  })
  ```

  Plus one test each for:
  - duplicate `senderDID` (two responders answering under the same name): `onReply` fires once;
  - quorum-completing reply fires `onReply` before the promise resolves (record order in an array);
  - abort before call: pre-aborted signal resolves `[]`; spy on `transport.write` shows no call;
  - abort after send: resolves the replies so far; a reply injected afterwards (responder with a delay,
    e.g. `await new Promise(r => setTimeout(r, 50))` before writing) fires no `onReply` and the resolved
    array length is unchanged;
  - early global completion: two clients on two buses, caller-side `Set` of DIDs, `controller.abort()`
    once the set reaches 2; both gathers resolve with their partial replies;
  - timeout resolves collected replies;
  - write rejection rejects; write that throws synchronously rejects;
  - dispose resolves partial replies;
  - throwing `onReply` does not change the result nor stop later replies being collected;
  - `onReply` calling `controller.abort()` resolves with that reply included, and a later reply is
    ignored;
  - `onReply` calling `client.dispose()` resolves once with that reply included;
  - listener leak: one `AbortController`, run 50 gathers to timeout/quorum; wrap
    `signal.addEventListener`/`removeEventListener` with counting spies and assert adds === removes
    after all settle (pre-aborted path adds none).

- [x] **Step 2: Run to verify they fail**

  Run: `pnpm --filter @kumiai/broadcast exec vitest run test/gather-stream.test.ts`
  Expected: FAIL (onReply never called / signal ignored).

- [x] **Step 3: Implement.** In `client.ts`:
  - Change `GatherOptions` to the generic form above (method-syntax `onReply`).
  - In `gather`: if `options.signal?.aborted`, return `Promise.resolve([])` before minting a `rid`.
  - Inside the promise: `let settled = false`; `const settle = (outcome: { ok: true } | { ok: false; error: unknown }) => { if (settled) return; settled = true; clearTimeout(timer); this.#pending.delete(rid); signal?.removeEventListener('abort', onAbort); outcome.ok ? resolve(replies) : reject(outcome.error) }`.
  - `collect(reply, senderDID)`: skip err/duplicate; `const gathered = { senderDID, value: reply.ok }`;
    push `gathered`; then `try { options.onReply?.(gathered) } catch {}`; then `if (replies.length >= quorum) settle({ ok: true })`.
  - `onDispose` and timer and `onAbort` call `settle({ ok: true })`.
  - Register the abort listener with `{ once: true }` after the pending entry is set.
  - Write: `let write: Promise<void>; try { write = this.#transport.write(...) } catch (error) { settle({ ok: false, error }); return }` then `write.catch((error) => settle({ ok: false, error }))`.
  - Update the `GatherOptions` doc comment: abort resolves partial replies; `onReply` receives the stored
    object, read-only; throwing observers are ignored.

- [x] **Step 4: Run to verify pass**, plus existing broadcast tests:

  Run: `pnpm --filter @kumiai/broadcast exec vitest run` and `pnpm --filter @kumiai/broadcast run test:types`
  Expected: PASS.

- [x] **Step 5: Lint and commit**

  ```bash
  rtk proxy pnpm run lint
  git add packages/broadcast
  git commit -m "feat(broadcast): stream gathered replies and cancel a gather per call"
  ```

### Task 2: rpc protocol surface — forward options, abortable readiness wait

**Files:**
- Modify: `packages/rpc/src/peer.ts` (`ProtocolSurface.gather` ~303, `InternalSurface.gather` ~317,
  `surfaceFor(...).gather` forwarding ~816, `protocolMethod.gather` ~2198)
- Modify: `packages/rpc/test/protocol-surface-types.test.ts`
- Test: `packages/rpc/test/gather-stream.test.ts` (create)

**Interfaces:**
- Consumes: `GatherOptions<T>` from Task 1 (re-exported by `@kumiai/broadcast`).
- Produces: `ProtocolSurface.gather` config type `{ param } & GatherOptions<T['Result']>`;
  `InternalSurface.gather` config `{ param?: unknown } & GatherOptions`.

- [ ] **Step 1: Write failing tests.**
  - Type test in `protocol-surface-types.test.ts`: inside the existing typed-surface block, add
    ```ts
    await chat.gather('chat/ask', {
      param: {},
      onReply: (reply) => {
        const text: string = reply.value // result type of chat/ask
        void text
      },
      signal: new AbortController().signal,
    })
    ```
    and keep the existing `ConfigOf<typeof internal.gather, 'chat/ask'>` assignability line passing.
    Adjust `text: string` to the actual declared `chat/ask` result type in that file.
  - Runtime in `gather-stream.test.ts`, built from the same fixtures `peer.test.ts` uses for a
    two-member group gather (read `peer.test.ts` / `peer-ledger-gather.test.ts` to find the helper
    that builds two peers over a memory hub):
    - `onReply` fires per reply through `peer.protocol(name).gather(...)` and receives the normalized
      DID the peer delivers;
    - an aborted signal passed to `gather` on a peer whose `ready` is held pending (use a hub/mux
      double whose first fetch never resolves, or whichever fixture hook existing dispose-race tests
      use to stall init) resolves `[]` within 100 ms;
    - the same on a disposed peer rejects with `PeerDisposedError`;
    - after `ready` resolves normally, the signal has no abort listener left (counting spies as in
      Task 1).

- [ ] **Step 2: Run to verify fail**

  Run: `pnpm --filter @kumiai/rpc exec vitest run test/gather-stream.test.ts` and
  `pnpm --filter @kumiai/rpc run test:types`
  Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `ProtocolSurface.gather`: config becomes `{ param: T['Param'] } & GatherOptions<T['Result']>` (and
    the `never` variant `{ param?: never } & GatherOptions<T['Result']>`); result unchanged.
  - Forwarding at ~816: pass `quorum`, `timeoutMs`, `onReply`, `signal`. Cast `onReply` only if the
    checker requires it; method syntax should make it assignable.
  - Add a helper next to `withReady`:
    ```ts
    const readyOrAbort = async (signal: AbortSignal | undefined): Promise<'ready' | 'aborted'> => {
      if (signal == null) {
        await ready
        return 'ready'
      }
      if (signal.aborted) return 'aborted'
      let onAbort: (() => void) | undefined
      const aborted = new Promise<'aborted'>((resolve) => {
        onAbort = () => resolve('aborted')
        signal.addEventListener('abort', onAbort, { once: true })
      })
      try {
        return await Promise.race([ready.then(() => 'ready' as const), aborted])
      } finally {
        if (onAbort != null) signal.removeEventListener('abort', onAbort)
      }
    }
    ```
  - `protocolMethod.gather`:
    ```ts
    gather: async (prc, config) => {
      const outcome = await readyOrAbort(config?.signal)
      assertLive()
      if (outcome === 'aborted') return []
      return surfaceFor(key).gather(prc, config)
    },
    ```
    A `ready` rejection propagates out of the race unchanged.

- [ ] **Step 4: Run to verify pass**

  Run: `pnpm --filter @kumiai/rpc exec vitest run` and `pnpm --filter @kumiai/rpc run test:types`
  Expected: PASS.

- [ ] **Step 5: Lint and commit**

  ```bash
  rtk proxy pnpm run lint
  git add packages/rpc
  git commit -m "feat(rpc): forward gather onReply and abort signal through the protocol surface"
  ```

### Task 3: Docs, release intent, full gate

**Files:**
- Modify: `packages/broadcast/README.md`, `packages/rpc/README.md`
- Create: `.changeset/gather-stream.md`

- [ ] **Step 1: README.** In each README's gather description, document: `onReply` (per accepted
  reply, authenticated `senderDID`, same object as the result, throwing ignored) and `signal` (abort
  resolves partial replies; pre-aborted resolves `[]` without sending; rpc: aborts the wait on `ready`).
  Surface only; no rationale essays.

- [ ] **Step 2: Change intent** `.changeset/gather-stream.md`:
  ```md
  ---
  "@kumiai/broadcast": minor
  "@kumiai/rpc": minor
  ---

  `gather` gains `onReply` (called once per accepted, attributed reply as it arrives) and `signal`
  (per-call `AbortSignal`; abort resolves with the replies collected so far, a pre-aborted signal
  resolves `[]` without sending). The rpc protocol surface forwards both and aborts its wait on the
  peer's initial readiness. Additive; existing callers are unaffected.
  ```
  Check `.changeset/roster-leaf-identity.md` for the exact bump keyword the repo uses within the
  band and match it.

- [ ] **Step 3: Full gate**

  Run: `pnpm exec turbo run test:types test:unit --force` — expect all successful and `Cached: 0`.
  Run: `pnpm exec vitest run --root tests/integration` — expect PASS (exported signature changed).

- [ ] **Step 4: Lint and commit**

  ```bash
  rtk proxy pnpm run lint
  git add packages/broadcast/README.md packages/rpc/README.md .changeset/gather-stream.md docs/superpowers/plans
  git commit -m "docs(rpc): document gather onReply and signal"
  ```
