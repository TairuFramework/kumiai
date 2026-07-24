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

  // The sweep is O(n) over every live bucket, but it only runs from the `buckets.size >= PRUNE_AT`
  // branch below — i.e. only on the cold path of a key NOT yet in the map, past the size gate —
  // so it never runs on the hot path of an existing key's tryConsume. Under a flood of distinct
  // keys it also evicts little per call (most buckets are freshly created, not yet idle past
  // `ttlMs`), so the map can still grow past PRUNE_AT; acknowledged, not restructured here.
  function prune(now: number): void {
    for (const [key, bucket] of buckets) {
      // Full-capacity AND idle past the TTL: carries no rate state, so dropping and re-creating it
      // on next use is identical. A partially-spent bucket is never dropped — that would refund a
      // caller their spent tokens.
      // Recompute fullness from elapsed time, do NOT read stored `tokens`: every tryConsume
      // decrements, so a resting bucket's stored tokens is always < burst — a stored-value
      // check would be inert and never prune. `refilledTokens` mirrors the hot-path refill,
      // so this is true exactly when the bucket would be legitimately full if touched now.
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
