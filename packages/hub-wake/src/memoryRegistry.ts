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
      // Cloned on the way in: a real backing store serialises the caller's object, disconnecting it
      // from storage. Storing the reference would make this double more permissive than any of them.
      registrations.set(registration.did, { ...registration })
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
      // Cloned on the way out for the same reason: a caller mutating what it got back must not
      // corrupt the stored entry with no `put` in between.
      return { ...stored }
    },
    async delete(did: string): Promise<void> {
      registrations.delete(did)
    },
  }
}
