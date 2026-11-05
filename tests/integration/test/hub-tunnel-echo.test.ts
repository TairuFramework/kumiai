import { Client } from '@enkaku/client'
import type { AnyClientMessageOf, AnyServerMessageOf, ProtocolDefinition } from '@enkaku/protocol'
import { type ProcedureHandlers, type RequestHandler, serve } from '@enkaku/server'
import { randomIdentity } from '@kokuin/token'
import { createHubTunnelTransport } from '@kumiai/hub-tunnel'
import { describe, expect, test } from 'vitest'

import { fixtureTopic } from './fixture-topic.js'
import { createWireHub } from './log-hub-over-wire.js'

const flush = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

const protocol = {
  echo: {
    type: 'request',
    param: {
      type: 'object',
      properties: { msg: { type: 'string' } },
      required: ['msg'],
      additionalProperties: false,
    },
    result: {
      type: 'object',
      properties: { msg: { type: 'string' } },
      required: ['msg'],
      additionalProperties: false,
    },
  },
} as const satisfies ProtocolDefinition

type Protocol = typeof protocol

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('hub-tunnel echo', () => {
  test('client → server round-trip via the real hub wire', async () => {
    const hub = createWireHub()
    const clientID = randomIdentity()
    const serverID = randomIdentity()
    const clientHub = hub.connect(clientID)
    const serverHub = hub.connect(serverID)
    const clientToServer = fixtureTopic('tunnel-c2s')
    const serverToClient = fixtureTopic('tunnel-s2c')

    const clientTransport = createHubTunnelTransport<
      AnyServerMessageOf<Protocol>,
      AnyClientMessageOf<Protocol>
    >({
      hub: clientHub,
      sessionID: 'session-1',
      localDID: clientID.id,
      sendTopicID: clientToServer,
      receiveTopicID: serverToClient,
    })

    const serverTransport = createHubTunnelTransport<
      AnyClientMessageOf<Protocol>,
      AnyServerMessageOf<Protocol>
    >({
      hub: serverHub,
      sessionID: 'session-1',
      localDID: serverID.id,
      sendTopicID: serverToClient,
      receiveTopicID: clientToServer,
    })

    const echoHandler: RequestHandler<Protocol, 'echo'> = async ({ param }) => param
    const handlers = { echo: echoHandler } as ProcedureHandlers<Protocol>

    const server = serve<Protocol>({ handlers, requireAuth: false, transport: serverTransport })
    const client = new Client<Protocol>({ transport: clientTransport })
    // A mailbox subscriber only sees later publishes, and `write` gates on its own subscribe only.
    await flush()

    try {
      const result = await client.request('echo', { param: { msg: 'hello' } })
      expect(result).toEqual({ msg: 'hello' })
    } finally {
      await client.dispose()
      await server.dispose()
      await hub.dispose()
    }
  })
})
