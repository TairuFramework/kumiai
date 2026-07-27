# Automatic Last-Resort Key-Package Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** executing
**Mode:** tasks
**Spec:** `docs/superpowers/specs/2026-07-26-last-resort-provisioning-design.md`

**Goal:** Give a host one call that keeps its last-resort key-package slot filled, valid, and backed
by retained private key material, turning two silent doc-only obligations into code.

**Architecture:** Three additions to `@kumiai/mls` (a private-key-package codec pair and a
`keyPackageRef` helper) plus a new bridge package `@kumiai/mls-hub` holding a host-implemented
`LastResortStore` port and a `createLastResortProvisioner` that mints, uploads, retains, and prunes.
The provisioner persists a record **before** uploading it, which is the design's load-bearing
decision: the reverse order has a crash window in which the hub serves a package whose private half
was never written down.

**Tech Stack:** TypeScript (ESM, `@kigu/dev` configs), `ts-mls` 2.0.0-rc.13, `@sozai/codec` for
base64, `@enkaku/*` for transport in tests, vitest 4, pnpm + turbo + changesets, biome.

## Global Constraints

- pnpm only. Never `npm` or `yarn`.
- Never edit generated files under any `lib/` directory.
- Cross-repo deps (`@sozai/*`, `@kokuin/*`, `@enkaku/*`) go through the workspace catalog as
  `"catalog:"`. Internal `@kumiai/*` deps are `"workspace:^"`. Never `workspace:` for cross-repo.
- Extend `@kigu/dev/tsconfig.json`, `["@kigu/dev/biome.json"]`, `@kigu/dev/swc.json`.
- `@kumiai/mls-hub` must NOT depend on `ts-mls`. Every MLS wire form it needs is reached through
  `@kumiai/mls`.
- `@kumiai/mls` must NOT gain a dependency on `@kumiai/hub-client` or any transport package.
- Consumer packages resolve siblings through built `lib/`, not `src/`. After editing `@kumiai/mls`,
  a direct `pnpm --filter @kumiai/mls-hub exec vitest` invocation silently tests stale artifacts.
  Use `pnpm exec turbo run test:unit --filter @kumiai/mls-hub`, which declares
  `dependsOn: ["^build:js", "^build:types"]`.
- Lint is `pnpm run lint` (biome). **On this machine an `rtk` shim intercepts both `pnpm run lint`
  and `pnpm exec biome`; run it as `rtk proxy pnpm run lint` to get real output.**
- `pnpm test` reports cached turbo results. To verify for real, run
  `pnpm exec turbo run test:types test:unit --force` and confirm `Cached: 0` in the summary.
  `pnpm test -- --force` does not work.
- Every task's tests are mutation-checked before commit: break the implementation, confirm the
  matching test FAILS, restore, and prove the restoration with `git diff` (must be empty).
- Values copied verbatim from the spec: `LAST_RESORT_LIFETIME_DAYS` is 90 (already shipped),
  default `rotateWithinDays` is 30, default `retainAfterExpiryDays` is 7, and
  `LAST_RESORT_EXTENSION_TYPE` is `0x000a`.

## File Structure

| File | Responsibility |
|------|----------------|
| `packages/mls/src/key-package-codec.ts` (modify) | Adds `encodePrivateKeyPackage`, `decodePrivateKeyPackage`, `keyPackageRef` beside the existing public-package codec — same concern, same canonicality argument, so same file. |
| `packages/mls/test/key-package-codec.test.ts` (modify) | Strictness and round-trip tests for the new codecs. |
| `packages/mls/src/group-credential.ts` (modify) | Doc-only: records the verified capability-advertisement finding at the `0x000A` constant. |
| `packages/mls/src/index.ts` (modify) | Re-exports the three new functions. |
| `docs/reference/reserved-namespaces.md` (modify) | Explains why `0x000A` sits outside the reserved range and needs no capability advertisement. |
| `packages/mls-hub/src/store.ts` (create) | `LastResortRecord`, `LastResortStore`, `createMemoryLastResortStore`. The port and its reference implementation, no policy. |
| `packages/mls-hub/src/provisioner.ts` (create) | `createLastResortProvisioner` — all timing, ordering, and pruning policy. |
| `packages/mls-hub/src/index.ts` (create) | Public surface and the module doc explaining why the package exists. |
| `packages/mls-hub/test/fixtures/hub.ts` (create) | Real hub + `HubClient` over `DirectTransports`, shared by every provisioner test. |
| `packages/mls-hub/test/store.test.ts` (create) | Memory-store semantics, including owner scoping. |
| `packages/mls-hub/test/provisioner.test.ts` (create) | Mint, no-op, single-flight, crash-retry, upload failure, rotation, pruning. |
| `packages/mls-hub/test/bundles.test.ts` (create) | `bundles()` ordering and decode failure, plus the two real-MLS integration tests. |

---

### Task 1: Private key package codec in `@kumiai/mls`

**Files:**
- Modify: `packages/mls/src/key-package-codec.ts`
- Modify: `packages/mls/src/index.ts:107-110` (the `key-package-codec.js` export block)
- Test: `packages/mls/test/key-package-codec.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `encodePrivateKeyPackage(privatePackage: PrivateKeyPackage): string` and
  `decodePrivateKeyPackage(encoded: string): PrivateKeyPackage | null`, both exported from
  `@kumiai/mls`. `PrivateKeyPackage` is `{ initPrivateKey: Uint8Array; hpkePrivateKey: Uint8Array;
  signaturePrivateKey: Uint8Array }`, publicly exported by `ts-mls`.

**Why this exists:** `key-package-codec.ts` already argues that leaving a canonical string form to
each host is how an uploader and a fetcher come to disagree about packages sitting in a hub. Task 4
introduces a store that must persist the *private* half, so the same argument now applies to it.

- [ ] **Step 1: Write the failing tests**

Append to `packages/mls/test/key-package-codec.test.ts`:

```ts
describe('encodePrivateKeyPackage / decodePrivateKeyPackage', () => {
  test('a round trip reproduces the private key package structurally', async () => {
    const bundle = await createKeyPackageBundle(randomIdentity())
    const decoded = decodePrivateKeyPackage(encodePrivateKeyPackage(bundle.privatePackage))
    expect(decoded).toEqual(bundle.privatePackage)
  })

  test('encoding is deterministic for the same private package', async () => {
    const bundle = await createKeyPackageBundle(randomIdentity())
    expect(encodePrivateKeyPackage(bundle.privatePackage)).toBe(
      encodePrivateKeyPackage(bundle.privatePackage),
    )
  })

  /** Same reasoning as the public codec: ts-mls's `decode()` discards the consumed length. */
  test('trailing bytes after a valid encoding are rejected', async () => {
    const bundle = await createKeyPackageBundle(randomIdentity())
    const bytes = new Uint8Array([
      ...fromEncoded(encodePrivateKeyPackage(bundle.privatePackage)),
      0x00,
    ])
    expect(decodePrivateKeyPackage(toB64(bytes))).toBeNull()
  })

  /** Canonicality is a STRING property: a store compares strings, and `fromB64` trims whitespace. */
  test('a whitespace-padded encoding is rejected', async () => {
    const bundle = await createKeyPackageBundle(randomIdentity())
    expect(decodePrivateKeyPackage(`${encodePrivateKeyPackage(bundle.privatePackage)}\n`)).toBeNull()
  })

  test('non-base64 input returns null rather than throwing', () => {
    expect(decodePrivateKeyPackage('not base64 !!!')).toBeNull()
  })

  test('the empty string is rejected', () => {
    expect(decodePrivateKeyPackage('')).toBeNull()
  })

  test('truncated TLS bytes are rejected', async () => {
    const bundle = await createKeyPackageBundle(randomIdentity())
    const bytes = fromEncoded(encodePrivateKeyPackage(bundle.privatePackage))
    expect(decodePrivateKeyPackage(toB64(bytes.subarray(0, bytes.length - 1)))).toBeNull()
  })
})
```

Extend the existing import of the codec module at the top of the file to:

```ts
import {
  decodeKeyPackage,
  decodePrivateKeyPackage,
  encodeKeyPackage,
  encodePrivateKeyPackage,
} from '../src/key-package-codec.js'
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @kumiai/mls exec vitest run test/key-package-codec.test.ts`
Expected: FAIL — `decodePrivateKeyPackage is not a function` / no export named
`encodePrivateKeyPackage`.

- [ ] **Step 3: Write the implementation**

In `packages/mls/src/key-package-codec.ts`, extend the existing ts-mls import to:

```ts
import {
  encode,
  type KeyPackage,
  keyPackageDecoder,
  keyPackageEncoder,
  type PrivateKeyPackage,
  privateKeyPackageDecoder,
  privateKeyPackageEncoder,
} from 'ts-mls'
```

and append:

```ts
/**
 * Serialize a private key package for durable storage.
 *
 * A last-resort key package is reusable, so its private half must OUTLIVE the process that
 * generated it — see `@kumiai/mls-hub`. That makes the string form a persistence format two
 * versions of one host must agree on, which is the same reason {@link encodeKeyPackage} refuses to
 * hand bytes back and leave the base64 choice to each caller.
 *
 * **The result is secret key material.** It is not a public wire form: never publish it, never log
 * it, and store it only where the host stores private keys.
 */
export function encodePrivateKeyPackage(privatePackage: PrivateKeyPackage): string {
  return toB64(encode(privateKeyPackageEncoder, privatePackage))
}

/**
 * Parse a stored private key package, or `null` if the string is not exactly one.
 *
 * Strict in the same three ways {@link decodeKeyPackage} is, for the same reasons: `fromB64`'s
 * throw on a bad alphabet is absorbed; the input must be the canonical base64 of its own bytes,
 * because a store compares strings and `fromB64` tolerates padding variation and trims whitespace;
 * and `privateKeyPackageDecoder` is called directly rather than through ts-mls's `decode()`, whose
 * `dec(t, 0)?.[0]` discards the consumed length and so accepts trailing garbage in silence.
 *
 * A successful decode proves well-formedness and nothing else — in particular it does not prove the
 * keys match any public package.
 */
