import { z } from 'zod'
import { publicRoute } from '@/lib/api/handler'
import { refreshTokens } from '@/lib/services/auth-tokens'
import { dbFor, parseMode } from '@/lib/mode'

const schema = z.object({
  refreshToken: z.string().min(16).max(512),
  // The mode the token was issued for. It selects the database the token is
  // stored in, so a DEMO token simply is not found when presented as LIVE.
  mode: z.enum(['LIVE', 'DEMO']).optional(),
})

export const POST = publicRoute({ schema }, async ({ body }) => {
  const mode = parseMode(body.mode)
  return refreshTokens(dbFor(mode), body.refreshToken, mode)
})
