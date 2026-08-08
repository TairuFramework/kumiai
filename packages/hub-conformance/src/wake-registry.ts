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
