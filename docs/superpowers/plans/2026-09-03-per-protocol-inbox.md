# Protocol isolation on the directed inbox — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** qa
**Mode:** tasks

**Goal:** Route each directed-inbox frame to exactly one protocol using an authenticated in-frame protocol discriminator, keeping the single shared inbox topic unchanged.

**Architecture:** Prepend a small fixed-width protocol tag INSIDE the MLS-sealed directed payload (before `crypto.wrap`), so it is AEAD-authenticated. The shared open-once path decodes the tag once and surfaces the protocol on `OpenedInbound`; each acceptor and directed client processes only frames tagged for its protocol. A peer-level responder NACKs frames tagged for an unregistered protocol, and directed clients get a default request timeout, so a dropped or unrouteable frame fails loudly instead of hanging. A separate, independent rider normalizes DIDs at ingress via `@kokuin/token`'s `normalizeDID`.

**Tech Stack:** TypeScript (ES2025, strict), `@kumiai/rpc`, `@enkaku/*`, `@kumiai/hub-tunnel`, `@sozai/codec`, `@kokuin/token`, vitest, biome.

**Spec:** `docs/superpowers/specs/2026-09-03-per-protocol-inbox-design.md` (read it — the plan argues from it).

## Global Constraints

- **Only `@kumiai/rpc` changes** (source + its own tests). `@kumiai/broadcast`, `@kumiai/mls-rpc`, `@kumiai/rpc-conformance`, and the hub packages do NOT change. No `GroupCrypto`/`GroupMLS` port-contract change — the port conformance suites (`rpc-conformance`, `hub-conformance`) are untouched. This is peer/integration behavior.
- Minor bump within the coupled version band (record a `pnpm change` intent; do not publish).
- Add `@kokuin/token` to `@kumiai/rpc`'s dependencies as `catalog:` (the catalog already pins `@kokuin/token: ^0.5.0` and `@kokuin/*` is a catalog group). Never `workspace:` for cross-repo deps.
- pnpm only. Do not edit generated files (`lib/`).
- TDD throughout; pair EVERY vitest step with `test:types` (`pnpm run test:types`) — vitest strips types, so a green test proves nothing about type correctness.
- Lint via `rtk proxy pnpm run lint` (the `rtk` shim fakes plain `pnpm run lint`/`pnpm exec biome`).
- Final verification: forced test run, confirm `Cached: 0` (turbo caches; `pnpm test -- --force` is broken — force via turbo/`--force` on the turbo invocation, or run the package's own `vitest run`).
- Comments terse: why + surprises only. British spelling in prose; American in identifiers. Capital `ID`/`DID`. `type` not `interface`, `Array<T>` not `T[]`, `#field` not `private`.

---

### Task 1: Directed-payload tag codec

A pure, standalone binary codec for the in-frame protocol discriminator. No crypto, no I/O — the smallest unit that carries its own test cycle. Mirrors `commit-frame.ts`'s fixed-width-length style.

**Files:**
- Create: `packages/rpc/src/directed-tag.ts`
- Test: `packages/rpc/src/directed-tag.test.ts`

**Interfaces:**
- Produces:
  - `const DIRECTED_TAG_VERSION = 0x00` (byte)
  - `encodeDirectedPayload(protocol: string, frame: Uint8Array): Uint8Array`
  - `decodeDirectedPayload(bytes: Uint8Array): { protocol: string; frame: Uint8Array }` — throws on a non-tagged (legacy/`{`-leading) or malformed buffer.
  - `isLegacyDirectedPayload(bytes: Uint8Array): boolean` (optional helper: `bytes.length === 0 || bytes[0] !== DIRECTED_TAG_VERSION`) — callers that must DROP rather than throw use this to avoid a try/catch.

**Format** (fixed-width, unambiguous by construction — the Spec B injectivity lesson):

```
VERSION(1 byte = 0x00) ‖ len(protocolUTF8) as uint16 BE ‖ protocolUTF8 ‖ frameBytes
```

- `0x00` is not a legal JSON leading byte (legacy directed frames are `JSON.stringify` output, starting `{` = 0x7B, or JSON leading whitespace 0x20/0x09/0x0A/0x0D), so the first byte alone distinguishes a tagged frame from a legacy one — no risk of misparsing legacy bytes as a bogus tag.
- uint16 BE caps the protocol name at 65535 UTF-8 bytes. The **encoder must reject** a longer name (registration imposes no byte bound — `topic.ts` rejects only NUL, ill-formed UTF-16, and the reserved prefix), never truncate modulo 65536.
- The decoder rejects: a buffer shorter than the 3-byte header, a wrong version byte, a length that overruns the buffer, and a protocol slice that is not well-formed UTF-8.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, test } from 'vitest'
import { fromUTF, toUTF } from '@sozai/codec'

import {
  DIRECTED_TAG_VERSION,
  decodeDirectedPayload,
  encodeDirectedPayload,
  isLegacyDirectedPayload,
} from './directed-tag.js'

