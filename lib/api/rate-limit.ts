/**
 * Rate limiting for `/api/v1`.
 *
 * The endpoint that needs it is `/auth/token`: unthrottled, it is an offer to
 * try every password in a list. The rest need it much less, and throttling them
 * hard would be worse than not throttling them at all — a warehouse pushing a
 * shift's work should never be told to come back later.
 *
 * **Keyed by identity, not by address, wherever an identity exists.** A
 * warehouse sits behind one NAT, so every handset shares an IP. Limiting
 * authenticated traffic by IP would mean one chatty phone throttling everybody
 * on the floor — which looks exactly like the network being down, and is the
 * kind of thing that gets a system switched off.
 *
 * IN-PROCESS ONLY, like the event bus, and for the same reason: one server is
 * the deployment we have. Behind two instances each would keep its own counts
 * and the effective limit would double. Moving to a shared store means
 * replacing this file. Said out loud because a rate limiter everybody believes
 * is stricter than it is provides false comfort.
 */

export interface RateLimitRule {
  /** Requests allowed per window. */
  limit: number
  windowMs: number
}

export interface RateLimitResult {
  ok: boolean
  limit: number
  remaining: number
  /** Seconds until the window resets. Sent as Retry-After on a refusal. */
  retryAfter: number
}

interface Bucket {
  count: number
  resetAt: number
}

/**
 * A fixed window rather than a sliding one.
 *
 * A sliding window is fairer at the boundary; a fixed one is a counter and a
 * timestamp. For stopping a password-guessing script the difference does not
 * matter, and the simpler thing is the one that stays correct.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private lastSweep = 0

  check(key: string, rule: RateLimitRule, now: number = Date.now()): RateLimitResult {
    this.sweep(now)

    const bucket = this.buckets.get(key)

    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + rule.windowMs })
      return { ok: true, limit: rule.limit, remaining: rule.limit - 1, retryAfter: 0 }
    }

    bucket.count++

    const remaining = Math.max(rule.limit - bucket.count, 0)
    const retryAfter = Math.ceil((bucket.resetAt - now) / 1000)

    return { ok: bucket.count <= rule.limit, limit: rule.limit, remaining, retryAfter }
  }

  /**
   * Drops expired buckets.
   *
   * Without this the map grows for the lifetime of the process, one entry per
   * address ever seen — a slow leak that only shows up after weeks of uptime,
   * which is the worst kind to diagnose. Swept lazily, at most once a minute,
   * so the cost lands on a request that was already doing work.
   */
  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return
    this.lastSweep = now

    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key)
    }
  }

  /** Test seam, and the reset an administrator would want after a lockout. */
  clear(key?: string): void {
    if (key) this.buckets.delete(key)
    else this.buckets.clear()
  }

  get size(): number {
    return this.buckets.size
  }
}

/**
 * One limiter per process, in every environment.
 *
 * Stashed on globalThis deliberately: a production build instantiates a shared
 * module once per bundle, so a limiter held in a module-level `const` would
 * give route handlers and Server Actions separate counts. That exact mistake
 * silently broke the event bus, and it would silently halve this.
 */
const globalForLimits = globalThis as unknown as { __rateLimiter?: RateLimiter }

export const limiter: RateLimiter = globalForLimits.__rateLimiter ?? new RateLimiter()
globalForLimits.__rateLimiter = limiter

/**
 * The rules.
 *
 * Sign-in is tight because it is the one worth attacking. Sync is loose because
 * a phone coming back from a shift offline legitimately pushes hard, and a
 * limiter that refuses that is a limiter that loses work.
 */
export const RULES = {
  /**
   * Sign-in attempts against ONE ACCOUNT from one address.
   *
   * This is the rule that stops password guessing: an attacker working through
   * a list hits it on the eleventh try against any single account.
   *
   * Enough for a fat-fingered morning, and — because it is per account — it
   * cannot be tripped by somebody else. That matters more than it looks: a
   * warehouse sits behind one NAT, so a per-address sign-in limit of ten would
   * mean the eleventh person arriving for a shift is refused because ten
   * colleagues signed in before them. A limiter that locks out the morning
   * shift gets switched off, and then there is no limiter at all.
   */
  signInPerAccount: { limit: 10, windowMs: 60_000 },
  /**
   * All sign-in attempts from one address, whatever account they name.
   *
   * Loose enough for a whole shift to arrive at once, tight enough that a
   * script spraying one password across many accounts still runs into it.
   */
  signInPerAddress: { limit: 120, windowMs: 60_000 },
  /** Token refresh, per device. Should happen about four times an hour. */
  refresh: { limit: 60, windowMs: 60_000 },
  /** Everything else, per user or device. Deliberately generous. */
  standard: { limit: 600, windowMs: 60_000 },
} as const

/**
 * The address a request came from, as well as it can be known.
 *
 * Behind a proxy the socket address is the proxy, so the forwarded header is
 * used when present — and only its FIRST entry, because everything after it is
 * supplied by the client and can say anything.
 */
export function addressOf(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0]!.trim()

  return request.headers.get('x-real-ip')?.trim() || 'unknown'
}

/** The headers a client needs to back off politely. */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'RateLimit-Limit': String(result.limit),
    'RateLimit-Remaining': String(result.remaining),
    ...(result.ok ? {} : { 'Retry-After': String(result.retryAfter) }),
  }
}
