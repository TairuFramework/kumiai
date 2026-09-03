import { fromUTF } from '@sozai/codec'
import { describe, expect, test, vi } from 'vitest'

import { createInboxPath, type OpenedInbound } from '../src/directed.js'
import { encodeDirectedPayload } from '../src/directed-tag.js'
import type { HubMux, InboundListener } from '../src/hub-mux.js'

function fakeMux() {
  let handler: InboundListener | undefined
  return {
    onInbound(_topicID: string, cb: InboundListener) {
      handler = cb
      return () => {
        handler = undefined
      }
    },
    deliver(payload: Uint8Array) {
      handler?.({ sequenceID: '1', senderDID: 'did:key:alice', topicID: 't', payload }, () => {})
    },
  }
}

describe('createInboxPath tag decoding', () => {
  test('surfaces the protocol and strips the tag', async () => {
    const mux = fakeMux()
    const path = createInboxPath({
      mux: mux as unknown as HubMux,
      topicID: 't',
      unwrap: async (b: Uint8Array) => ({ payload: b, senderDID: 'did:key:alice' }),
    })
    const seen: Array<OpenedInbound> = []
    path((m) => seen.push(m))
    const inner = fromUTF(JSON.stringify({ v: 1, sessionID: 's', seq: 0, kind: 'message' }))
    mux.deliver(encodeDirectedPayload('chat', inner))
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0].protocol).toBe('chat')
    expect(seen[0].payload).toEqual(inner)
  })

  test('drops a legacy untagged frame', async () => {
    const mux = fakeMux()
    const path = createInboxPath({
      mux: mux as unknown as HubMux,
      topicID: 't',
      unwrap: async (b: Uint8Array) => ({ payload: b, senderDID: 'did:key:alice' }),
    })
    const seen: Array<OpenedInbound> = []
    path((m) => seen.push(m))
    mux.deliver(fromUTF(JSON.stringify({ v: 1, sessionID: 's', seq: 0, kind: 'message' })))
    await new Promise((r) => setTimeout(r, 10))
    expect(seen).toHaveLength(0)
  })
})