describe('directed-tag codec', () => {
  test('round-trips protocol and frame', () => {
    const frame = new Uint8Array([1, 2, 3, 4])
    const encoded = encodeDirectedPayload('chat', frame)
    expect(encoded[0]).toBe(DIRECTED_TAG_VERSION)
    const decoded = decodeDirectedPayload(encoded)
    expect(decoded.protocol).toBe('chat')
    expect(decoded.frame).toEqual(frame)
  })

  test('recovers a protocol name containing arbitrary characters exactly', () => {
    const name = 'app/v1:room-42'
    const decoded = decodeDirectedPayload(encodeDirectedPayload(name, new Uint8Array([9])))
    expect(decoded.protocol).toBe(name)
  })

  test('recovers an empty frame and a multibyte protocol name', () => {
    const name = 'café/協定'
    const decoded = decodeDirectedPayload(encodeDirectedPayload(name, new Uint8Array(0)))
    expect(decoded.protocol).toBe(name)
    expect(decoded.frame.length).toBe(0)
  })

  test('rejects a legacy JSON frame by its version marker', () => {
    const legacy = fromUTF(JSON.stringify({ v: 1, sessionID: 's', seq: 0, kind: 'message' }))
    expect(legacy[0]).not.toBe(DIRECTED_TAG_VERSION)
    expect(isLegacyDirectedPayload(legacy)).toBe(true)
    expect(() => decodeDirectedPayload(legacy)).toThrow()
  })

  test('encoder rejects a protocol name exceeding the uint16 length', () => {
    const tooLong = 'x'.repeat(65536)
    expect(fromUTF(tooLong).length).toBeGreaterThan(0xffff)
    expect(() => encodeDirectedPayload(tooLong, new Uint8Array(1))).toThrow(/length|65535|tag limit/i)
  })

  test('decoder rejects a truncated header', () => {
    expect(() => decodeDirectedPayload(new Uint8Array([DIRECTED_TAG_VERSION, 0]))).toThrow()
  })

  test('decoder rejects a length that overruns the buffer', () => {
    // VERSION, len=10, but only 2 name bytes follow
    const bad = new Uint8Array([DIRECTED_TAG_VERSION, 0, 10, 65, 66])
    expect(() => decodeDirectedPayload(bad)).toThrow()
  })

  test('decoder rejects a non-well-formed-UTF-8 protocol slice', () => {
    // VERSION, len=1, 0xff is not valid UTF-8
    const bad = new Uint8Array([DIRECTED_TAG_VERSION, 0, 1, 0xff, 42])
    expect(() => decodeDirectedPayload(bad)).toThrow()
  })
})
```

Note: fix the obvious typo before running — `expect(...).toBeGreaterThan(0xffff)` (parenthesised).

- [ ] **Step 2: Run the tests, verify they fail**

Run: `cd packages/rpc && pnpm exec vitest run src/directed-tag.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the codec**

