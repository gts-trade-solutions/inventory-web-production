import { z } from 'zod'
import { publicRoute } from '@/lib/api/handler'
import { RULES, addressOf, limiter } from '@/lib/api/rate-limit'
import { issueTokens } from '@/lib/services/auth-tokens'
import { dbFor, isDemoModeEnabled, parseMode } from '@/lib/mode'
import { ApiError, ErrorCode } from '@/lib/api/errors'

const schema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
  mode: z.enum(['LIVE', 'DEMO']).optional(),
  device: z
    .object({
      id: z.string().uuid().optional(),
      label: z.string().max(120).optional(),
      platform: z.string().max(40).optional(),
      appVersion: z.string().max(40).optional(),
      osVersion: z.string().max(40).optional(),
    })
    .optional(),
})

/**
 * Exchanges credentials for a device-bound token pair.
 *
 * The mode chosen here is baked into the signed token and cannot be changed
 * afterwards; switching means signing in again (WADR-024).
 */
export const POST = publicRoute({ schema }, async ({ body, request }) => {
  /**
   * Per ACCOUNT as well as per address.
   *
   * The wrapper's per-address limit is loose, because a warehouse shares one
   * NAT and a shift arriving together must not lock each other out. This is the
   * rule that actually stops password guessing: an attacker working a list is
   * refused on the eleventh try against any one account.
   *
   * Applied here rather than in the wrapper because only this route knows which
   * account is being named.
   */
  const attempt = limiter.check(
    `signin:${addressOf(request)}:${body.email.trim().toLowerCase()}`,
    RULES.signInPerAccount,
  )
  if (!attempt.ok) {
    // Deliberately the same shape of answer as a wrong password. A throttle
    // that fires only for accounts that exist is an account oracle.
    throw new ApiError(
      ErrorCode.RATE_LIMITED,
      `Too many sign-in attempts for that account. Try again in ${attempt.retryAfter} seconds.`,
    )
  }

  if (body.mode === 'DEMO' && !isDemoModeEnabled()) {
    throw new ApiError(ErrorCode.FORBIDDEN, 'Demo mode is not enabled on this deployment.')
  }

  const mode = parseMode(body.mode)
  const pair = await issueTokens(
    dbFor(mode),
    { email: body.email, password: body.password },
    body.device,
    mode,
  )

  return { ...pair, demoAvailable: isDemoModeEnabled() }
})
