import { RequestError } from '@enkaku/client'
import type { ProtocolDefinition } from '@enkaku/protocol'
import { encodeFrame } from '@kumiai/hub-tunnel'
import { describe, expect, test, vi } from 'vitest'

import {
  createDirectedClient,
  createUnroutedTagResponder,
  DEFAULT_DIRECTED_REQUEST_TIMEOUT_MS,
  type InboundPath,
  type OpenedInbound,
} from '../src/directed.js'
import type { HubMux } from '../src/hub-mux.js'
import { createGroupPeer } from '../src/peer.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'

const flush = () => new Promise((r) => setTimeout(r, 30))

const alpha = {
  ping: { type: 'request', param: { type: 'object' }, result: { type: 'object' } },
} as const satisfies ProtocolDefinition

const beta = {
  ping: { type: 'request', param: { type: 'object' }, result: { type: 'object' } },
} as const satisfies ProtocolDefinition

// Caller A serves both; recipient B serves only alpha, so a call on beta.to(B) is tagged for a
// protocol B does not serve — the case the responder exists to make legible.
type CallerProtocols = { alpha: typeof alpha; beta: typeof beta }
type RecipientProtocols = { alpha: typeof alpha }

function makeCaller(hub: FakeHub, localDID: string) {
  return createGroupPeer<CallerProtocols>({
    hub,
    crypto: createFakeCrypto({ epoch: 1, localDID }),
    localDID,
    protocols: { alpha, beta },
    handlers: { alpha: {}, beta: {} } as never,
  })
}

function makeRecipientAlphaOnly(hub: FakeHub, localDID: string) {
  return createGroupPeer<RecipientProtocols>({
    hub,
    crypto: createFakeCrypto({ epoch: 1, localDID }),
    localDID,
    protocols: { alpha },
    handlers: {
      alpha: {
        ping: () => ({ from: 'alpha' }),
      },
    } as never,
  })
}

describe('unrouted directed tag is NACKed, not silently dropped', () => {
  test('a unary request to a protocol the recipient does not serve rejects, well under the default timeout', async () => {
    const hub = new FakeHub()
    const a = makeCaller(hub, 'a')
    const b = makeRecipientAlphaOnly(hub, 'b')
    await flush()

    const betaClient = await a.protocol('beta').to('b')
    const started = Date.now()
    let rejected: unknown
    try {
      await betaClient.request('ping', { param: {} })
      throw new Error('expected the beta request to reject')
    } catch (error) {
      rejected = error
    }
    const elapsed = Date.now() - started

    // A NACK — not the timeout — drove the rejection: it must land far below the default, and the
    // error must be the INVALID_MESSAGE reply the recipient hand-built, not a RequestTimeoutError.
    expect(elapsed).toBeLessThan(2_000)
    expect(DEFAULT_DIRECTED_REQUEST_TIMEOUT_MS).toBe(30_000)
    expect(rejected).toBeInstanceOf(RequestError)
    expect((rejected as RequestError).name).not.toBe('RequestTimeoutError')
    expect((rejected as RequestError & { code?: string }).code).toBe('EK08')

    await a.dispose()
    await b.dispose()
  })

  test('a served protocol on the same recipient still works — the responder only NACKs unrouted tags', async () => {
    const hub = new FakeHub()
    const a = makeCaller(hub, 'a')
    const b = makeRecipientAlphaOnly(hub, 'b')
    await flush()

    const alphaClient = await a.protocol('alpha').to('b')
    const result = await alphaClient.request('ping', { param: {} })
    expect(result).toEqual({ from: 'alpha' })

    await a.dispose()
    await b.dispose()
  })
})

// A minimal OpenedInbound carrying an inner hub-tunnel frame of the given payload type.
function openedFrame(protocol: string, senderDID: string, typ: string, rid: string): OpenedInbound {
  const payload = encodeFrame({
    v: 1,
    sessionID: 'session-1',
    seq: 0,
    kind: 'message',
    body: { header: {}, payload: { typ, rid } },
  })
  return { sequenceID: '', senderDID, topicID: 'inbox', protocol, payload }
}

describe('the responder answers only what it should', () => {
  test('no ping-pong: a reply-typed frame tagged for an unregistered protocol publishes nothing', async () => {
    const publish = vi.fn(async () => ({ sequenceID: '1' }))
    const mux = { mailbox: { publish } } as unknown as HubMux
    let deliver: ((m: OpenedInbound) => void) | undefined
    const inbound: InboundPath = (onOpened) => {
      deliver = onOpened
      return () => {}
    }
    const responder = createUnroutedTagResponder({
      mux,
      localDID: 'me',
      inbound,
      isRegistered: (name) => name === 'alpha',
      resolveSendTopic: (did) => `inbox:${did}`,
      wrap: async (bytes) => bytes,
    })

    // Reply-typed frames on an unregistered tag: each carries an rid, none is a request to answer.
    for (const typ of ['error', 'result', 'receive']) {
      deliver?.(openedFrame('beta', 'caller', typ, 'rid-1'))
    }
    // A registered tag is never the responder's business, whatever its type.
    deliver?.(openedFrame('alpha', 'caller', 'request', 'rid-2'))
    await flush()
    expect(publish).not.toHaveBeenCalled()

    // A request-like frame on the unregistered tag IS answered — proving the silence above is
    // discrimination, not a dead responder.
    deliver?.(openedFrame('beta', 'caller', 'request', 'rid-3'))
    await flush()
    expect(publish).toHaveBeenCalledTimes(1)

    responder.dispose()
  })
})

describe('the default request timeout is the unary backstop', () => {
  test('a unary request the recipient never answers rejects on the caller-supplied timeout', async () => {
    const hub = new FakeHub()
    const crypto = createFakeCrypto({ epoch: 1, localDID: 'a' })
    // A directed client aimed at a member with no acceptor at all: nothing NACKs, nothing answers,
    // so only the timeout can end the call. The shared path here opens nothing (no matching topic).
    const inbound: InboundPath = () => () => {}
    const { client, dispose } = createDirectedClient<typeof alpha>({
      mux: { mailbox: hub } as unknown as HubMux,
      localDID: 'a',
      memberDID: 'gone',
      sendTopicID: 'send',
      receiveTopicID: 'recv',
      inbound,
      wrap: crypto.wrap,
      protocol: 'alpha',
      requestTimeoutMs: 150,
    })

    const started = Date.now()
    await expect(client.request('ping', { param: {} })).rejects.toThrow()
    const elapsed = Date.now() - started
    // Honoured the override: well under the 30s default, and not instant.
    expect(elapsed).toBeGreaterThanOrEqual(100)
    expect(elapsed).toBeLessThan(2_000)

    await dispose()
  })
})