export function decodePrivateKeyPackage(encoded: string): PrivateKeyPackage | null {
  let bytes: Uint8Array
  try {
    bytes = fromB64(encoded)
  } catch {
    return null
  }
  if (toB64(bytes) !== encoded) return null
  let decoded: ReturnType<typeof privateKeyPackageDecoder>
  try {
    decoded = privateKeyPackageDecoder(bytes, 0)
  } catch {
    return null
  }
  // The tuple's second element is the CONSUMED LENGTH, so this is a whole-input check.
  if (decoded == null || decoded[1] !== bytes.length) return null
  return decoded[0]
}
```

In `packages/mls/src/index.ts`, replace the `key-package-codec.js` export block with:

```ts
export {
  decodeKeyPackage,
  decodePrivateKeyPackage,
  encodeKeyPackage,
  encodePrivateKeyPackage,
} from './key-package-codec.js'
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @kumiai/mls exec vitest run test/key-package-codec.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @kumiai/mls run test:types`
Expected: exits 0 with no output. (vitest strips types, so step 4 passing proves nothing about the
type annotations above.)

- [ ] **Step 6: Mutation-check**

Delete the line `if (toB64(bytes) !== encoded) return null` from `decodePrivateKeyPackage`.
Run: `pnpm --filter @kumiai/mls exec vitest run test/key-package-codec.test.ts`
Expected: FAIL on 'a whitespace-padded encoding is rejected'.
Restore the line. Run `git diff packages/mls/src/key-package-codec.ts` and confirm only the intended
additions remain.

- [ ] **Step 7: Lint and commit**

```bash
rtk proxy pnpm run lint
git add packages/mls/src/key-package-codec.ts packages/mls/src/index.ts packages/mls/test/key-package-codec.test.ts
git commit -m "feat(mls): canonical codec for private key packages"
```

---

### Task 2: `keyPackageRef` in `@kumiai/mls`

**Files:**
- Modify: `packages/mls/src/key-package-codec.ts`
- Modify: `packages/mls/src/index.ts` (the `key-package-codec.js` export block from Task 1)
- Test: `packages/mls/test/key-package-codec.test.ts`

**Interfaces:**
- Consumes: Task 1's export block in `index.ts`.
- Produces: `keyPackageRef(keyPackage: KeyPackage, options?: GroupOptions): Promise<string>`.
  Task 4 uses it as the `LastResortRecord.ref` field.

**Why a ref rather than the encoded package as the record ID:** the ref is 32 bytes rather than
several hundred, and it is the value a Welcome names — so a later "which retained bundle does this
Welcome match" helper needs no store migration.

- [ ] **Step 1: Write the failing tests**

Append to `packages/mls/test/key-package-codec.test.ts`:

```ts
describe('keyPackageRef', () => {
  test('is stable for the same package and differs between packages', async () => {
    const bundle = await createKeyPackageBundle(randomIdentity())
    const other = await createKeyPackageBundle(randomIdentity())

    const ref = await keyPackageRef(bundle.publicPackage)
    expect(await keyPackageRef(bundle.publicPackage)).toBe(ref)
    expect(await keyPackageRef(other.publicPackage)).not.toBe(ref)
  })

  /** The ref must depend on the package's bytes, not on object identity or insertion order. */
  test('survives a codec round trip', async () => {
    const bundle = await createKeyPackageBundle(randomIdentity())
    const decoded = decodeKeyPackage(encodeKeyPackage(bundle.publicPackage))
    expect(decoded).not.toBeNull()
    if (decoded == null) return
    expect(await keyPackageRef(decoded)).toBe(await keyPackageRef(bundle.publicPackage))
  })

  test('is base64 of a 32-byte hash for the default ciphersuite', async () => {
    const bundle = await createKeyPackageBundle(randomIdentity())
    const ref = await keyPackageRef(bundle.publicPackage)
    expect(fromEncoded(ref)).toHaveLength(32)
  })
})
```

Extend the codec import to include `keyPackageRef`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @kumiai/mls exec vitest run test/key-package-codec.test.ts -t keyPackageRef`
Expected: FAIL — `keyPackageRef is not a function`.

- [ ] **Step 3: Write the implementation**

Add `makeKeyPackageRef` to the ts-mls import in `packages/mls/src/key-package-codec.ts`, add these
two imports:

```ts
import { resolveMlsContext } from './group-context.js'
import type { GroupOptions } from './types.js'
```

and append:

```ts
/**
 * The KeyPackageRef for a key package, base64 — the value a Welcome names when it says which
 * package a set of encrypted group secrets is for.
 *
 * Used as the stable identity of a stored package. It is a hash over the package's canonical
 * encoding, so it is unchanged by a codec round trip, and it is derived under the ciphersuite's
 * hash — a package encoded under one suite and referenced under another yields a different ref,
 * which is why `options` is threaded through rather than defaulted here.
 */
export async function keyPackageRef(
  keyPackage: KeyPackage,
  options?: GroupOptions,
): Promise<string> {
  const { cipherSuite } = await resolveMlsContext(options)
  return toB64(await makeKeyPackageRef(keyPackage, cipherSuite.hash))
}
```

Add `keyPackageRef` to the `key-package-codec.js` export block in `packages/mls/src/index.ts`,
keeping the block alphabetically ordered:

```ts
export {
  decodeKeyPackage,
  decodePrivateKeyPackage,
  encodeKeyPackage,
  encodePrivateKeyPackage,
  keyPackageRef,
} from './key-package-codec.js'
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @kumiai/mls exec vitest run test/key-package-codec.test.ts`
Expected: PASS, whole file.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @kumiai/mls run test:types`
Expected: exits 0. This is also the check that importing `group-context.js` from
`key-package-codec.ts` introduced no circular type resolution.

- [ ] **Step 6: Mutation-check**

Change `makeKeyPackageRef(keyPackage, cipherSuite.hash)` to hash a fixed constant instead — e.g.
return `toB64(new Uint8Array(32))`.
Run: `pnpm --filter @kumiai/mls exec vitest run test/key-package-codec.test.ts -t keyPackageRef`
Expected: FAIL on 'is stable for the same package and differs between packages'.
Restore, and confirm with `git diff packages/mls/src/key-package-codec.ts`.

- [ ] **Step 7: Lint and commit**

```bash
rtk proxy pnpm run lint
git add packages/mls/src/key-package-codec.ts packages/mls/src/index.ts packages/mls/test/key-package-codec.test.ts
git commit -m "feat(mls): keyPackageRef for identifying a stored key package"
```

---

### Task 3: Record the capability-advertisement finding (docs only)

**Files:**
- Modify: `packages/mls/src/group-credential.ts:73-80` (the `LAST_RESORT_EXTENSION_TYPE` doc block)
- Modify: `docs/reference/reserved-namespaces.md` (after the GroupContext extension-type table,
  currently ending around line 88)
- Modify: `packages/mls/README.md` (exports list — add the three new functions)

**Interfaces:**
- Consumes: Tasks 1 and 2 (the functions named in the README).
- Produces: nothing consumed by later tasks.

**Why this is a task and not a footnote:** the originating `next/` item left an open
wire-compatibility question whose cost of guessing wrong is that a conforming peer refuses every
last-resort package this stack publishes. It was researched and answered during design; the answer
belongs in the codebase next to the constant, not only in a spec.

- [ ] **Step 1: Extend the constant's doc block**

In `packages/mls/src/group-credential.ts`, replace the doc comment above
`export const LAST_RESORT_EXTENSION_TYPE = 0x000a` with:

```ts
/**
 * The `last_resort` KeyPackage extension from draft-ietf-mls-extensions (NOT RFC 9420, which has
 * no such extension). Its presence marks a key package as reusable by design; its data is empty.
 *
 * This is a KeyPackage extension, not a leaf-node one, so it needs no entry in the leaf's
 * capabilities and `controlCapabilities()` is unaffected.
 *
 * **Verified, not assumed.** Three sources were read, and none requires a publisher to advertise
 * this type:
 *
 * - draft-ietf-mls-extensions-05, which this value matches: `Value: 0x000A`,
 *   `Name: last_resort_key_package`, `Message(s): KP`, `Recommended: Y`. No advertisement clause.
 * - RFC 9420 independently: its capabilities rule binds LEAF NODE extensions, and this one is
 *   KeyPackage-only, so the rule does not reach it. This is also why ts-mls checks a peer's
 *   declared capabilities against leaf extensions alone.
 * - draft-ietf-mls-extensions-08 (current) restructured the feature: last_resort is no longer an
 *   extension type but an MLS *Component* Type, `0x00000004`, carried inside the
 *   `app_data_dictionary` extension.
 *
 * **Watch item, not a change.** `0x000A` is what deployed implementations do — OpenMLS `main`
 * ships `ExtensionType::LastResort => 10` — so it remains the interoperable choice. Anyone
 * migrating to -08's component form must revisit `controlCapabilities()` at the same time,
 * because -08 DOES tell clients to advertise `app_data_dictionary` support in their LeafNodes.
 */
```

- [ ] **Step 2: Add the reference-doc section**

Append to `docs/reference/reserved-namespaces.md`, after the GroupContext extension-type section:

```markdown
## The one MLS extension type kumiai uses but does not reserve

`0x000A` (`LAST_RESORT_EXTENSION_TYPE`, `packages/mls/src/group-credential.ts`) is not in the
`0xf10x` reserved block, because kumiai did not define it: it is `last_resort_key_package` from
draft-ietf-mls-extensions, and the number is the draft's.

**The rule above does not apply to it.** A leaf must advertise a custom extension type before it can
be installed — that is what makes the reserved GroupContext types work — but `last_resort` is a
**KeyPackage** extension (`Message(s): KP`), and RFC 9420's capabilities rule binds leaf-node
extensions only. ts-mls follows the RFC here, checking a peer's declared capabilities against leaf
extensions alone. So `controlCapabilities()` does not list `0x000A`, and that is correct rather than
an omission. Neither draft -05 nor -08 adds an advertisement requirement of its own.

