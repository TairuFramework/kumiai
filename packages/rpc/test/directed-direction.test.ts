import type { ProtocolDefinition } from '@enkaku/protocol'
import type { HubFrameMessageBody } from '@kumiai/hub-tunnel'
import * as hubTunnel from '@kumiai/hub-tunnel'
import { createRuntime } from '@sozai/runtime'
import { afterEach, expect, test, vi } from 'vitest'

import {
  createDirectedClient,
  createInboxAcceptor,
  type InboundPath,
  type OpenedInbound,
} from '../src/directed.js'
import { createHubMux } from '../src/hub-mux.js'
import { FakeHub } from './fixtures/fake-hub.js'

const calls = [
  { typ: 'request', rid: 'request-1', prc: 'ping', prm: { n: 1 } },
  { typ: 'stream', rid: 'stream-1', prc: 'ping', prm: { n: 2 } },
  { typ: 'channel', rid: 'channel-1', prc: 'ping', prm: { n: 3 } },
  { typ: 'event', prc: 'notice', data: { n: 4 } },
  { typ: 'send', rid: 'channel-1', prc: 'ping', val: { n: 5 } },
  { typ: 'abort', rid: 'request-1', rsn: 'cancelled' },
]
const replies = [
  { typ: 'result', rid: 'request-2', val: { n: 6 } },
  { typ: 'receive', rid: 'channel-2', val: { n: 7 } },
  { typ: 'error', rid: 'request-3', code: 'EK08', msg: 'rejected', data: {} },
]
const protocol = {
  ping: { type: 'request', param: { type: 'object' }, result: { type: 'object' } },
  notice: { type: 'event', data: { type: 'object' } },
} as const satisfies ProtocolDefinition

afterEach(() => vi.restoreAllMocks())

test.each(['client', 'acceptor'] as const)(
  '%s receives only payloads travelling in its direction',
  async (side) => {
    const seen: Record<'client' | 'acceptor', Array<HubFrameMessageBody['payload']>> = {
      client: [],
      acceptor: [],
    }
    const createTunnel = hubTunnel.createHubTunnelTransport
    const spy = vi.spyOn(hubTunnel, 'createHubTunnelTransport').mockImplementation((params) => {
      const transport = createTunnel(params)
      const read = transport.read.bind(transport)
      const destination = typeof params.sessionID === 'string' ? 'client' : 'acceptor'
      vi.spyOn(transport, 'read').mockImplementation(async () => {
        const message = await read()
        if (!message.done) {
          seen[destination].push((message.value as HubFrameMessageBody).payload)
        }
        return message
      })
      return transport
    })
    const listeners = new Set<(message: OpenedInbound) => void>()
    const inbound: InboundPath = (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
    const mux = createHubMux({ hub: new FakeHub(), localDID: 'alice' })
    const directed = createDirectedClient<typeof protocol>({
      mux,
      localDID: 'alice',
      memberDID: 'bob',
      sendTopicID: 'bob-inbox',
      receiveTopicID: 'alice-inbox',
      inbound,
      wrap: async ({ bytes }) => bytes,
      protocol: 'rpc',
      runtime: createRuntime({ getRandomID: () => 'client-session' }),
    })
    const acceptor = createInboxAcceptor({
      mux,
      localDID: 'alice',
      selfInboxTopic: 'alice-inbox',
      inbound,
      resolveSendTopic: () => 'bob-inbox',
      protocol,
      protocolName: 'rpc',
      handlers: { ping: () => ({}), notice: () => {} },
      wrap: async ({ bytes }) => bytes,
    })
    let seq = 0
    const deliver = (params: { sessionID: string; payload: HubFrameMessageBody['payload'] }) => {
      const message: OpenedInbound = {
        sequenceID: String(seq),
        senderDID: 'bob',
        topicID: 'alice-inbox',
        protocol: 'rpc',
        payload: hubTunnel.encodeFrame({
          v: 1,
          sessionID: params.sessionID,
          seq: seq++,
          kind: 'message',
          body: { header: { typ: 'JWT', alg: 'none' }, payload: params.payload },
        }),
      }
      for (const listener of listeners) listener(message)
    }
    try {
      for (const payload of calls) deliver({ sessionID: 'client-session', payload })
      for (const payload of replies) deliver({ sessionID: 'client-session', payload })
      deliver({
        sessionID: 'another-client-session',
        payload: { typ: 'result', rid: 'foreign-request', val: { n: 99 } },
      })
      // Drain the real tunnel and Enkaku read loops before checking rejected payloads.
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(seen[side]).toEqual(side === 'client' ? replies : calls)
    } finally {
      await directed.dispose()
      await acceptor.dispose()
      await mux.dispose()
      spy.mockRestore()
    }
  },
)
