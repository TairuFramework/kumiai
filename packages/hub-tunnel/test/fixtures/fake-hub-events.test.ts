import { describe, expect, test } from 'vitest'

import { FakeHub } from './fake-hub.js'

describe('FakeHub events', () => {
  test('emits status transitions to on("status") listeners', () => {
    const hub = new FakeHub()
    const seen: Array<string> = []
    const off = hub.events.on('status', (event) => {
      seen.push(event.type)
    })
    hub.simulateReconnecting()
    hub.simulateConnected()
    hub.simulateDisconnected()
    off()
    hub.simulateConnected() // after off(): not observed
    expect(seen).toEqual(['reconnecting', 'connected', 'disconnected'])
  })
})