```typescript
import { fromUTF, toUTF } from '@sozai/codec'

/**
 * Format version of the directed-payload tag, AND the byte that tells a tagged frame from a
 * legacy one: legacy directed frames are `JSON.stringify` output (`hub-tunnel/frame.ts`), so they
 * begin with `{` or JSON leading whitespace — never `0x00`. The first byte alone disambiguates.
 */
export const DIRECTED_TAG_VERSION = 0x00

const VERSION_BYTES = 1
const LENGTH_BYTES = 2
const HEADER_BYTES = VERSION_BYTES + LENGTH_BYTES
const MAX_PROTOCOL_BYTES = 0xffff

/** Whether these bytes are NOT a tagged directed payload (empty, or a non-version leading byte). */
export function isLegacyDirectedPayload(bytes: Uint8Array): boolean {
  return bytes.length === 0 || bytes[0] !== DIRECTED_TAG_VERSION
}

/**
 * Prepend the authenticated protocol tag to a directed frame, to be sealed by `crypto.wrap`. The
 * fixed-width length makes the `protocol ‖ frame` split injective regardless of the name's bytes.
 */
export function encodeDirectedPayload(protocol: string, frame: Uint8Array): Uint8Array {
  const name = fromUTF(protocol)
  if (name.length > MAX_PROTOCOL_BYTES) {
    throw new Error(
      `encodeDirectedPayload: protocol name is ${name.length} bytes, exceeds the ${MAX_PROTOCOL_BYTES}-byte tag limit`,
    )
  }
  const out = new Uint8Array(HEADER_BYTES + name.length + frame.length)
  out[0] = DIRECTED_TAG_VERSION
  new DataView(out.buffer).setUint16(VERSION_BYTES, name.length, false)
  out.set(name, HEADER_BYTES)
  out.set(frame, HEADER_BYTES + name.length)
  return out
}

/**
 * Split a sealed directed payload into its protocol tag and inner frame. Throws on a legacy or
 * malformed buffer (a caller that must drop rather than throw checks {@link isLegacyDirectedPayload}
 * first). Never a partial read: an overrunning length or ill-formed UTF-8 name is rejected.
 */
export function decodeDirectedPayload(bytes: Uint8Array): { protocol: string; frame: Uint8Array } {
  if (bytes.length < HEADER_BYTES) {
    throw new Error('decodeDirectedPayload: buffer shorter than the tag header')
  }
  if (bytes[0] !== DIRECTED_TAG_VERSION) {
    throw new Error(`decodeDirectedPayload: unexpected version byte ${bytes[0]}`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const nameLength = view.getUint16(VERSION_BYTES, false)
  const frameStart = HEADER_BYTES + nameLength
  if (bytes.length < frameStart) {
    throw new Error('decodeDirectedPayload: protocol length overruns the buffer')
  }
  // `toUTF` is a fatal TextDecoder in this repo (fromUTF/toUTF wrap WHATWG codecs); ill-formed
  // UTF-8 throws here rather than yielding replacement chars.
  const protocol = toUTF(bytes.subarray(HEADER_BYTES, frameStart))
  return { protocol, frame: bytes.subarray(frameStart) }
}
```

Verify `toUTF` throws on invalid UTF-8. Check `node_modules/@sozai/codec/lib/index.d.ts` / its source: if `toUTF` is a non-fatal decoder (yields U+FFFD instead of throwing), replace the name decode with an explicit fatal `new TextDecoder('utf-8', { fatal: true }).decode(...)` so the "rejects non-well-formed UTF-8" test passes. Do not change `@sozai/codec`.

- [ ] **Step 4: Run the tests, verify they pass, then type-check**

Run: `cd packages/rpc && pnpm exec vitest run src/directed-tag.test.ts`
Expected: PASS.
Run: `cd packages/rpc && pnpm run test:types`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/rpc/src/directed-tag.ts packages/rpc/src/directed-tag.test.ts
git commit -m "feat(rpc): directed-payload protocol tag codec"
```

---

### Task 2: Decode the tag on the shared inbound path

`createInboxPath` is the ONE open-once path every directed consumer shares (`directed.ts:49`). Decode the tag here, once, and surface the protocol on `OpenedInbound`; set `payload` to the INNER frame so downstream `decodeFrame` still sees an unchanged hub-tunnel frame. Drop a legacy/malformed payload here (the open already happened; a lane rejects in its projection).

**Files:**
- Modify: `packages/rpc/src/directed.ts` (`OpenedInbound` type ~:23; `createInboxPath` project ~:56-64)
- Test: `packages/rpc/src/directed.test.ts` (add cases; create the file if absent)

**Interfaces:**
- Consumes: Task 1's `decodeDirectedPayload`, `isLegacyDirectedPayload`.
- Produces: `OpenedInbound` gains `protocol: string`; `OpenedInbound.payload` is now the tag-stripped inner frame.

- [ ] **Step 1: Write the failing test** (path-level, with a fake mux and a pass-through unwrap)

Drive `createInboxPath` through a minimal fake `HubMux` whose `onInbound(topicID, cb)` you can invoke by hand, and an `unwrap` that returns its input. Publish a tagged payload and assert the opened value carries `protocol` and the stripped `frame`; publish a legacy `{`-leading payload and assert NO opened value is delivered.

```typescript
import { describe, expect, test, vi } from 'vitest'
import { fromUTF } from '@sozai/codec'

import { createInboxPath, type OpenedInbound } from './directed.js'
import { encodeDirectedPayload } from './directed-tag.js'

function fakeMux() {
  let handler: ((message: any, ack: () => void) => void) | undefined
  return {
    onInbound(_topicID: string, cb: (message: any, ack: () => void) => void) {
      handler = cb
      return () => {
        handler = undefined
      }
    },
    deliver(payload: Uint8Array) {
      handler?.({ sequenceID: '1', senderDID: 'did:key:alice', topicID: 't', payload }, () => {})
    },
  }
}

describe('createInboxPath tag decoding', () => {
  test('surfaces the protocol and strips the tag', async () => {
    const mux = fakeMux()
    const path = createInboxPath({
      mux: mux as any,
      topicID: 't',
      unwrap: async (b: Uint8Array) => ({ payload: b, senderDID: 'did:key:alice' }),
    })
    const seen: Array<OpenedInbound> = []
    path((m) => seen.push(m))
    const inner = fromUTF(JSON.stringify({ v: 1, sessionID: 's', seq: 0, kind: 'message' }))
    mux.deliver(encodeDirectedPayload('chat', inner))
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0].protocol).toBe('chat')
    expect(seen[0].payload).toEqual(inner)
  })

  test('drops a legacy untagged frame', async () => {
    const mux = fakeMux()
    const path = createInboxPath({
      mux: mux as any,
      topicID: 't',
      unwrap: async (b: Uint8Array) => ({ payload: b, senderDID: 'did:key:alice' }),
    })
    const seen: Array<OpenedInbound> = []
    path((m) => seen.push(m))
    mux.deliver(fromUTF(JSON.stringify({ v: 1, sessionID: 's', seq: 0, kind: 'message' })))
    await new Promise((r) => setTimeout(r, 10))
    expect(seen).toHaveLength(0)
  })
})
```

Match the fake `unwrap`'s return shape to what `createOpenOncePath` expects (a `Uint8Array` OR `{ payload, senderDID }`; see `open-once.ts:61`). Adjust `as any` casts to the real exported types where possible.

- [ ] **Step 2: Run the test, verify it fails** (`protocol` is `undefined`).

Run: `cd packages/rpc && pnpm exec vitest run src/directed.test.ts`

- [ ] **Step 3: Add `protocol` to `OpenedInbound` and decode in the project**

```typescript
export type OpenedInbound = {
  sequenceID: string
  /** Recovered from the ciphertext by the open, never the hub-asserted one. */
  senderDID: string
  topicID: string
  /** The protocol this frame is tagged for, decoded from the sealed in-frame discriminator. */
  protocol: string
  /** The inner hub-tunnel frame, with the protocol tag stripped. */
  payload: Uint8Array
}
```

In `createInboxPath`'s `project` (currently `directed.ts:56-64`):

```typescript
    project: (message, opened) => {
      if (opened.senderDID == null) return undefined
      // The tag is inside the seal, so it is authenticated to the recovered sender. A legacy or
      // malformed payload is dropped HERE — the open already spent the ratchet key.
      if (isLegacyDirectedPayload(opened.payload)) return undefined
      let decoded: { protocol: string; frame: Uint8Array }
      try {
        decoded = decodeDirectedPayload(opened.payload)
      } catch {
        return undefined
      }
      return {
        sequenceID: message.sequenceID,
        senderDID: opened.senderDID,
        topicID: message.topicID,
        protocol: decoded.protocol,
        payload: decoded.frame,
      }
    },
