import { expect, test, vi } from 'vitest'

import { createHubMux } from '../src/hub-mux.js'
import { FakeHub } from './fixtures/fake-hub.js'

const flush = () => new Promise((resolve) => setTimeout(resolve, 10))

test('gated retain resumes exactly once with its original options', async () => {
  const hub = new FakeHub()
  const subscribe = vi.spyOn(hub, 'subscribe')
  let allowed = false
  const mux = createHubMux({ hub, localDID: 'reader', networkAllowed: () => allowed })
  try {
    mux.retainTopic('deferred', { retention: 604800 })
    mux.resume()
    expect(subscribe).not.toHaveBeenCalled()
    allowed = true
    mux.resume()
    mux.resume()
    await flush()
    const subscribeCallsAfterClear = subscribe.mock.calls.length
    expect(subscribeCallsAfterClear).toBe(1)
    expect(hub.requestedRetention('deferred')).toBe(604800)
  } finally {
    await mux.dispose()
  }
})

test('deferred holder released before clear never subscribes', async () => {
  const hub = new FakeHub()
  const subscribe = vi.spyOn(hub, 'subscribe')
  let allowed = false
  const mux = createHubMux({ hub, localDID: 'reader', networkAllowed: () => allowed })
  const release = mux.onInbound('released', () => {})
  release()
  allowed = true
  mux.resume()
  await flush()
  const subscribeCallsForReleasedHolder = subscribe.mock.calls.length
  expect(subscribeCallsForReleasedHolder).toBe(0)
  await mux.dispose()
  mux.resume()
  expect(subscribe).not.toHaveBeenCalled()
})

test('clear during pending subscribe retains exactly one holder', async () => {
  const hub = new FakeHub()
  let reject: (error: Error) => void = () => {
    throw new Error('No subscribe pending')
  }
  const subscribe = vi.spyOn(hub, 'subscribe').mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail
      }),
  )
  let allowed = true
  const mux = createHubMux({
    hub,
    localDID: 'reader',
    networkAllowed: () => allowed,
    subscribeRetryDelaysMs: [0],
  })
  try {
    const release = mux.onInbound('pending', () => {})
    allowed = false
    reject(new Error('Disconnected'))
    await flush()
    allowed = true
    mux.resume()
    mux.rearmRefusedTopics()
    await flush()
    expect(subscribe).toHaveBeenCalledTimes(2)
    release()
    mux.resume()
    expect(subscribe).toHaveBeenCalledTimes(2)
  } finally {
    await mux.dispose()
  }
})

test.each([
  { failure: 'retryable', retryDelaysMs: [0] },
  { failure: 'exhausted', retryDelaysMs: [] },
])(
  'replacement demand keeps its options after a released pending subscribe fails ($failure)',
  async ({ retryDelaysMs }) => {
    const hub = new FakeHub()
    let reject: (error: Error) => void = () => {
      throw new Error('No subscribe pending')
    }
    const subscribe = vi.spyOn(hub, 'subscribe').mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail
        }),
    )
    let allowed = true
    const mux = createHubMux({
      hub,
      localDID: 'reader',
      networkAllowed: () => allowed,
      subscribeRetryDelaysMs: retryDelaysMs,
    })
    try {
      const release = mux.onInbound('replacement', () => {}, { retention: 123 })
      release()
      allowed = false
      const releaseReplacement = mux.onInbound('replacement', () => {}, { retention: 456 })
      mux.resume()
      expect(subscribe).toHaveBeenCalledTimes(1)
      reject(new Error('Disconnected'))
      await flush()
      expect(subscribe).toHaveBeenCalledTimes(1)
      allowed = true
      mux.resume()
      mux.resume()
      await flush()
      expect(subscribe.mock.calls.map((call) => call[2]?.retention)).toEqual([123, 456])
      expect(hub.requestedRetention('replacement')).toBe(456)
      releaseReplacement()
      mux.rearmRefusedTopics()
      mux.resume()
      expect(subscribe).toHaveBeenCalledTimes(2)
    } finally {
      await mux.dispose()
    }
  },
)

