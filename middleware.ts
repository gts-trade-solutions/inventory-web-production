import NextAuth from 'next-auth'
import { authConfig } from '@/auth.config'

/**
 * Route gating at the edge, before a page renders.
 *
 * Uses the edge-safe config only — it has no Credentials provider, so no Prisma
 * and no bcrypt reach the Edge runtime. Middleware decides "is there a valid
 * session?"; role and site checks happen server-side in lib/auth/guards.ts,
 * where the database is available.
 */
export const { auth: middleware } = NextAuth(authConfig)

export default middleware

export const config = {
  matcher: [
    /**
     * Everything except Next internals, static files, and BOTH api trees.
     *
     * `/api/v1` is excluded deliberately. It authenticates with a device-bound
     * bearer token, not a session cookie, and this middleware redirects an
     * unauthenticated request to /login — so an API call landed on the login
     * page and came back as 200 with HTML. A client would read that as success.
     * The API does its own auth in lib/api/handler.ts.
     */
    '/((?!api/auth|api/v1|_next/static|_next/image|favicon.ico|.*\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
}
