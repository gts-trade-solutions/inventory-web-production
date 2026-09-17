import type { NextAuthConfig } from 'next-auth'

/**
 * The edge-safe half of the auth configuration.
 *
 * Middleware runs on the Edge runtime, which cannot load Prisma or bcrypt. So
 * the parts middleware needs — pages, session strategy, and the callbacks that
 * only read the token — live here, and `auth.ts` adds the Credentials provider
 * that actually touches the database.
 *
 * This is the standard Auth.js v5 split. Putting the provider here would pull
 * Prisma into the Edge bundle and fail at build time.
 */

export const PUBLIC_PATHS = ['/login', '/api/v1/health', '/api/v1/auth'] as const

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))
}

export const authConfig = {
  session: {
    strategy: 'jwt',
    // A warehouse shift. Long enough not to interrupt work, short enough that a
    // walk-away terminal does not stay signed in overnight.
    maxAge: 12 * 60 * 60,
  },
  pages: {
    signIn: '/login',
    error: '/login',
  },
  providers: [],
  callbacks: {
    /**
     * Copies our fields onto the token at sign-in, then leaves them alone. The
     * token is signed, so nothing here can be tampered with client-side.
     */
    jwt({ token, user }) {
      if (user) {
        token.uid = user.id ?? token.sub ?? ''
        token.role = user.role
        token.siteIds = user.siteIds
        token.defaultSiteId = user.defaultSiteId
        token.mode = user.mode
      }
      return token
    },

    session({ session, token }) {
      session.user.id = token.uid
      session.user.role = token.role
      session.user.siteIds = token.siteIds
      session.user.defaultSiteId = token.defaultSiteId
      session.mode = token.mode
      return session
    },

    /** Used by middleware to gate whole routes before a page renders. */
    authorized({ auth, request }) {
      if (isPublicPath(request.nextUrl.pathname)) return true
      return Boolean(auth?.user)
    },
  },
} satisfies NextAuthConfig
