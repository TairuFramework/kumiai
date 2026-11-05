import type { StoredMessage } from '@kumiai/hub-protocol'
import { describe, expect, test, vi } from 'vitest'

import { HubClientRegistry } from '../src/registry.js'

const DID = 'did:key:alice'

function noopWriter(_message: StoredMessage): void {}
function noopEnd(): void {}

describe('HubClientRegistry', () => {
  test('register is idempotent', () => {
    const registry = new HubClientRegistry()
    const first = registry.register(DID)
    const second = registry.register(DID)
    expect(first).toBe(second)
    expect(first.sendMessage).toBeNull()
  })

  test('bindReceiveWriter binds, and hands back the writer it displaced', () => {
    const registry = new HubClientRegistry()
    registry.register(DID)
    const endFirst = vi.fn()
    const first = registry.bindReceiveWriter({ did: DID, writer: noopWriter, endReceive: endFirst })
    expect(first.evicted).toBeNull()
    expect(registry.isWriterBound(DID)).toBe(true)
    expect(registry.isOnline(DID)).toBe(true)

    // The second bind takes the lane. Ending the first is the caller's to do — the registry
    // hands the callback back rather than closing a stream itself.
    const second = registry.bindReceiveWriter({ did: DID, writer: noopWriter, endReceive: noopEnd })
    expect(second.evicted).toBe(endFirst)
    expect(endFirst).not.toHaveBeenCalled()
    expect(registry.isWriterBound(DID)).toBe(true)
  })

  test('releasing an evicted token does not unbind its successor', () => {
    const registry = new HubClientRegistry()
    registry.register(DID)
    const first = registry.bindReceiveWriter({ did: DID, writer: noopWriter, endReceive: noopEnd })
    const live = vi.fn()
    registry.bindReceiveWriter({ did: DID, writer: live, endReceive: noopEnd })

    // The evicted channel runs its own cleanup afterwards, not knowing why it ended. It must not
    // take the live binding down with it — that would leave the DID online with nothing behind
    // it, which is the silent-deafness this whole rule exists to prevent.
    registry.releaseReceiveWriter({ did: DID, token: first.token })
    expect(registry.isWriterBound(DID)).toBe(true)

    const message: StoredMessage = {
      sequenceID: '1',
      senderDID: 'did:key:bob',
      topicID: 'topic:1',
      payload: new Uint8Array([1]),
    }
    registry.getClient(DID)?.sendMessage?.(message)
    expect(live).toHaveBeenCalledWith(message)
  })

  test('releaseReceiveWriter unbinds the current token', () => {
    const registry = new HubClientRegistry()
    registry.register(DID)
    const { token } = registry.bindReceiveWriter({
      did: DID,
      writer: noopWriter,
      endReceive: noopEnd,
    })
    registry.releaseReceiveWriter({ did: DID, token })
    expect(registry.isWriterBound(DID)).toBe(false)
  })

  test('unregisterIfIdle removes only when no writer is bound', () => {
    const registry = new HubClientRegistry()
    registry.register(DID)
    const { token } = registry.bindReceiveWriter({
      did: DID,
      writer: noopWriter,
      endReceive: noopEnd,
    })
    registry.unregisterIfIdle(DID)
    expect(registry.getClient(DID)).toBeDefined()
    registry.releaseReceiveWriter({ did: DID, token })
    registry.unregisterIfIdle(DID)
    expect(registry.getClient(DID)).toBeUndefined()
  })

  test('getClient exposes the bound writer', () => {
    const registry = new HubClientRegistry()
    registry.register(DID)
    const writer = vi.fn()
    registry.bindReceiveWriter({ did: DID, writer, endReceive: noopEnd })
    const message: StoredMessage = {
      sequenceID: '1',
      senderDID: 'did:key:bob',
      topicID: 'topic:1',
      payload: new Uint8Array([1]),
    }
    registry.getClient(DID)?.sendMessage?.(message)
    expect(writer).toHaveBeenCalledWith(message)
  })
})
