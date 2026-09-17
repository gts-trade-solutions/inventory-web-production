import { z } from 'zod'
import { publicRoute } from '@/lib/api/handler'
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
export const POST = publicRoute({ schema }, async ({ body }) => {
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
