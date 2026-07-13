import { deriveTopicID } from '@kumiai/broadcast'
import { sha256 } from '@noble/hashes/sha2.js'
import { fromUTF, toB64U } from '@sozai/codec'

/** Reserved label for per-member unicast inbox topics. */
export const INBOX_LABEL = 'enkaku/inbox/v1'

/** Reserved label for the non-rotating MLS commit topic. */
export const COMMIT_LABEL = 'enkaku/commit/v1'

/** Reserved label for the non-rotating recovery-rendezvous topic. */
export const RENDEZVOUS_LABEL = 'enkaku/rendezvous/v1'

const DISCOVERY_PREFIX = 'enkaku/discovery/v1'
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
 * The non-rotating commit topic: MLS Commits only, retained as a log and read by
 * pull. Derived from the epoch-independent recovery secret (epoch fixed at `0`), so
 * it is stable for the group's whole life and a member stranded on any epoch can
 * still derive it. Opaque to the hub.
 *
 * Separate from {@link rendezvousTopic} because the two lanes want opposite things
 * from the hub: the commit lane is a log whose head every commit moves, and the
 * rendezvous lane is a mailbox whose frames must never move that head.
 */
export function commitTopic(recoverySecret: Uint8Array): string {
  return deriveTopicID(recoverySecret, 0, COMMIT_LABEL)
}

/**
 * The non-rotating recovery-rendezvous topic: recovery request/reply, published
 * unconditionally and delivered by push. Derived from the same epoch-independent
 * recovery secret, so a stranded peer always shares this rendezvous with the live
 * group. Keeps mailbox semantics: a requester subscribes before it asks, so it
 * cannot miss its own reply. Opaque to the hub.
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
