import type { UserRole } from '@prisma/client'
import type { AppMode } from '@/lib/mode'
import type { DefaultSession } from '@auth/core/types'

/**
 * The session shape this app actually uses.
 *
 * `mode` is the important one: it travels in the signed JWT, so a client cannot
 * change which database it is talking to by editing a request (WADR-024).
 *
 * These augment `@auth/core/*`, not `next-auth`. The `next-auth` package only
 * RE-EXPORTS these interfaces (`export type { Session, User } from
 * "@auth/core/types"`), so `declare module 'next-auth'` declares new interfaces
 * that nothing merges with, and every field silently widens to `unknown`.
 */

declare module '@auth/core/types' {
  interface Session {
    user: {
      id: string
      role: UserRole
      siteIds: string[]
      defaultSiteId: string | null
    } & DefaultSession['user']
    mode: AppMode
  }

  interface User {
    role: UserRole
    siteIds: string[]
    defaultSiteId: string | null
    mode: AppMode
  }
}

/**
 * The `user` handed to the jwt callback is typed `User | AdapterUser`. Without
 * augmenting both, the union widens every field back to `unknown`.
 */
declare module '@auth/core/adapters' {
  interface AdapterUser {
    role: UserRole
    siteIds: string[]
    defaultSiteId: string | null
    mode: AppMode
  }
}

declare module '@auth/core/jwt' {
  interface JWT {
    uid: string
    role: UserRole
    siteIds: string[]
    defaultSiteId: string | null
    mode: AppMode
  }
}

export {}