```

Add the import: `import { decodeDirectedPayload, isLegacyDirectedPayload } from './directed-tag.js'`.

- [ ] **Step 4: Run the test and type-check**

Run: `cd packages/rpc && pnpm exec vitest run src/directed.test.ts && pnpm run test:types`
Expected: PASS. Type-check will flag every downstream consumer of `OpenedInbound` that must now supply/consume `protocol` — Task 3 handles those, so a `test:types` failure pointing only at `createDirectedClient`/`createInboxAcceptor` is expected here; if so, note it in the report and proceed (Task 3 resolves it). If you can satisfy the type without behavioral change (the consumers already spread/ignore extra fields), prefer that.

- [ ] **Step 5: Commit**

```bash
git add packages/rpc/src/directed.ts packages/rpc/src/directed.test.ts
git commit -m "feat(rpc): decode protocol tag on the shared directed inbound path"
```

---

### Task 3: Tag on send, filter on receive, wire per-protocol names

Make each directed client and acceptor tag its outbound frames and process only inbound frames tagged for its own protocol; thread the protocol name through `peer.ts`'s `buildEpoch`. This closes the double-execution and spurious-error-reply defects. Ends with peer-level isolation integration tests.

**Files:**
- Modify: `packages/rpc/src/directed.ts` (`DirectedClientParams` +`protocol`; client `hub.publish` ~:100 and receive filter ~:120; `InboxAcceptorParams` +`protocolName`; acceptor session `hub.publish` ~:210 and inbound filter ~:297)
- Modify: `packages/rpc/src/peer.ts` (`buildEpoch` acceptor wiring ~:612-621; `.to()` client wiring ~:701-713)
- Test: `packages/rpc/src/directed-isolation.test.ts` (new — peer-level integration)

**Interfaces:**
- Consumes: Task 1 `encodeDirectedPayload`; Task 2's `OpenedInbound.protocol`.
- Produces: `DirectedClientParams` requires `protocol: string`; `InboxAcceptorParams` requires `protocolName: string`.

- [ ] **Step 1: Write the failing integration tests**

Use the existing peer-level test harness (find how current `@kumiai/rpc` tests build peers — search for `createGroupPeer` in `packages/rpc/src/*.test.ts` and reuse the FakeHub + fake crypto double + two-member group helper; do NOT invent a new harness if one exists). Define two protocols, `alpha` and `beta`, each with a same-named procedure `ping`. Assertions:

1. A directed call `peerA.protocol('alpha').to(bDID).request('ping', ...)` runs `beta`'s `ping` handler **zero** times on B and `alpha`'s **once**.
2. The caller receives `alpha`'s single reply and **no** error reply from `beta`'s server (assert the returned value equals `alpha`'s result; assert the call resolves, not rejects).
3. Two clients from A to the same member B — one on `alpha`, one on `beta` — each receive only their own protocol's reply (issue both, assert each resolves to its own protocol's distinct result).

Give each protocol's `ping` a distinct return so a cross-delivered reply is detectable. Count handler invocations with a shared counter closed over by the handlers.

- [ ] **Step 2: Run the tests, verify they fail** (today both handlers run / a spurious reply can win).

Run: `cd packages/rpc && pnpm exec vitest run src/directed-isolation.test.ts`

- [ ] **Step 3: Tag + filter in the directed client**

In `DirectedClientParams` add `protocol: string`. Destructure it. In `hub.publish`, tag before wrap:

```typescript
    async publish(publishParams) {
      return mux.mailbox.publish({
        senderDID: publishParams.senderDID,
        topicID: publishParams.topicID,
        payload: await wrap(encodeDirectedPayload(protocol, publishParams.payload), {
          aad: fromUTF(publishParams.topicID),
        }),
      })
    },
```

In the receive listener (currently `directed.ts:120`), add the protocol predicate:

```typescript
      unsubscribe = inbound((message) => {
        if (
          closed ||
          message.topicID !== receiveTopicID ||
          message.protocol !== protocol ||
          message.senderDID !== memberDID
        )
          return
        // ...unchanged
      })
```

Add `import { encodeDirectedPayload } from './directed-tag.js'` (Task 2 may have added it already).

- [ ] **Step 4: Tag + filter in the acceptor**

In `InboxAcceptorParams` add `protocolName: string` (distinct from the existing `protocol: Protocol` definition object — the tag needs the string NAME). Destructure it. In the session `sessionHub.publish` (currently `directed.ts:210`), tag before wrap:

```typescript
      async publish(publishParams) {
        const sealed = await wrap(encodeDirectedPayload(protocolName, publishParams.payload), {
          aad: fromUTF(publishParams.topicID),
        })
        return mux.mailbox.publish({
          senderDID: publishParams.senderDID,
          topicID: publishParams.topicID,
          payload: sealed,
        })
      },
```

In the inbound listener (currently `directed.ts:297`), filter by protocol first:

```typescript
  const unsubscribe = inbound((message) => {
    if (message.topicID !== selfInboxTopic || message.protocol !== protocolName) return
    // ...unchanged: decodeFrame(message.payload) etc.
  })
```

`message.payload` is the tag-stripped inner frame (Task 2), so `decodeFrame` and `session.feed` are unchanged.

- [ ] **Step 5: Thread the protocol name through `peer.ts`**

In `buildEpoch` (`peer.ts:612`), pass `protocolName: name` to `createInboxAcceptor`. In `.to()` (`peer.ts:701`), pass `protocol: name` to `createDirectedClient` — `name` is the protocol key of the enclosing `surfaceFor(name)`/runtime; confirm it is in scope at `.to()` (it is the `name` closed over by `surfaceFor`). If `.to()` cannot see the protocol name, thread it via the `ProtocolRuntime` or `surfaceFor`'s closure — do NOT read it from anywhere dynamic.

- [ ] **Step 6: Run the integration tests, the full rpc suite, and type-check**

Run: `cd packages/rpc && pnpm exec vitest run src/directed-isolation.test.ts src/directed.test.ts && pnpm run test:types`
Expected: PASS. Then run the whole unit suite to catch regressions: `pnpm exec vitest run`.
Expected: PASS (existing directed tests must still pass — they now go through a tagged round trip).

- [ ] **Step 7: Commit**

```bash
git add packages/rpc/src/directed.ts packages/rpc/src/peer.ts packages/rpc/src/directed-isolation.test.ts
git commit -m "feat(rpc): route directed frames to the owning protocol via the in-frame tag"
```

---

### Task 4: Failure legibility — unrouted-tag NACK + default directed timeout

A frame tagged for a protocol NO acceptor on this peer claims is now silently dropped (Task 3 filters it out everywhere), which regresses today's `INVALID_MESSAGE` reply for an unknown procedure. Restore legibility with a peer-level NACK responder, and give directed clients a default request timeout as the unary backstop.

**Files:**
- Modify: `packages/rpc/src/directed.ts` (add `createUnroutedTagResponder`; add a default `requestTimeoutMs` to the client `Client` construction ~:159)
- Modify: `packages/rpc/src/peer.ts` (`buildEpoch`: create the responder on the shared `inboxLane.path`, dispose in `teardownEpoch`)
- Test: `packages/rpc/src/directed-legibility.test.ts` (new)

**Interfaces:**
- Consumes: `OpenedInbound` (`protocol`, `senderDID`, `payload`); `decodeFrame` (`hub-tunnel`); `HandlerError` + error code (`@enkaku/server`/`@enkaku/protocol`); Task 1 `encodeDirectedPayload`.
- Produces: `createUnroutedTagResponder(params): { dispose: () => void }`.

**The NACK's three hard constraints** (from the spec — violating any makes it worse than nothing):
1. **Echo the caller's tag.** Tag the NACK with the *unrouted* protocol from the offending frame, not one of ours — else the caller's own protocol filter (Task 3) discards it.
2. **Only NACK request-like frames.** Restrict to `body.payload.typ ∈ {request, stream, channel, send}` (exactly enkaku's own invalid-message path, `server.js:253`). A `result`/`error`/`receive` reply also carries an `rid`; NACKing those lets two peers that both lack the tag volley error frames forever.
3. **Fresh, non-stale session sequence.** The caller's client tunnel drops `frame.seq < expectedSeq` (`hub-tunnel/transport.ts:427`) and locks its session to the offending frame's `sessionID` (`:403`). So the NACK MUST reuse the offending frame's `sessionID` and carry a `seq` the caller has not passed — use a per-responder monotonically increasing counter.

- [ ] **Step 1: Write the failing legibility tests** (peer-level)

Using the same harness as Task 3:

1. A directed unary `request` to a protocol the recipient has NOT registered **rejects** (does not hang). Give the test a bounded timeout; assert it rejects well under the default `requestTimeoutMs`, proving the NACK — not the timeout — drove it. (To register a client for an unknown protocol, drive a peer that defines `alpha` locally but call a protocol the *remote* lacks — e.g. remote peer B defines only `alpha`, caller A defines `alpha`+`beta` and calls `beta`.to(bDID); B NACKs the `beta` tag.)
2. The NACK carries the caller's protocol tag (assert the caller's `beta` client actually rejects — if the tag were wrong, its filter would drop the NACK and the call would instead hang to timeout).
3. No NACK ping-pong: construct/deliver a *reply-typed* frame (`typ: 'error'`) tagged for an unregistered protocol and assert the responder publishes nothing (spy on `mux.mailbox.publish`).
4. The default `requestTimeoutMs` still fires as a backstop when no NACK is possible (e.g. frame simply never answered): assert a unary call rejects on timeout, and that a caller-supplied `requestTimeoutMs` override is honoured.

- [ ] **Step 2: Run, verify failure.**

Run: `cd packages/rpc && pnpm exec vitest run src/directed-legibility.test.ts`

- [ ] **Step 3: Add the default request timeout**

Confirm the option name and application: `node_modules/@enkaku/client/lib/client.d.ts:71` (`requestTimeoutMs`), applied at `client.js:499`, unary-only (`client.js:517`). In `createDirectedClient`, thread an optional `requestTimeoutMs` param with a sensible default (choose a concrete value, e.g. `DEFAULT_DIRECTED_REQUEST_TIMEOUT_MS = 30_000`, exported so a caller can see it) and pass it to `new Client<Protocol>({ transport, serverID: memberDID, requestTimeoutMs })`. A caller override flows through `.to()` → `createDirectedClient`. Reach: unary only; stream/channel creation does not accept a timeout — this is the accepted limit stated in the spec, covered by the NACK.

- [ ] **Step 4: Implement `createUnroutedTagResponder`**

```typescript
import { HandlerError } from '@enkaku/server'
// Confirm the error-code constant: ErrorCodes.INVALID_MESSAGE from '@enkaku/protocol' if exported,
// else the literal 'INVALID_MESSAGE' (the value enkaku's server uses, server.js:253).

const REQUEST_LIKE = new Set(['request', 'stream', 'channel', 'send'])

export type UnroutedTagResponderParams = {
  mux: HubMux
  localDID: string
  inbound: InboundPath
  /** Protocol names this peer serves; a tag outside this set is unrouted. */
  isRegistered: (protocol: string) => boolean
  /** The topic to reply on for an authenticated sender — the sender's own inbox. */
  resolveSendTopic: (senderDID: string) => string
  wrap: GroupCrypto['wrap']
}

