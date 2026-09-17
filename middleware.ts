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
    // Everything except Next internals, static files and the auth endpoints
    // themselves.
    '/((?!api/auth|_next/static|_next/image|favicon.ico|.*\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
}