**Version drift to watch.** Draft -08 moved the feature out of the extension registry entirely: it
is now MLS Component Type `0x00000004`, carried inside the `app_data_dictionary` extension. `0x000A`
is nonetheless what deployed implementations use (OpenMLS `main`: `ExtensionType::LastResort => 10`),
so it stays. Whoever migrates to the component form must revisit `controlCapabilities()` at the same
time, because -08 *does* ask clients to advertise `app_data_dictionary` support in their LeafNodes.
```

Also update the file's opening line, which currently reads "kumiai reserves two string prefixes and
three MLS extension type" — leave the reservation count alone (it is still three reserved types) but
confirm the new section does not contradict it. If the sentence promises the file covers only
reserved types, extend it to "...three MLS extension types, and explains one it uses without
reserving."

- [ ] **Step 3: Update the `@kumiai/mls` README exports list**

Add to the exports section of `packages/mls/README.md`, alongside the existing
`encodeKeyPackage` / `decodeKeyPackage` entry:

```markdown
- `encodePrivateKeyPackage` / `decodePrivateKeyPackage` — the canonical string form of a key
  package's **private** half, for a host that must persist it across restarts (a reusable
  last-resort package outlives the process that made it). Secret material: never publish or log it.
- `keyPackageRef` — the base64 KeyPackageRef a Welcome names, stable across a codec round trip.
  Use it as the identity of a stored package.
```

- [ ] **Step 4: Verify the claims are reproducible**

Read the two draft sources and confirm the quoted values before committing. The exact rows are:
- `-05` §4.2.5: `Value: 0x000A`, `Name: last_resort_key_package`, `Message(s): KP`,
  `Recommended: Y`.
- `-08` §7.5 MLS Component Types: `0x0000 0004 | last_resort_key_package | KP | Y | RFCXXXX`.

If either differs from what the doc now claims, fix the doc to match the source — the source wins.

- [ ] **Step 5: Lint and commit**

```bash
rtk proxy pnpm run lint
git add packages/mls/src/group-credential.ts packages/mls/README.md docs/reference/reserved-namespaces.md
git commit -m "docs(mls): record why 0x000A needs no capability advertisement"
```

---

### Task 4: `@kumiai/mls-hub` package with the `LastResortStore` port

**Files:**
- Create: `packages/mls-hub/package.json`
- Create: `packages/mls-hub/tsconfig.json`
- Create: `packages/mls-hub/tsconfig.test.json`
- Create: `packages/mls-hub/src/store.ts`
- Create: `packages/mls-hub/src/index.ts`
- Test: `packages/mls-hub/test/store.test.ts`

**Interfaces:**
- Consumes: nothing at runtime yet; the package's deps are declared here for Tasks 5-8.
- Produces: `LastResortRecord`, `LastResortStore`, `createMemoryLastResortStore()`. Tasks 5-8 import
  all three from `../src/store.js`.

- [ ] **Step 1: Create the package manifest**

`packages/mls-hub/package.json`:

```json
{
  "name": "@kumiai/mls-hub",
  "version": "0.0.0",
  "description": "Key-package provisioning between @kumiai/mls and a kumiai hub",
  "keywords": [
    "mls",
    "hub",
    "keypackage",
    "e2ee"
  ],
  "repository": {
    "type": "git",
    "url": "https://github.com/TairuFramework/kumiai",
    "directory": "packages/mls-hub"
  },
  "license": "MIT",
  "sideEffects": false,
  "type": "module",
  "exports": {
    ".": "./lib/index.js"
  },
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "files": [
    "lib/*"
  ],
  "scripts": {
    "build": "pnpm run build:clean && pnpm run build:js && pnpm run build:types",
    "build:clean": "del lib",
    "build:js": "swc src -d ./lib --config-file ../../node_modules/@kigu/dev/swc.json --strip-leading-paths",
    "build:types": "tsc --emitDeclarationOnly --skipLibCheck",
    "prepublishOnly": "pnpm run build",
    "test": "pnpm run test:types && pnpm run test:unit",
    "test:types": "tsc --noEmit --skipLibCheck -p tsconfig.test.json",
    "test:unit": "vitest run"
  },
  "dependencies": {
    "@kokuin/token": "catalog:",
    "@kumiai/hub-client": "workspace:^",
    "@kumiai/mls": "workspace:^"
  },
  "devDependencies": {
    "@enkaku/client": "catalog:",
    "@enkaku/protocol": "catalog:",
    "@enkaku/transport": "catalog:",
    "@kumiai/hub-protocol": "workspace:^",
    "@kumiai/hub-server": "workspace:^"
  }
}
```

`packages/mls-hub/tsconfig.json`:

```json
{
  "extends": "@kigu/dev/tsconfig.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./lib"
  },
  "include": ["./src/**/*"]
}
```

`packages/mls-hub/tsconfig.test.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "lib": ["es2025", "dom"],
    "types": ["node"],
    "rootDir": ".",
    "noEmit": true
  },
  "include": ["./src/**/*", "./test/**/*"]
}
```

- [ ] **Step 2: Install so the workspace picks the package up**

Run: `pnpm install`
Expected: succeeds, and `pnpm ls --filter @kumiai/mls-hub --depth 0` shows `@kumiai/mls` and
`@kumiai/hub-client` resolved to the workspace versions. `packages/*` is already in
`pnpm-workspace.yaml` and `turbo.json` uses task globs, so neither file needs editing.

- [ ] **Step 3: Write the failing store tests**

`packages/mls-hub/test/store.test.ts`:

```ts
import { describe, expect, test } from 'vitest'

import { type LastResortRecord, createMemoryLastResortStore } from '../src/store.js'

const ALICE = 'did:key:alice'
const BOB = 'did:key:bob'

function record(ref: string, notAfter = 1_000): LastResortRecord {
  return {
    ref,
    keyPackage: `kp-${ref}`,
    privatePackage: `priv-${ref}`,
    notAfter,
    uploadedAt: null,
  }
}

describe('createMemoryLastResortStore', () => {
  test('put then list returns the record', async () => {
    const store = createMemoryLastResortStore()
    await store.put(ALICE, record('a'))
    expect(await store.list(ALICE)).toEqual([record('a')])
  })

  test('an owner with no records lists empty', async () => {
    const store = createMemoryLastResortStore()
    expect(await store.list(ALICE)).toEqual([])
  })

  /**
   * The provisioner re-puts the SAME ref with `uploadedAt` set as the second write of its upload
   * sequence. A store that appended instead of replacing would grow a duplicate per rotation and
   * make `list` ambiguous about which copy reached the hub.
   */
  test('put replaces a record with the same ref rather than duplicating it', async () => {
    const store = createMemoryLastResortStore()
    await store.put(ALICE, record('a'))
    await store.put(ALICE, { ...record('a'), uploadedAt: 42 })
    const listed = await store.list(ALICE)
    expect(listed).toHaveLength(1)
    expect(listed[0]?.uploadedAt).toBe(42)
  })

  /**
   * The `WHERE owner = ?` trap, and the reason it is tested rather than trusted: these records hold
   * PRIVATE KEY MATERIAL, so a list that crossed owners would be worse than any of the hub-store
   * scoping bugs the hub conformance suite pins.
   */
  test("one owner's records are never listed for another", async () => {
    const store = createMemoryLastResortStore()
    await store.put(ALICE, record('a'))
    expect(await store.list(BOB)).toEqual([])
  })

  test('delete removes only the named record for the named owner', async () => {
    const store = createMemoryLastResortStore()
    await store.put(ALICE, record('a'))
    await store.put(ALICE, record('b'))
    await store.put(BOB, record('a'))

    await store.delete(ALICE, 'a')

    expect((await store.list(ALICE)).map((r) => r.ref)).toEqual(['b'])
    expect((await store.list(BOB)).map((r) => r.ref)).toEqual(['a'])
  })

  test('deleting a ref the owner does not hold is a no-op', async () => {
    const store = createMemoryLastResortStore()
    await store.put(ALICE, record('a'))
    await store.delete(ALICE, 'missing')
    expect((await store.list(ALICE)).map((r) => r.ref)).toEqual(['a'])
  })

  /** A returned record must not alias stored state, or a caller's edit silently rewrites the store. */
  test('mutating a listed record does not change what is stored', async () => {
    const store = createMemoryLastResortStore()
    await store.put(ALICE, record('a'))
    const [listed] = await store.list(ALICE)
    if (listed != null) listed.uploadedAt = 999
    expect((await store.list(ALICE))[0]?.uploadedAt).toBeNull()
  })
})
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm exec turbo run test:unit --filter @kumiai/mls-hub`
Expected: FAIL — cannot resolve `../src/store.js`.

- [ ] **Step 5: Write the store module**

`packages/mls-hub/src/store.ts`:

```ts
/**
 * One retained last-resort key package.
 *
 * Records ACCUMULATE across rotations rather than replacing one another. An inviter that fetched the
 * hub's slot before the last rotation still holds the previous package, and callers of
 * `fetchKeyPackages(did, N)` cache for future joins — so a Welcome arriving after a rotation
 * legitimately matches an older record, and deleting it on rotation would make that join impossible.
 */
export type LastResortRecord = {
  /** `keyPackageRef` from `@kumiai/mls` — this record's ID. */
  ref: string
  /** `encodeKeyPackage` output: the exact string uploaded to the hub's slot. */
  keyPackage: string
  /** `encodePrivateKeyPackage` output. SECRET key material. */
  privatePackage: string
  /**
   * The package's MLS lifetime `notAfter`, in seconds since the epoch.
   *
   * Denormalized out of the package so a SQL store can index pruning without decoding MLS. A
   * SCHEDULING HINT ONLY — nothing security-relevant reads it. An inviter validates the real
   * lifetime inside the package when it builds the Add, and that check is the authority.
   */
  notAfter: number
  /**
   * When the hub's slot was confirmed to hold this package, in milliseconds; `null` for a record
   * that was minted but whose upload has not yet succeeded.
   *
   * Only its NULLNESS is ever read — no code compares the value — so it carries a local timestamp
   * for host observability and need not agree with `notAfter`'s unit.
   */
  uploadedAt: number | null
}

/**
 * Durable storage for retained last-resort key packages, implemented by the host.
 *
 * `@kumiai/mls` never owns private key material, so something above it must. This is that seam.
 * **Everything a store persists here is secret** — treat it as private key storage, not as a cache.
 *
 * A store MUST:
 *
 * - scope `list` to `ownerDID` and return NOTHING belonging to another owner. Omitting the owner
 *   predicate leaks private key material across identities.
 * - scope `delete` to `ownerDID`, and no-op for a `ref` that owner does not hold.
 * - treat `put` as replace-by-`ref`, never append. The provisioner re-puts one `ref` twice — once
 *   before uploading and once after — so an appending store grows a duplicate per rotation.
 * - return records that do not alias its own state, so a caller's mutation cannot rewrite the store.
 *
 * No ordering is required from `list`: the provisioner sorts what it gets.
 */