test('replacement demand keeps its options across an existing retry backoff', async () => {
  vi.useFakeTimers()
  const hub = new FakeHub()
  const subscribe = vi.spyOn(hub, 'subscribe').mockRejectedValueOnce(new Error('Disconnected'))
  let allowed = true
  const mux = createHubMux({
    hub,
    localDID: 'reader',
    networkAllowed: () => allowed,
    subscribeRetryDelaysMs: [100],
  })
  try {
    const release = mux.onInbound('backoff', () => {}, { retention: 123 })
    await vi.advanceTimersByTimeAsync(0)
    release()
    allowed = false
    const releaseReplacement = mux.onInbound('backoff', () => {}, { retention: 456 })
    await vi.advanceTimersByTimeAsync(100)
    expect(subscribe).toHaveBeenCalledTimes(1)
    allowed = true
    mux.resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(subscribe.mock.calls.map((call) => call[2]?.retention)).toEqual([123, 456])
    expect(hub.requestedRetention('backoff')).toBe(456)
    releaseReplacement()
  } finally {
    await mux.dispose()
    vi.useRealTimers()
  }
})

test('receive pauses while held and resumes retained delivery', async () => {
  const hub = new FakeHub()
  let allowed = true
  const mux = createHubMux({ hub, localDID: 'reader', networkAllowed: () => allowed })
  const got: Array<number> = []
  mux.onInbound('messages', (message, ack) => {
    got.push(message.payload[0] ?? 0)
    ack()
  })
  try {
    await flush()
    allowed = false
    await hub.publish({ senderDID: 'sender', topicID: 'messages', payload: new Uint8Array([1]) })
    await flush()
    expect(got).toEqual([])
    allowed = true
    mux.resume()
    await flush()
    expect(got).toEqual([1])
  } finally {
    await mux.dispose()
  }
})

test('gated late listener waits for release before receiving unmatched mail', async () => {
  const hub = new FakeHub()
  let allowed = true
  const mux = createHubMux({ hub, localDID: 'reader', networkAllowed: () => allowed })
  mux.retainTopic('late')
  const got: Array<number> = []
  try {
    await hub.publish({ senderDID: 'sender', topicID: 'late', payload: new Uint8Array([2]) })
    await flush()
    allowed = false
    mux.onInbound('late', (message, ack) => {
      got.push(message.payload[0] ?? 0)
      ack()
    })
    expect(got).toEqual([])
    allowed = true
    mux.resume()
    expect(got).toEqual([2])
  } finally {
    await mux.dispose()
  }
})

test('a fresh deferred holder keeps its own options after the last holder releases', async () => {
  const hub = new FakeHub()
  let allowed = false
  const mux = createHubMux({ hub, localDID: 'reader', networkAllowed: () => allowed })
  const release = mux.onInbound('fresh', () => {}, { retention: 123 })
  release()
  const releaseFresh = mux.onInbound('fresh', () => {}, { retention: 456 })
  allowed = true
  mux.resume()
  await flush()
  expect(hub.requestedRetention('fresh')).toBe(456)
  releaseFresh()
  await mux.dispose()
})

test('resume visits each deferred subscription once if the gate closes during subscribe', async () => {
  const hub = new FakeHub()
  let allowed = false
  let reopenAfterCheck = false
  const mux = createHubMux({
    hub,
    localDID: 'reader',
    networkAllowed: () => {
      const current = allowed
      if (!current && reopenAfterCheck) {
        allowed = true
        reopenAfterCheck = false
      }
      return current
    },
  })
  mux.retainTopic('first')
  mux.retainTopic('second')
  const original = hub.subscribe.bind(hub)
  const subscribe = vi.spyOn(hub, 'subscribe').mockImplementationOnce((...args) => {
    allowed = false
    reopenAfterCheck = true
    return original(...args)
  })
  try {
    allowed = true
    mux.resume()
    expect(subscribe).toHaveBeenCalledTimes(1)
    mux.resume()
    expect(subscribe).toHaveBeenCalledTimes(2)
  } finally {
    await mux.dispose()
  }
})

test('released in-flight holder never retries a failed subscribe', async () => {
  const hub = new FakeHub()
  const subscribe = vi.spyOn(hub, 'subscribe').mockRejectedValueOnce(new Error('Disconnected'))
  const mux = createHubMux({ hub, localDID: 'reader', subscribeRetryDelaysMs: [1] })
  try {
    const release = mux.onInbound('released-pending', () => {})
    release()
    await flush()
    mux.rearmRefusedTopics()
    mux.resume()
    await flush()
    expect(subscribe).toHaveBeenCalledTimes(1)
  } finally {
    await mux.dispose()
  }
})
