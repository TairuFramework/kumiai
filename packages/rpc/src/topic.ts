import { deriveTopicID } from '@kumiai/broadcast'
import { sha256 } from '@noble/hashes/sha2.js'
import { fromUTF, toB64U } from '@sozai/codec'

/**
 * The label the app-lane anchor is exported under — the one `GroupCrypto.exportSecret` call in
 * this package, made once per anchor capture (`captureAnchor` in `peer.ts`, on init and every
 * roster-changing commit). Fixed rather than per-protocol: the secret it produces is not itself
 * a topic, it is what {@link protocolTopic} and {@link inboxTopic} derive every app-lane topic
 * FROM, so one label covers every protocol a host defines and `protocol`/`scope` do the
 * discriminating below it.
 *
 * MUST MATCH the label a real host's `GroupCrypto` implementation is exercised with, and there is
 * nothing that checks that at compile time: `@kumiai/rpc` cannot depend on `@kumiai/mls-rpc` (see
 * that package's module doc — the dependency runs the other way, so it cannot re-export this for
 * rpc to import), so the two packages agree on the string by convention, not by sharing a
 * constant. Changing it changes every topic ID this package has ever derived.
 */
export const APP_TOPIC_LABEL = 'kumiai/app-topic/v1'

/** Reserved label for per-member unicast inbox topics. */
export const INBOX_LABEL = 'kumiai/inbox/v1'

/** Reserved label for the non-rotating MLS commit topic. */
export const COMMIT_LABEL = 'kumiai/commit/v1'

/** Reserved label for the non-rotating recovery-rendezvous topic. */
export const RENDEZVOUS_LABEL = 'kumiai/rendezvous/v1'

const DISCOVERY_PREFIX = 'kumiai/discovery/v1'
const SEP = '\0'

/**
 * Group-scoped broadcast/multicast topic for an application protocol. Opaque to
 * the hub; derivable only by members holding the epoch secret. `scope`
 * discriminates a subgroup (e.g. an ephemeral room) sharing the protocol.
 */
export function protocolTopic(
  secret: Uint8Array,
  epoch: number,
  protocol: string,
  scope = '',
): string {
  return deriveTopicID(secret, epoch, protocol, scope)
}

/**
 * Group-scoped personal inbox topic for unicast/directed RPC to `memberDID`.
 * Opaque; derivable only by fellow members. Uses the reserved {@link INBOX_LABEL}
 * so it never collides with an application protocol of the same name.
 */
export function inboxTopic(secret: Uint8Array, epoch: number, memberDID: string): string {
  return deriveTopicID(secret, epoch, INBOX_LABEL, memberDID)
}

/**
 * The non-rotating commit topic: MLS Commits only, retained as a log, read by pull. Derived
 * from the epoch-independent recovery secret (epoch fixed at `0`), so it is stable for the
 * group's life and a member stranded on any epoch can still derive it. Opaque to the hub.
 *
 * Separate from {@link rendezvousTopic}: the commit lane is a log whose head every commit
 * moves, the rendezvous lane is a mailbox whose frames must never move a head.
 */
export function commitTopic(recoverySecret: Uint8Array): string {
  return deriveTopicID(recoverySecret, 0, COMMIT_LABEL)
}

/**
 * The non-rotating recovery-rendezvous topic: recovery request/reply, published
 * unconditionally and pushed. Derived from the same epoch-independent recovery secret, so a
 * stranded peer always shares it with the live group. Mailbox semantics: a requester
 * subscribes before it asks, so it cannot miss its own reply. Opaque to the hub.
 */
export function rendezvousTopic(recoverySecret: Uint8Array): string {
  return deriveTopicID(recoverySecret, 0, RENDEZVOUS_LABEL)
}

/**
 * Public, secretless pre-group rendezvous topic (invite / keypackage / Welcome).
 * `b64url(SHA-256(DISCOVERY_PREFIX ‖ SEP ‖ memberDID))` — intentionally
 * enumerable from the DID alone; the published domain-separation tag makes it
 * nothing-up-my-sleeve.
 */
export function discoveryTopic(memberDID: string): string {
  return toB64U(sha256(fromUTF(`${DISCOVERY_PREFIX}${SEP}${memberDID}`)))
}