/**
 * Restores failure legibility for a frame tagged for a protocol this peer does not serve. Task 3's
 * per-protocol filter means no acceptor is fed such a frame, so none would NACK it; this one
 * peer-level consumer of the shared inbound path does, so a caller's unary request rejects (and a
 * stream/channel creation, which the client timeout cannot abort) instead of hanging silently.
 */
export function createUnroutedTagResponder(
  params: UnroutedTagResponderParams,
): { dispose: () => void } {
  const { mux, localDID, inbound, isRegistered, resolveSendTopic, wrap } = params
  let seq = 0
  const unsubscribe = inbound((message) => {
    if (isRegistered(message.protocol)) return
    let frame: ReturnType<typeof decodeFrame>
    try {
      frame = decodeFrame(message.payload)
    } catch {
      return
    }
    if (frame.kind !== 'message') return
    const payload = frame.body.payload
    const rid = payload.rid
    if (typeof rid !== 'string' || !REQUEST_LIKE.has(payload.typ)) return
    // Reply on the caller's inbox, on the caller's own session, with a fresh seq (the tunnel drops
    // a stale one), tagged with the caller's unrouted protocol so their client filter accepts it.
    const errorPayload = new HandlerError({
      code: 'INVALID_MESSAGE',
      message: `No handler registered for protocol "${message.protocol}"`,
    }).toPayload(rid)
    const nack = encodeFrame({
      v: 1,
      sessionID: frame.sessionID,
      seq: seq++,
      kind: 'message',
      body: { header: {}, payload: errorPayload },
    })
    void (async () => {
      const topicID = resolveSendTopic(message.senderDID)
      const sealed = await wrap(encodeDirectedPayload(message.protocol, nack), {
        aad: fromUTF(topicID),
      })
      await mux.mailbox.publish({ senderDID: localDID, topicID, payload: sealed })
    })()
  })
  return { dispose: unsubscribe }
}
```

Add `encodeFrame` to the `@kumiai/hub-tunnel` import. Verify: (a) `HandlerError.toPayload(rid)` returns `{ typ:'error', rid, code, msg }` (`@enkaku/server/lib/error.js`); (b) the hand-built enkaku error `body` passes the caller's `Client` reply validator so the call actually rejects — the Step-1 test is the proof; if the caller does not reject, inspect the on-wire shape a real acceptor's error reply produces and match `header`/`payload` exactly. Fresh-seq caveat: if `expectedSeq` on a virgin client session is not 0, a `seq` of 0 could be dropped — the test will catch it; if so, start `seq` high (still monotonic) or read the tunnel's initial `expectedSeq`.

- [ ] **Step 5: Wire into `buildEpoch` and `teardownEpoch`**

In `buildEpoch`, after building `inboxLane`, create ONE responder on the shared path and store it for teardown:

```typescript
    unroutedTagResponder = createUnroutedTagResponder({
      mux,
      localDID,
      inbound: inboxLane.path,
      isRegistered: (name) => Object.hasOwn(protocols, name),
      resolveSendTopic: (senderDID) => inboxTopic(anchor.secret, anchor.epoch, senderDID),
      wrap: crypto.wrap,
    })
