# Key-Package Codec Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `@kumiai/mls` an `encodeKeyPackage` / `decodeKeyPackage` pair so a host can move a `KeyPackage` to and from the hub's opaque `string` without reaching into `ts-mls` itself.

**Architecture:** A new file `packages/mls/src/key-package-codec.ts` wraps ts-mls's `keyPackageEncoder` / `keyPackageDecoder` in base64 via `@sozai/codec`. Encode is a two-step: TLS-serialize, then `toB64`. Decode is strict in three ways — it catches `fromB64`'s throw and returns `null`, it rejects any string that is not the canonical base64 of its own bytes, and it calls the decoder directly (not ts-mls's `decode()` helper) so it can require that the decoder consumed the entire input. It performs no cryptographic validation; Add-time validation inside ts-mls remains the only gate that matters.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `ts-mls` 2.0.0-rc.13, `@sozai/codec`, vitest, biome, pnpm workspaces + turbo, changesets.

**Spec:** `docs/superpowers/specs/2026-07-26-key-package-codec-design.md`

## Global Constraints

- **pnpm only.** Never `npm` or `yarn`.
- **Never edit `lib/`.** It is generated output and gitignored.
- **Cross-repo deps** (`@sozai/*`, `@kokuin/*`, `@enkaku/*`) go in `package.json` as `"catalog:"`, resolving to the published `^` range in `pnpm-workspace.yaml`. Never `workspace:`. Internal `@kumiai/*` deps are `workspace:^`.
- **Lint must be run as `rtk proxy pnpm run lint`** from the repo root. A shim intercepts both plain `pnpm run lint` and `pnpm exec biome` and will report misleading results.
- **`@sozai/codec` is already in the workspace catalog** at `^0.2.0` (`pnpm-workspace.yaml:24`). Do not add or change the catalog entry — only reference it.
- **All new source files carry doc comments in the style of their neighbours** (`packages/mls/src/head.ts`, `packages/mls/src/codec.ts`): explain *why*, not *what*, and state what a guard buys.
- **No validation beyond well-formedness in the codec.** No signature verification, no lifetime check, no capability check. That is a deliberate spec decision, not an omission — see "What decode deliberately does not do" in the spec.

## Reference: exact upstream signatures (verified in `node_modules`)

Copy these; do not guess.

```ts
// ts-mls (all exported from the package root)
export declare const keyPackageEncoder: Encoder<KeyPackage>
export declare const keyPackageDecoder: Decoder<KeyPackage>
export type Decoder<T> = (b: Uint8Array, offset: number) => [T, number] | undefined
export declare function encode<T>(enc: Encoder<T>, t: T): Uint8Array
```

The `number` in a `Decoder`'s tuple is the **consumed length**, not an absolute
offset — `mapDecoders` returns `cursor - offset`. At `offset: 0` the two are the same
value, which is the only offset this codec ever uses.

```ts
// @sozai/codec
export declare function toB64(bytes: Uint8Array): string
export declare function fromB64(base64: string): Uint8Array
```

`fromB64` **throws** `Error('Invalid base64 encoding')` on a bad alphabet — it does not
return `undefined`. It also **trims surrounding whitespace** before validating, and it
accepts the empty string (decoding to an empty `Uint8Array`).

## Design note: canonical-form check (an addition to the spec)

The spec requires strictness about *trailing bytes*. Two string-level looseness paths
survive that requirement, both stemming from `fromB64`:

1. Surrounding whitespace is trimmed, so `encoded + '\n'` decodes to the same package.
2. Padding and trailing-bit variations that `fromB64` tolerates map several strings to
   the same bytes.

Either one means the same key package has more than one string form. The hub stores and
compares **strings**, so a byte-level canonicality guarantee does not reach the layer
that needs it. `toB64(bytes) !== encoded` closes both in one comparison, and subsumes the
"is this valid base64" check entirely.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `packages/mls/src/key-package-codec.ts` | Create | The whole codec: `encodeKeyPackage`, `decodeKeyPackage`. Nothing else. |
| `packages/mls/src/index.ts` | Modify | Re-export the two functions plus the `KeyPackage` type. |
| `packages/mls/package.json` | Modify | Add `"@sozai/codec": "catalog:"` to `dependencies`. |
| `packages/mls/test/key-package-codec.test.ts` | Create | Unit guards (Task 1) and the MLS end-to-end proof (Task 2). |
| `packages/mls/README.md` | Modify | One bullet under Capabilities (Task 2). |
| `.changeset/key-package-codec.md` | Create | Release note (Task 2). |

The codec deliberately does **not** live in `packages/mls/src/codec.ts`. That file's doc
comment says its blobs are "one process serializing its own state to itself … never a
wire format another peer or another build reads". This codec is exactly the opposite, and
colocating them would falsify a comment that is doing real work.

---

### Task 1: The codec and its well-formedness guards

**Files:**
- Create: `packages/mls/src/key-package-codec.ts`
- Modify: `packages/mls/package.json` (add one dependency)
- Modify: `packages/mls/src/index.ts` (add one export block)
- Test: `packages/mls/test/key-package-codec.test.ts`

**Interfaces:**
- Consumes: `createKeyPackageBundle(identity, options?) => Promise<KeyPackageBundle>` from `../src/group.js`; `randomIdentity()` from `@kokuin/token`. `KeyPackageBundle.publicPackage` is a ts-mls `KeyPackage`.
- Produces:
  ```ts
  export function encodeKeyPackage(keyPackage: KeyPackage): string
  export function decodeKeyPackage(encoded: string): KeyPackage | null
  ```
  Task 2 relies on both names and on `decodeKeyPackage` returning a `KeyPackage` that
  `commitInvite` accepts unmodified.

- [ ] **Step 1: Add the `@sozai/codec` dependency**

In `packages/mls/package.json`, inside `"dependencies"`, keeping alphabetical order — it
goes immediately before `"@sozai/runtime"`:

```json
    "@sozai/codec": "catalog:",
    "@sozai/runtime": "catalog:",
```

Then install:

```bash
cd /Users/paul/dev/yulsi/kumiai && pnpm install
```

Expected: succeeds, resolving `@sozai/codec` to the catalog's `^0.2.0`. Do **not** edit
`pnpm-workspace.yaml`.

- [ ] **Step 2: Write the failing tests**

Create `packages/mls/test/key-package-codec.test.ts`:

```ts
import { randomIdentity } from '@kokuin/token'
import { toB64 } from '@sozai/codec'
import { describe, expect, test } from 'vitest'

import { createKeyPackageBundle } from '../src/group.js'
import { decodeKeyPackage, encodeKeyPackage } from '../src/key-package-codec.js'

async function samplePackage() {
  const bundle = await createKeyPackageBundle(randomIdentity())
  return bundle.publicPackage
}

describe('encodeKeyPackage / decodeKeyPackage', () => {
  test('a round trip reproduces the key package structurally', async () => {
    const original = await samplePackage()
    const decoded = decodeKeyPackage(encodeKeyPackage(original))
    expect(decoded).toEqual(original)
  })

  test('encoding is deterministic for the same package', async () => {
    const original = await samplePackage()
    expect(encodeKeyPackage(original)).toBe(encodeKeyPackage(original))
  })

  /**
   * ts-mls's own `decode()` helper is `dec(t, 0)?.[0]` — it discards the consumed length, so
   * trailing garbage rides along silently and one logical package gains unlimited byte forms.
   * The codec calls the decoder directly to get that length back and compare it.
   */
  test('trailing bytes after a valid encoding are rejected', async () => {
    const original = await samplePackage()
    const bytes = new Uint8Array([...fromEncoded(encodeKeyPackage(original)), 0x00])
    expect(decodeKeyPackage(toB64(bytes))).toBeNull()
  })

  /**
   * Canonicality is a STRING-level property here, not just a byte-level one: the hub stores and
   * compares the string. `fromB64` trims surrounding whitespace, so without the canonical-form
   * check the same package has a second, equally-acceptable string form.
   */
  test('a whitespace-padded encoding is rejected', async () => {
    const original = await samplePackage()
    expect(decodeKeyPackage(`${encodeKeyPackage(original)}\n`)).toBeNull()
  })

  /** `fromB64` THROWS on a bad alphabet rather than returning a sentinel — decode must absorb it. */
  test('non-base64 input returns null rather than throwing', () => {
    expect(decodeKeyPackage('not base64 !!!')).toBeNull()
  })

  test('the empty string is rejected', () => {
    expect(decodeKeyPackage('')).toBeNull()
  })

  test('truncated TLS bytes are rejected', async () => {
    const original = await samplePackage()
    const bytes = fromEncoded(encodeKeyPackage(original))
    expect(decodeKeyPackage(toB64(bytes.subarray(0, bytes.length - 1)))).toBeNull()
  })
})
```

Add this helper at the top of the file, under the imports — it exists so the mutation
tests build byte-level variants without importing `fromB64` for anything else:

```ts
function fromEncoded(encoded: string): Uint8Array {
  return Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))
}
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
cd /Users/paul/dev/yulsi/kumiai && pnpm --filter @kumiai/mls exec vitest run test/key-package-codec.test.ts
```

Expected: FAIL — the suite cannot resolve `../src/key-package-codec.js`.

- [ ] **Step 4: Write the implementation**

Create `packages/mls/src/key-package-codec.ts`:

```ts
import { fromB64, toB64 } from '@sozai/codec'
import { encode, type KeyPackage, keyPackageDecoder, keyPackageEncoder } from 'ts-mls'

/**
 * Serialize a key package to the string form the hub stores.
 *
 * Returns a `string` rather than the `Uint8Array` every other encoder in this package returns
 * (`encodeGroupAnchor`, `encodeClientState`, `encodeLedgerHead`), and the deviation is the point.
 * Those blobs are read only by the process that wrote them; this one is a wire format two peers
 * must agree on before either has met the other. `@sozai/codec` exports both `toB64` and `toB64U`
 * and they are not interchangeable, so handing bytes back and leaving the string step to each host
 * is precisely how an uploader and a fetcher end up disagreeing about packages already sitting in
 * a hub. One canonical form, decided here, removes the choice.
 */
export function encodeKeyPackage(keyPackage: KeyPackage): string {
  return toB64(encode(keyPackageEncoder, keyPackage))
}

/**
 * Parse a key package from its stored string form, or `null` if the string is not exactly one.
 *
 * **A successful decode proves well-formedness and nothing else.** No signature is verified, no
 * lifetime is checked, no capability is inspected. ts-mls performs all of those at Add time, on
 * the inviter, with the group context in hand — which a decoder does not have. Repeating them
 * here would be redundant where it duplicated that gate and actively misleading where it did not,
 * because a caller could reasonably read "it decoded" as "it is safe to add". It is not.
 *
 * Strict in three separate ways, each closing a path by which one package gains a second string
 * form:
 *
 * 1. `fromB64` throws on a bad alphabet rather than returning a sentinel, so the throw is absorbed.
 * 2. The re-encode comparison requires the input to be the canonical base64 of its own bytes.
 *    `fromB64` trims surrounding whitespace and tolerates some padding variation, and the hub
 *    stores and compares *strings* — so a byte-level guarantee alone never reaches the layer that
 *    needs it.
 * 3. `keyPackageDecoder` is called directly rather than through ts-mls's `decode()`, which is
 *    `dec(t, 0)?.[0]` and discards the consumed length — silently accepting trailing garbage. The
 *    length is compared against the input instead.
 *
 * One canonical representation per package is what any later attempt to dedup or identify a
 * package by its stored form depends on.
 */
export function decodeKeyPackage(encoded: string): KeyPackage | null {
  let bytes: Uint8Array
  try {
    bytes = fromB64(encoded)
  } catch {
    return null
  }
  if (toB64(bytes) !== encoded) return null
  const decoded = keyPackageDecoder(bytes, 0)
  // The tuple's second element is the CONSUMED LENGTH (ts-mls's `mapDecoders` returns
  // `cursor - offset`), so this is a whole-input check, not an offset comparison.
  if (decoded == null || decoded[1] !== bytes.length) return null
  return decoded[0]
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd /Users/paul/dev/yulsi/kumiai && pnpm --filter @kumiai/mls exec vitest run test/key-package-codec.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 6: Export from the package index**

In `packages/mls/src/index.ts`, add a new export block in alphabetical position — between
the `./head.js` block and the `./ledger.js` block:

```ts
export {
  decodeKeyPackage,
  encodeKeyPackage,
} from './key-package-codec.js'
```

And add `KeyPackage` to the existing type re-export from `ts-mls` at the top of the file,
in alphabetical order — a consumer that decodes needs the type name to hold the result:

```ts
export type {
  Capabilities,
  GroupContextExtension,
  IncomingMessageCallback,
  KeyPackage,
  Proposal,
  ProposalWithSender,
} from 'ts-mls'
```

- [ ] **Step 7: Mutation-check each guard**

For each row: apply the break, run the suite, confirm **exactly** the named test fails,
then restore. A break that fails nothing means the test does not discriminate and must be
strengthened before moving on.

| Break in `key-package-codec.ts` | Test that must fail |
|---|---|
| Replace the body of the `catch` with `throw new Error('x')` | `non-base64 input returns null rather than throwing` |
| Delete the line `if (toB64(bytes) !== encoded) return null` | `a whitespace-padded encoding is rejected` |
| Change `decoded == null \|\| decoded[1] !== bytes.length` to `decoded == null` | `trailing bytes after a valid encoding are rejected` |

After the last restore, prove nothing was left behind. The file is still untracked at this
point, so `git diff` would report nothing whatever its contents — read the file back
instead and confirm it matches Step 4 verbatim, then:

```bash
cd /Users/paul/dev/yulsi/kumiai && pnpm --filter @kumiai/mls exec vitest run test/key-package-codec.test.ts
```

Expected: PASS, 7 tests. A restore that left a break behind shows up here.

- [ ] **Step 8: Type-check and lint**

```bash
cd /Users/paul/dev/yulsi/kumiai && pnpm --filter @kumiai/mls run test:types
cd /Users/paul/dev/yulsi/kumiai && rtk proxy pnpm run lint
```

Expected: both clean. If biome reformats, accept its output.

- [ ] **Step 9: Commit**

```bash
cd /Users/paul/dev/yulsi/kumiai && git add packages/mls/src/key-package-codec.ts packages/mls/src/index.ts packages/mls/package.json packages/mls/test/key-package-codec.test.ts pnpm-lock.yaml && git commit -m "feat(mls): add key-package codec for the hub's string wire form"
```

---

### Task 2: Prove the codec against real MLS, then document and release

**Files:**
- Modify: `packages/mls/test/key-package-codec.test.ts` (append one `describe` block)
- Modify: `packages/mls/README.md` (one bullet under Capabilities)
- Create: `.changeset/key-package-codec.md`

**Interfaces:**
- Consumes: `encodeKeyPackage` / `decodeKeyPackage` from Task 1; `commitInvite`, `createGroup`, `createInvite`, `processWelcome` from `../src/group.js`; `ledgerEntryDigest` from `../src/ledger.js`; the `Invite` type from `../src/types.js`.
- Produces: nothing consumed by a later task.

**Why this is its own task:** Task 1's tests check the codec against itself. A structural
equality assertion passes for an encoding MLS cannot actually consume — for instance one
that round-trips a field into a shape ts-mls's own validation rejects. This task is the
independent claim that the *decoded* object is a working key package, and a reviewer could
reasonably accept Task 1 while rejecting the way this proves it.

- [ ] **Step 1: Write the failing test**

Append to `packages/mls/test/key-package-codec.test.ts`. Add the extra imports to the
existing import block at the top of the file (biome will sort them):

```ts
import {
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  processWelcome,
} from '../src/group.js'
import { ledgerEntryDigest } from '../src/ledger.js'
import type { Invite } from '../src/types.js'
```

Then the new block, at the end of the file:

```ts
/**
 * The claim Task 1's tests cannot make. Structural equality proves the codec agrees with itself;
 * it would pass just as happily for an encoding real MLS refuses. So the DECODED package — never
 * the original — is what gets added to a group here, and the join is carried all the way through
 * `processWelcome` so the invitee actually derives the epoch secrets.
 */
describe('a decoded key package against real MLS', () => {
  test('joins a group when the round trip is the only source of the package', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()

    const tokens = new Map<string, string>()
    const publish = (invite: Invite) => {
      for (const token of invite.ledgerEntries) tokens.set(ledgerEntryDigest(token), token)
    }
    const resolveLedgerEntries = async (ids: Array<string>) =>
      ids.map((id) => {
        const token = tokens.get(id)
        if (token == null) throw new Error(`unknown ledger entry ${id}`)
        return token
      })

    const bundle = await createKeyPackageBundle(bob)
    const decoded = decodeKeyPackage(encodeKeyPackage(bundle.publicPackage))
    expect(decoded).not.toBeNull()
    if (decoded == null) return

    const { group } = await createGroup(alice, 'group:codec', { resolveLedgerEntries })
    const { invite } = await createInvite({
      group,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    publish(invite)

    // The decoded package, not `bundle.publicPackage`. That substitution is the whole test.
    const added = await commitInvite(group, decoded, invite)
    const { group: joined } = await processWelcome({
      identity: bob,
      invite,
      welcome: added.welcomeMessage,
      keyPackageBundle: bundle,
      ratchetTree: added.newGroup.state.ratchetTree,
      options: { resolveLedgerEntries },
    })

    expect(joined.findMemberLeafIndex(bob.id)).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run the test**

```bash
cd /Users/paul/dev/yulsi/kumiai && pnpm --filter @kumiai/mls exec vitest run test/key-package-codec.test.ts
```

Expected: PASS, 8 tests total. This one is expected to pass on first run — the
implementation already exists from Task 1, and the test's job is to *falsify* the claim
that the codec is MLS-compatible, not to drive new code. If it fails, the codec is wrong
and the failure is the finding.

- [ ] **Step 3: Mutation-check the integration proof**

The test must fail when the codec is genuinely broken, not merely when it throws. In
`key-package-codec.ts`, temporarily corrupt the encoder by dropping the last byte:

```ts
export function encodeKeyPackage(keyPackage: KeyPackage): string {
  const bytes = encode(keyPackageEncoder, keyPackage)
  return toB64(bytes.subarray(0, bytes.length - 1))
}
```

Run the suite. Expected: `joins a group when the round trip is the only source of the
package` fails at the `expect(decoded).not.toBeNull()` assertion. Restore the original
body and confirm 8 passes.

- [ ] **Step 4: Document the capability**

In `packages/mls/README.md`, add to the `## Capabilities` list, after the
`restoreGroup` bullet:

```markdown
- `encodeKeyPackage` + `decodeKeyPackage` — convert a key package to and from the opaque string a hub stores; decode is strict and returns `null` rather than throwing
```

- [ ] **Step 5: Write the changeset**

Create `.changeset/key-package-codec.md`:

```markdown
---
'@kumiai/mls': minor
---

Add `encodeKeyPackage` and `decodeKeyPackage`, so a host can move key packages to and from the
hub without a direct `ts-mls` dependency.

Nothing in the stack converted an MLS `KeyPackage` to the `string` the hub's
`hub/v1/keypackage/upload` and `hub/v1/keypackage/fetch` carry, or back — so `uploadKeyPackages`
and `uploadLastResortKeyPackage` were unusable from inside this stack without each host
hand-rolling TLS encoding plus a binary-to-string step, then independently reinventing the exact
inverse on the fetching side. The encoding is a wire-compatibility decision rather than a local
one: the uploading peer and the fetching peer must agree, and once packages are sitting in a hub,
changing it breaks them. `@sozai/codec` exports both `toB64` and `toB64U` and they are not
interchangeable, so this returns a `string` — deviating from every other encoder in the package,
which returns `Uint8Array` — and makes one form canonical.

`decodeKeyPackage` returns `null` rather than throwing, matching `decodeGroupAnchor` and
`decodeLedgerHead`, and is strict about canonical form: it rejects a string that is not the
canonical base64 of its own bytes (`fromB64` trims whitespace and tolerates padding variation,
and the hub compares strings), and it calls `keyPackageDecoder` directly rather than through
ts-mls's `decode()` — which discards the consumed length and so silently accepts trailing
garbage — to require that the whole input was consumed. One canonical string per package is what
any later attempt to dedup or identify a package by its stored form depends on.

A successful decode proves well-formedness and nothing more. No signature is verified, no
lifetime is checked, no capability is inspected: ts-mls performs all of those at Add time on the
inviter, with the group context in hand, and repeating them here would be redundant where it
duplicated that gate and misleading where it did not.
```

- [ ] **Step 6: Full package gate**

```bash
cd /Users/paul/dev/yulsi/kumiai && pnpm --filter @kumiai/mls run test
cd /Users/paul/dev/yulsi/kumiai && rtk proxy pnpm run lint
```

Expected: the whole `@kumiai/mls` suite green (types + unit), lint clean. The full suite
matters here, not just the new file — `index.ts` gained a type re-export that other
packages compile against.

- [ ] **Step 7: Commit**

```bash
cd /Users/paul/dev/yulsi/kumiai && git add packages/mls/test/key-package-codec.test.ts packages/mls/README.md .changeset/key-package-codec.md && git commit -m "test(mls): prove the key-package codec against a real MLS join"
```

---

## Out of Scope

Confirmed by the spec, and not to be added opportunistically:

- **Provisioning, rotation, and upload scheduling.** The separate follow-on this unblocks
  (`docs/agents/plans/next/2026-07-26-last-resort-keypackage-provisioning.md`).
- **Any change to the hub protocol, `HubStore`, or `hub-client`.** Their wire types
  already accept the string this produces. If a task seems to need one, stop — it means
  the codec's output type is wrong, which is a spec question.
- **Encoding for `PrivateKeyPackage`.** Host-side persistence of private key material
  carries retention and rotation obligations that belong with the provisioning work.
