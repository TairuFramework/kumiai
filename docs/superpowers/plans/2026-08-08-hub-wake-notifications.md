# Hub Wake Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wake a device whose app is suspended so it opens a hub connection, without telling the push provider anything about the group, the topic, or the content.

**Architecture:** `hub-protocol` gains two procedures, the `WakeRegistry`/`WakeSender` port types, and an RFC 8291 seal. `hub-server` gains an optional `wake` param carrying a registry and a sender, plus a leading-edge per-DID debounce dispatcher called from the existing publish fan-out loop. A new `@kumiai/hub-wake` package holds the in-memory registry and two senders. `hub-client` gains registration and unsealing.

**Tech Stack:** TypeScript ESM, pnpm workspaces, turbo, vitest, biome. Crypto from `@noble/curves` (P-256), `@noble/hashes` (HKDF/SHA-256), `@noble/ciphers` (AES-128-GCM) — all already in the workspace catalog, all pure JS so they run under React Native.

**Spec:** `docs/superpowers/specs/2026-08-08-hub-wake-notifications-design.md`

## Global Constraints

- pnpm only. Never edit `lib/` — it is generated.
- Internal deps are `workspace:^`; cross-repo deps (`@sozai/*`, `@kokuin/*`, `@enkaku/*`, `@noble/*`) go through the workspace catalog as `catalog:`, never `workspace:`.
- All eleven existing packages share one version band; `@kumiai/hub-wake` joins it at the current version (`0.6.0`).
- Lint with `rtk proxy pnpm run lint` — a bare `pnpm run lint` or `pnpm exec biome` is intercepted by a shim and reports nothing useful.
- `pnpm test` reports cached turbo results. To verify a change, run the package's own `pnpm test` from its directory, or check `Cached: 0` in turbo output.
- Every package script set matches `packages/hub-tunnel/package.json`: `test` = `test:types` then `test:unit`; `test:types` = `tsc --noEmit -p tsconfig.test.json`; `test:unit` = `vitest run`.
- New enkaku procedures are added, never widened — `additionalProperties: false` stays sealed on every schema.
- A test double may be stricter than its port, never more permissive.
- The wake ping never carries anything in cleartext. `topicID`, `sequenceID` and `count` are sealed; nothing else is sent.
- Sealed bodies are constant size regardless of hint contents.
- `WAKE_RECORD_SIZE` is `512`. `WAKE_HINT_VERSION` is `1`.

---

## File Structure

**`packages/hub-protocol/`**
- Create `src/wake.ts` — `WakeRegistration`, `WakeRegistry`, `WakeSender`, `WakeVerdict` types. Types only, no runtime code.
- Create `src/wake-envelope.ts` — `sealWakeHint`, `openWakeHint`, `WAKE_HINT_VERSION`, `WAKE_RECORD_SIZE`, `WakeHint`.
- Modify `src/errors.ts` — add `WakeNotSupportedError` and its wire code.
- Modify `src/protocol.ts` — add `hub/v1/wake/register` and `hub/v1/wake/unregister`.
- Modify `src/index.ts` — export the above.
- Create `test/wake-envelope.test.ts`.

**`packages/hub-conformance/`**
- Create `src/wake-registry.ts` — `testWakeRegistryConformance`.
- Modify `src/index.ts` — export it.

**`packages/hub-wake/`** (new package)
- Create `package.json`, `tsconfig.json`, `tsconfig.test.json`, `README.md`, `src/index.ts`.
- Create `src/memoryRegistry.ts` — in-memory `WakeRegistry`.
- Create `src/webPushSender.ts` — generic HTTP sender with VAPID.
- Create `src/expoSender.ts` — Expo Push API sender.
- Create `test/memoryRegistry.test.ts`, `test/webPushSender.test.ts`, `test/expoSender.test.ts`.

**`packages/hub-server/`**
- Create `src/wake.ts` — `createWakeDispatcher`.
- Modify `src/handlers.ts` — two handlers, the publish-loop hook, the receive-bind hook.
- Modify `src/hub.ts` — the `wake` param.
- Modify `src/index.ts` — exports.
- Create `test/wake.test.ts`, `test/handlers-wake.test.ts`.

**`packages/hub-client/`**
- Modify `src/client.ts` — `registerWake`, `unregisterWake`.
- Create `src/wake-keys.ts` — `createWakeKeys`.
- Modify `src/index.ts` — export `createWakeKeys` and re-export `openWakeHint`.
- Create `test/wake.test.ts`.

**Docs**
- Create `docs/reference/wake-notifications.md`.
- Modify `docs/agents/architecture.md` — reference table row, package list.
- Modify `AGENTS.md` — package list, eleven → twelve.

---

### Task 1: Wake port types and the not-supported error

