# Probe report — sec-3: cross-group isolation rests on one throw

Status: **DONE**. All five "done when" items met. Changes uncommitted on `feat/app-lane-delivery`.

## What the defect actually was

Confirmed as briefed, and the confirmation is sharper than "no test covers it": with today's fake, a
foreign-key frame does not merely slip through — it is *silently* dropped by `decodeFrame`, one layer
too late and with **zero** observability events. The transport could not tell you it had rejected a
foreign group's frame, because it never knew it had one. That is what made the gap invisible: the
suite saw "the right message arrived" and stopped asking why.

## Changes

All in `packages/hub-tunnel/`. Nothing outside it was touched.

### 1. The fake's tag is derived from the key

`packages/hub-tunnel/test/fixtures/fake-encryptor.ts` — `TAG_BYTE_0` / `TAG_BYTE_1` constants
replaced by `deriveTag(key)`, FNV-1a over the key bytes, 4 bytes (was 2). `#tag` is computed once in
the constructor and both `encrypt` and `decrypt` use it.

Widened to 4 bytes deliberately: at 2 bytes an arbitrary foreign key collides with ours 1-in-65536,
and a fixture that is *usually* strict is the same class of trap as one that is never strict. The
error message (`invalid tag`) and the `corruptNextCiphertexts` tamper simulation are unchanged, so
the existing fixture tests bind exactly as before.

The tag covers the key only, not the ciphertext — it is not a MAC. That is stated in the comment.
It is enough here because tamper is simulated by flipping a tag byte, and because the rule that
matters is "the fake must never be *more* permissive than the port". Stricter is safe; more
permissive is the defect.

### 2. `groupID` is checked on receive

`packages/hub-tunnel/src/encrypted-transport.ts` — before the `decrypt` call, a frame whose
`envelope.groupID` is not this transport's is dropped and `{ type: 'frame-dropped', reason:
'group-mismatch' }` is emitted. `'group-mismatch'` added to `FrameDroppedReason` in
`packages/hub-tunnel/src/events.ts`.

The comment argues the honest case, as asked. Against a *working* AEAD this catches little: a
foreign group's frame is encrypted under a key we do not hold and fails to decrypt anyway. What it
catches is the case the cipher structurally cannot see — **same key, wrong group**: a misroute, or a
configuration error that puts two groups on one key or one topic. There the bytes authenticate
perfectly and are still not ours. It is one string compare before any crypto, so the cost of keeping
it is nil, and the cost of trusting the cipher for a property the envelope states in the clear is a
silent cross-group delivery. The receive path's shape did not fight this — it dropped in cleanly
next to the existing `envelope-decode` and `decrypt` drops, no restructuring.

### 3. Both `fake-hub.ts` divergences fixed (they were genuinely small)

`packages/hub-tunnel/test/fixtures/fake-hub.ts`:

- **Sender echo.** One `continue`. The real server does exactly this at
  `packages/hub-server/src/handlers.ts:156` (`if (recipientDID === senderDID) continue`), so this is
  matching the port, not inventing behaviour.
- **Unpadded sequenceIDs.** `String(++this.#sequence)` → `.padStart(12, '0')`, matching
  `packages/hub-server/src/memoryStore.ts:55`. No hub-tunnel test asserts on a sequenceID value
  (grepped), so this was zero-risk, and it removes the 9→10 lexicographic trap before some future
  ordering test steps on it.

Both were one-liners with the suite green after, so I did them rather than filing them.

## Tests

New: `packages/hub-tunnel/test/encrypted-transport-isolation.test.ts`, two tests. Both drive the
transport's **real receive path** — no direct calls into the fake, no failure-injection controls.

Each test wires three transports on one hub and varies exactly one dimension, so nothing but the
property under test can explain the result:

1. **Foreign key.** Same group, same session, same topic — only the key differs. The foreign frame
   must be rejected by the cipher, and a following same-key frame must still arrive.
2. **Wrong groupID.** Same key, same session — the frame decrypts and parses cleanly. Only the
   envelope's group says it is not ours.

The existing `failNextDecrypts` / `corruptNextCiphertexts` tests are untouched. They test a
different thing (injected failure, wire tamper) and still pass unchanged.

### Red first

Both new tests run against the original fake and the original transport:

```
PASS (0) FAIL (2)

1. ... a frame encrypted under a foreign key is rejected on the receive path
   AssertionError: expected +0 to be 1 // Object.is equality
       at .../encrypted-transport-isolation.test.ts:70:36
2. ... a frame for another groupID is dropped even though it decrypts cleanly
   AssertionError: expected 'theirs' to be 'ours' // Object.is equality
       at .../encrypted-transport-isolation.test.ts:143:43
```

Red for the right reasons: (1) zero `decrypt-failed` events — the foreign-key frame was accepted by
the fake and only died later at frame decode; (2) the other group's message was delivered to us
verbatim.

### Mutation checks

**A — revert the fake's tag to key-independent** (`for (const byte of key)` → `for (const byte of
[])`, making `deriveTag` ignore the key and return a constant):

```
PASS (1) FAIL (1)

1. ... a frame encrypted under a foreign key is rejected on the receive path
   AssertionError: expected +0 to be 1 // Object.is equality
       at .../encrypted-transport-isolation.test.ts:70:36
```

Test (1) red, test (2) unaffected. Inverted by hand.

**B — remove the `groupID` check** (`if (envelope.groupID !== groupID)` → `if (false as boolean)`):

```
PASS (1) FAIL (1)

1. ... a frame for another groupID is dropped even though it decrypts cleanly
   AssertionError: expected 'theirs' to be 'ours' // Object.is equality
       at .../encrypted-transport-isolation.test.ts:143:43
```

Test (2) red — the other group's frame is delivered as ours. Test (1) unaffected. Inverted by hand.

Each test is pinned by exactly one mutation, which is what makes them independent rather than two
views of one assertion.

## Verify (repo root)

```
$ pnpm run build
 Tasks:    8 successful, 8 total

$ rtk proxy pnpm run lint
Checked 225 files in 231ms. No fixes applied.
lint exit: 0

$ pnpm test
 Tasks:    30 successful, 30 total

@kumiai/hub-tunnel:test:unit:  Test Files  21 passed (21)
@kumiai/hub-tunnel:test:unit:       Tests  65 passed (65)
```

Mid-probe, lint reported 2 warnings in `packages/rpc/src/hub-mux.ts` (unused import, unused
variable) — a concurrent probe's file, not mine and not touched. They were gone by the final run;
that probe fixed them.

## Concerns

- **The production `Encryptor` port is still unproven.** This probe fixed the *fixture* so the suite
  can no longer be fooled by a non-authenticating cipher. It does not prove the real implementation
  authenticates. Nothing in `packages/hub-tunnel/` binds the port to AEAD semantics — no conformance
  test says "a wrong-key ciphertext must throw". A shared `Encryptor` conformance suite that both
  `FakeEncryptor` and every real implementation must pass is the durable fix; the fake being strict
  is only the half that stops the suite lying.
- **`groupID` is unauthenticated.** It sits in the clear in the envelope and is not covered by the
  cipher, so an attacker who can write to the topic can set it to anything. The new check is
  defence-in-depth against misroutes and misconfiguration, exactly as scoped — it is not an
  authorization boundary and must not be read as one. Binding it as AEAD associated data would make
  it one; that is a port-level change and out of this probe's scope.
- **`FakeHub` has no retention or redelivery**, so the `ack` half of `HubReceiveSubscription` is
  exercised nowhere in this package. Not in scope here, but it is a second place where the fixture
  is thinner than the port.