```

Declare `let unroutedTagResponder: { dispose: () => void } | undefined` beside `inboxLane`, and in `teardownEpoch` call `unroutedTagResponder?.dispose()` then set it `undefined` (dispose it BEFORE the shared path's consumers are gone — order it with the acceptor disposals; `dispose` here is just an unsubscribe, so it cannot reject).

- [ ] **Step 6: Run legibility tests, full suite, type-check**

Run: `cd packages/rpc && pnpm exec vitest run src/directed-legibility.test.ts && pnpm run test:types && pnpm exec vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/rpc/src/directed.ts packages/rpc/src/peer.ts packages/rpc/src/directed-legibility.test.ts
git commit -m "feat(rpc): NACK unrouted directed tags and default the directed request timeout"
```

---

### Task 5: Rider — normalize DIDs at ingress

Independent correctness fix: `normalizeDID` (`@kokuin/token`) at every point an MLS-recovered or caller-supplied DID enters `@kumiai/rpc`, so equivalent DID forms compare equal and a long-form caller converges onto the canonical inbox topic. Canonicalizes, does not validate.

**Files:**
- Modify: `packages/rpc/package.json` (add `"@kokuin/token": "catalog:"` to `dependencies`)
- Modify: `packages/rpc/src/peer.ts` (normalize `localDID` at construction; `memberDID` in `.to()`; recovered `senderDID` in `createInboxPath`/`createInboundPath` projects; `committerDID` from `readCommitHeader`; `rosterDIDs()` results)
- Modify: `packages/rpc/src/app-lane.ts` if its recovered `senderDID` (`:445`) is not already normalized by the ingress point that feeds it
- Test: `packages/rpc/src/did-normalization.test.ts` (new) + a golden inbox-topic pin

**Interfaces:**
- Consumes: `normalizeDID(did: string): string` from `@kokuin/token`.

**Ingress sites** (normalize AS the value enters rpc — do not scatter normalize calls at every comparison):
- Caller-supplied: `localDID` at peer construction (`peer.ts:350`), `memberDID` at `.to()` (`peer.ts:696`, and the `withReady` wrapper `:2051` — normalize once, at the innermost `.to()`).
- MLS-recovered: the open's `senderDID` in `createInboxPath`'s project (`directed.ts`) and `createInboundPath`'s project (`peer.ts:511-519`, where `openedFrames` is keyed); `committerDID` from `port.readCommitHeader` (`peer.ts:1231`); every DID in `port.rosterDIDs()` (`peer.ts:1090`, `:1108`).
- **Left raw deliberately:** the hub-asserted `message.senderDID` in commit context (`peer.ts:1282`, `:1288`) — documented as auxiliary, never an MLS authorization input. Do NOT normalize it; add a one-line comment if none exists.

- [ ] **Step 1: Write the failing tests**

```typescript
// Peer-level: a member addressed in LONG form is reached and its replies matched when MLS
// returns the SHORT credential form.
test('directed call to a long-form DID matches short-form MLS replies', async () => {
  // build a two-member group where B's short credential id is `shortB`; call peerA.to(longB)
  // where normalizeDID(longB) === shortB; assert the request resolves.
})

