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

/** Per-key token-bucket rate limiter. */
export function createRateLimiter(config: RateLimitConfig): RateLimiter {
  const buckets = new Map<string, Bucket>()
  const ttlMs = config.ttlMs ?? 300_000

  function prune(now: number): void {
    for (const [key, bucket] of buckets) {
      // Full-capacity AND idle past the TTL: carries no rate state, so dropping and re-creating it
      // on next use is identical. A partially-spent bucket is never dropped — that would refund a
      // caller their spent tokens.
      const elapsedSeconds = (now - bucket.lastRefill) / 1000
      const refilled = Math.min(config.burst, bucket.tokens + elapsedSeconds * config.rate)
      if (refilled >= config.burst && now - bucket.lastRefill >= ttlMs) {
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
        const elapsedSeconds = (now - bucket.lastRefill) / 1000
        bucket.tokens = Math.min(config.burst, bucket.tokens + elapsedSeconds * config.rate)
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
