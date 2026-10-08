import { randomIdentity } from '@kokuin/token'
import type * as HubServerModule from '@kumiai/hub-server'
import { createHub } from '@kumiai/hub-server'
import type * as HTTPServerModule from '@sozai/http-server'
import { createServer, definePlugin, pluginName } from '@sozai/http-server'
import { hozonDBPlugin } from '@teikyo/hozon'
import { afterEach, expect, test, vi } from 'vitest'

import { hubPlugin } from '../src/plugin.js'
import { createHubServer } from '../src/server.js'

// Keep real factories, with spies for boundary assertions and disposal fault injection.
vi.mock('@kumiai/hub-server', async (importOriginal) => {
  const actual = await importOriginal<typeof HubServerModule>()
  return { ...actual, createHub: vi.fn(actual.createHub) }
})
vi.mock('@sozai/http-server', async (importOriginal) => {
  const actual = await importOriginal<typeof HTTPServerModule>()
  return { ...actual, createServer: vi.fn(actual.createServer) }
})

afterEach(() => {
  vi.clearAllMocks()
})

test('handles hub disposal rejection during shutdown and reports it at close', async () => {
  const actual = await vi.importActual<typeof HubServerModule>('@kumiai/hub-server')
  const failure = new Error('hub disposal failed')
  vi.mocked(createHub).mockImplementationOnce((params) => {
    const hub = actual.createHub(params)
    const dispose = hub.dispose
    hub.dispose = async () => {
      await dispose()
      throw failure
    }
    return hub
  })
  const unhandled: Array<unknown> = []
  const listener = (reason: unknown) => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', listener)
  const drain = definePlugin({
    name: pluginName<void>()('test:drain'),
    setup(ctx) {
      ctx.onShutdown(async () => {
        // Keep the shutdown phase open past Node's unhandled-rejection checkpoint.
        await new Promise<void>((resolve) => setImmediate(resolve))
        await new Promise<void>((resolve) => setImmediate(resolve))
      })
    },
  })
  const server = await createServer({
    plugins: [hozonDBPlugin({ db: ':memory:' }), hubPlugin({ identity: randomIdentity() }), drain],
  })
  try {
    await server.dispose()
    expect(unhandled).toEqual([])
    expect(server.shutdownReport?.hooks).toContainEqual({
      plugin: 'kumiai:hub',
      phase: 'close',
      outcome: 'failed',
    })
  } finally {
    await server.dispose()
    process.off('unhandledRejection', listener)
  }
})

test('keeps HTTP server and hub options at their own factory boundaries', async () => {
  const identity = randomIdentity()
  const signal = new AbortController().signal
  const server = await createHubServer({
    db: ':memory:',
    rateLimit: false,
    identity,
    path: '/custom',
    purge: false,
    port: 0,
    hostname: '127.0.0.1',
    graceMs: 1234,
    closeHookTimeoutMs: 2345,
    trustProxy: false,
    health: { readyPath: '/ready' },
    signal,
    limits: { bodyBytes: 1000, requestTimeoutMs: 2000, cleanupTimeoutMs: 3000 },
  })
  try {
    const httpParams = vi.mocked(createServer).mock.calls[0]?.[0]
    expect(httpParams).toMatchObject({
      port: 0,
      hostname: '127.0.0.1',
      graceMs: 1234,
      closeHookTimeoutMs: 2345,
      trustProxy: false,
      health: { readyPath: '/ready' },
      signal,
    })
    expect(httpParams?.limits).toEqual({ bodyBytes: 1000, requestTimeoutMs: 2000 })
    for (const key of [
      'identity',
      'path',
      'purge',
      'db',
      'rateLimit',
      'access',
      'store',
      'transport',
    ]) {
      expect(httpParams).not.toHaveProperty(key)
    }
    const hubParams = vi.mocked(createHub).mock.calls[0]?.[0]
    expect(hubParams).toMatchObject({ identity, purge: false })
    expect(hubParams?.limits).toEqual({ cleanupTimeoutMs: 3000 })
    for (const key of [
      'db',
      'rateLimit',
      'port',
      'hostname',
      'graceMs',
      'closeHookTimeoutMs',
      'trustProxy',
      'health',
      'signal',
      'logger',
      'tracer',
      'plugins',
    ]) {
      expect(hubParams).not.toHaveProperty(key)
    }
  } finally {
    await server.dispose()
  }
})
