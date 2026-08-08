import type { ProtocolDefinition } from '@enkaku/protocol'

/**
 * Namespaced `hub/v1/*` so the series stays regular: a future shape change ships as a new
 * versioned procedure (`hub/v2/publish`, say) — additive in an enkaku protocol — never by
 * widening an existing schema. Every `additionalProperties: false` below stays sealed; if a
 * later change wants a wider param or result, it belongs on a new procedure, not here.
 */
export const hubProtocol = {
  'hub/v1/publish': {
    type: 'request',
    description: 'Publish an opaque message to a topic; fans out to current subscribers',
    param: {
      type: 'object',
      properties: {
        topicID: { type: 'string', minLength: 1, maxLength: 256 },
        payload: { type: 'string', contentEncoding: 'base64', maxLength: 1048576 },
        /** Retention class. Absent: 'mailbox'. */
        retain: { type: 'string', enum: ['log', 'mailbox'] },
        /**
         * Compare-and-set on the topic's head. Absent: unconditional. `null`: the topic has never
         * had an accepted log publish. Absent and `null` are NOT the same request.
         */
        expectedHead: { type: ['string', 'null'], maxLength: 64 },
        /** Idempotency key: a replay returns the original sequenceID and appends nothing. */
        publishID: { type: 'string', minLength: 1, maxLength: 128 },
      },
      required: ['topicID', 'payload'],
      additionalProperties: false,
    },
    result: {
      type: 'object',
      properties: {
        sequenceID: { type: 'string' },
      },
      required: ['sequenceID'],
      additionalProperties: false,
    },
  },
  'hub/v1/subscribe': {
    type: 'request',
    description: 'Subscribe to a topic, creating a durable inbox for the caller',
    param: {
      type: 'object',
      properties: {
        topicID: { type: 'string', minLength: 1, maxLength: 256 },
        /**
         * Requested retention in seconds. Above the hub's maximum the subscribe is refused, never
         * clamped. Absent: the hub's default.
         */
        retention: { type: 'integer', minimum: 0 },
      },
      required: ['topicID'],
      additionalProperties: false,
    },
    result: {
      type: 'object',
      properties: {
        subscribed: { type: 'boolean' },
      },
      required: ['subscribed'],
      additionalProperties: false,
    },
  },
  'hub/v1/unsubscribe': {
    type: 'request',
    description: "Unsubscribe from a topic, dropping the caller's inbox for it",
    param: {
      type: 'object',
      properties: {
        topicID: { type: 'string', minLength: 1, maxLength: 256 },
      },
      required: ['topicID'],
      additionalProperties: false,
    },
    result: {
      type: 'object',
      properties: {
        unsubscribed: { type: 'boolean' },
      },
      required: ['unsubscribed'],
      additionalProperties: false,
    },
  },
  'hub/v1/topic/fetch': {
    type: 'request',
    description:
      "Pull a topic's log. Gated on subscription: the caller is the authenticated DID, never a wire field, so a member cannot read a topic's log by naming someone else",
    param: {
      type: 'object',
      properties: {
        topicID: { type: 'string', minLength: 1, maxLength: 256 },
        /** Exclusive cursor: entries after this sequenceID. Absent: from the oldest retained. */
        after: { type: 'string', maxLength: 64 },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
      },
      required: ['topicID'],
      additionalProperties: false,
    },
    result: {
      type: 'object',
      properties: {
        messages: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              sequenceID: { type: 'string' },
              senderDID: { type: 'string' },
              topicID: { type: 'string' },
              payload: { type: 'string', contentEncoding: 'base64' },
            },
            required: ['sequenceID', 'senderDID', 'topicID', 'payload'],
            additionalProperties: false,
          },
        },
        /** The sequenceID of the last accepted log publish, or null. Survives a trim. */
        head: { type: ['string', 'null'] },
        /** The oldest sequenceID still retained, or null if the log is empty. */
        oldest: { type: ['string', 'null'] },
      },
      required: ['messages', 'head', 'oldest'],
      additionalProperties: false,
    },
  },
  'hub/v1/receive': {
    type: 'channel',
    description:
      'Bidirectional mailbox channel — hub pushes messages across all subscribed topics, device pushes acks',
    param: {
      type: 'object',
      properties: {
        after: { type: 'string', maxLength: 64 },
      },
      additionalProperties: false,
    },
    send: {
      type: 'object',
      properties: {
        ack: {
          type: 'array',
          items: { type: 'string', maxLength: 64 },
          maxItems: 1000,
        },
      },
      required: ['ack'],
      additionalProperties: false,
    },
    receive: {
      type: 'object',
      properties: {
        sequenceID: { type: 'string' },
        senderDID: { type: 'string' },
        topicID: { type: 'string' },
        payload: { type: 'string', contentEncoding: 'base64' },
        /**
         * Where the frame sits in its topic's log — the position `hub/v1/topic/fetch` serves it at.
         * Present iff the frame is log-class; a mailbox frame has no place in a log and carries no
         * key. `sequenceID` above names a place in THIS recipient's delivery queue instead, which is
         * a different sequence, so a reader advancing a log cursor over a pushed frame reads this
         * and never that.
         */
        logPosition: { type: 'string', maxLength: 64 },
      },
      required: ['sequenceID', 'senderDID', 'topicID', 'payload'],
      additionalProperties: false,
    },
    result: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  'hub/v1/keypackage/upload': {
    type: 'request',
    description: 'Upload key packages for later retrieval',
    param: {
      type: 'object',
      properties: {
        keyPackages: {
          type: 'array',
          items: { type: 'string', maxLength: 16384 },
          minItems: 1,
          maxItems: 50,
        },
        /**
         * Route this upload to the owner's single reusable last-resort slot instead of the
         * destructive pool. The hub stores opaque blobs and cannot tell a `last_resort`-marked
         * package from an ordinary one, so it takes the uploader's word for it: mislabelling an
         * ordinary package is init-key reuse, but only against the uploader's own DID.
         *
         * Requires `keyPackages` to hold exactly one entry — the slot holds one.
         */
        lastResort: { type: 'boolean' },
        /**
         * When every package in this batch expires, in seconds. Absent means "no expiry known":
         * the entries never expire, exactly as before this field existed.
         *
         * The hub stores opaque blobs and cannot read an MLS lifetime, so it takes the uploader's
         * word — the same trust `lastResort` above already asks for, and misstating it only harms
         * the uploader's own DID: too early evicts your own live packages, too late keeps your own
         * dead ones holding your own cap.
         *
         * One value for the batch, because a batch is minted together and shares a lifetime.
         * Meaningless for `lastResort`, whose staleness is handled by rotation, so sending both is
         * rejected.
         */
        notAfter: { type: 'integer', minimum: 0 },
      },
      required: ['keyPackages'],
      additionalProperties: false,
    },
    result: {
      type: 'object',
      properties: {
        stored: { type: 'integer' },
      },
      required: ['stored'],
      additionalProperties: false,
    },
  },
  'hub/v1/keypackage/fetch': {
    type: 'request',
    description: 'Fetch and consume key packages for a DID',
    param: {
      type: 'object',
      properties: {
        did: { type: 'string', minLength: 1, maxLength: 256 },
        count: { type: 'integer', minimum: 1, maximum: 10 },
      },
      required: ['did'],
      additionalProperties: false,
    },
    result: {
      type: 'object',
      properties: {
        keyPackages: { type: 'array', items: { type: 'string' } },
      },
      required: ['keyPackages'],
      additionalProperties: false,
    },
  },
  'hub/v1/keypackage/status': {
    type: 'request',
    description: "The caller's own key-package inventory",
    param: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    result: {
      type: 'object',
      properties: {
        /** Live entries in the caller's ordinary pool: expired ones are not counted. */
        count: { type: 'integer' },
        /** `keyPackageDigest` of the caller's stored last-resort package, or `null` for an empty
         * slot. A digest rather than a boolean so a hub holding some OTHER package is
         * distinguishable from one holding the right one. */
        lastResort: { type: ['string', 'null'] },
      },
      required: ['count', 'lastResort'],
      additionalProperties: false,
    },
  },
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
} as const satisfies ProtocolDefinition

export type HubProtocol = typeof hubProtocol