**Files:**
- Create: `packages/hub-protocol/src/wake.ts`
- Modify: `packages/hub-protocol/src/errors.ts`
- Modify: `packages/hub-protocol/src/index.ts`
- Test: `packages/hub-protocol/test/errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `WakeRegistration`, `WakeRegistry`, `WakeSender`, `WakeVerdict`, `WakeNotSupportedError`, `HUB_ERROR_CODES.wakeNotSupported`.

- [ ] **Step 1: Write the failing test**

Append to `packages/hub-protocol/test/errors.test.ts` (keep the file's existing imports and add the two new names to them):

```ts
describe('WakeNotSupportedError', () => {
  test('crosses the wire as HUB_WAKE_NOT_SUPPORTED', () => {
    expect(hubErrorCodeOf(new WakeNotSupportedError('no wake'))).toBe(
      HUB_ERROR_CODES.wakeNotSupported,
    )
  })

  test('rebuilds from its code', () => {
    const rebuilt = hubErrorFromCode(HUB_ERROR_CODES.wakeNotSupported, 'no wake')
    expect(rebuilt).toBeInstanceOf(WakeNotSupportedError)
    expect(rebuilt?.message).toBe('no wake')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub-protocol && pnpm exec vitest run test/errors.test.ts`
Expected: FAIL — `WakeNotSupportedError` is not exported.

- [ ] **Step 3: Add the error**

In `src/errors.ts`, add to `HUB_ERROR_CODES`:

```ts
  wakeNotSupported: 'HUB_WAKE_NOT_SUPPORTED',
```

Add the class:

```ts
/**
 * A wake procedure was called on a hub configured without wake support. A settled answer, not a
 * transient failure: accepting a registration the hub will never act on would leave the device
 * believing it is reachable.
 */
export class WakeNotSupportedError extends Error {
  override name = 'WakeNotSupportedError'
}
```

Add a branch to `hubErrorCodeOf`:

```ts
  if (error instanceof WakeNotSupportedError) return HUB_ERROR_CODES.wakeNotSupported
```

And a case to `hubErrorFromCode`:

```ts
    case HUB_ERROR_CODES.wakeNotSupported:
      return new WakeNotSupportedError(message)
```

- [ ] **Step 4: Create the port types**

Create `packages/hub-protocol/src/wake.ts`:

```ts
/**
 * A device's push registration. The hub stores it verbatim and interprets nothing in it: `kind`
 * is switched on by the SENDER, and `endpoint` is an opaque string. A hub that parsed endpoint
 * URLs would grow provider-specific behaviour it has no business having.
 */
export type WakeRegistration = {
  did: string
  /** Opaque sender tag, e.g. 'webpush' or 'expo'. Never interpreted by the hub. */
  kind: string
  /** Opaque delivery address. Never parsed by the hub. */
  endpoint: string
  /** RFC 8291 user-agent public key: raw uncompressed P-256 point, 65 bytes, base64url. */
  publicKey: string
  /** RFC 8291 auth secret: 16 bytes, base64url. */
  authSecret: string
  /**
   * When this registration expires, in seconds since the epoch. A registry MUST NOT return an
   * entry past its `expiresAt` — an expired entry that still answers is one that fails silently,
   * the same rule key packages already carry. Absent means it never expires.
   */
  expiresAt?: number
}

/**
 * Durable storage for wake registrations: one per DID, since a DID names one device.
 *
 * Verified by `testWakeRegistryConformance` in `@kumiai/hub-conformance`.
 */
export type WakeRegistry = {
  /** Store this DID's registration, REPLACING any previous one. */
  put(registration: WakeRegistration): Promise<void>
  /** The DID's registration, or null when there is none or it has expired. */
  get(did: string): Promise<WakeRegistration | null>
  delete(did: string): Promise<void>
}

/**
 * What a send attempt settled as.
 *
 * - `delivered` — the provider accepted it.
 * - `gone` — the endpoint is permanently dead (Web Push 404/410, Expo `DeviceNotRegistered`). The
 *   dispatcher DELETES the registration: a dead endpoint retained forever is a stale identifier
 *   the hub keeps volunteering to a provider.
 * - `retry` — transient. The dispatcher drops the ping and reports it; the next frame re-triggers.
 *   There is deliberately no retry queue, which would be a second delivery system with its own
 *   durability story.
 */
export type WakeVerdict = 'delivered' | 'gone' | 'retry'

export type WakeSendParams = {
  registration: WakeRegistration
  /** The sealed body. Constant size; never inspected by the sender. */
  body: Uint8Array
}

export type WakeSender = {
  /** Resolves to a verdict. MUST NOT throw — a provider failure is a `retry`, not an exception. */
  send(params: WakeSendParams): Promise<WakeVerdict>
}
```

- [ ] **Step 5: Export from the index**

In `src/index.ts`, add `WakeNotSupportedError` to the `./errors.js` export block (alphabetical, after `SubscriptionQuotaExceededError`), and add:

```ts
export type {
  WakeRegistration,
  WakeRegistry,
  WakeSender,
  WakeSendParams,
  WakeVerdict,
} from './wake.js'
```

- [ ] **Step 6: Run tests**

Run: `cd packages/hub-protocol && pnpm test`
Expected: PASS, including `test:types`.

- [ ] **Step 7: Commit**

```bash
git add packages/hub-protocol/src/wake.ts packages/hub-protocol/src/errors.ts packages/hub-protocol/src/index.ts packages/hub-protocol/test/errors.test.ts
git commit -m "feat(hub-protocol): wake registry and sender port types"
```

---

### Task 2: The RFC 8291 sealed hint

**Files:**
- Create: `packages/hub-protocol/src/wake-envelope.ts`
- Modify: `packages/hub-protocol/src/index.ts`
- Modify: `packages/hub-protocol/package.json`
- Test: `packages/hub-protocol/test/wake-envelope.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `sealWakeHint(hint, recipient) => Uint8Array`, `openWakeHint(body, recipient) => WakeHint`, `WakeHint`, `WAKE_HINT_VERSION`, `WAKE_RECORD_SIZE`, `encodeBase64url(bytes) => string`, `decodeBase64url(value) => Uint8Array`.

**Why base64url helpers live here:** every package downstream needs them and `Buffer` is not available — the `src` tsconfigs declare `lib: ["es2025", "dom"]` with no `types: ["node"]`, so `Buffer` typechecks in tests and fails in source. `atob`/`btoa` are in the DOM lib and exist in Node, browsers and React Native alike.

**Why RFC 8291 rather than a house format:** a browser refuses a Web Push body that does not decrypt this way. The scheme is therefore fixed by the platform, not chosen. The version lives *inside* the sealed JSON as `v` — an outer version byte would break the RFC 8188 framing browsers require.

- [ ] **Step 1: Add the crypto dependencies**

In `packages/hub-protocol/package.json`, add to `dependencies` (keep them alphabetical):

```json
    "@noble/ciphers": "catalog:",
    "@noble/curves": "catalog:",
```

`@noble/hashes` is already a dependency (used by `digest.ts`).

Run: `pnpm install`

- [ ] **Step 2: Write the failing test**

Create `packages/hub-protocol/test/wake-envelope.test.ts`:

```ts
import { p256 } from '@noble/curves/nist.js'
import { describe, expect, test } from 'vitest'

import {
  openWakeHint,
  sealWakeHint,
  WAKE_HINT_VERSION,
} from '../src/wake-envelope.js'

const b64uToBytes = (value: string) => new Uint8Array(Buffer.from(value, 'base64url'))
const bytesToB64u = (value: Uint8Array) => Buffer.from(value).toString('base64url')

function createRecipient() {
  const privateKey = p256.utils.randomSecretKey()
  return {
    privateKey,
    publicKey: p256.getPublicKey(privateKey, false),
    authSecret: crypto.getRandomValues(new Uint8Array(16)),
  }
}

describe('sealWakeHint', () => {
  // The published worked example from RFC 8291 section 5. Reproducing it byte for byte is what
  // proves the key derivation matches every browser's, rather than merely round-tripping against
  // our own opener.
  test('reproduces the RFC 8291 section 5 test vector', () => {
    const body = sealWakeHint(
      { topicID: 'unused', sequenceID: 'unused', count: 1 },
      {
        publicKey: b64uToBytes(
          'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
        ),
        authSecret: b64uToBytes('BTBZMqHH6r4Tts7J_aSIgg'),
      },
      {
        // Test-only overrides. Production callers never pass these.
        senderPrivateKey: b64uToBytes('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
        salt: b64uToBytes('DGv6ra1nlYgDCS1FRnbzlw'),
        recordSize: 4096,
        plaintext: new TextEncoder().encode('When I grow up, I want to be a watermelon'),
      },
    )
    expect(bytesToB64u(body)).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    )
  })

  test('round-trips a hint', () => {
    const recipient = createRecipient()
    const hint = { topicID: 'topic-a', sequenceID: '000000000042', count: 3 }
    const body = sealWakeHint(hint, recipient)
    expect(openWakeHint(body, recipient)).toEqual(hint)
  })

  // The body's LENGTH is the one thing padding cannot hide by accident. A provider that could see
  // a longer body for a longer topic would be reading topic length off the wire.
  test('body size does not vary with hint contents', () => {
    const recipient = createRecipient()
    const short = sealWakeHint({ topicID: 'ab', sequenceID: '1', count: 1 }, recipient)
    const long = sealWakeHint(
      { topicID: 'x'.repeat(256), sequenceID: '0'.repeat(32), count: 9999 },
      recipient,
    )
    expect(short.length).toBe(long.length)
  })

  test('refuses a hint too large for the record', () => {
    const recipient = createRecipient()
    expect(() =>
      sealWakeHint({ topicID: 'x'.repeat(600), sequenceID: '1', count: 1 }, recipient),
    ).toThrow(/too large/)
  })
})

describe('openWakeHint', () => {
  test('fails under the wrong key', () => {
    const body = sealWakeHint({ topicID: 'a', sequenceID: '1', count: 1 }, createRecipient())
    expect(() => openWakeHint(body, createRecipient())).toThrow()
  })

  test('rejects an unknown hint version', () => {
    const recipient = createRecipient()
    const body = sealWakeHint(
      { topicID: 'a', sequenceID: '1', count: 1 },
      recipient,
      {
        plaintext: new TextEncoder().encode(
          JSON.stringify({ v: WAKE_HINT_VERSION + 1, topicID: 'a', sequenceID: '1', count: 1 }),
        ),
      },
    )
    expect(() => openWakeHint(body, recipient)).toThrow(/version/)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/hub-protocol && pnpm exec vitest run test/wake-envelope.test.ts`
Expected: FAIL — cannot resolve `../src/wake-envelope.js`.

- [ ] **Step 4: Implement the envelope**

Create `packages/hub-protocol/src/wake-envelope.ts`. This derivation reproduces the RFC 8291 §5 vector exactly; do not "simplify" the info strings or the shared-secret slice.

```ts
import { gcm } from '@noble/ciphers/aes.js'
import { p256 } from '@noble/curves/nist.js'
import { expand, extract } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { randomBytes } from '@noble/hashes/utils.js'

/** The hint schema version, carried INSIDE the sealed JSON as `v`. */
export const WAKE_HINT_VERSION = 1

/**
 * The aes128gcm record size. Every sealed body is padded to it, so its length says nothing about
 * the topic or the count. A body is 597 bytes at this size — far under Web Push's 4096 limit.
 */
export const WAKE_RECORD_SIZE = 512

/** What the device learns from a wake, once it has opened it. */
export type WakeHint = {
  /** The topic the frame landed on. The device maps it to a group locally; that map never leaves. */
  topicID: string
  sequenceID: string
  /** Frames seen for this device since its LAST wake ping — not its total backlog. */
  count: number
}

export type WakeRecipient = {
  /** Raw uncompressed P-256 point, 65 bytes. */
  publicKey: Uint8Array
  /** 16 bytes. */
  authSecret: Uint8Array
}

export type WakeOpener = {
  privateKey: Uint8Array
  authSecret: Uint8Array
}

/** Test-only overrides, so the RFC's worked example can be reproduced. Never passed in production. */
export type SealOverrides = {
  senderPrivateKey?: Uint8Array
  salt?: Uint8Array
  recordSize?: number
  plaintext?: Uint8Array
}

/**
 * base64url, via `atob`/`btoa` rather than `Buffer`: this module is imported by hub-client, which
 * runs under React Native, and by hub-protocol's own `src`, which has no Node types.
 */
export function encodeBase64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export function decodeBase64url(value: string): Uint8Array {
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'))
  const out = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) out[index] = binary.charCodeAt(index)
  return out
}

const KEY_INFO_PREFIX = new TextEncoder().encode('WebPush: info')
const CEK_INFO = new TextEncoder().encode('Content-Encoding: aes128gcm\0')
const NONCE_INFO = new TextEncoder().encode('Content-Encoding: nonce\0')
const RECORD_DELIMITER = 2

function concat(...parts: Array<Uint8Array>): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

// RFC 8291 section 3.4 then RFC 8188 section 2.2: the auth secret salts the ECDH extract, and the
// resulting IKM is what the content-encoding's own salt then extracts over.
function deriveKeys(
  sharedSecret: Uint8Array,
  authSecret: Uint8Array,
  uaPublic: Uint8Array,
  asPublic: Uint8Array,
  salt: Uint8Array,
): { cek: Uint8Array; nonce: Uint8Array } {
  const prkKey = extract(sha256, sharedSecret, authSecret)
  const keyInfo = concat(KEY_INFO_PREFIX, new Uint8Array([0]), uaPublic, asPublic)
  const ikm = expand(sha256, prkKey, keyInfo, 32)
  const prk = extract(sha256, ikm, salt)
  return {
    cek: expand(sha256, prk, CEK_INFO, 16),
    nonce: expand(sha256, prk, NONCE_INFO, 12),
  }
}

/**
 * Seal a hint for one device, RFC 8291 `aes128gcm`.
 *
 * The scheme is not a free choice: a browser refuses a Web Push body that does not decrypt this
 * way, and one implementation then serves web, Expo, and any later direct-APNs path.
 */
export function sealWakeHint(
  hint: WakeHint,
  recipient: WakeRecipient,
  overrides: SealOverrides = {},
): Uint8Array {
  const recordSize = overrides.recordSize ?? WAKE_RECORD_SIZE
  const plaintext =
    overrides.plaintext ??
    new TextEncoder().encode(JSON.stringify({ v: WAKE_HINT_VERSION, ...hint }))

  // Pad to a fixed length so the body's SIZE carries no information. The 16 subtracted bytes are
  // the GCM tag; one more is the record delimiter.
  const recordLength = recordSize - 16
  if (plaintext.length + 1 > recordLength) {
    throw new Error(`Wake hint too large: ${plaintext.length + 1} > ${recordLength}`)
  }
  const record = new Uint8Array(recordLength)
  record.set(plaintext, 0)
  record[plaintext.length] = RECORD_DELIMITER

  const senderPrivate = overrides.senderPrivateKey ?? p256.utils.randomSecretKey()
  const senderPublic = p256.getPublicKey(senderPrivate, false)
  const salt = overrides.salt ?? randomBytes(16)
  // getSharedSecret returns a point with a 1-byte prefix; RFC 8291 uses the X coordinate alone.
  const shared = p256.getSharedSecret(senderPrivate, recipient.publicKey, false).slice(1, 33)
  const { cek, nonce } = deriveKeys(
    shared,
    recipient.authSecret,
    recipient.publicKey,
    senderPublic,
    salt,
  )

  const rs = new Uint8Array(4)
  new DataView(rs.buffer).setUint32(0, recordSize)
  const header = concat(salt, rs, new Uint8Array([senderPublic.length]), senderPublic)
  return concat(header, gcm(cek, nonce).encrypt(record))
}

/** Open a sealed wake body. Throws on a bad key, a corrupt body, or an unknown hint version. */
export function openWakeHint(body: Uint8Array, opener: WakeOpener): WakeHint {
  const salt = body.subarray(0, 16)
  const keyIDLength = body[20]
  if (keyIDLength == null) {
    throw new Error('Wake body truncated')
  }
  const senderPublic = body.subarray(21, 21 + keyIDLength)
  const ciphertext = body.subarray(21 + keyIDLength)

  const uaPublic = p256.getPublicKey(opener.privateKey, false)
  const shared = p256.getSharedSecret(opener.privateKey, senderPublic, false).slice(1, 33)
  const { cek, nonce } = deriveKeys(shared, opener.authSecret, uaPublic, senderPublic, salt)
  const record = gcm(cek, nonce).decrypt(ciphertext)

  let end = record.length
  while (end > 0 && record[end - 1] === 0) end--
  if (record[end - 1] !== RECORD_DELIMITER) {
    throw new Error('Wake body has no record delimiter')
  }
  const parsed = JSON.parse(new TextDecoder().decode(record.subarray(0, end - 1))) as {
    v?: number
    topicID?: string
    sequenceID?: string
    count?: number
  }
  if (parsed.v !== WAKE_HINT_VERSION) {
    // Rejected rather than best-effort parsed, following TUNNEL_ENVELOPE_VERSION's precedent.
    throw new Error(`Unsupported wake hint version: ${String(parsed.v)}`)
  }
  if (
    typeof parsed.topicID !== 'string' ||
    typeof parsed.sequenceID !== 'string' ||
    typeof parsed.count !== 'number'
  ) {
    throw new Error('Malformed wake hint')
  }
  return { topicID: parsed.topicID, sequenceID: parsed.sequenceID, count: parsed.count }
}
```

- [ ] **Step 5: Export from the index**

Add to `packages/hub-protocol/src/index.ts`:

```ts
export {
  decodeBase64url,
  encodeBase64url,
  openWakeHint,
  sealWakeHint,
  WAKE_HINT_VERSION,
  WAKE_RECORD_SIZE,
  type WakeHint,
  type WakeOpener,
  type WakeRecipient,
} from './wake-envelope.js'
```

- [ ] **Step 6: Run tests**

Run: `cd packages/hub-protocol && pnpm test`
Expected: PASS. The vector test must pass — if it does not, the derivation is wrong and the round-trip test passing means nothing (it would only prove the code agrees with itself).

- [ ] **Step 7: Commit**

```bash
git add packages/hub-protocol/src/wake-envelope.ts packages/hub-protocol/src/index.ts packages/hub-protocol/package.json packages/hub-protocol/test/wake-envelope.test.ts pnpm-lock.yaml
git commit -m "feat(hub-protocol): RFC 8291 sealed wake hint"
```

---

### Task 3: The wake procedures

**Files:**
- Modify: `packages/hub-protocol/src/protocol.ts`
- Test: `packages/hub-protocol/test/protocol.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `hub/v1/wake/register` and `hub/v1/wake/unregister` on `hubProtocol`.

- [ ] **Step 1: Write the failing test**

Append to `packages/hub-protocol/test/protocol.test.ts`, matching the file's existing import and assertion style:

```ts
describe('hub/v1/wake/register', () => {
  test('is a sealed request procedure', () => {
    const definition = hubProtocol['hub/v1/wake/register']
    expect(definition.type).toBe('request')
    expect(definition.param.additionalProperties).toBe(false)
    expect(definition.param.required).toEqual(['kind', 'endpoint', 'publicKey', 'authSecret'])
  })

  test('has no did field — the hub uses the authenticated caller', () => {
    expect(hubProtocol['hub/v1/wake/register'].param.properties).not.toHaveProperty('did')
  })
})

describe('hub/v1/wake/unregister', () => {
  test('takes no parameters', () => {
    const definition = hubProtocol['hub/v1/wake/unregister']
    expect(definition.type).toBe('request')
    expect(definition.param.additionalProperties).toBe(false)
    expect(Object.keys(definition.param.properties ?? {})).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub-protocol && pnpm exec vitest run test/protocol.test.ts`
Expected: FAIL — the procedures are undefined.

- [ ] **Step 3: Add the procedures**

In `src/protocol.ts`, after `'hub/v1/keypackage/status'`:

```ts
  'hub/v1/wake/register': {
    type: 'request',
    description: "Register the caller's push endpoint, replacing any previous one",
    param: {
      type: 'object',
      properties: {
        /**
         * Opaque sender tag ('webpush', 'expo', …). The SENDER switches on it; the hub never
         * interprets it, so a new provider needs no protocol change.
         */
        kind: { type: 'string', minLength: 1, maxLength: 32 },
        /** Opaque delivery address. Never parsed by the hub. */
        endpoint: { type: 'string', minLength: 1, maxLength: 2048 },
        /** RFC 8291 user-agent public key: raw uncompressed P-256 point, base64url. */
        publicKey: { type: 'string', minLength: 1, maxLength: 128 },
        /** RFC 8291 auth secret, base64url. */
        authSecret: { type: 'string', minLength: 1, maxLength: 64 },
        /** When the registration expires, in seconds since the epoch. */
        expiresAt: { type: 'integer', minimum: 0 },
      },
      required: ['kind', 'endpoint', 'publicKey', 'authSecret'],
      additionalProperties: false,
    },
    result: {
      type: 'object',
      properties: {
        registered: { type: 'boolean' },
      },
      required: ['registered'],
      additionalProperties: false,
    },
  },
  'hub/v1/wake/unregister': {
    type: 'request',
    description: "Remove the caller's push endpoint",
    param: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    result: {
      type: 'object',
      properties: {
        /** False when the caller had no registration — not an error. */
        unregistered: { type: 'boolean' },
      },
      required: ['unregistered'],
      additionalProperties: false,
    },
  },
```

There is no `did` field on either. The hub derives the DID from the verified issuer, exactly as `hub/v1/topic/fetch` does — a wire-supplied DID would let any member redirect another member's wakes to an endpoint they control.

- [ ] **Step 4: Run tests**

Run: `cd packages/hub-protocol && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub-protocol/src/protocol.ts packages/hub-protocol/test/protocol.test.ts
git commit -m "feat(hub-protocol): hub/v1/wake register and unregister procedures"
```

---

### Task 4: WakeRegistry conformance suite

**Files:**
- Create: `packages/hub-conformance/src/wake-registry.ts`
- Modify: `packages/hub-conformance/src/index.ts`

**Interfaces:**
- Consumes: `WakeRegistry`, `WakeRegistration` from Task 1.
- Produces: `testWakeRegistryConformance({ createRegistry, now? })`.

No test-for-the-test here: this file *is* tests, and Task 5 is what runs it. That is why Task 5 immediately follows.

- [ ] **Step 1: Write the suite**

Create `packages/hub-conformance/src/wake-registry.ts`:

```ts
import type { WakeRegistration, WakeRegistry } from '@kumiai/hub-protocol'
import { describe, expect, test } from 'vitest'

export type WakeRegistryConformanceParams = {
  /** MUST return a fresh empty registry per case. */
  createRegistry: () => WakeRegistry | Promise<WakeRegistry>
}

function registration(overrides: Partial<WakeRegistration> = {}): WakeRegistration {
  return {
    did: 'did:key:alice',
    kind: 'webpush',
    endpoint: 'https://push.example/aaa',
    publicKey: 'cHVibGlj',
    authSecret: 'YXV0aA',
    ...overrides,
  }
}

/**
 * Conformance suite for the `WakeRegistry` contract.
 *
 * ```ts
 * testWakeRegistryConformance({ createRegistry: () => new SQLWakeRegistry(freshDatabase()) })
 * ```
 *
 * Every clause exists because a plausible implementation gets it wrong. The load-bearing one is
 * expiry: a registry that stores `expiresAt` but still SERVES the entry passes everything else,
 * and the only symptom is the hub going on pushing to an endpoint the provider has released —
 * possibly to someone else's device.
 */
export function testWakeRegistryConformance(params: WakeRegistryConformanceParams): void {
  describe('WakeRegistry conformance', () => {
    test('get returns null for an unknown DID', async () => {
      const registry = await params.createRegistry()
      await expect(registry.get('did:key:nobody')).resolves.toBeNull()
    })

    test('put then get returns the registration', async () => {
      const registry = await params.createRegistry()
      const entry = registration()
      await registry.put(entry)
      await expect(registry.get(entry.did)).resolves.toEqual(entry)
    })

    test('put REPLACES a previous registration for the same DID', async () => {
      const registry = await params.createRegistry()
      await registry.put(registration({ endpoint: 'https://push.example/old' }))
      await registry.put(registration({ endpoint: 'https://push.example/new' }))
      const stored = await registry.get('did:key:alice')
      expect(stored?.endpoint).toBe('https://push.example/new')
    })

    test('registrations are per DID', async () => {
      const registry = await params.createRegistry()
      await registry.put(registration({ did: 'did:key:alice' }))
      await registry.put(registration({ did: 'did:key:bob', endpoint: 'https://push.example/bob' }))
      expect((await registry.get('did:key:alice'))?.endpoint).toBe('https://push.example/aaa')
      expect((await registry.get('did:key:bob'))?.endpoint).toBe('https://push.example/bob')
    })

    test('delete removes it', async () => {
      const registry = await params.createRegistry()
      await registry.put(registration())
      await registry.delete('did:key:alice')
      await expect(registry.get('did:key:alice')).resolves.toBeNull()
    })

    test('delete of an unknown DID resolves', async () => {
      const registry = await params.createRegistry()
      await expect(registry.delete('did:key:nobody')).resolves.toBeUndefined()
    })

    test('an expired registration is NOT served', async () => {
      const registry = await params.createRegistry()
      const past = Math.floor(Date.now() / 1000) - 60
      await registry.put(registration({ expiresAt: past }))
      await expect(registry.get('did:key:alice')).resolves.toBeNull()
    })

    test('an unexpired registration is served', async () => {
      const registry = await params.createRegistry()
      const future = Math.floor(Date.now() / 1000) + 3600
      await registry.put(registration({ expiresAt: future }))
      expect(await registry.get('did:key:alice')).not.toBeNull()
    })

    test('a registration with no expiresAt never expires', async () => {
      const registry = await params.createRegistry()
      await registry.put(registration())
      expect(await registry.get('did:key:alice')).not.toBeNull()
    })
  })
}
```

- [ ] **Step 2: Export it**

In `packages/hub-conformance/src/index.ts`, add at the end of the file:

```ts
export {
  testWakeRegistryConformance,
  type WakeRegistryConformanceParams,
} from './wake-registry.js'
```

- [ ] **Step 3: Typecheck**

Run: `cd packages/hub-conformance && pnpm run test:types`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/hub-conformance/src/wake-registry.ts packages/hub-conformance/src/index.ts
git commit -m "test(hub-conformance): WakeRegistry contract suite"
```

---

### Task 5: The @kumiai/hub-wake package and its in-memory registry

**Files:**
- Create: `packages/hub-wake/package.json`, `tsconfig.json`, `tsconfig.test.json`, `README.md`
- Create: `packages/hub-wake/src/index.ts`, `src/memoryRegistry.ts`
- Test: `packages/hub-wake/test/memoryRegistry.test.ts`

**Interfaces:**
- Consumes: `WakeRegistry`, `WakeRegistration` (Task 1); `testWakeRegistryConformance` (Task 4).
- Produces: `createMemoryWakeRegistry(): WakeRegistry`.

- [ ] **Step 1: Scaffold the package**

Create `packages/hub-wake/package.json`:

```json
{
  "name": "@kumiai/hub-wake",
  "version": "0.6.0",
  "description": "Wake-notification registry and senders for a kumiai hub",
  "keywords": ["hub", "push", "notifications", "webpush", "kumiai"],
  "repository": {
    "type": "git",
    "url": "https://github.com/TairuFramework/kumiai",
    "directory": "packages/hub-wake"
  },
  "license": "MIT",
  "sideEffects": false,
  "type": "module",
  "exports": {
    ".": "./lib/index.js"
  },
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "files": ["lib/*"],
  "scripts": {
    "build": "pnpm run build:clean && pnpm run build:js && pnpm run build:types",
    "build:clean": "del lib",
    "build:js": "swc src -d ./lib --config-file ../../node_modules/@kigu/dev/swc.json --strip-leading-paths",
    "build:types": "tsc --emitDeclarationOnly --skipLibCheck",
    "prepublishOnly": "pnpm run build",
    "test": "pnpm run test:types && pnpm run test:unit",
    "test:types": "tsc --noEmit -p tsconfig.test.json",
    "test:unit": "vitest run"
  },
  "dependencies": {
    "@kumiai/hub-protocol": "workspace:^",
    "@noble/curves": "catalog:",
    "@noble/hashes": "catalog:"
  },
  "devDependencies": {
    "@kumiai/hub-conformance": "workspace:^"
  },
  "publishConfig": {
    "access": "public"
  }
}
```

Create `packages/hub-wake/tsconfig.json`:

```json
{
  "extends": "@kigu/dev/tsconfig.json",
  "compilerOptions": {
    "lib": ["es2025", "dom"],
    "rootDir": "./src",
    "outDir": "./lib"
  },
  "include": ["./src/**/*"]
}
```

Create `packages/hub-wake/tsconfig.test.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "types": ["node"],
    "rootDir": ".",
    "noEmit": true
  },
  "include": ["./src/**/*", "./test/**/*"]
}
```

Run: `pnpm install`

- [ ] **Step 2: Write the failing test**

Create `packages/hub-wake/test/memoryRegistry.test.ts`:

```ts
import { testWakeRegistryConformance } from '@kumiai/hub-conformance'

import { createMemoryWakeRegistry } from '../src/memoryRegistry.js'

testWakeRegistryConformance({ createRegistry: () => createMemoryWakeRegistry() })
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/hub-wake && pnpm exec vitest run`
Expected: FAIL — cannot resolve `../src/memoryRegistry.js`.

- [ ] **Step 4: Implement the registry**

Create `packages/hub-wake/src/memoryRegistry.ts`:

```ts
import type { WakeRegistration, WakeRegistry } from '@kumiai/hub-protocol'

/**
 * A `WakeRegistry` held in a Map. Reference implementation and test double — it loses every
 * registration on restart, so a production hub wants a durable one, which is what the conformance
 * suite exists to check.
 */
export function createMemoryWakeRegistry(): WakeRegistry {
  const registrations = new Map<string, WakeRegistration>()

  return {
    async put(registration: WakeRegistration): Promise<void> {
      registrations.set(registration.did, registration)
    },
    async get(did: string): Promise<WakeRegistration | null> {
      const stored = registrations.get(did)
      if (stored == null) return null
      // Expired entries are dropped on read, not merely hidden: an entry that still answers is one
      // whose only symptom is the hub pushing to an endpoint the provider may have reassigned.
      if (stored.expiresAt != null && stored.expiresAt <= Math.floor(Date.now() / 1000)) {
        registrations.delete(did)
        return null
      }
      return stored
    },
    async delete(did: string): Promise<void> {
      registrations.delete(did)
    },
  }
}
```

Create `packages/hub-wake/src/index.ts`:

```ts
/**
 * Wake-notification storage and delivery for a kumiai hub.
 *
 * @module hub-wake
 */

export { createMemoryWakeRegistry } from './memoryRegistry.js'
```

- [ ] **Step 5: Run tests**

Run: `cd packages/hub-wake && pnpm test`
Expected: PASS — nine conformance cases.

- [ ] **Step 6: Commit**

```bash
git add packages/hub-wake pnpm-lock.yaml
git commit -m "feat(hub-wake): package scaffold and in-memory wake registry"
```

---

### Task 6: The wake dispatcher

**Files:**
- Create: `packages/hub-server/src/wake.ts`
- Modify: `packages/hub-server/src/index.ts`
- Test: `packages/hub-server/test/wake.test.ts`

**Interfaces:**
- Consumes: `WakeRegistry`, `WakeSender`, `WakeVerdict` (Task 1); `sealWakeHint` (Task 2).
- Produces: `createWakeDispatcher(params): WakeDispatcher`, with `notify({ did, topicID, sequenceID })`, `online(did)`, `dispose()`.

- [ ] **Step 1: Write the failing test**

Create `packages/hub-server/test/wake.test.ts`:

```ts
import { openWakeHint, type WakeRegistration, type WakeSender } from '@kumiai/hub-protocol'
import { p256 } from '@noble/curves/nist.js'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { createMemoryWakeRegistry } from '@kumiai/hub-wake'
import { createWakeDispatcher } from '../src/wake.js'

const privateKey = p256.utils.randomSecretKey()
const authSecret = crypto.getRandomValues(new Uint8Array(16))
const opener = { privateKey, authSecret }

const registration: WakeRegistration = {
  did: 'did:key:alice',
  kind: 'webpush',
  endpoint: 'https://push.example/alice',
  publicKey: Buffer.from(p256.getPublicKey(privateKey, false)).toString('base64url'),
  authSecret: Buffer.from(authSecret).toString('base64url'),
}

function createRecordingSender(verdict: 'delivered' | 'gone' | 'retry' = 'delivered') {
  const sent: Array<{ registration: WakeRegistration; body: Uint8Array }> = []
  const sender: WakeSender = {
    async send(params) {
      sent.push(params)
      return verdict
    },
  }
  return { sender, sent }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createWakeDispatcher', () => {
  test('sends immediately on the first frame — the leading edge', async () => {
    const registry = createMemoryWakeRegistry()
    await registry.put(registration)
    const { sender, sent } = createRecordingSender()
    const dispatcher = createWakeDispatcher({ registry, sender, debounceMs: 1000 })

    dispatcher.notify({ did: 'did:key:alice', topicID: 'topic-a', sequenceID: '001' })
    await vi.waitFor(() => expect(sent).toHaveLength(1))

    expect(openWakeHint(sent[0].body, opener)).toEqual({
      topicID: 'topic-a',
      sequenceID: '001',
      count: 1,
    })
    dispatcher.dispose()
  })

  test('coalesces a burst into one trailing ping carrying the latest frame', async () => {
    const registry = createMemoryWakeRegistry()
    await registry.put(registration)
    const { sender, sent } = createRecordingSender()
    const dispatcher = createWakeDispatcher({ registry, sender, debounceMs: 1000 })

    dispatcher.notify({ did: 'did:key:alice', topicID: 'topic-a', sequenceID: '001' })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    for (const sequenceID of ['002', '003', '004']) {
      dispatcher.notify({ did: 'did:key:alice', topicID: 'topic-b', sequenceID })
    }
    expect(sent).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(openWakeHint(sent[1].body, opener)).toEqual({
      topicID: 'topic-b',
      sequenceID: '004',
      count: 3,
    })
    dispatcher.dispose()
  })

  test('no trailing ping when nothing followed the leading edge', async () => {
    const registry = createMemoryWakeRegistry()
    await registry.put(registration)
    const { sender, sent } = createRecordingSender()
    const dispatcher = createWakeDispatcher({ registry, sender, debounceMs: 1000 })

    dispatcher.notify({ did: 'did:key:alice', topicID: 'topic-a', sequenceID: '001' })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(5000)
    expect(sent).toHaveLength(1)
    dispatcher.dispose()
  })

  test('online cancels the trailing ping — the device is already draining', async () => {
    const registry = createMemoryWakeRegistry()
    await registry.put(registration)
    const { sender, sent } = createRecordingSender()
    const dispatcher = createWakeDispatcher({ registry, sender, debounceMs: 1000 })

    dispatcher.notify({ did: 'did:key:alice', topicID: 'topic-a', sequenceID: '001' })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    dispatcher.notify({ did: 'did:key:alice', topicID: 'topic-a', sequenceID: '002' })
    dispatcher.online('did:key:alice')

    await vi.advanceTimersByTimeAsync(5000)
    expect(sent).toHaveLength(1)
    dispatcher.dispose()
  })

  test('sends nothing for a DID with no registration', async () => {
    const registry = createMemoryWakeRegistry()
    const { sender, sent } = createRecordingSender()
    const dispatcher = createWakeDispatcher({ registry, sender, debounceMs: 1000 })

    dispatcher.notify({ did: 'did:key:nobody', topicID: 'topic-a', sequenceID: '001' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(sent).toHaveLength(0)
    dispatcher.dispose()
  })

  test('a gone verdict deletes the registration', async () => {
    const registry = createMemoryWakeRegistry()
    await registry.put(registration)
    const { sender } = createRecordingSender('gone')
    const dispatcher = createWakeDispatcher({ registry, sender, debounceMs: 1000 })

    dispatcher.notify({ did: 'did:key:alice', topicID: 'topic-a', sequenceID: '001' })
    await vi.waitFor(async () => {
      expect(await registry.get('did:key:alice')).toBeNull()
    })
    dispatcher.dispose()
  })

  test('a retry verdict reports and keeps the registration', async () => {
    const registry = createMemoryWakeRegistry()
    await registry.put(registration)
    const { sender } = createRecordingSender('retry')
    const errors: Array<{ did: string }> = []
    const dispatcher = createWakeDispatcher({
      registry,
      sender,
      debounceMs: 1000,
      onError: (params) => errors.push({ did: params.did }),
    })

    dispatcher.notify({ did: 'did:key:alice', topicID: 'topic-a', sequenceID: '001' })
    await vi.waitFor(() => expect(errors).toHaveLength(1))
    expect(await registry.get('did:key:alice')).not.toBeNull()
    dispatcher.dispose()
  })

  test('a throwing sender is reported, not propagated', async () => {
    const registry = createMemoryWakeRegistry()
    await registry.put(registration)
    const errors: Array<unknown> = []
    const dispatcher = createWakeDispatcher({
      registry,
      sender: {
        async send() {
          throw new Error('provider exploded')
        },
      },
      debounceMs: 1000,
      onError: (params) => errors.push(params.error),
    })

    expect(() =>
      dispatcher.notify({ did: 'did:key:alice', topicID: 'topic-a', sequenceID: '001' }),
    ).not.toThrow()
    await vi.waitFor(() => expect(errors).toHaveLength(1))
    dispatcher.dispose()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub-server && pnpm exec vitest run test/wake.test.ts`
Expected: FAIL — cannot resolve `../src/wake.js`.

- [ ] **Step 3: Implement the dispatcher**

Add `@kumiai/hub-wake` to `packages/hub-server/package.json` `devDependencies` as `"workspace:^"` (the test imports its memory registry; hub-server itself must NOT depend on it at runtime — the registry is the host's to choose). Run `pnpm install`.

Create `packages/hub-server/src/wake.ts`:

```ts
import {
  decodeBase64url,
  sealWakeHint,
  type WakeRegistry,
  type WakeSender,
} from '@kumiai/hub-protocol'

export type WakeDispatcherParams = {
  registry: WakeRegistry
  sender: WakeSender
  /** Coalescing window in milliseconds. Default: 10 000. */
  debounceMs?: number
  /** Reports a transient send failure or a throwing sender. Fire-and-forget. */
  onError?: (params: { did: string; error: unknown }) => void
}

export type WakeNotifyParams = {
  did: string
  topicID: string
  sequenceID: string
}

export type WakeDispatcher = {
  /** A frame was queued for an OFFLINE subscriber. Never throws, never awaited by the caller. */
  notify(params: WakeNotifyParams): void
  /** The device bound a receive channel: drop any pending trailing ping. */
  online(did: string): void
  dispose(): void
}

type Pending = {
  timer: ReturnType<typeof setTimeout>
  latest: { topicID: string; sequenceID: string } | null
  count: number
}

const DEFAULT_DEBOUNCE_MS = 10_000

/**
 * Coalesces wake pings per DID on a LEADING edge: the first frame pings immediately, then a window
 * opens and everything inside it collapses into one trailing summary.
 *
 * Leading rather than trailing because the timer map is in-process. A hub restart drops pending
 * windows; on a leading edge that loses at most a summary, whereas trailing-only would lose the
 * notification itself every time a restart landed inside a window.
 */
export function createWakeDispatcher(params: WakeDispatcherParams): WakeDispatcher {
  const debounceMs = params.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const pending = new Map<string, Pending>()
  let disposed = false

  function report(did: string, error: unknown): void {
    try {
      params.onError?.({ did, error })
    } catch {
      // A reporter that throws must not take the dispatcher with it.
    }
  }

  function send(did: string, topicID: string, sequenceID: string, count: number): void {
    // Deliberately not awaited: a slow or hanging provider must never delay the publish fan-out
    // this is called from.
    void (async () => {
      try {
        const registration = await params.registry.get(did)
        if (registration == null) return
        const body = sealWakeHint(
          { topicID, sequenceID, count },
          {
            publicKey: decodeBase64url(registration.publicKey),
            authSecret: decodeBase64url(registration.authSecret),
          },
        )
        const verdict = await params.sender.send({ registration, body })
        if (verdict === 'gone') {
          await params.registry.delete(did)
        } else if (verdict === 'retry') {
          report(did, new Error('Wake send failed transiently'))
        }
      } catch (error) {
        report(did, error)
      }
    })()
  }

  function openWindow(did: string): Pending {
    const entry: Pending = {
      timer: setTimeout(() => {
        const current = pending.get(did)
        pending.delete(did)
        if (current?.latest == null) return
        send(did, current.latest.topicID, current.latest.sequenceID, current.count)
        // Traffic is still flowing, so a fresh window opens behind the summary rather than letting
        // the next frame ping immediately and undo the coalescing.
        pending.set(did, openWindow(did))
      }, debounceMs),
      latest: null,
      count: 0,
    }
    // A pending wake must never hold a process open by itself.
    entry.timer.unref?.()
    return entry
  }

  return {
    notify({ did, topicID, sequenceID }: WakeNotifyParams): void {
      if (disposed) return
      const entry = pending.get(did)
      if (entry == null) {
        pending.set(did, openWindow(did))
        send(did, topicID, sequenceID, 1)
        return
      }
      entry.latest = { topicID, sequenceID }
      entry.count += 1
    },
    online(did: string): void {
      const entry = pending.get(did)
      if (entry == null) return
      clearTimeout(entry.timer)
      pending.delete(did)
    },
    dispose(): void {
      disposed = true
      for (const entry of pending.values()) clearTimeout(entry.timer)
      pending.clear()
    },
  }
}
```

- [ ] **Step 4: Export from the index**

Add to `packages/hub-server/src/index.ts`:

```ts
export {
  createWakeDispatcher,
  type WakeDispatcher,
  type WakeDispatcherParams,
  type WakeNotifyParams,
} from './wake.js'
```

- [ ] **Step 5: Run tests**

Run: `cd packages/hub-server && pnpm exec vitest run test/wake.test.ts`
Expected: PASS, all eight cases.

- [ ] **Step 6: Prove the coalescing test bites**

Temporarily change `notify` so the `entry != null` branch also calls `send(...)`. Re-run the test.
Expected: the coalescing and online-cancel cases FAIL. Restore the code and confirm they pass again.

A debounce test that passes against a dispatcher with no debounce is worthless, and this is the cheapest way to know it is not one.

- [ ] **Step 7: Commit**

```bash
git add packages/hub-server/src/wake.ts packages/hub-server/src/index.ts packages/hub-server/test/wake.test.ts packages/hub-server/package.json pnpm-lock.yaml
git commit -m "feat(hub-server): leading-edge wake dispatcher"
```

---

### Task 7: Wake handlers and the createHub param

**Files:**
- Modify: `packages/hub-server/src/handlers.ts`
- Modify: `packages/hub-server/src/hub.ts`
- Test: `packages/hub-server/test/handlers-wake.test.ts`

**Interfaces:**
- Consumes: `WakeRegistry`, `WakeNotSupportedError`, `HUB_ERROR_CODES.wakeNotSupported` (Task 1); `WakeDispatcher` (Task 6).
- Produces: `CreateHandlersParams.wake?: { registry: WakeRegistry; dispatcher: WakeDispatcher }`; `CreateHubParams.wake?: { registry: WakeRegistry; sender: WakeSender; debounceMs?: number }`.

- [ ] **Step 1: Write the failing test**

Create `packages/hub-server/test/handlers-wake.test.ts`. Build the client/server pair exactly as `packages/hub-server/test/handlers.test.ts` already does — read that file first and copy its harness rather than inventing one.

```ts
import { HUB_ERROR_CODES } from '@kumiai/hub-protocol'
import { describe, expect, test } from 'vitest'

import { createMemoryWakeRegistry } from '@kumiai/hub-wake'

// Reuse the harness from handlers.test.ts: a hub over an in-memory transport with an
// authenticated client DID. Name it `createTestHub` here.

describe('hub/v1/wake/register', () => {
  test('stores a registration for the authenticated caller', async () => {
    const registry = createMemoryWakeRegistry()
    const { client, clientDID, dispose } = await createTestHub({ wake: { registry } })

    await expect(
      client.registerWake({
        kind: 'webpush',
        endpoint: 'https://push.example/a',
        publicKey: 'cHVibGlj',
        authSecret: 'YXV0aA',
      }),
    ).resolves.toEqual({ registered: true })

    const stored = await registry.get(clientDID)
    expect(stored?.endpoint).toBe('https://push.example/a')
    expect(stored?.did).toBe(clientDID)
    await dispose()
  })

  test('replaces a previous registration', async () => {
    const registry = createMemoryWakeRegistry()
    const { client, clientDID, dispose } = await createTestHub({ wake: { registry } })

    await client.registerWake({
      kind: 'webpush',
      endpoint: 'https://push.example/old',
      publicKey: 'cHVibGlj',
      authSecret: 'YXV0aA',
    })
    await client.registerWake({
      kind: 'expo',
      endpoint: 'ExponentPushToken[xxx]',
      publicKey: 'cHVibGlj',
      authSecret: 'YXV0aA',
    })

    expect((await registry.get(clientDID))?.kind).toBe('expo')
    await dispose()
  })

  test('refuses when the hub has no wake support', async () => {
    const { client, dispose } = await createTestHub({})
    await expect(
      client.registerWake({
        kind: 'webpush',
        endpoint: 'https://push.example/a',
        publicKey: 'cHVibGlj',
        authSecret: 'YXV0aA',
      }),
    ).rejects.toMatchObject({ code: HUB_ERROR_CODES.wakeNotSupported })
    await dispose()
  })
})

describe('hub/v1/wake/unregister', () => {
  test('removes the registration', async () => {
    const registry = createMemoryWakeRegistry()
    const { client, clientDID, dispose } = await createTestHub({ wake: { registry } })

    await client.registerWake({
      kind: 'webpush',
      endpoint: 'https://push.example/a',
      publicKey: 'cHVibGlj',
      authSecret: 'YXV0aA',
    })
    await expect(client.unregisterWake()).resolves.toEqual({ unregistered: true })
    expect(await registry.get(clientDID)).toBeNull()
    await dispose()
  })

  test('reports false when there was nothing to remove', async () => {
    const registry = createMemoryWakeRegistry()
    const { client, dispose } = await createTestHub({ wake: { registry } })
    await expect(client.unregisterWake()).resolves.toEqual({ unregistered: false })
    await dispose()
  })
})
```

`client.registerWake` / `client.unregisterWake` arrive in Task 10. Until then, call the procedures directly through the enkaku client — `client.request('hub/v1/wake/register', { param: { … } })` — and switch to the `HubClient` methods in Task 10.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub-server && pnpm exec vitest run test/handlers-wake.test.ts`
Expected: FAIL — the procedures have no handler.

- [ ] **Step 3: Add the handlers**

In `packages/hub-server/src/handlers.ts`, extend `CreateHandlersParams` with:

```ts
  /**
   * Wake support. Absent: both wake procedures refuse. The registry is separate from the
   * dispatcher because the handlers only ever store and remove; sending is the dispatcher's.
   */
  wake?: { registry: WakeRegistry; dispatcher?: WakeDispatcher }
```

Add the two handlers alongside the others:

```ts
    'hub/v1/wake/register': (async (ctx) => {
      const clientDID = getClientDID(ctx)
      const wake = params.wake
      if (wake == null) {
        throw new HandlerError({
          code: HUB_ERROR_CODES.wakeNotSupported,
          message: 'This hub does not support wake notifications',
        })
      }
      if (!didLimiter.tryConsume(clientDID)) {
        throw new HandlerError({ code: 'EK01', message: 'Wake rate limit exceeded for DID' })
      }
      try {
        await wake.registry.put({
          // The DID is the verified issuer, never a wire field — otherwise any member could
          // redirect another member's wakes to an endpoint they control.
          did: clientDID,
          kind: ctx.param.kind,
          endpoint: ctx.param.endpoint,
          publicKey: ctx.param.publicKey,
          authSecret: ctx.param.authSecret,
          ...(ctx.param.expiresAt != null ? { expiresAt: ctx.param.expiresAt } : {}),
        })
      } catch (error) {
        rethrowAsHandlerError(error)
      }
      return { registered: true }
    }) as RequestHandler<HubProtocol, 'hub/v1/wake/register'>,

    'hub/v1/wake/unregister': (async (ctx) => {
      const clientDID = getClientDID(ctx)
      const wake = params.wake
      if (wake == null) {
        throw new HandlerError({
          code: HUB_ERROR_CODES.wakeNotSupported,
          message: 'This hub does not support wake notifications',
        })
      }
      let existed: boolean
      try {
        existed = (await wake.registry.get(clientDID)) != null
        await wake.registry.delete(clientDID)
      } catch (error) {
        rethrowAsHandlerError(error)
      }
      return { unregistered: existed }
    }) as RequestHandler<HubProtocol, 'hub/v1/wake/unregister'>,
```

Import `HUB_ERROR_CODES`, `WakeRegistry` and `WakeDispatcher` at the top of the file.

- [ ] **Step 4: Wire the createHub param**

In `packages/hub-server/src/hub.ts`, add to `CreateHubParams`:

```ts
  /**
   * Wake notifications. Absent: `hub/v1/wake/*` refuse with `WakeNotSupportedError` — refusing is
   * the only honest answer, since accepting a registration the hub will never act on leaves the
   * device believing it is reachable.
   */
  wake?: {
    registry: WakeRegistry
    sender: WakeSender
    /** Coalescing window in milliseconds. Default: 10 000. */
    debounceMs?: number
  }
```

In `createHub`, before `createHandlers`:

```ts
  const wakeDispatcher =
    params.wake == null
      ? undefined
      : createWakeDispatcher({
          registry: params.wake.registry,
          sender: params.wake.sender,
          debounceMs: params.wake.debounceMs,
          onError: ({ did, error }) => storeErrorReporter({ method: 'wake', did, error }),
        })
```

Pass `wake: params.wake == null ? undefined : { registry: params.wake.registry, dispatcher: wakeDispatcher }` into `createHandlers`, and dispose the dispatcher with the server:

```ts
  if (wakeDispatcher != null) {
    server.disposed.then(() => wakeDispatcher.dispose())
  }
```

Add `{ method: 'wake'; did: string; error: unknown }` to the `HubStoreErrorHook` union in `handlers.ts`, and a line for it in the accompanying explanation map next to `getSubscribers`.

- [ ] **Step 5: Run tests**

Run: `cd packages/hub-server && pnpm test`
Expected: PASS. Existing tests must be untouched — a hub with no `wake` param behaves exactly as before.

- [ ] **Step 6: Commit**

```bash
git add packages/hub-server/src/handlers.ts packages/hub-server/src/hub.ts packages/hub-server/test/handlers-wake.test.ts
git commit -m "feat(hub-server): wake register and unregister handlers"
```

---

### Task 8: Fire the wake from the publish fan-out

**Files:**
- Modify: `packages/hub-server/src/handlers.ts:414-426` (the publish fan-out loop) and the receive handler's writer-bind site
- Test: `packages/hub-server/test/handlers-wake.test.ts`

**Interfaces:**
- Consumes: `WakeDispatcher` (Task 6), the handler wiring (Task 7).
- Produces: no new exports — behaviour only.

- [ ] **Step 1: Write the failing test**

Append to `packages/hub-server/test/handlers-wake.test.ts`:

```ts
describe('wake on publish', () => {
  test('wakes a subscriber with no live receive channel', async () => {
    const registry = createMemoryWakeRegistry()
    const { sender, sent } = createRecordingSender()
    const { publisher, offlineDID, dispose } = await createTestHubPair({
      wake: { registry, sender },
    })
    await registry.put({
      did: offlineDID,
      kind: 'webpush',
      endpoint: 'https://push.example/a',
      publicKey: recipientPublicKeyB64u,
      authSecret: recipientAuthSecretB64u,
    })

    await publisher.publish({ topicID: 'topic-a', payload: 'aGk' })

    await vi.waitFor(() => expect(sent).toHaveLength(1))
    await dispose()
  })

  test('does NOT wake a subscriber that is online', async () => {
    // Same harness, but the second client holds an open hub/v1/receive channel.
    const registry = createMemoryWakeRegistry()
    const { sender, sent } = createRecordingSender()
    const { publisher, offlineDID, bringOnline, dispose } = await createTestHubPair({
      wake: { registry, sender },
    })
    await registry.put({
      did: offlineDID,
      kind: 'webpush',
      endpoint: 'https://push.example/a',
      publicKey: recipientPublicKeyB64u,
      authSecret: recipientAuthSecretB64u,
    })
    await bringOnline()

    await publisher.publish({ topicID: 'topic-a', payload: 'aGk' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(sent).toHaveLength(0)
    await dispose()
  })

  test('wakes on a log-class publish too — a commit is what a sleeping device most needs', async () => {
    const registry = createMemoryWakeRegistry()
    const { sender, sent } = createRecordingSender()
    const { publisher, offlineDID, dispose } = await createTestHubPair({
      wake: { registry, sender },
    })
    await registry.put({
      did: offlineDID,
      kind: 'webpush',
      endpoint: 'https://push.example/a',
      publicKey: recipientPublicKeyB64u,
      authSecret: recipientAuthSecretB64u,
    })

    await publisher.publish({ topicID: 'topic-a', payload: 'aGk', retain: 'log' })

    await vi.waitFor(() => expect(sent).toHaveLength(1))
    await dispose()
  })

  test('never wakes the sender itself', async () => {
    const registry = createMemoryWakeRegistry()
    const { sender, sent } = createRecordingSender()
    const { publisher, publisherDID, dispose } = await createTestHubPair({
      wake: { registry, sender },
    })
    await registry.put({
      did: publisherDID,
      kind: 'webpush',
      endpoint: 'https://push.example/a',
      publicKey: recipientPublicKeyB64u,
      authSecret: recipientAuthSecretB64u,
    })

    await publisher.publish({ topicID: 'topic-a', payload: 'aGk' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(sent).toHaveLength(0)
    await dispose()
  })
})
```

`createTestHubPair` extends the harness from Step 1 of Task 7: two authenticated clients on one hub, both subscribed to `topic-a`, the second one offline unless `bringOnline()` is called. `recipientPublicKeyB64u` / `recipientAuthSecretB64u` come from a P-256 keypair generated at the top of the file, as in `test/wake.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub-server && pnpm exec vitest run test/handlers-wake.test.ts`
Expected: FAIL — nothing is ever sent.

- [ ] **Step 3: Hook the fan-out loop**

In `handlers.ts`, in the publish fan-out loop, add the else branch:

```ts
        for (const recipientDID of subscribers) {
          if (recipientDID === senderDID) continue
          const client = registry.getClient(recipientDID)
          if (client?.sendMessage != null) {
            client.sendMessage({
              sequenceID,
              senderDID,
              topicID,
              payload: payloadBytes,
              ...logPosition,
            })
          } else {
            // No live channel: the frame is durably queued, so all that is missing is a nudge to
            // come and get it. Both retention classes wake — a commit-lane frame is log-class, and
            // a membership change is exactly what a sleeping device must learn.
            params.wake?.dispatcher?.notify({ did: recipientDID, topicID, sequenceID })
          }
        }
```

- [ ] **Step 4: Cancel on reconnect**

In the `hub/v1/receive` handler, immediately after `registry.bindReceiveWriter(...)` succeeds, add:

```ts
      // The device is draining; a trailing summary would be noise it has already outrun.
      params.wake?.dispatcher?.online(clientDID)
```

- [ ] **Step 5: Run tests**

Run: `cd packages/hub-server && pnpm test`
Expected: PASS.

- [ ] **Step 6: Prove the online case bites**

Temporarily delete the `else` guard so `notify` runs unconditionally. Re-run.
Expected: "does NOT wake a subscriber that is online" and "never wakes the sender itself" FAIL. Restore and confirm green.

- [ ] **Step 7: Commit**

```bash
git add packages/hub-server/src/handlers.ts packages/hub-server/test/handlers-wake.test.ts
git commit -m "feat(hub-server): wake offline subscribers from the publish fan-out"
```

---

### Task 9: The senders

**Files:**
- Create: `packages/hub-wake/src/webPushSender.ts`, `packages/hub-wake/src/expoSender.ts`
- Modify: `packages/hub-wake/src/index.ts`
- Test: `packages/hub-wake/test/webPushSender.test.ts`, `packages/hub-wake/test/expoSender.test.ts`

**Interfaces:**
- Consumes: `WakeSender`, `WakeVerdict`, `WakeRegistration` (Task 1).
- Produces: `createWebPushSender({ vapid, fetch? }): WakeSender`, `createExpoSender({ accessToken?, fetch? }): WakeSender`.

- [ ] **Step 1: Write the failing tests**

Create `packages/hub-wake/test/webPushSender.test.ts`:

```ts
import type { WakeRegistration } from '@kumiai/hub-protocol'
import { p256 } from '@noble/curves/nist.js'
import { describe, expect, test } from 'vitest'

import { createWebPushSender } from '../src/webPushSender.js'

const vapidPrivateKey = p256.utils.randomSecretKey()
const vapid = {
  subject: 'mailto:ops@example.com',
  privateKey: vapidPrivateKey,
  publicKey: p256.getPublicKey(vapidPrivateKey, false),
}

const registration: WakeRegistration = {
  did: 'did:key:alice',
  kind: 'webpush',
  endpoint: 'https://push.example.com/send/abc',
  publicKey: 'cHVibGlj',
  authSecret: 'YXV0aA',
}

const body = new Uint8Array(597).fill(7)

function recordingFetch(status: number) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(null, { status })
  }
  return { calls, fetchImpl }
}

describe('createWebPushSender', () => {
  test('POSTs the body to the endpoint with the aes128gcm headers', async () => {
    const { calls, fetchImpl } = recordingFetch(201)
    const sender = createWebPushSender({ vapid, fetch: fetchImpl })

    await expect(sender.send({ registration, body })).resolves.toBe('delivered')

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://push.example.com/send/abc')
    const headers = new Headers(calls[0].init.headers)
    expect(calls[0].init.method).toBe('POST')
    expect(headers.get('content-encoding')).toBe('aes128gcm')
    expect(headers.get('content-type')).toBe('application/octet-stream')
    expect(headers.get('ttl')).toBe('86400')
    expect(headers.get('authorization')).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/)
  })

  test('404 and 410 are gone', async () => {
    for (const status of [404, 410]) {
      const { fetchImpl } = recordingFetch(status)
      const sender = createWebPushSender({ vapid, fetch: fetchImpl })
      await expect(sender.send({ registration, body })).resolves.toBe('gone')
    }
  })

  test('429 and 5xx are retry', async () => {
    for (const status of [429, 500, 503]) {
      const { fetchImpl } = recordingFetch(status)
      const sender = createWebPushSender({ vapid, fetch: fetchImpl })
      await expect(sender.send({ registration, body })).resolves.toBe('retry')
    }
  })

  test('a thrown network error is retry, not an exception', async () => {
    const sender = createWebPushSender({
      vapid,
      fetch: async () => {
        throw new Error('ECONNRESET')
      },
    })
    await expect(sender.send({ registration, body })).resolves.toBe('retry')
  })
})
```

Create `packages/hub-wake/test/expoSender.test.ts`:

```ts
import type { WakeRegistration } from '@kumiai/hub-protocol'
import { describe, expect, test } from 'vitest'

import { createExpoSender } from '../src/expoSender.js'

const registration: WakeRegistration = {
  did: 'did:key:alice',
  kind: 'expo',
  endpoint: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]',
  publicKey: 'cHVibGlj',
  authSecret: 'YXV0aA',
}

const body = new Uint8Array(597).fill(7)

function jsonFetch(payload: unknown, status = 200) {
  const calls: Array<{ url: string; body: unknown }> = []
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { calls, fetchImpl }
}

describe('createExpoSender', () => {
  test('posts the sealed body base64url in the data field', async () => {
    const { calls, fetchImpl } = jsonFetch({ data: [{ status: 'ok', id: '1' }] })
    const sender = createExpoSender({ fetch: fetchImpl })

    await expect(sender.send({ registration, body })).resolves.toBe('delivered')

    expect(calls[0].url).toBe('https://exp.host/--/api/v2/push/send')
    const sent = calls[0].body as {
      to: string
      data: { w: string }
      mutableContent: boolean
      contentAvailable: boolean
    }
    expect(sent.to).toBe(registration.endpoint)
    expect(sent.mutableContent).toBe(true)
    expect(sent.contentAvailable).toBe(true)
    expect(Buffer.from(sent.data.w, 'base64url')).toHaveLength(body.length)
  })

  test('carries no cleartext topic, DID or count', async () => {
    const { calls, fetchImpl } = jsonFetch({ data: [{ status: 'ok', id: '1' }] })
    const sender = createExpoSender({ fetch: fetchImpl })
    await sender.send({ registration, body })
    const serialized = JSON.stringify(calls[0].body)
    expect(serialized).not.toContain('did:key:alice')
    expect(serialized).not.toContain('topic')
  })

  test('DeviceNotRegistered is gone', async () => {
    const { fetchImpl } = jsonFetch({
      data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }],
    })
    const sender = createExpoSender({ fetch: fetchImpl })
    await expect(sender.send({ registration, body })).resolves.toBe('gone')
  })

  test('another error status is retry', async () => {
    const { fetchImpl } = jsonFetch({
      data: [{ status: 'error', details: { error: 'MessageRateExceeded' } }],
    })
    const sender = createExpoSender({ fetch: fetchImpl })
    await expect(sender.send({ registration, body })).resolves.toBe('retry')
  })

  test('a non-200 response is retry', async () => {
    const { fetchImpl } = jsonFetch({}, 503)
    const sender = createExpoSender({ fetch: fetchImpl })
    await expect(sender.send({ registration, body })).resolves.toBe('retry')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/hub-wake && pnpm exec vitest run`
Expected: FAIL — neither module resolves.

- [ ] **Step 3: Implement the Web Push sender**

Create `packages/hub-wake/src/webPushSender.ts`:

```ts
import {
  encodeBase64url,
  type WakeSendParams,
  type WakeSender,
  type WakeVerdict,
} from '@kumiai/hub-protocol'
import { p256 } from '@noble/curves/nist.js'
import { sha256 } from '@noble/hashes/sha2.js'

export type VapidParams = {
  /** `mailto:` or `https:` contact the push service can reach you at. RFC 8292 requires one. */
  subject: string
  /** VAPID private key, 32 bytes. */
  privateKey: Uint8Array
  /** VAPID public key, raw uncompressed P-256 point, 65 bytes. */
  publicKey: Uint8Array
}

export type WebPushSenderParams = {
  vapid: VapidParams
  /** Seconds the push service may hold the message. Default: 86 400. */
  ttl?: number
  /** Injected for tests. Default: global `fetch`. */
  fetch?: typeof globalThis.fetch
  /** Seconds the VAPID JWT stays valid. Default: 43 200 (RFC 8292's 12-hour ceiling). */
  jwtLifetime?: number
}

function vapidToken(vapid: VapidParams, audience: string, lifetime: number): string {
  const header = encodeBase64url(
    new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })),
  )
  const claims = encodeBase64url(
    new TextEncoder().encode(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + lifetime,
        sub: vapid.subject,
      }),
    ),
  )
  const signingInput = `${header}.${claims}`
  const digest = sha256(new TextEncoder().encode(signingInput))
  // ES256 wants the raw 64-byte r||s pair, which is exactly what noble v2's sign returns.
  const signature = p256.sign(digest, vapid.privateKey, { prehash: false })
  return `${signingInput}.${encodeBase64url(signature)}`
}

/**
 * A sender for any endpoint speaking RFC 8030 Web Push: browser push services, UnifiedPush
 * distributors, ntfy, or a self-hosted relay. It POSTs the sealed body untouched — the encryption
 * already happened in `sealWakeHint`, and this layer never sees inside it.
 */
export function createWebPushSender(params: WebPushSenderParams): WakeSender {
  const fetchImpl = params.fetch ?? globalThis.fetch
  const ttl = params.ttl ?? 86_400
  const jwtLifetime = params.jwtLifetime ?? 43_200

  return {
    async send({ registration, body }: WakeSendParams): Promise<WakeVerdict> {
      let response: Response
      try {
        const url = new URL(registration.endpoint)
        response = await fetchImpl(registration.endpoint, {
          method: 'POST',
          headers: {
            authorization: `vapid t=${vapidToken(params.vapid, url.origin, jwtLifetime)}, k=${encodeBase64url(params.vapid.publicKey)}`,
            'content-encoding': 'aes128gcm',
            'content-type': 'application/octet-stream',
            ttl: String(ttl),
          },
          body: body as BodyInit,
        })
      } catch {
        // A network failure is transient by definition — never a reason to drop a registration.
        return 'retry'
      }
      if (response.status === 404 || response.status === 410) return 'gone'
      if (response.status >= 200 && response.status < 300) return 'delivered'
      return 'retry'
    },
  }
}
```

- [ ] **Step 4: Implement the Expo sender**

Create `packages/hub-wake/src/expoSender.ts`:

```ts
import {
  encodeBase64url,
  type WakeSendParams,
  type WakeSender,
  type WakeVerdict,
} from '@kumiai/hub-protocol'

export type ExpoSenderParams = {
  /** Expo access token, when the project enforces one. */
  accessToken?: string
  /** Injected for tests. Default: global `fetch`. */
  fetch?: typeof globalThis.fetch
  /** Placeholder title the Notification Service Extension REPLACES once it opens the hint. */
  placeholderTitle?: string
  endpoint?: string
}

type ExpoTicket = { status?: string; details?: { error?: string } }

const EXPO_ENDPOINT = 'https://exp.host/--/api/v2/push/send'

/**
 * A sender for the Expo Push API — a plain HTTPS POST, so no vendor SDK is pulled in.
 *
 * Expo (and APNs or FCM behind it) sees the device token, the timing, and a constant-size
 * ciphertext. It never sees a topic, a DID, or content: `data.w` is the sealed body and nothing
 * else travels.
 *
 * `mutableContent` is what lets an iOS Notification Service Extension open the hint and rewrite the
 * title before display. `contentAvailable` asks for a background wake, which iOS throttles — so the
 * placeholder alert, not the background pass, is what the user is guaranteed to see.
 */
export function createExpoSender(params: ExpoSenderParams = {}): WakeSender {
  const fetchImpl = params.fetch ?? globalThis.fetch
  const endpoint = params.endpoint ?? EXPO_ENDPOINT
  const title = params.placeholderTitle ?? 'New activity'

  return {
    async send({ registration, body }: WakeSendParams): Promise<WakeVerdict> {
      let payload: { data?: Array<ExpoTicket> }
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            ...(params.accessToken != null
              ? { authorization: `Bearer ${params.accessToken}` }
              : {}),
          },
          body: JSON.stringify({
            to: registration.endpoint,
            title,
            mutableContent: true,
            contentAvailable: true,
            data: { w: encodeBase64url(body) },
          }),
        })
        if (!response.ok) return 'retry'
        payload = (await response.json()) as { data?: Array<ExpoTicket> }
      } catch {
        return 'retry'
      }
      const ticket = payload.data?.[0]
      if (ticket?.status === 'ok') return 'delivered'
      if (ticket?.details?.error === 'DeviceNotRegistered') return 'gone'
      return 'retry'
    },
  }
}
```

- [ ] **Step 5: Export both**

In `packages/hub-wake/src/index.ts`:

```ts
export { createExpoSender, type ExpoSenderParams } from './expoSender.js'
export { createMemoryWakeRegistry } from './memoryRegistry.js'
export {
  createWebPushSender,
  type VapidParams,
  type WebPushSenderParams,
} from './webPushSender.js'
```

- [ ] **Step 6: Run tests**

Run: `cd packages/hub-wake && pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/hub-wake
git commit -m "feat(hub-wake): Web Push and Expo senders"
```

---

### Task 10: Client registration and unsealing

**Files:**
- Modify: `packages/hub-client/src/client.ts`
- Create: `packages/hub-client/src/wake-keys.ts`
- Modify: `packages/hub-client/src/index.ts`, `packages/hub-client/package.json`
- Test: `packages/hub-client/test/wake.test.ts`

**Interfaces:**
- Consumes: the procedures (Task 3), `openWakeHint` (Task 2).
- Produces: `HubClient.registerWake(params)`, `HubClient.unregisterWake()`, `createWakeKeys()`, re-exported `openWakeHint`.

- [ ] **Step 1: Write the failing test**

Create `packages/hub-client/test/wake.test.ts`:

```ts
import { openWakeHint, sealWakeHint } from '@kumiai/hub-protocol'
import { describe, expect, test } from 'vitest'

import { createWakeKeys } from '../src/wake-keys.js'

describe('createWakeKeys', () => {
  test('produces RFC 8291 sized material', () => {
    const keys = createWakeKeys()
    expect(Buffer.from(keys.publicKey, 'base64url')).toHaveLength(65)
    expect(Buffer.from(keys.authSecret, 'base64url')).toHaveLength(16)
    expect(keys.privateKey).toHaveLength(32)
  })

  test('opens what the hub would seal for it', () => {
    const keys = createWakeKeys()
    const body = sealWakeHint(
      { topicID: 'topic-a', sequenceID: '007', count: 2 },
      {
        publicKey: new Uint8Array(Buffer.from(keys.publicKey, 'base64url')),
        authSecret: new Uint8Array(Buffer.from(keys.authSecret, 'base64url')),
      },
    )
    expect(
      openWakeHint(body, {
        privateKey: keys.privateKey,
        authSecret: new Uint8Array(Buffer.from(keys.authSecret, 'base64url')),
      }),
    ).toEqual({ topicID: 'topic-a', sequenceID: '007', count: 2 })
  })

  test('each call is a fresh keypair', () => {
    expect(createWakeKeys().publicKey).not.toBe(createWakeKeys().publicKey)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub-client && pnpm exec vitest run test/wake.test.ts`
Expected: FAIL — cannot resolve `../src/wake-keys.js`.

- [ ] **Step 3: Implement the keys helper**

Add `"@noble/curves": "catalog:"` and `"@noble/hashes": "catalog:"` to `packages/hub-client/package.json` dependencies, then `pnpm install`.

Create `packages/hub-client/src/wake-keys.ts`:

```ts
import { encodeBase64url } from '@kumiai/hub-protocol'
import { p256 } from '@noble/curves/nist.js'
import { randomBytes } from '@noble/hashes/utils.js'

export type WakeKeys = {
  /** Keep this on the device. It is the only thing that can open a wake ping. */
  privateKey: Uint8Array
  /** base64url, for `registerWake`. */
  publicKey: string
  /** base64url, for `registerWake`. */
  authSecret: string
}

/**
 * Fresh RFC 8291 key material for one device.
 *
 * The private half never leaves the device — the hub stores only the public key and the auth
 * secret, which are all it needs to seal. Rotation is a new call followed by `registerWake`.
 *
 * On iOS the private key must be reachable from the Notification Service Extension, which means
 * the Keychain behind a shared App Group; an in-process-only copy leaves the extension unable to
 * open anything.
 */
export function createWakeKeys(): WakeKeys {
  const privateKey = p256.utils.randomSecretKey()
  return {
    privateKey,
    publicKey: encodeBase64url(p256.getPublicKey(privateKey, false)),
    authSecret: encodeBase64url(randomBytes(16)),
  }
}
```

- [ ] **Step 4: Add the client methods**

In `packages/hub-client/src/client.ts`, add the params type and two methods to `HubClient`:

```ts
export type RegisterWakeParams = {
  /** Opaque sender tag matching the hub's configured sender, e.g. 'webpush' or 'expo'. */
  kind: string
  /** The push endpoint. Opaque to the hub. */
  endpoint: string
  /** base64url, from `createWakeKeys`. */
  publicKey: string
  /** base64url, from `createWakeKeys`. */
  authSecret: string
  /** When this registration expires, in seconds since the epoch. */
  expiresAt?: number
}
```

```ts
  /**
   * Register this device's push endpoint, replacing any previous one.
   *
   * The hub seals every wake to `publicKey`, so re-registering with fresh keys is what rotation
   * means. A hub configured without wake support refuses with the `WakeNotSupportedError` wire
   * code rather than accepting a registration it would never act on.
   */
  registerWake(params: RegisterWakeParams): RequestCall<{ registered: boolean }> {
    return this.#client.request('hub/v1/wake/register', {
      param: {
        kind: params.kind,
        endpoint: params.endpoint,
        publicKey: params.publicKey,
        authSecret: params.authSecret,
        // An explicit `undefined` fails the wire schema's `integer` check on transports that do
        // not drop undefined properties — omit the key instead.
        ...(params.expiresAt != null ? { expiresAt: params.expiresAt } : {}),
      },
    })
  }

  /** Remove this device's push endpoint. `unregistered: false` means there was nothing stored. */
  unregisterWake(): RequestCall<{ unregistered: boolean }> {
    return this.#client.request('hub/v1/wake/unregister', { param: {} })
  }
```

- [ ] **Step 5: Export from the index**

In `packages/hub-client/src/index.ts`, export `createWakeKeys`, `type WakeKeys`, `type RegisterWakeParams`, and re-export the opener so a device needs one import:

```ts
export { openWakeHint, type WakeHint } from '@kumiai/hub-protocol'
```

- [ ] **Step 6: Switch the Task 7 tests to the client methods**

In `packages/hub-server/test/handlers-wake.test.ts`, replace the raw `client.request('hub/v1/wake/…')` calls with `client.registerWake(…)` / `client.unregisterWake()`.

- [ ] **Step 7: Run tests**

Run: `cd packages/hub-client && pnpm test && cd ../hub-server && pnpm test`
Expected: PASS in both.

- [ ] **Step 8: Commit**

```bash
git add packages/hub-client packages/hub-server/test/handlers-wake.test.ts pnpm-lock.yaml
git commit -m "feat(hub-client): wake registration and key material"
```

---

### Task 11: Documentation and release intent

**Files:**
- Create: `docs/reference/wake-notifications.md`, `packages/hub-wake/README.md`
- Modify: `docs/agents/architecture.md`, `AGENTS.md`
- Create: a `pnpm change` intent file

**Interfaces:**
- Consumes: everything above.
- Produces: no code.

- [ ] **Step 1: Write the reference doc**

Create `docs/reference/wake-notifications.md` covering, in the voice of the existing `docs/reference/*.md` files:

- What a wake is and is not — a doorbell, not a delivery path. The frame is already durably queued; the ping only says come and get it.
- The trust boundary: what the hub gains (`DID → endpoint`, a stable identifier outliving every group) and what the provider learns (device identity, timing, constant ciphertext size — never topic, group, sender or content).
- The sealed hint: RFC 8291 `aes128gcm`, why the scheme is fixed by browsers rather than chosen, `{ v, topicID, sequenceID, count }`, and that `count` is frames since the last ping rather than a backlog total.
- Leading-edge debouncing and why leading rather than trailing (a restart loses a summary, never the notification).
- The three verdicts and what each does to the registration.
- The iOS section: the NSE is Swift and outside this repo; **it must never unwrap an MLS frame**, because opening one consumes the per-message ratchet key that `rpc/src/open-once.ts` exists to protect; silent push is throttled, so the visible notification renders from the hint alone.
- Wiring: what `createHub({ wake })` needs and which two pieces the host chooses.

- [ ] **Step 2: Write the package README**

Create `packages/hub-wake/README.md` documenting the surface — `createMemoryWakeRegistry`, `createWebPushSender`, `createExpoSender` — with a wiring example. Document the surface, not why the package exists; that belongs in the reference doc.

- [ ] **Step 3: Update the architecture doc**

In `docs/agents/architecture.md`, add `hub-wake` to the package paragraph, and add a row to the Reference table:

```markdown
| [Wake notifications](../reference/wake-notifications.md) | The push doorbell: the sealed hint, leading-edge debouncing, sender verdicts, and the iOS limits. |
```

Add a residual to the "Stated residuals" list:

```markdown
- **A wake ping tells the push provider that a device received something, and when.** The content
  is sealed and the topic never leaves the hub, but timing is inherent to waking a suspended app.
  Self-hosting the push service collapses this to the hub operator, who already saw the timing.
```

- [ ] **Step 4: Update AGENTS.md**

Add `hub-wake` to the "What this repo is" package list and change "eleven packages" to "twelve packages".

- [ ] **Step 5: Record the release intent**

Run: `pnpm change`

Select every changed package (`@kumiai/hub-protocol`, `@kumiai/hub-server`, `@kumiai/hub-client`, `@kumiai/hub-conformance`, `@kumiai/hub-wake`) as a **minor** bump — new procedures and a new package are additive, and the band moves together. Describe it as "wake notifications: sealed push pings for suspended devices".

- [ ] **Step 6: Verify the whole branch**

```bash
rtk proxy pnpm run lint
pnpm test -- --filter=...
```

Confirm turbo reports `Cached: 0` for the packages you changed; a cached pass proves nothing. If it reports cache hits, run each changed package's `pnpm test` from its own directory.

- [ ] **Step 7: Commit**

```bash
git add docs AGENTS.md .changeset packages/hub-wake/README.md
git commit -m "docs: wake notifications reference and release intent"
```

---

## Out of scope for this branch

Named so nobody mistakes their absence for an oversight:

- **The iOS Notification Service Extension.** Swift, reached through an Expo config plugin, and it
  needs an EAS development build. It is what turns the sealed hint into visible text, and it must
  never unwrap an MLS frame — opening one consumes the per-message ratchet key.
- **A device-level check in `tests/e2e-expo`.** The harness exists, but `xcrun simctl push` injects
  a payload without exercising APNs, and the Android emulator needs Play Services for FCM. Real
  delivery is a manual check on hardware.
- **A durable `WakeRegistry`.** Only the in-memory one ships; the conformance suite is what a host
  runs against its own.
- **APNs and FCM senders.** Both sit behind `WakeSender` for a host that wants them without Expo in
  the path.

## Verification

The branch is done when:

1. `rtk proxy pnpm run lint` is clean.
2. Every changed package's own `pnpm test` passes with `Cached: 0`.
3. The RFC 8291 vector test passes — without it, the round-trip test only proves the code agrees with itself.
4. `testWakeRegistryConformance` passes against `createMemoryWakeRegistry`.
5. A hub built with no `wake` param behaves exactly as before, and both wake procedures refuse.
6. The two mutation checks in Tasks 6 and 8 were performed: breaking the debounce and breaking the online guard each made a test fail, and both were restored.
