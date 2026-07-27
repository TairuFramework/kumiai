# Every MLS operation builds a fresh ciphersuite implementation

**Priority:** medium — a wasted-work problem, not a defect. Nothing is incorrect; batch operations pay
a multiple of what they need to.
**Origin:** PR #17 review of `feat/ordinary-keypackage-pool`, 2026-07-27. Parallelising the ref
computation in `processWelcomeFromSources` overlapped this cost rather than removing it, which is what
surfaced it. See `docs/agents/plans/completed/2026-07-27-ordinary-keypackage-pool.complete.md`.

## The premise, verified

`resolveMlsContext` (`packages/mls/src/group-context.ts:16-21`) does two things on **every** call:

```ts
const cipherSuite = await getCiphersuiteImpl(name, options?.cryptoProvider ?? nobleCryptoProvider)
const authService = createDIDAuthenticationService()
```

Neither is cached, at any layer:

- `getCiphersuiteImpl` in ts-mls is a straight delegation to `provider.getCiphersuiteImpl(...)` with no
  memoisation (`ts-mls/dist/src/crypto/getCiphersuiteImpl.js`).
- `nobleCryptoProvider.getCiphersuiteImpl` constructs a new object each time — `makeKdfImpl`,
  `makeHashImpl`, `await makeNobleSignatureImpl(...)`, `await makeHpke(...)`, and the rng
  (`ts-mls/dist/src/crypto/implementation/noble/provider.js`). Two of the five are async, so this is not
  a trivial allocation.
- `createDIDAuthenticationService()` (`packages/mls/src/authentication.ts:23`) returns a fresh service
  per call.

`resolveMlsContext` has six call sites across `@kumiai/mls`: `group-credential.ts` (every key-package
mint), `group-create.ts` (twice), `group-welcome.ts` (twice), and `key-package-codec.ts` (every
`keyPackageRef`).

## Where it actually shows

One `KeyPackagePool.ensureStocked()` topping up a default deficit of 20 does **40** ciphersuite
constructions: one per `createKeyPackageBundle` and one per `keyPackageRef`, since `mint()` calls both.
`processWelcomeFromSources` adds one per retained bundle it hashes while looking for a match. None of
this is on a per-message hot path — these are provisioning and join operations — which is why it reads
as waste rather than as a bug.

**This has not been benchmarked.** The first task is to measure, not to optimise: if a construction is
sub-millisecond, 40 of them are noise and this item should be closed as not-worth-doing. Measure before
designing anything below.

## If it is worth doing

The shape that fits the existing API is a context a caller can resolve once and pass down, rather than
a hidden cache. `GroupOptions` already threads through every one of these calls, so the resolved context
could ride there — but note `GroupOptions` is a public type and the field would be too.

- **Memoise inside `resolveMlsContext`**, keyed on ciphersuite name plus provider identity. Smallest
  change and every call site benefits with no signature churn. The cost is a module-level cache holding
  crypto implementations for the process lifetime, and a keying question for a caller supplying a custom
  `cryptoProvider` — a provider object is not obviously safe to use as a cache key.
- **A batch API for the specific case**: something like `keyPackageRefs(packages, options)` resolving
  once and hashing many, which is all `processWelcomeFromSources` and the pool's mint loop need. Narrow
  and safe, but leaves the general case untouched and adds an export.
- **An explicit resolved-context parameter** threaded from callers that do batches. Most honest, most
  invasive, and it widens a public type.

The first is probably right if measurement justifies any of it, but the provider-keying question needs
answering before it is written — a wrong cache key here hands one caller another caller's crypto
provider, which is worse than the waste it removes.

## Scope

`@kumiai/mls` only. `@kumiai/mls-hub` and `@kumiai/rpc` are consumers and would need no change under the
memoisation option.
