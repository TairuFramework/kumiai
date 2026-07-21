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

  get rawClient(): Client<HubProtocol> {
    return this.#client
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

  uploadKeyPackages(keyPackages: Array<string>): RequestCall<{ stored: number }> {
    return this.#client.request('hub/v1/keypackage/upload', {
      param: { keyPackages },
    })
  }

  fetchKeyPackages(did: string, count?: number): RequestCall<{ keyPackages: Array<string> }> {
    return this.#client.request('hub/v1/keypackage/fetch', {
      param: { did, count },
    })
  }
}