// detectRosterChange does not fire on an equivalent-form flip (unit — normalize before diffing).
test('roster change is not detected on an equivalent DID-form flip', () => {
  // if normalization is applied at the rosterDIDs ingress, detectRosterChange sees identical sets
})

// self-echo suppression holds across DID forms (app-lane): a frame whose recovered sender
// normalizes to localDID is suppressed even if MLS returned a different form.

// Golden: a short-form DID's inbox topic is byte-identical to today (no rotation).
test('short-form inbox topic is unchanged (golden pin)', () => {
  expect(inboxTopic(SECRET, EPOCH, SHORT_DID)).toBe('<pin the current literal value>')
})
```

For the golden pin: first compute today's value (run `inboxTopic` with fixed inputs before making changes), paste the literal, and assert equality — proving normalization moved no short-form topic. Reuse Spec B's golden-pin approach if a helper exists.

- [ ] **Step 2: Run, verify failure / compute the golden.**

- [ ] **Step 3: Add the dependency**

Add to `packages/rpc/package.json` `dependencies` (alphabetical — before `@kumiai/broadcast`): `"@kokuin/token": "catalog:"`. Then `pnpm install` at the repo root to update the lockfile.

- [ ] **Step 4: Apply `normalizeDID` at each ingress**

`import { normalizeDID } from '@kokuin/token'`. Then:
- Construction: `const localDID = normalizeDID(params.localDID)` (or normalize the destructured `localDID` once — ensure every downstream use sees the normalized value).
- `.to(memberDID)`: `const member = normalizeDID(memberDID)`; use `member` for the cache key, `sendTopicID` derivation, and `createDirectedClient`'s `memberDID`.
- `createInboundPath` project: `openedFrames.set(payload, { payload, senderDID: normalizeDID(senderDID) })`, and use the normalized value in the `undefined`-guard.
- `createInboxPath` project: `senderDID: normalizeDID(opened.senderDID)`.
- `readCommitHeader` result: normalize `committerDID` where the header is consumed (`peer.ts:1231-1232`) before it reaches `classifyCommit`.
- `rosterDIDs()`: `(await port.rosterDIDs()).map(normalizeDID)` at both `:1090` and `:1108`.
- `app-lane.ts:445`: if the `opened.senderDID` there flows from the same `crypto.unwrap` NOT via the normalized ingress, normalize at that open; if it already comes normalized, leave it and note why.

Keep each change surgical; add a terse comment only where the normalization is non-obvious (e.g. the deliberately-raw `peer.ts:1282`).

- [ ] **Step 5: Run the tests, full suite, type-check**

Run: `cd packages/rpc && pnpm exec vitest run src/did-normalization.test.ts && pnpm run test:types && pnpm exec vitest run`
Expected: PASS, golden pin green.

- [ ] **Step 6: Commit**

```bash
git add packages/rpc/package.json pnpm-lock.yaml packages/rpc/src/peer.ts packages/rpc/src/app-lane.ts packages/rpc/src/did-normalization.test.ts
git commit -m "fix(rpc): normalize DIDs at ingress via @kokuin/token"
```

---

## Final verification (after all tasks)

- Whole-branch review on the most capable model.
- At least one blind adversarial Codex review, briefed with the isolation and authentication QUESTIONS, never the expected answers.
- Confirm the isolation fix rotates nothing: app broadcast, commit, rendezvous, and short-form inbox topics byte-identical (the Task 5 golden pin plus a manual spot check). The only permitted movement is Rider 2 converging a long-form DID onto its short-form topic.
- `rtk proxy pnpm run lint` clean.
- Forced full test run for `@kumiai/rpc`, confirm `Cached: 0`.
- Record a `pnpm change` (minor) intent for the coupled band. Do not publish.

## Notes carried from the spec (do not lose)

- **Mixed-version is a hard cutover.** All group peers reach this version together. A wire-format mismatch drops (the `0x00` version byte prevents any misroute); a long-form-DID topic mismatch means the two sides never meet. An upgraded caller's unary straddle rejects on the default timeout; legacy and stream/channel straddles hang — accepted cost, NOT a bug to "fix" with a dual-format transition (that would reopen the cross-delivery this closes).
- **Why the tag is inside the seal:** outside, a lying hub could flip it and misroute onto the shared key. Inside, the AEAD authenticates it; a member can only tag their OWN frames, and every member may already call every protocol — no privilege boundary. It is an accidental-cross-delivery and reply-routing fix, not authorization (`Server` is `requireAuth: false`).
- **Out of scope, do not touch:** per-protocol inbox TOPICS (rejected — mailbox class loses undelivered frames on rotation), the app-topic subscription leak (~R×P), `discoveryTopic`, hub-level metadata separation, session-end stranding on disposal.
