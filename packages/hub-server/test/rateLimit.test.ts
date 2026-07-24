import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { createRateLimiter } from '../src/rateLimit.js'

describe('createRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test('allows up to burst then rejects', () => {
    const limiter = createRateLimiter({ rate: 1, burst: 3 })
    expect(limiter.tryConsume('a')).toBe(true)
    expect(limiter.tryConsume('a')).toBe(true)
    expect(limiter.tryConsume('a')).toBe(true)
    expect(limiter.tryConsume('a')).toBe(false)
  })

  test('refills over time at the configured rate', () => {
    const limiter = createRateLimiter({ rate: 2, burst: 2 })
    expect(limiter.tryConsume('a')).toBe(true)
    expect(limiter.tryConsume('a')).toBe(true)
    expect(limiter.tryConsume('a')).toBe(false)
    // After 1s, rate=2 refills 2 tokens (capped at burst).
    vi.advanceTimersByTime(1000)
    expect(limiter.tryConsume('a')).toBe(true)
    expect(limiter.tryConsume('a')).toBe(true)
    expect(limiter.tryConsume('a')).toBe(false)
  })

  test('keys are independent', () => {
    const limiter = createRateLimiter({ rate: 1, burst: 1 })
    expect(limiter.tryConsume('a')).toBe(true)
    expect(limiter.tryConsume('a')).toBe(false)
    expect(limiter.tryConsume('b')).toBe(true)
  })

  test('evicts idle full buckets past the TTL, keeps buckets with spent tokens', () => {
    const limiter = createRateLimiter({ rate: 1, burst: 2, ttlMs: 1000 }) as ReturnType<
      typeof createRateLimiter
    > & { size(): number }

    // 1025 distinct idle keys: each consumes once then refills to full within the TTL window is
    // NOT what we want — consume once leaves them below burst, so they are NOT idle. Instead we
    // want full buckets: create them, then let them refill to full before the prune fires.
    for (let i = 0; i < 1025; i++) limiter.tryConsume(`k${i}`)
    // Every bucket now has burst-1 tokens (spent one). Refill them to full.
    vi.advanceTimersByTime(2000)
    // A touch on a fresh key past the threshold triggers the prune; the 1025 full+expired buckets go.
    limiter.tryConsume('trigger')
    expect(limiter.size()).toBeLessThan(1025)

    // A bucket with spent tokens (not full) is never evicted even if old.
    const l2 = createRateLimiter({ rate: 1, burst: 3, ttlMs: 1000 }) as ReturnType<
      typeof createRateLimiter
    > & { size(): number }
    for (let i = 0; i < 1025; i++) l2.tryConsume(`k${i}`) // each now at 2 tokens (spent 1)
    vi.advanceTimersByTime(500) // +0.5 token, still below burst=3, still non-idle
    l2.tryConsume('trigger')
    expect(l2.size()).toBe(1026) // nothing pruned: none are full
  })

  test('preserves a spent bucket that is idle past the TTL but has not refilled to full', () => {
    const limiter = createRateLimiter({ rate: 0.001, burst: 10, ttlMs: 1000 }) as ReturnType<
      typeof createRateLimiter
    > & { size(): number }
    // 1025 keys each spend 1 token -> each at 9 tokens, well below burst=10.
    for (let i = 0; i < 1025; i++) limiter.tryConsume(`k${i}`)
    // Idle far past ttlMs. At rate 0.001/s, refill in 5s is 0.005 tokens -> still ~9, < burst.
    vi.advanceTimersByTime(5000)
    // Trigger the prune via a fresh cold-path key past the threshold.
    limiter.tryConsume('trigger')
    // None of the spent buckets may be evicted: they are idle-past-TTL but NOT full.
    expect(limiter.size()).toBe(1026)
  })
})
