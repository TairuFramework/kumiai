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
  /**
   * RFC 8291 user-agent public key: raw uncompressed P-256 point, 65 bytes, base64url.
   * `wakeRecipientKeyProblem` checks this and `authSecret` together, on the curve and not merely
   * by length.
   */
  publicKey: string
  /** RFC 8291 auth secret: 16 bytes, base64url. */
  authSecret: string
  /**
   * When this registration expires, in seconds since the epoch. A registry MUST NOT return an
   * entry once the clock has REACHED its `expiresAt` — the boundary is inclusive, so `expiresAt`
   * names the first second at which the entry is gone. An expired entry that still answers is one
   * that fails silently, the same rule key packages already carry. Absent means it never expires.
   */
  expiresAt?: number
}

/**
 * Durable storage for wake registrations: one per DID, since a DID names one device.
 *
 * Storage is by VALUE. `put` MUST store a copy and `get` MUST return one, so neither the caller's
 * object nor the returned object stays connected to what the registry serves. A durable backend
 * gets this from serialisation; an in-process one has to copy on purpose, and one that does not
 * lets any caller rewrite a stored endpoint with no `put` in between.
 *
 * Verified by `testWakeRegistryConformance` in `@kumiai/hub-conformance`.
 */
export type WakeRegistry = {
  /** Store this DID's registration, REPLACING any previous one. */
  put(registration: WakeRegistration): Promise<void>
  /** The DID's registration, or null when there is none or it has expired. */
  get(did: string): Promise<WakeRegistration | null>
  /** Remove this DID's registration, and ONLY this DID's. */
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
