export type RateLimitConfig = {
  /** Sustained refill rate in tokens per second. */
  rate: number
  /** Maximum bucket capacity (burst). */
  burst: number
  /** Idle full buckets older than this (ms) are evicted opportunistically. Default: 300_000. */
  ttlMs?: number
}

export type RateLimiter = {
  /** Consumes a token if available, returning true; returns false otherwise. */
  tryConsume(key: string): boolean
  /** Current number of live buckets. Introspection for tests and metrics. */
  size(): number
}

type Bucket = {
  tokens: number
  lastRefill: number
}

/** Threshold above which `tryConsume` sweeps for evictable buckets. */
const PRUNE_AT = 1024

/** Tokens a bucket would hold at `now` under continuous refill, capped at burst. */
function refilledTokens(bucket: Bucket, now: number, rate: number, burst: number): number {
  const elapsedSeconds = (now - bucket.lastRefill) / 1000
  return Math.min(burst, bucket.tokens + elapsedSeconds * rate)
}

/** Per-key token-bucket rate limiter. */
export function createRateLimiter(config: RateLimitConfig): RateLimiter {
  const buckets = new Map<string, Bucket>()
  const ttlMs = config.ttlMs ?? 300_000

  // O(n), but only from the cold path past the size gate below, never on the hot path.
  function prune(now: number): void {
    for (const [key, bucket] of buckets) {
      // Evict only full-and-idle buckets: recreating one on next use is identical, and a
      // partially-spent one must never be dropped (that refunds its spent tokens). Fullness is
      // recomputed from elapsed time, NOT read from stored `tokens` — every tryConsume decrements,
      // so stored tokens is always < burst at rest and a stored-value check would never prune.
      if (
        refilledTokens(bucket, now, config.rate, config.burst) >= config.burst &&
        now - bucket.lastRefill >= ttlMs
      ) {
        buckets.delete(key)
      }
    }
  }

  return {
    tryConsume(key: string): boolean {
      const now = Date.now()
      let bucket = buckets.get(key)
      if (bucket == null) {
        if (buckets.size >= PRUNE_AT) prune(now)
        bucket = { tokens: config.burst, lastRefill: now }
        buckets.set(key, bucket)
      } else {
        bucket.tokens = refilledTokens(bucket, now, config.rate, config.burst)
        bucket.lastRefill = now
      }
      if (bucket.tokens < 1) {
        return false
      }
      bucket.tokens -= 1
      return true
    },
    size(): number {
      return buckets.size
    },
  }
}
