import type { UserRole } from '@prisma/client'

/**
 * Deliberately in its own module, with no imports beyond a type.
 *
 * `lib/auth/guards.ts` pulls in Auth.js, which pulls in Next's server runtime.
 * Anything that merely needs to RECOGNISE a permission failure — the API error
 * envelope, a service, a test — would otherwise drag that whole stack in with
 * it, and fail outside a Next runtime.
 */
export class ForbiddenError extends Error {
  readonly code = 'FORBIDDEN'

  constructor(
    message: string,
    readonly required: UserRole,
    readonly actual: UserRole,
  ) {
    super(message)
    this.name = 'ForbiddenError'
  }
}
