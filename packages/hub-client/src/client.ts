import type { ChannelCall, Client, RequestCall } from '@enkaku/client'
import type { HubProtocol } from '@kumiai/hub-protocol'

export type HubClientParams = {
  client: Client<HubProtocol>
}

export type PublishParams = {
  topicID: string
  payload: string
  /** Retention class. Absent: 'mailbox' — the frame dies with its last ack. */
  retain?: 'log' | 'mailbox'
  /**
   * Compare-and-set on the topic's head. Absent: unconditional. `null`: the topic has never had an
   * accepted log publish. On mismatch the request rejects with the HeadMismatchError wire code.
   */
  expectedHead?: string | null
  /** Idempotency key: a replay returns the original sequenceID and appends nothing. */
  publishID?: string
}

export type SubscribeOptions = {
  /** Requested retention in seconds. Above the hub's maximum the subscribe is refused. */
  retention?: number
}

export type FetchTopicParams = {
  topicID: string
  /** Exclusive cursor: entries after this sequenceID. */
  after?: string
  limit?: number
}

export type FetchTopicResult = {
  messages: Array<{
    sequenceID: string
    senderDID: string
    topicID: string
    payload: string
  }>
  head: string | null
  oldest: string | null
}

export type ReceiveOptions = {
  after?: string
}

type ReceiveMessage = {
  sequenceID: string
  senderDID: string
  topicID: string
  payload: string
  /**
   * Where the frame sits in its topic's log, present iff it is log-class. `sequenceID` names a place
   * in this recipient's delivery queue instead — a different sequence — so a caller advancing a log
   * cursor over a pushed frame reads this one.
   */
  logPosition?: string
}

type ReceiveAck = {
  ack: Array<string>
}

export class HubClient {
  #client: Client<HubProtocol>

  constructor(params: HubClientParams) {
    this.#client = params.client
  }

  publish(params: PublishParams): RequestCall<{ sequenceID: string }> {
    return this.#client.request('hub/v1/publish', {
      param: {
        topicID: params.topicID,
        payload: params.payload,
        retain: params.retain,
        // Absent and null are different requests — null is the empty-topic sentinel — so the key
        // is only sent when the caller actually set it.
        ...('expectedHead' in params ? { expectedHead: params.expectedHead } : {}),
        publishID: params.publishID,
      },
    })
  }

  subscribe(topicID: string, options?: SubscribeOptions): RequestCall<{ subscribed: boolean }> {
    return this.#client.request('hub/v1/subscribe', {
      param: { topicID, retention: options?.retention },
    })
  }

  /** Pull a topic's log. The hub gates this on the caller's own subscription. */
  fetchTopic(params: FetchTopicParams): RequestCall<FetchTopicResult> {
    return this.#client.request('hub/v1/topic/fetch', {
      param: { topicID: params.topicID, after: params.after, limit: params.limit },
    })
  }

  unsubscribe(topicID: string): RequestCall<{ unsubscribed: boolean }> {
    return this.#client.request('hub/v1/unsubscribe', {
      param: { topicID },
    })
  }

  receive(
    options?: ReceiveOptions,
  ): ChannelCall<ReceiveMessage, ReceiveAck, Record<string, never>> {
    return this.#client.createChannel('hub/v1/receive', {
      param: {
        after: options?.after,
      },
    })
  }

  /**
   * Upload single-use key packages to the caller's ordinary pool.
   *
   * `notAfter` is when every package in this batch expires, in seconds — take it from the minted
   * package's own MLS lifetime. Omit it and the hub keeps the entries forever, which means a pool
   * that has gone stale still holds the per-DID cap against every future upload. `@kumiai/mls-hub`'s
   * key package pool passes it for you.
   */
  uploadKeyPackages(
    keyPackages: Array<string>,
    notAfter?: number,
  ): RequestCall<{ stored: number }> {
    return this.#client.request('hub/v1/keypackage/upload', {
      // An explicit `notAfter: undefined` fails the wire schema's `integer` check on some
      // transports (unlike JSON, they don't drop `undefined` properties) — omit the key instead.
      param: { keyPackages, ...(notAfter != null ? { notAfter } : {}) },
    })
  }

  /**
   * Upload the caller's single reusable last-resort key package, replacing any previous one. The
   * hub serves it without consuming it once the ordinary pool runs dry, so the caller stays
   * addable to a group. Generate it with `createLastResortKeyPackageBundle` from `@kumiai/mls` —
   * an ordinary package sent here would be handed out twice, which is init-key reuse.
   *
   * Two obligations sit on the caller, and both fail SILENTLY — the hub reports success either way:
   *
   * - **Re-upload before `LAST_RESORT_LIFETIME_DAYS` (90) elapses.** The hub stores opaque bytes
   *   and cannot see the expiry, so it goes on reporting the slot full while serving a dead package
   *   that every inviter refuses. Uploading once at enrolment buys 90 days, not forever.
   * - **Retain the bundle's `privatePackage` for as long as it may be reused.** Deleting it after
   *   a Welcome — as a host correctly would for an ordinary, single-use bundle — makes the member
   *   silently unaddable forever, the exact outage this slot exists to prevent.
   */
  uploadLastResortKeyPackage(keyPackage: string): RequestCall<{ stored: number }> {
    return this.#client.request('hub/v1/keypackage/upload', {
      param: { keyPackages: [keyPackage], lastResort: true },
    })
  }

  /**
   * The caller's own key-package inventory: live pool depth, and a digest of the last-resort slot
   * (`null` when empty).
   *
   * Answers only for the authenticated caller — there is no way to ask about another DID, because a
   * query that could would report exactly when a drain against that DID had succeeded.
   *
   * The digest is `keyPackageDigest` from `@kumiai/hub-protocol` over the stored string. Compare it
   * against a digest of your own retained package to catch a hub that lost the slot or is holding
   * something else.
   */
  keyPackageStatus(): RequestCall<{ count: number; lastResort: string | null }> {
    return this.#client.request('hub/v1/keypackage/status', { param: {} })
  }

  fetchKeyPackages(did: string, count?: number): RequestCall<{ keyPackages: Array<string> }> {
    return this.#client.request('hub/v1/keypackage/fetch', {
      param: { did, count },
    })
  }
}