export type LastResortStore = {
  list(ownerDID: string): Promise<Array<LastResortRecord>>
  put(ownerDID: string, record: LastResortRecord): Promise<void>
  delete(ownerDID: string, ref: string): Promise<void>
}

/**
 * An in-memory {@link LastResortStore}, and the strict reference for the rules above.
 *
 * **Loses every record on restart**, which for this port means the host's last-resort slot survives
 * in the hub while the private half needed to use it does not — the silent "unaddable forever"
 * outage the slot exists to prevent. Use it in tests and throwaway processes only.
 */
export function createMemoryLastResortStore(): LastResortStore {
  const byOwner = new Map<string, Map<string, LastResortRecord>>()
  return {
    async list(ownerDID: string): Promise<Array<LastResortRecord>> {
      const records = byOwner.get(ownerDID)
      return records == null ? [] : [...records.values()].map((record) => ({ ...record }))
    },
    async put(ownerDID: string, record: LastResortRecord): Promise<void> {
      let records = byOwner.get(ownerDID)
      if (records == null) {
        records = new Map()
        byOwner.set(ownerDID, records)
      }
      records.set(record.ref, { ...record })
    },
    async delete(ownerDID: string, ref: string): Promise<void> {
      byOwner.get(ownerDID)?.delete(ref)
    },
  }
}
```

`packages/mls-hub/src/index.ts`:

```ts
/**
 * Key-package provisioning between `@kumiai/mls` and a kumiai hub.
 *
 * ## Why this is its own package
 *
 * `@kumiai/mls` is the crypto core and must not depend on transport — a group library that imported
 * a hub client would invert the stack. `@kumiai/hub-client` must not depend on `ts-mls`: its whole
 * character is that it never decodes MLS, matching the hub it speaks to, and every consumer would
 * otherwise pay that dependency. `@kumiai/mls-rpc` implements `@kumiai/rpc`'s consumer ports, and
 * provisioning implements no rpc port.
 *
 * So the code that joins the two belongs above both, for the same reason `@kumiai/mls-rpc` exists:
 * an implementation spanning two packages goes in a third, because putting it in either one imports
 * a dependency that package must not have. Note that this package does NOT depend on `ts-mls` —
 * every MLS wire form it needs is reached through `@kumiai/mls`.
 *
 * @module mls-hub
 */

export {
  createMemoryLastResortStore,
  type LastResortRecord,
  type LastResortStore,
} from './store.js'
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm exec turbo run test:unit --filter @kumiai/mls-hub`
Expected: PASS, 7 tests.

- [ ] **Step 7: Typecheck and build**

Run: `pnpm exec turbo run test:types build:js --filter @kumiai/mls-hub`
Expected: both succeed. This confirms the swc and tsc scripts and the `@kigu/dev` config paths are
right — the relative `../../node_modules/@kigu/dev/swc.json` is load-bearing.

- [ ] **Step 8: Mutation-check**

In `createMemoryLastResortStore`, change `list` to `[...byOwner.values()].flatMap((records) => [...records.values()])`
(dropping the owner scope).
Run: `pnpm exec turbo run test:unit --filter @kumiai/mls-hub`
Expected: FAIL on "one owner's records are never listed for another".
Restore, and confirm with `git diff packages/mls-hub/src/store.ts`.

- [ ] **Step 9: Lint and commit**

```bash
rtk proxy pnpm run lint
git add packages/mls-hub pnpm-lock.yaml
git commit -m "feat(mls-hub): new package with the LastResortStore port"
```

---

### Task 5: Provisioner — mint, no-op, and single-flight

**Files:**
- Create: `packages/mls-hub/src/provisioner.ts`
- Modify: `packages/mls-hub/src/index.ts`
- Create: `packages/mls-hub/test/fixtures/hub.ts`
- Test: `packages/mls-hub/test/provisioner.test.ts`

**Interfaces:**
- Consumes: `LastResortRecord`, `LastResortStore`, `createMemoryLastResortStore` from
  `../src/store.js` (Task 4); `createLastResortKeyPackageBundle`, `encodeKeyPackage`,
  `encodePrivateKeyPackage`, `keyPackageRef` from `@kumiai/mls` (Tasks 1-2).
- Produces: `createLastResortProvisioner(params: LastResortProvisionerParams): LastResortProvisioner`
  where `ensureProvisioned(): Promise<{ rotated: boolean; ref: string }>`. Tasks 6-8 extend the
  same file and its tests. The `bundles()` method is declared on the type here and implemented in
  Task 8; until then it throws `new Error('not implemented')`.

- [ ] **Step 1: Write the shared test fixture**

`packages/mls-hub/test/fixtures/hub.ts`:

```ts
import { Client } from '@enkaku/client'
import type { AnyClientMessageOf, AnyServerMessageOf } from '@enkaku/protocol'
import { DirectTransports } from '@enkaku/transport'
import { type OwnIdentity, randomIdentity } from '@kokuin/token'
import { HubClient } from '@kumiai/hub-client'
import type { HubProtocol } from '@kumiai/hub-protocol'
import { createHub, createMemoryStore } from '@kumiai/hub-server'

type HubTransports = DirectTransports<
  AnyServerMessageOf<HubProtocol>,
  AnyClientMessageOf<HubProtocol>
>

export type TestHub = {
  client: HubClient
  identity: OwnIdentity
  /** The hub's own store, for asserting what actually reached the slot. */
  hubStore: ReturnType<typeof createMemoryStore>
  dispose: () => Promise<void>
}

/** A real hub over in-process transports, plus one authenticated client for `identity`. */
export function createTestHub(identity: OwnIdentity = randomIdentity()): TestHub {
  const hubStore = createMemoryStore()
  const hubIdentity = randomIdentity()
  const serverTransports: HubTransports = new DirectTransports()
  const hub = createHub({
    transport: serverTransports.server,
    store: hubStore,
    identity: hubIdentity,
  })

  const clientTransports: HubTransports = new DirectTransports()
  hub.server.handle(clientTransports.server)
  const client = new HubClient({
    client: new Client<HubProtocol>({
      transport: clientTransports.client,
      identity,
      serverID: hubIdentity.id,
    }),
  })

  return {
    client,
    identity,
    hubStore,
    dispose: async () => {
      await clientTransports.dispose()
      await serverTransports.dispose()
    },
  }
}
```

- [ ] **Step 2: Write the failing tests**

`packages/mls-hub/test/provisioner.test.ts`:

```ts
import { describe, expect, test, vi } from 'vitest'

import { createLastResortProvisioner } from '../src/provisioner.js'
import { createMemoryLastResortStore } from '../src/store.js'
import { createTestHub } from './fixtures/hub.js'

