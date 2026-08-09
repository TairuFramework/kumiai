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
      const next = registration({ endpoint: 'https://push.example/new' })
      await registry.put(next)
      await expect(registry.get('did:key:alice')).resolves.toEqual(next)
    })

    test('delete after a replace leaves no registration for the DID', async () => {
      const registry = await params.createRegistry()
      await registry.put(registration({ endpoint: 'https://push.example/old' }))
      await registry.put(registration({ endpoint: 'https://push.example/new' }))
      await registry.delete('did:key:alice')
      await expect(registry.get('did:key:alice')).resolves.toBeNull()
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

    // Every other delete case here holds a single DID, so a registry that wiped the whole table
    // would satisfy all of them. A SQL implementation missing its `WHERE did = ?`, or a Redis one
    // flushing a key prefix, then passes conformance — and the first `gone` verdict or the first
    // `unregister` silently unsubscribes every device on the hub, with no error anywhere.
    test('delete removes ONLY the named DID', async () => {
      const registry = await params.createRegistry()
      await registry.put(registration({ did: 'did:key:alice' }))
      await registry.put(registration({ did: 'did:key:bob', endpoint: 'https://push.example/bob' }))

      await registry.delete('did:key:alice')

      expect(await registry.get('did:key:alice')).toBeNull()
      expect((await registry.get('did:key:bob'))?.endpoint).toBe('https://push.example/bob')
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

    // The boundary itself, not merely "past". `expiresAt` names the second the registration stops
    // being valid, so a registry comparing with `<` rather than `<=` serves it for one more second
    // — invisible against every other case here, and exactly the window in which a push service may
    // already have handed the endpoint to another device.
    test('a registration expiring exactly NOW is NOT served', async () => {
      const registry = await params.createRegistry()
      // Begin early in a second, so `put` and `get` cannot straddle the tick and turn the equality
      // case into a strictly-past one that a `<` implementation would pass by accident.
      while (Date.now() % 1000 > 200) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      await registry.put(registration({ expiresAt: Math.floor(Date.now() / 1000) }))
      await expect(registry.get('did:key:alice')).resolves.toBeNull()
    })

    test('a registration with no expiresAt never expires', async () => {
      const registry = await params.createRegistry()
      await registry.put(registration())
      expect(await registry.get('did:key:alice')).not.toBeNull()
    })

    // Storage is by VALUE, not by reference. A durable registry serialises on the way in and
    // deserialises on the way out, so it gets this for free; an in-process one that hands back the
    // stored object lets any caller silently rewrite an endpoint with no `put` in between. The
    // memory registry shipped with exactly that leak (fixed in abf0b81), and the suite it passes
    // never asked.
    test('put stores a COPY: mutating the caller object afterwards does not change what is served', async () => {
      const registry = await params.createRegistry()
      const entry = registration()
      await registry.put(entry)

      entry.endpoint = 'https://push.example/mutated-after-put'

      expect((await registry.get('did:key:alice'))?.endpoint).toBe('https://push.example/aaa')
    })

    test('get returns a COPY: mutating it does not change what the next get serves', async () => {
      const registry = await params.createRegistry()
      await registry.put(registration())

      const first = await registry.get('did:key:alice')
      if (first == null) throw new Error('expected a registration')
      first.endpoint = 'https://push.example/mutated-after-get'

      expect((await registry.get('did:key:alice'))?.endpoint).toBe('https://push.example/aaa')
    })
  })
}
