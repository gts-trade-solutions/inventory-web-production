import { beforeEach, describe, expect, it } from 'vitest'
import { RULES, RateLimiter, addressOf, limiter, rateLimitHeaders } from './rate-limit'

/**
 * Rate limiting.
 *
 * The endpoint this exists for is sign-in: unthrottled, it is an offer to try
 * every password in a list. Everything else is throttled loosely, because a
 * limiter that refuses a phone pushing a shift's work is a limiter that loses
 * work — and that is a worse outcome than the one it prevents.
 */

let limits: RateLimiter

beforeEach(() => {
  limits = new RateLimiter()
})

const rule = { limit: 3, windowMs: 1_000 }

describe('counting', () => {
  it('allows up to the limit', () => {
    const now = 1_000_000

    expect(limits.check('a', rule, now).ok).toBe(true)
    expect(limits.check('a', rule, now).ok).toBe(true)
    expect(limits.check('a', rule, now).ok).toBe(true)
  })

  it('refuses the one after', () => {
    const now = 1_000_000
    for (let i = 0; i < 3; i++) limits.check('a', rule, now)

    expect(limits.check('a', rule, now).ok).toBe(false)
  })

  it('reports what is left', () => {
    const now = 1_000_000

    expect(limits.check('a', rule, now).remaining).toBe(2)
    expect(limits.check('a', rule, now).remaining).toBe(1)
    expect(limits.check('a', rule, now).remaining).toBe(0)
    // Never negative: a client reading this should see zero, not a countdown
    // into the negatives.
    expect(limits.check('a', rule, now).remaining).toBe(0)
  })

  it('says how long to wait', () => {
    const now = 1_000_000
    for (let i = 0; i < 4; i++) limits.check('a', rule, now)

    expect(limits.check('a', rule, now + 400).retryAfter).toBe(1)
  })

  it('starts again once the window passes', () => {
    const now = 1_000_000
    for (let i = 0; i < 4; i++) limits.check('a', rule, now)

    expect(limits.check('a', rule, now + 1_001).ok).toBe(true)
  })

  it('counts each key separately', () => {
    // One handset hitting its limit must not throttle the one beside it.
    const now = 1_000_000
    for (let i = 0; i < 4; i++) limits.check('phone-a', rule, now)

    expect(limits.check('phone-b', rule, now).ok).toBe(true)
  })
})

describe('not leaking memory', () => {
  it('drops buckets once their window has passed', () => {
    // Without this the map grows for the lifetime of the process, one entry per
    // address ever seen — a leak that only shows after weeks of uptime.
    const now = 1_000_000
    for (let i = 0; i < 50; i++) limits.check(`address-${i}`, rule, now)
    expect(limits.size).toBe(50)

    // The sweep runs at most once a minute, so this is the first call after it.
    limits.check('later', rule, now + 61_000)

    expect(limits.size).toBe(1)
  })

  it('does not sweep on every call', () => {
    const now = 1_000_000
    for (let i = 0; i < 10; i++) limits.check(`address-${i}`, rule, now + i)

    expect(limits.size).toBe(10)
  })
})

describe('the rules', () => {
  it('limits one account tightly and one address loosely', () => {
    // The per-account rule is what stops password guessing. The per-address one
    // has to let a whole shift arrive at once, because a warehouse shares a NAT
    // and a limiter that locks out the morning gets switched off.
    expect(RULES.signInPerAccount.limit).toBeLessThan(RULES.signInPerAddress.limit)
    expect(RULES.signInPerAddress.limit).toBeGreaterThanOrEqual(100)
  })

  it('are tight on sign-in and loose on everything else', () => {
    // Sign-in is the one worth attacking. Sync is not, and a phone coming back
    // from a shift offline legitimately pushes hard.
    expect(RULES.signInPerAccount.limit).toBeLessThan(RULES.standard.limit)
    expect(RULES.standard.limit).toBeGreaterThanOrEqual(600)
  })

  it('allow a fat-fingered morning', () => {
    // Somebody mistyping a password four times must not be locked out.
    expect(RULES.signInPerAccount.limit).toBeGreaterThanOrEqual(5)
  })
})

describe('addressOf', () => {
  it('reads the forwarded header behind a proxy', () => {
    const request = new Request('https://example.test', {
      headers: { 'x-forwarded-for': '203.0.113.9' },
    })

    expect(addressOf(request)).toBe('203.0.113.9')
  })

  it('takes only the first entry', () => {
    // Everything after the first is supplied by the client and can say
    // anything, so trusting the last would let a caller pick its own bucket.
    const request = new Request('https://example.test', {
      headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1, 127.0.0.1' },
    })

    expect(addressOf(request)).toBe('203.0.113.9')
  })

  it('falls back to a real-ip header', () => {
    const request = new Request('https://example.test', {
      headers: { 'x-real-ip': '198.51.100.4' },
    })

    expect(addressOf(request)).toBe('198.51.100.4')
  })

  it('has a value even when nothing is known', () => {
    // All unknown callers share one bucket, which is the safe direction: it
    // throttles harder, not less.
    expect(addressOf(new Request('https://example.test'))).toBe('unknown')
  })
})

describe('headers', () => {
  it('tells a client its allowance', () => {
    const headers = rateLimitHeaders({ ok: true, limit: 10, remaining: 7, retryAfter: 0 })

    expect(headers['RateLimit-Limit']).toBe('10')
    expect(headers['RateLimit-Remaining']).toBe('7')
  })

  it('adds Retry-After only on a refusal', () => {
    expect(rateLimitHeaders({ ok: true, limit: 10, remaining: 7, retryAfter: 0 })).not.toHaveProperty(
      'Retry-After',
    )
    expect(rateLimitHeaders({ ok: false, limit: 10, remaining: 0, retryAfter: 42 })['Retry-After']).toBe(
      '42',
    )
  })
})

describe('the shared limiter', () => {
  it('is one instance per process, in every environment', () => {
    // A production build instantiates a shared module once per bundle, so a
    // limiter in a module-level const gives route handlers and Server Actions
    // separate counts. That exact mistake silently broke the event bus, and
    // here it would silently double the limit.
    const stashed = (globalThis as unknown as { __rateLimiter?: RateLimiter }).__rateLimiter

    expect(stashed).toBe(limiter)
  })
})
