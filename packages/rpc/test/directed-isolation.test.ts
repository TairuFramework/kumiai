import type { ProtocolDefinition } from '@enkaku/protocol'
import { describe, expect, test } from 'vitest'

import { createGroupPeer } from '../src/peer.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'

const flush = () => new Promise((r) => setTimeout(r, 30))

// Same-named procedure on both protocols, on purpose: the tag — not the procedure name — is what
// must keep a directed call from reaching the wrong protocol's handler.
const alpha = {
  ping: { type: 'request', param: { type: 'object' }, result: { type: 'object' } },
} as const satisfies ProtocolDefinition

const beta = {
  ping: { type: 'request', param: { type: 'object' }, result: { type: 'object' } },
} as const satisfies ProtocolDefinition

type Protocols = { alpha: typeof alpha; beta: typeof beta }

function makePeer(
  hub: FakeHub,
  localDID: string,
  handlers: Partial<Record<'alpha' | 'beta', Record<string, unknown>>>,
) {
  const crypto = createFakeCrypto({ epoch: 1, localDID })
  return createGroupPeer<Protocols>({
    hub,
    crypto,
    localDID,
    protocols: { alpha, beta },
    handlers: { alpha: handlers.alpha ?? {}, beta: handlers.beta ?? {} } as never,
  })
}

describe('directed frames route to only the addressed protocol', () => {
  test('a call on alpha runs only alpha’s handler, and the caller sees only alpha’s reply', async () => {
    const hub = new FakeHub()
    const counts = { alpha: 0, beta: 0 }
    const a = makePeer(hub, 'a', {})
    const b = makePeer(hub, 'b', {
      alpha: {
        ping: () => {
          counts.alpha++
          return { from: 'alpha' }
        },
      },
      beta: {
        ping: () => {
          counts.beta++
          return { from: 'beta' }
        },
      },
    })
    await flush()

    const client = await a.protocol('alpha').to('b')
    const result = await client.request('ping', { param: {} })

    expect(result).toEqual({ from: 'alpha' })
    expect(counts.alpha).toBe(1)
    expect(counts.beta).toBe(0)

    await a.dispose()
    await b.dispose()
  })

  test('two clients from the same caller to the same member each get only their own protocol’s reply', async () => {
    const hub = new FakeHub()
    const counts = { alpha: 0, beta: 0 }
    const a = makePeer(hub, 'a', {})
    const b = makePeer(hub, 'b', {
      alpha: {
        ping: () => {
          counts.alpha++
          return { from: 'alpha' }
        },
      },
      beta: {
        ping: () => {
          counts.beta++
          return { from: 'beta' }
        },
      },
    })
    await flush()

    const alphaClient = await a.protocol('alpha').to('b')
    const betaClient = await a.protocol('beta').to('b')
    const [alphaResult, betaResult] = await Promise.all([
      alphaClient.request('ping', { param: {} }),
      betaClient.request('ping', { param: {} }),
    ])

    expect(alphaResult).toEqual({ from: 'alpha' })
    expect(betaResult).toEqual({ from: 'beta' })
    expect(counts.alpha).toBe(1)
    expect(counts.beta).toBe(1)

    await a.dispose()
    await b.dispose()
  })
})