describe('ensureProvisioned', () => {
  test('an empty store mints, uploads once, and records the upload', async () => {
    const hub = createTestHub()
    const store = createMemoryLastResortStore()
    const upload = vi.spyOn(hub.client, 'uploadLastResortKeyPackage')
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    const result = await provisioner.ensureProvisioned()

    expect(result.rotated).toBe(true)
    expect(upload).toHaveBeenCalledTimes(1)

    const records = await store.list(hub.identity.id)
    expect(records).toHaveLength(1)
    expect(records[0]?.ref).toBe(result.ref)
    expect(records[0]?.uploadedAt).toBeTypeOf('number')

    // The bytes in the hub's slot are the record's, not some re-encoding of them.
    expect(await hub.hubStore.fetchLastResortKeyPackage(hub.identity.id)).toBe(
      records[0]?.keyPackage,
    )

    await hub.dispose()
  })

  test('a second call inside the validity window uploads nothing', async () => {
    const hub = createTestHub()
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    const first = await provisioner.ensureProvisioned()
    const upload = vi.spyOn(hub.client, 'uploadLastResortKeyPackage')
    const second = await provisioner.ensureProvisioned()

    expect(second).toEqual({ rotated: false, ref: first.ref })
    expect(upload).not.toHaveBeenCalled()
    expect(await store.list(hub.identity.id)).toHaveLength(1)

    await hub.dispose()
  })

  /**
   * Two overlapping callers must not both mint: each would generate its own package, each would
   * overwrite the other's slot, and the store would carry a record whose package the hub no longer
   * holds. The second caller joins the first instead.
   */
  test('overlapping calls produce one rotation and one upload', async () => {
    const hub = createTestHub()
    const store = createMemoryLastResortStore()
    const upload = vi.spyOn(hub.client, 'uploadLastResortKeyPackage')
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    const [a, b] = await Promise.all([
      provisioner.ensureProvisioned(),
      provisioner.ensureProvisioned(),
    ])

    expect(a).toEqual(b)
    expect(upload).toHaveBeenCalledTimes(1)
    expect(await store.list(hub.identity.id)).toHaveLength(1)

    await hub.dispose()
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm exec turbo run test:unit --filter @kumiai/mls-hub`
Expected: FAIL — cannot resolve `../src/provisioner.js`.

- [ ] **Step 4: Write the provisioner**

`packages/mls-hub/src/provisioner.ts`:

```ts
import type { OwnIdentity } from '@kokuin/token'
import {
  createLastResortKeyPackageBundle,
  encodeKeyPackage,
  encodePrivateKeyPackage,
  type GroupOptions,
  type KeyPackageBundle,
  keyPackageRef,
} from '@kumiai/mls'
import type { HubClient } from '@kumiai/hub-client'

import type { LastResortRecord, LastResortStore } from './store.js'

const DAY_SECONDS = 86_400
const DEFAULT_ROTATE_WITHIN_DAYS = 30
const DEFAULT_RETAIN_AFTER_EXPIRY_DAYS = 7

export type LastResortProvisionerParams = {
  /** The identity the package is minted for; also the store's owner key. */
  identity: OwnIdentity
  /** Narrowed to the one method used, so nothing else about the client is coupled here. */
  client: Pick<HubClient, 'uploadLastResortKeyPackage'>
  store: LastResortStore
  /** Threaded into `createLastResortKeyPackageBundle` and `keyPackageRef`. */
  options?: GroupOptions
  /** Rotate once the live package has fewer than this many days left. Default 30. */
  rotateWithinDays?: number
  /** Keep a retired record this many days past its `notAfter`. Default 7. */
  retainAfterExpiryDays?: number
}

export type LastResortProvisioner = {
  /**
   * Bring the hub's last-resort slot up to date, doing nothing when it already is.
   *
   * `rotated` means THE SLOT WAS WRITTEN BY THIS CALL — true both for a fresh mint and for
   * completing an interrupted upload, false when the live package was good enough to leave alone.
   * `ref` names the package the slot holds on return.
   */
  ensureProvisioned(): Promise<{ rotated: boolean; ref: string }>
  /** Every retained bundle, `notAfter` descending, for `processWelcome`. */
  bundles(): Promise<Array<KeyPackageBundle>>
}

export function createLastResortProvisioner(
  params: LastResortProvisionerParams,
): LastResortProvisioner {
  const {
    identity,
    client,
    store,
    options,
    rotateWithinDays = DEFAULT_ROTATE_WITHIN_DAYS,
    retainAfterExpiryDays = DEFAULT_RETAIN_AFTER_EXPIRY_DAYS,
  } = params
  const ownerDID = identity.id
  let inFlight: Promise<{ rotated: boolean; ref: string }> | null = null

  /** The record the hub's slot should hold: newest by lifetime, `ref` breaking a tie. */
  const pickCandidate = (records: Array<LastResortRecord>): LastResortRecord | null => {
    let best: LastResortRecord | null = null
    for (const record of records) {
      if (
        best == null ||
        record.notAfter > best.notAfter ||
        (record.notAfter === best.notAfter && record.ref > best.ref)
      ) {
        best = record
      }
    }
    return best
  }

  const mint = async (): Promise<LastResortRecord> => {
    const bundle = await createLastResortKeyPackageBundle(identity, options)
    const record: LastResortRecord = {
      ref: await keyPackageRef(bundle.publicPackage, options),
      keyPackage: encodeKeyPackage(bundle.publicPackage),
      privatePackage: encodePrivateKeyPackage(bundle.privatePackage),
      notAfter: Number(bundle.publicPackage.leafNode.lifetime.notAfter),
      uploadedAt: null,
    }
    // DURABLE BEFORE THE UPLOAD, and this order is the load-bearing decision of the whole design.
    // Upload-then-persist has a crash window in which the hub serves a package whose private half
    // was never written down — the silent "unaddable forever" outage this slot exists to prevent.
    // A crash here instead leaves an un-uploaded record, which the next call finishes.
    await store.put(ownerDID, record)
    return record
  }

  const upload = async (record: LastResortRecord): Promise<void> => {
    await client.uploadLastResortKeyPackage(record.keyPackage)
    await store.put(ownerDID, { ...record, uploadedAt: Date.now() })
  }

  /**
   * Drop records past their lifetime plus the retention grace, EXCEPT the one this call settled on.
   * The exception matters on the resume path, where an interrupted record can itself be old enough
   * to prune and must not be deleted immediately after being uploaded.
   */
  const prune = async (records: Array<LastResortRecord>, keepRef: string): Promise<void> => {
    const cutoff = Math.floor(Date.now() / 1000) - retainAfterExpiryDays * DAY_SECONDS
    for (const record of records) {
      if (record.ref !== keepRef && record.notAfter < cutoff) {
        await store.delete(ownerDID, record.ref)
      }
    }
  }

  const run = async (): Promise<{ rotated: boolean; ref: string }> => {
    const records = await store.list(ownerDID)
    const candidate = pickCandidate(records)
    const nowSeconds = Math.floor(Date.now() / 1000)

    // Resume an interrupted provision rather than minting: a retry that minted would leave the
    // orphan behind on every attempt. But only while the pending record is still worth uploading —
    // a process down past its expiry would otherwise return `rotated: true` over a full-but-dead
    // slot, which is the failure this feature exists to remove. A fresh mint has ~90 days left, so
    // ordinary crash-retry is unaffected; a stale one falls through to the mint below.
    if (
      candidate != null &&
      candidate.uploadedAt == null &&
      candidate.notAfter - nowSeconds > rotateWithinDays * DAY_SECONDS
    ) {
      await upload(candidate)
      await prune(records, candidate.ref)
      return { rotated: true, ref: candidate.ref }
    }

    // An expired candidate needs no special case: the difference goes negative and falls through.
    if (candidate != null && candidate.notAfter - nowSeconds > rotateWithinDays * DAY_SECONDS) {
      // Pruning runs even here. A host calling daily would otherwise never prune between
      // rotations, which are 90 days apart.
      await prune(records, candidate.ref)
      return { rotated: false, ref: candidate.ref }
    }

    const minted = await mint()
    await upload(minted)
    await prune([...records, minted], minted.ref)
    return { rotated: true, ref: minted.ref }
  }

  return {
    async ensureProvisioned(): Promise<{ rotated: boolean; ref: string }> {
      // Single-flight: a second caller joins the first instead of minting a competing package.
      // Cross-PROCESS overlap is not prevented and needs no defence — the outcome is one occupied
      // slot and two valid retained records.
      if (inFlight != null) return await inFlight
      const started = run().finally(() => {
        inFlight = null
      })
      inFlight = started
      return await started
    },
    async bundles(): Promise<Array<KeyPackageBundle>> {
      throw new Error('bundles: not implemented')
    },
  }
}
```

Add to `packages/mls-hub/src/index.ts`, above the `store.js` export:

```ts
export {
  createLastResortProvisioner,
  type LastResortProvisioner,
  type LastResortProvisionerParams,
} from './provisioner.js'
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec turbo run test:unit --filter @kumiai/mls-hub`
Expected: PASS — 7 store tests + 3 provisioner tests.

- [ ] **Step 6: Typecheck**

Run: `pnpm exec turbo run test:types --filter @kumiai/mls-hub`
Expected: exits 0. This is where `publicPackage.leafNode.lifetime.notAfter` is proven to type-check
without narrowing, and where `Pick<HubClient, …>` is proven to accept a real `HubClient`.

- [ ] **Step 7: Mutation-check**

Replace the single-flight body with `return await run()`.
Run: `pnpm exec turbo run test:unit --filter @kumiai/mls-hub`
Expected: FAIL on 'overlapping calls produce one rotation and one upload'.
Restore, and confirm with `git diff packages/mls-hub/src/provisioner.ts`.

- [ ] **Step 8: Lint and commit**

```bash
rtk proxy pnpm run lint
git add packages/mls-hub
git commit -m "feat(mls-hub): provision a last-resort key package, persisting before upload"
```

---

### Task 6: Resume an interrupted provision, and surface upload failure

**Files:**
- Test: `packages/mls-hub/test/provisioner.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `createLastResortProvisioner` (Task 5), `createMemoryLastResortStore` (Task 4),
  `createTestHub` (Task 5).
- Produces: nothing new. Task 5's implementation already contains both paths; this task proves them
  and is where they are allowed to fail review.

**Why the code is already written:** the resume path and the persist-before-upload order are the same
decision, and splitting them across two commits would leave a commit whose central claim nothing
tests. What this task adds is the evidence.

- [ ] **Step 1: Write the failing tests**

Append to `packages/mls-hub/test/provisioner.test.ts`:

```ts
describe('an interrupted provision', () => {
  /**
   * The crash window between persisting a record and uploading it. The next call must finish THAT
   * package rather than mint a second one, or every retry leaves another orphan behind.
   */
  test('is resumed by uploading the pending record, not by minting', async () => {
    const hub = createTestHub()
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    // Produce a genuine pending record by failing the first upload.
    const failing = vi
      .spyOn(hub.client, 'uploadLastResortKeyPackage')
      .mockRejectedValueOnce(new Error('offline'))
    await expect(provisioner.ensureProvisioned()).rejects.toThrow('offline')

    const pending = await store.list(hub.identity.id)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.uploadedAt).toBeNull()
    // Nothing reached the hub, which is the point of persisting first.
    expect(await hub.hubStore.fetchLastResortKeyPackage(hub.identity.id)).toBeNull()

    failing.mockRestore()
    const result = await provisioner.ensureProvisioned()

    expect(result).toEqual({ rotated: true, ref: pending[0]?.ref })
    const settled = await store.list(hub.identity.id)
    expect(settled).toHaveLength(1)
    expect(settled[0]?.uploadedAt).toBeTypeOf('number')
    expect(await hub.hubStore.fetchLastResortKeyPackage(hub.identity.id)).toBe(
      pending[0]?.keyPackage,
    )

    await hub.dispose()
  })

  /**
   * The other crash window: the upload landed but the confirming write did not. Re-uploading the
   * same bytes must be harmless, because the slot is replace-on-upload.
   */
  test('re-uploading an already-served package is a no-op on the slot', async () => {
    const hub = createTestHub()
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    const first = await provisioner.ensureProvisioned()
    const record = (await store.list(hub.identity.id))[0]
    expect(record).toBeDefined()
    if (record == null) return

    // Simulate the lost confirmation.
    await store.put(hub.identity.id, { ...record, uploadedAt: null })

    const result = await provisioner.ensureProvisioned()

    expect(result).toEqual({ rotated: true, ref: first.ref })
    expect(await store.list(hub.identity.id)).toHaveLength(1)
    expect(await hub.hubStore.fetchLastResortKeyPackage(hub.identity.id)).toBe(record.keyPackage)

    await hub.dispose()
  })

  /** A host that cannot reach the hub must be told, not left believing the floor is in place. */
  test('an upload failure propagates rather than resolving quietly', async () => {
    const hub = createTestHub()
    const store = createMemoryLastResortStore()
    vi.spyOn(hub.client, 'uploadLastResortKeyPackage').mockRejectedValue(new Error('hub refused'))
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    await expect(provisioner.ensureProvisioned()).rejects.toThrow('hub refused')

    await hub.dispose()
  })

  /** A failed call must not wedge the single-flight slot shut for every later caller. */
  test('a failed call does not block the next one', async () => {
    const hub = createTestHub()
    const store = createMemoryLastResortStore()
    const spy = vi
      .spyOn(hub.client, 'uploadLastResortKeyPackage')
      .mockRejectedValueOnce(new Error('offline'))
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    await expect(provisioner.ensureProvisioned()).rejects.toThrow('offline')
    spy.mockRestore()

    await expect(provisioner.ensureProvisioned()).resolves.toMatchObject({ rotated: true })

    await hub.dispose()
  })
})
```

- [ ] **Step 2: Run tests to verify which fail**

Run: `pnpm exec turbo run test:unit --filter @kumiai/mls-hub`
Expected: all four PASS against Task 5's implementation. **If any fails, the implementation is
wrong, not the test** — fix `provisioner.ts` and record what was wrong in the commit message.

The one plausible failure is 'a failed call does not block the next one': it passes only because
`.finally()` clears `inFlight` on rejection as well as resolution. If it fails, the single-flight
clearing is on the wrong callback.

- [ ] **Step 3: Mutation-check the resume path**

In `run()`, change the resume branch's `candidate.uploadedAt == null` conjunct to
`candidate.uploadedAt === 0` so pending records are never resumed. (Leave the lifetime conjunct
beside it alone — that one is mutation-checked by Task 5's own fix round.)
Run: `pnpm exec turbo run test:unit --filter @kumiai/mls-hub`
Expected: FAIL on 'is resumed by uploading the pending record, not by minting' — it mints a second
record, so `store.list` has 2 entries.
Restore, and confirm with `git diff packages/mls-hub/src/provisioner.ts`.

- [ ] **Step 4: Mutation-check the write order**

In `mint()`, move `await store.put(ownerDID, record)` to after the `upload(minted)` call in `run()`
(i.e. upload first, persist second).
Run: `pnpm exec turbo run test:unit --filter @kumiai/mls-hub`
Expected: FAIL on 'is resumed by uploading the pending record, not by minting' — after the rejected
upload the store is empty, so there is no pending record to resume.
Restore, and confirm with `git diff packages/mls-hub/src/provisioner.ts`.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm exec turbo run test:types --filter @kumiai/mls-hub
rtk proxy pnpm run lint
git add packages/mls-hub/test/provisioner.test.ts
git commit -m "test(mls-hub): resume an interrupted provision and surface upload failure"
```

---

### Task 7: Rotation and pruning

**Files:**
- Test: `packages/mls-hub/test/provisioner.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: everything from Tasks 4-6.
- Produces: nothing new. Tests the rotation threshold and the retention window against Task 5's
  implementation.

**Note on time:** rotation decisions are driven by seeding `notAfter` directly. There is no clock
seam in the implementation and none is wanted — a seam only tests would use is worse than arithmetic
the tests control.

**Amended after execution:** that still holds for every rotation and retention decision, but one
test added in the Task 7 fix round mocks the global `Date.now` (a mutable offset over the real
clock, not `vi.useFakeTimers()`, which breaks the enkaku transports in the hub fixture). It
simulates a forward clock correction landing between the rotation check and `prune`'s own clock
read — the clock moving BETWEEN two reads inside one call, which seeded `notAfter` values cannot
express. The implementation still has no seam; the test reaches around it.

- [ ] **Step 1: Write the failing tests**

Append to `packages/mls-hub/test/provisioner.test.ts`:

```ts
const DAY = 86_400

function secondsFromNow(days: number): number {
  return Math.floor(Date.now() / 1000) + days * DAY
}

describe('rotation and retention', () => {
  /**
   * The rotation deadline exists because a last-resort package carries a real MLS lifetime and an
   * inviter enforces it. An unrotated slot stops working while the hub still reports it full.
   */
  test('a package inside the rotation window is replaced, and the old one is kept', async () => {
    const hub = createTestHub()
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    const first = await provisioner.ensureProvisioned()
    const original = (await store.list(hub.identity.id))[0]
    expect(original).toBeDefined()
    if (original == null) return

    // 10 days left: inside the 30-day window.
    await store.put(hub.identity.id, { ...original, notAfter: secondsFromNow(10) })

    const second = await provisioner.ensureProvisioned()

    expect(second.rotated).toBe(true)
    expect(second.ref).not.toBe(first.ref)
    // The retired record is RETAINED: an inviter may hold the package it names.
    const refs = (await store.list(hub.identity.id)).map((r) => r.ref).sort()
    expect(refs).toEqual([first.ref, second.ref].sort())
    expect(await hub.hubStore.fetchLastResortKeyPackage(hub.identity.id)).not.toBe(
      original.keyPackage,
    )

    await hub.dispose()
  })

  test('a package just outside the rotation window is left alone', async () => {
    const hub = createTestHub()
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    const first = await provisioner.ensureProvisioned()
    const original = (await store.list(hub.identity.id))[0]
    if (original == null) return
    await store.put(hub.identity.id, { ...original, notAfter: secondsFromNow(31) })

    const second = await provisioner.ensureProvisioned()

    expect(second).toEqual({ rotated: false, ref: first.ref })

    await hub.dispose()
  })

  test('rotateWithinDays is honoured when overridden', async () => {
    const hub = createTestHub()
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
      rotateWithinDays: 5,
    })

    const first = await provisioner.ensureProvisioned()
    const original = (await store.list(hub.identity.id))[0]
    if (original == null) return
    // 10 days left: inside the default 30-day window, outside the configured 5-day one.
    await store.put(hub.identity.id, { ...original, notAfter: secondsFromNow(10) })

    expect(await provisioner.ensureProvisioned()).toEqual({ rotated: false, ref: first.ref })

    await hub.dispose()
  })

  /**
   * Retention is bounded: a record whose lifetime ended more than the grace ago can no longer be
   * the target of any Add an inviter could have built, so keeping its private half is pure risk.
   */
  test('a record past its lifetime plus the grace is pruned', async () => {
    const hub = createTestHub()
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    await provisioner.ensureProvisioned()
    const live = (await store.list(hub.identity.id))[0]
    if (live == null) return

    await store.put(hub.identity.id, {
      ...live,
      ref: 'stale-ref',
      keyPackage: 'kp-stale',
      notAfter: secondsFromNow(-8),
      uploadedAt: 1,
    })

    const result = await provisioner.ensureProvisioned()

    expect(result).toEqual({ rotated: false, ref: live.ref })
    expect((await store.list(hub.identity.id)).map((r) => r.ref)).toEqual([live.ref])

    await hub.dispose()
  })

  /** Inside the grace it stays: a Welcome from an Add built just before expiry still needs it. */
  test('a record inside the retention grace is kept', async () => {
    const hub = createTestHub()
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    await provisioner.ensureProvisioned()
    const live = (await store.list(hub.identity.id))[0]
    if (live == null) return

    await store.put(hub.identity.id, {
      ...live,
      ref: 'recent-ref',
      keyPackage: 'kp-recent',
      notAfter: secondsFromNow(-3),
      uploadedAt: 1,
    })

    await provisioner.ensureProvisioned()

    expect((await store.list(hub.identity.id)).map((r) => r.ref).sort()).toEqual(
      [live.ref, 'recent-ref'].sort(),
    )

    await hub.dispose()
  })

  test('retainAfterExpiryDays is honoured when overridden', async () => {
    const hub = createTestHub()
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
      retainAfterExpiryDays: 1,
    })

    await provisioner.ensureProvisioned()
    const live = (await store.list(hub.identity.id))[0]
    if (live == null) return
    await store.put(hub.identity.id, {
      ...live,
      ref: 'stale-ref',
      keyPackage: 'kp-stale',
      notAfter: secondsFromNow(-3),
      uploadedAt: 1,
    })

    await provisioner.ensureProvisioned()

    expect((await store.list(hub.identity.id)).map((r) => r.ref)).toEqual([live.ref])

    await hub.dispose()
  })

  /**
   * An expired live package is not a special case in the code, and this is the test that says so:
   * the rotation arithmetic goes negative and falls through to a mint.
   */
  test('an expired package is rotated rather than reported as fine', async () => {
    const hub = createTestHub()
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    const first = await provisioner.ensureProvisioned()
    const original = (await store.list(hub.identity.id))[0]
    if (original == null) return
    await store.put(hub.identity.id, { ...original, notAfter: secondsFromNow(-1) })

    const second = await provisioner.ensureProvisioned()

    expect(second.rotated).toBe(true)
    expect(second.ref).not.toBe(first.ref)

    await hub.dispose()
  })
})
```

- [ ] **Step 2: Run tests**

Run: `pnpm exec turbo run test:unit --filter @kumiai/mls-hub`
Expected: all PASS against Task 5's implementation. Any failure is an implementation bug — fix
`provisioner.ts`, do not weaken the test.

- [ ] **Step 3: Mutation-check the rotation threshold**

In the no-op guard, change `rotateWithinDays * DAY_SECONDS` to `0`, so only an already-expired
package rotates.
Run: `pnpm exec turbo run test:unit --filter @kumiai/mls-hub`
Expected: FAIL on 'a package inside the rotation window is replaced, and the old one is kept'.
Restore, and confirm with `git diff packages/mls-hub/src/provisioner.ts`.

- [ ] **Step 4: Mutation-check the prune exception**

Remove `record.ref !== keepRef &&` from `prune`.
Run: `pnpm exec turbo run test:unit --filter @kumiai/mls-hub`
Expected: FAIL on 'a record past its lifetime plus the grace is pruned' or another retention test —
the record the call just settled on is deleted.

If NOTHING fails, the exception is untested: add a test in which the resumed record is itself past
the retention cutoff by the time `prune` runs. Then re-run this mutation and confirm the new test
fails. Restore afterwards.

**Amended after execution.** This step originally prescribed seeding a pending record with
`notAfter: secondsFromNow(-8)`, `uploadedAt: null` and asserting `ensureProvisioned` returns its
ref. Task 5's review fix changed the resume guard mid-execution: a pending record already inside the
rotation window is now judged too stale to finish and falls through to a fresh mint, so such a
record can never be returned as its own ref and the prescribed test became impossible. The Task 7
fix round replaced it with the shipped test — a pending record with `notAfter: secondsFromNow(31)`,
comfortably outside the rotation window at the check, plus a mocked `Date.now` that jumps forward 40
days from inside the upload so `prune`'s later clock read puts the cutoff past the record's own
`notAfter`. Same invariant, reachable under the amended guard.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm exec turbo run test:types --filter @kumiai/mls-hub
rtk proxy pnpm run lint
git add packages/mls-hub
git commit -m "test(mls-hub): rotation window, retention grace, and expiry fallthrough"
```

---

### Task 8: `bundles()` and the real-MLS integration tests

**Files:**
- Modify: `packages/mls-hub/src/provisioner.ts` (replace the `bundles` stub)
- Create: `packages/mls-hub/test/bundles.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-7.
- Produces: `bundles(): Promise<Array<KeyPackageBundle>>` returning
  `{ publicPackage, privatePackage, ownerDID }` objects — the shape `processWelcome` takes as
  `keyPackageBundle`.

**Why the integration tests are here and not earlier:** every test so far would pass just as happily
if the private-package codec were lossy, because none of them ever uses the decoded private half for
anything. These do.

- [ ] **Step 1: Write the failing tests**

`packages/mls-hub/test/bundles.test.ts`:

```ts
import { randomIdentity } from '@kokuin/token'
import {
  commitInvite,
  createGroup,
  createInvite,
  type Invite,
  ledgerEntryDigest,
  processWelcome,
} from '@kumiai/mls'
import { describe, expect, test } from 'vitest'

import { createLastResortProvisioner } from '../src/provisioner.js'
import { createMemoryLastResortStore } from '../src/store.js'
import { createTestHub } from './fixtures/hub.js'

/** The ledger-entry plumbing every kumiai join needs, shared by the tests below. */
function createLedger() {
  const tokens = new Map<string, string>()
  return {
    publish: (invite: Invite) => {
      for (const token of invite.ledgerEntries) tokens.set(ledgerEntryDigest(token), token)
    },
    resolveLedgerEntries: async (ids: Array<string>) =>
      ids.map((id) => {
        const token = tokens.get(id)
        if (token == null) throw new Error(`unknown ledger entry ${id}`)
        return token
      }),
  }
}

describe('bundles', () => {
  test('returns the retained bundles newest first', async () => {
    const hub = createTestHub()
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    const first = await provisioner.ensureProvisioned()
    const original = (await store.list(hub.identity.id))[0]
    if (original == null) return
    await store.put(hub.identity.id, {
      ...original,
      notAfter: Math.floor(Date.now() / 1000) + 10 * 86_400,
    })
    const second = await provisioner.ensureProvisioned()

    const bundles = await provisioner.bundles()
    expect(bundles).toHaveLength(2)
    expect(bundles.map((b) => b.ownerDID)).toEqual([hub.identity.id, hub.identity.id])

    // Newest first: the rotation's package leads, the retired one follows.
    const refs = (await store.list(hub.identity.id))
    const newest = refs.find((r) => r.ref === second.ref)
    const retired = refs.find((r) => r.ref === first.ref)
    expect(newest?.notAfter).toBeGreaterThan(retired?.notAfter ?? 0)

    await hub.dispose()
  })

  /**
   * A store handing back bytes it did not round-trip is broken, and reporting that as "you appear to
   * have no last-resort package" would recreate exactly the silent failure this feature removes.
   */
  test('throws on a record whose private package will not decode', async () => {
    const hub = createTestHub()
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    await provisioner.ensureProvisioned()
    const record = (await store.list(hub.identity.id))[0]
    if (record == null) return
    await store.put(hub.identity.id, { ...record, privatePackage: 'not base64 !!!' })

    await expect(provisioner.bundles()).rejects.toThrow(record.ref)

    await hub.dispose()
  })

  test('throws on a record whose public package will not decode', async () => {
    const hub = createTestHub()
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    await provisioner.ensureProvisioned()
    const record = (await store.list(hub.identity.id))[0]
    if (record == null) return
    await store.put(hub.identity.id, { ...record, keyPackage: 'not base64 !!!' })

    await expect(provisioner.bundles()).rejects.toThrow(record.ref)

    await hub.dispose()
  })

  test('an owner with no records returns an empty array', async () => {
    const hub = createTestHub()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store: createMemoryLastResortStore(),
    })

    expect(await provisioner.bundles()).toEqual([])

    await hub.dispose()
  })
})

describe('a provisioned bundle against real MLS', () => {
  /**
   * THE CENTRAL CLAIM. The bundle used here came out of the store — encoded on the way in, decoded
   * on the way out — so a lossy private-package codec fails here and nowhere else. The join is
   * carried through `processWelcome` so the invitee actually derives the epoch secrets.
   */
  test('joins a group using only what the store gave back', async () => {
    const hub = createTestHub()
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })
    await provisioner.ensureProvisioned()

    const [bundle] = await provisioner.bundles()
    expect(bundle).toBeDefined()
    if (bundle == null) return

    const alice = randomIdentity()
    const ledger = createLedger()
    const { group } = await createGroup(alice, 'group:provisioned', {
      resolveLedgerEntries: ledger.resolveLedgerEntries,
    })
    const { invite } = await createInvite({
      group,
      identity: alice,
      recipientDID: hub.identity.id,
      permission: 'member',
    })
    ledger.publish(invite)

    const added = await commitInvite(group, bundle.publicPackage, invite)
    const { group: joined } = await processWelcome({
      identity: hub.identity,
      invite,
      welcome: added.welcomeMessage,
      keyPackageBundle: bundle,
      ratchetTree: added.newGroup.state.ratchetTree,
      options: { resolveLedgerEntries: ledger.resolveLedgerEntries },
    })

    expect(joined.findMemberLeafIndex(hub.identity.id)).not.toBeNull()

    await hub.dispose()
  })

  /**
   * Reusability, at this layer rather than in `@kumiai/mls`: the point of the slot is that ONE
   * package serves join after join, so a round-tripped bundle must join two independent groups with
   * two different inviters.
   */
  test('the same provisioned bundle joins two different groups', async () => {
    const hub = createTestHub()
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })
    await provisioner.ensureProvisioned()

    const [bundle] = await provisioner.bundles()
    if (bundle == null) return

    const ledger = createLedger()
    const join = async (inviter: ReturnType<typeof randomIdentity>, groupID: string) => {
      const { group } = await createGroup(inviter, groupID, {
        resolveLedgerEntries: ledger.resolveLedgerEntries,
      })
      const { invite } = await createInvite({
        group,
        identity: inviter,
        recipientDID: hub.identity.id,
        permission: 'member',
      })
      ledger.publish(invite)
      const added = await commitInvite(group, bundle.publicPackage, invite)
      const { group: joined } = await processWelcome({
        identity: hub.identity,
        invite,
        welcome: added.welcomeMessage,
        keyPackageBundle: bundle,
        ratchetTree: added.newGroup.state.ratchetTree,
        options: { resolveLedgerEntries: ledger.resolveLedgerEntries },
      })
      return joined
    }

    const joinedA = await join(randomIdentity(), 'group:provisioned-a')
    const joinedB = await join(randomIdentity(), 'group:provisioned-b')

    expect(joinedA.findMemberLeafIndex(hub.identity.id)).not.toBeNull()
    expect(joinedB.findMemberLeafIndex(hub.identity.id)).not.toBeNull()

    await hub.dispose()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec turbo run test:unit --filter @kumiai/mls-hub`
Expected: FAIL on every test in the new file with `bundles: not implemented`.

- [ ] **Step 3: Implement `bundles()`**

In `packages/mls-hub/src/provisioner.ts`, add `decodeKeyPackage` and `decodePrivateKeyPackage` to
the `@kumiai/mls` import, then replace the stub with:

```ts
    async bundles(): Promise<Array<KeyPackageBundle>> {
      const records = await store.list(ownerDID)
      const ordered = [...records].sort((a, b) => {
        if (a.notAfter !== b.notAfter) return b.notAfter - a.notAfter
        return a.ref < b.ref ? 1 : a.ref > b.ref ? -1 : 0
      })
      return ordered.map((record) => {
        const publicPackage = decodeKeyPackage(record.keyPackage)
        const privatePackage = decodePrivateKeyPackage(record.privatePackage)
        if (publicPackage == null || privatePackage == null) {
          // Loud, not skipped: silently narrowing a corrupt store to "no last-resort package" is
          // the failure mode this whole feature exists to remove. `ensureProvisioned` reads only
          // `notAfter` and never decodes, so rotation still works past a corrupt record — only the
          // join path stops. The message names the ref and NEVER the material.
          throw new Error(
            `mls-hub: stored last-resort record ${record.ref} did not decode; the store returned bytes it did not round-trip`,
          )
        }
        return { publicPackage, privatePackage, ownerDID }
      })
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec turbo run test:unit --filter @kumiai/mls-hub`
Expected: PASS — the whole package, all three test files.

- [ ] **Step 5: Typecheck**

Run: `pnpm exec turbo run test:types --filter @kumiai/mls-hub`
Expected: exits 0. This proves the returned objects satisfy `KeyPackageBundle` and are accepted as
`processWelcome`'s `keyPackageBundle`.

- [ ] **Step 6: Mutation-check the codec**

In `packages/mls/src/key-package-codec.ts`, make `encodePrivateKeyPackage` lossy — drop a field:

```ts
export function encodePrivateKeyPackage(privatePackage: PrivateKeyPackage): string {
  return toB64(
    encode(privateKeyPackageEncoder, { ...privatePackage, initPrivateKey: new Uint8Array(32) }),
  )
}
```

Run: `pnpm exec turbo run test:unit --filter @kumiai/mls-hub`
Expected: FAIL on 'joins a group using only what the store gave back' — the invitee cannot open the
Welcome. This is the mutation that proves the integration test earns its place; if it passes, the
test is not exercising the private half.
Restore, and confirm with `git diff packages/mls/src/key-package-codec.ts`.

- [ ] **Step 7: Mutation-check the throw**

Change the `bundles()` guard to skip instead of throwing (`return null` filtered out).
Run: `pnpm exec turbo run test:unit --filter @kumiai/mls-hub`
Expected: FAIL on 'throws on a record whose private package will not decode'.
Restore, and confirm with `git diff`.

- [ ] **Step 8: Lint and commit**

```bash
rtk proxy pnpm run lint
git add packages/mls-hub packages/mls
git commit -m "feat(mls-hub): bundles() for processWelcome, throwing on a corrupt record"
```

---

### Task 9: README, changesets, and plan housekeeping

**Files:**
- Create: `packages/mls-hub/README.md`
- Create: `.changeset/last-resort-provisioning.md`
- Modify: `AGENTS.md` (the "What this repo is" paragraph)
- Modify: `docs/agents/architecture.md` (the "Packages" section, around lines 9-18)
- Delete: `docs/agents/plans/next/2026-07-26-last-resort-keypackage-provisioning.md`
- Create: `docs/agents/plans/next/2026-07-26-ordinary-keypackage-replenishment.md`

**Interfaces:**
- Consumes: the finished surface from Tasks 1-8.
- Produces: nothing consumed by code.

- [ ] **Step 1: Write the package README**

`packages/mls-hub/README.md`:

```markdown
# @kumiai/mls-hub

Key-package provisioning between `@kumiai/mls` and a kumiai hub. It decides *when* to generate,
upload, retain, and discard a last-resort key package — the mechanism for each of those already
existed and nothing decided anything.

## Why a separate package

`@kumiai/mls` is the crypto core and must not depend on transport. `@kumiai/hub-client` must not
depend on `ts-mls` — it never decodes MLS, matching the hub. So the code joining them lives above
both, exactly as `@kumiai/mls-rpc` does for `mls` × `rpc`. This package does **not** depend on
`ts-mls`.

## Exports

- `createLastResortProvisioner` — `ensureProvisioned()` and `bundles()`.
- `LastResortStore`, `LastResortRecord` — the storage port the host implements.
- `createMemoryLastResortStore` — the strict reference implementation. In-memory; see the warning
  below.

```ts
import { createLastResortProvisioner } from '@kumiai/mls-hub'

const provisioner = createLastResortProvisioner({ identity, client: hubClient, store })

// At startup and on whatever cadence the host already has. Idempotent and cheap when nothing is due.
await provisioner.ensureProvisioned()

// When a Welcome arrives, try the retained bundles newest first.
for (const bundle of await provisioner.bundles()) {
  try {
    return await processWelcome({ identity, invite, welcome, keyPackageBundle: bundle, ratchetTree })
  } catch {
    // Not this one — an inviter may hold a package from before the last rotation.
  }
}
```

## ⚠️ Security: the store holds private key material

Every `LastResortRecord.privatePackage` is a secret. Store it where the host stores private keys,
never log it, and never publish it.

`createMemoryLastResortStore` loses everything on restart, which for this port is worse than it
sounds: the hub keeps serving the slot while the private half needed to use it is gone, so the owner
is silently unaddable — the exact outage a last-resort package exists to prevent. Use it in tests
and throwaway processes only.

## Two obligations this package now discharges

Both used to sit on the host, and both failed silently:

- **Retention.** A last-resort package is reusable, so its private half must survive a Welcome
  instead of being deleted as an ordinary bundle's would be. Records accumulate across rotations and
  are pruned only once the MLS lifetime plus a grace period has passed, because an inviter that
  fetched the slot before a rotation still holds the older package.
- **Rotation.** The package carries a 90-day MLS lifetime that the *inviter* enforces, so an
  unrotated slot goes full-but-dead while the hub reports success. `ensureProvisioned` replaces it
  once fewer than 30 days remain.

## What it does not do

Nothing replenishes the **ordinary** key-package pool. A host that only wires this leans on the
last-resort slot for every join: correct, but it forfeits forward secrecy for new members. Doing it
properly needs a pool-depth query the hub protocol does not have.
```

- [ ] **Step 2: Write the changeset**

`.changeset/last-resort-provisioning.md`:

```markdown
---
'@kumiai/mls-hub': minor
'@kumiai/mls': minor
---

Automatic last-resort key-package provisioning: the defence is now armed, not merely present.

`@kumiai/mls` could already generate a last-resort key package and the hub could already serve one
without consuming it, but nothing decided *when* — so until a host wired it by hand, no DID had one
and the key-package drain residual stayed open in practice.

New package `@kumiai/mls-hub` owns that policy. `createLastResortProvisioner({ identity, client,
store }).ensureProvisioned()` is idempotent: it mints, uploads, and retains a package, replaces it
once fewer than 30 days of its 90-day lifetime remain, and prunes a retired record only after its
lifetime plus a 7-day grace. `bundles()` returns every retained bundle newest-first for
`processWelcome`. It lives above both `@kumiai/mls` and `@kumiai/hub-client` for the same reason
`@kumiai/mls-rpc` exists — neither may depend on the other — and it does not depend on `ts-mls`.

The record is persisted **before** the upload. The reverse order has a crash window in which the hub
serves a package whose private half was never written down, which is the silent "unaddable forever"
outage the slot exists to prevent; a crash in the chosen order leaves an un-uploaded record that the
next call finishes.

Two host obligations that were previously doc comments are now discharged by code: retaining a
reusable package's private half across a Welcome, and rotating before the MLS lifetime the *inviter*
enforces runs out. The `LastResortStore` port is host-implemented and holds secret key material; a
store MUST scope every method by owner DID.

`@kumiai/mls` gains `encodePrivateKeyPackage` / `decodePrivateKeyPackage` — the canonical string form
of a key package's private half, strict in the same three ways the public codec is — and
`keyPackageRef`, the base64 KeyPackageRef a Welcome names.

Also recorded, having been read and verified rather than assumed: nothing requires a publisher to
advertise extension type `0x000A` in its capabilities. draft-ietf-mls-extensions-05 has no such
clause, RFC 9420's capabilities rule binds leaf-node extensions and `last_resort` is
KeyPackage-only, and draft -08 has moved the feature to MLS Component Type `0x00000004` inside
`app_data_dictionary`. `0x000A` remains what deployed implementations use, so it stays;
`controlCapabilities()` is unchanged.
```

- [ ] **Step 3: Add the package to the two repo-level docs**

In `AGENTS.md`, the "What this repo is" paragraph lists the packages. Add `mls-hub` beside
`mls-rpc`:

```markdown
`mls-rpc` (the real implementation of rpc's consumer ports over `mls`), `mls-hub` (key-package
provisioning between `mls` and a hub),
```

In `docs/agents/architecture.md`, extend the paragraph beginning "Alongside them: **mls-rpc**":

```markdown
Alongside them: **mls-rpc**, the real implementation of rpc's two consumer ports over a live MLS
handle — until it existed nothing had ever run the ports outside fixtures — **mls-hub**, which owns
when a peer's last-resort key package is generated, uploaded, retained, and pruned (the mechanism
shipped first and nothing decided any of it), and two contract suites, …
```

Keep the rest of that sentence as it is.

- [ ] **Step 4: Retire the completed `next/` item and re-file its residual**

Delete `docs/agents/plans/next/2026-07-26-last-resort-keypackage-provisioning.md`.

Create `docs/agents/plans/next/2026-07-26-ordinary-keypackage-replenishment.md`:

```markdown
# Nothing tops up the ordinary key-package pool

**Priority:** medium — a host that never re-uploads still works, but forfeits forward secrecy for
every new member.
**Origin:** scoped out of the last-resort provisioning work landed 2026-07-26; see
`docs/agents/plans/completed/2026-07-26-last-resort-provisioning.complete.md`.

## The gap

`@kumiai/mls-hub` keeps the last-resort slot filled. Nothing keeps the ordinary pool filled. A host
that uploads once at enrolment and never again eventually serves every join from the reusable
last-resort package — correct, and the availability floor works exactly as designed, but a reused
init key means new members do not get the forward secrecy a fresh package would give them.

## The blocker, and why this is not a small change

**A client cannot learn its own pool depth.** `hub/v1/keypackage/upload` returns
`{ stored: number }`, meaning stored-by-this-call; consumption happens on someone else's fetch and is
never reported. So there are only two shapes available:

- **Blind top-up.** Re-upload N packages on a schedule and treat `KeyPackageQuotaExceededError` as
  normal operation. No protocol change; wasteful and noisy, and it cannot tell a drained pool from a
  full one — which is exactly the distinction that matters.
- **Add a depth query.** `hub/v1/keypackage/status` returning the caller's own count, then top up on
  demand. Correct, and it needs `hub-protocol`, `hub-server`, and `hub-conformance` clauses, plus a
  minor release across them. Note the authorization shape: a DID may read only its OWN depth, or the
  query becomes a reconnaissance channel telling an attacker exactly when a drain has succeeded.

The second is the real answer. It was kept out of the last-resort work because the item's premise
there was "no hub-side change expected", and mixing a protocol addition into a policy layer would
have obscured both.

## Scope

`@kumiai/hub-protocol`, `@kumiai/hub-server`, `@kumiai/hub-conformance`, `@kumiai/hub-client`,
`@kumiai/mls-hub`. Retention is simpler than the last-resort case — an ordinary bundle's private half
may be dropped once its Welcome is processed — but the same store-before-upload ordering applies, and
the same accumulate-then-prune shape, so `LastResortStore` is the template rather than a thing to
reuse verbatim.
```

- [ ] **Step 5: Full verification, forced**

```bash
pnpm exec turbo run test:types test:unit --force
```
Expected: every task green with `Cached: 0` in the summary. A cached run proves nothing — check the
number.

Then:
```bash
rtk proxy pnpm run lint
```
Expected: clean.

Then confirm the layering constraints held:
```bash
grep -n '"ts-mls"' packages/mls-hub/package.json          # expect no match
grep -rn "from 'ts-mls'" packages/mls-hub/src             # expect no match
grep -n 'hub-client' packages/mls/package.json            # expect no match
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs(mls-hub): README, changeset, and next/ housekeeping"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: additions to `@kumiai/mls` → Tasks 1-2; port
contract and memory store → Task 4; the algorithm, write order, constants, concurrency, and errors →
Tasks 5-7; `bundles()` and its throw → Task 8; the wire-compat finding → Task 3; deliverables and
out-of-scope re-filing → Task 9. The spec's test table maps as: tests 1-2 → Task 5, 3-4 → Task 6,
5-6 → Task 7, 7-9 → Task 8, 10 → Task 5, 11-12 → Task 1.

**Type consistency.** `LastResortRecord` fields (`ref`, `keyPackage`, `privatePackage`, `notAfter`,
`uploadedAt`) are identical in Tasks 4-8. `ensureProvisioned` returns `{ rotated, ref }` everywhere.
`bundles()` returns `Array<KeyPackageBundle>` in both its declaration (Task 5) and implementation
(Task 8). `client` is `Pick<HubClient, 'uploadLastResortKeyPackage'>` in the params type and is
satisfied by the real `HubClient` the fixture builds.

**Cross-package imports verified.** `packages/mls-hub/test/bundles.test.ts` imports `Invite`,
`ledgerEntryDigest`, `commitInvite`, `createGroup`, `createInvite`, and `processWelcome` from
`@kumiai/mls` rather than a relative path, because it is a consumer package. All six are already
exported from `packages/mls/src/index.ts`, as are `GroupOptions` and `KeyPackageBundle`, which
`provisioner.ts` imports. Only Tasks 1-2's three new functions need adding to that file.
