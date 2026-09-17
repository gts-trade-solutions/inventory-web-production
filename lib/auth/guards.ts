import 'server-only'
import { redirect } from 'next/navigation'
import { UserRole } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import { auth } from '@/auth'
import { dbFor, type AppMode } from '@/lib/mode'
import { ForbiddenError } from './errors'

/**
 * Server-side access control.
 *
 * Every Server Action and route handler goes through one of these. Hiding a
 * button is presentation; this is the enforcement (ARCHITECTURE §6). A guard
 * that only runs in the UI is not a guard.
 */

export interface AuthContext {
  userId: string
  name: string
  email: string
  role: UserRole
  siteIds: string[]
  defaultSiteId: string | null
  mode: AppMode
  /** The database for this session's mode. The only way to reach one. */
  db: PrismaClient
}

/** Role hierarchy. ADMIN can do anything a SUPERVISOR can, and so on. */
const ROLE_RANK: Record<UserRole, number> = {
  [UserRole.USER]: 1,
  [UserRole.SUPERVISOR]: 2,
  [UserRole.ADMIN]: 3,
}

export function roleAtLeast(role: UserRole, minimum: UserRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum]
}

/** The current session, or null. Use when absence is a normal outcome. */
export async function currentUser(): Promise<AuthContext | null> {
  const session = await auth()
  if (!session?.user?.id) return null

  return {
    userId: session.user.id,
    name: session.user.name ?? '',
    email: session.user.email ?? '',
    role: session.user.role,
    siteIds: session.user.siteIds ?? [],
    defaultSiteId: session.user.defaultSiteId,
    mode: session.mode,
    db: dbFor(session.mode),
  }
}

/** Requires a signed-in user. Redirects to the login page when there isn't one. */
export async function requireUser(): Promise<AuthContext> {
  const user = await currentUser()
  if (!user) redirect('/login')
  return user
}

/**
 * Requires at least `minimum`. Throws rather than redirecting, because reaching
 * here without the role means the UI offered something it should not have — that
 * is a bug to surface, not a navigation event.
 */
export async function requireRole(minimum: UserRole): Promise<AuthContext> {
  const user = await requireUser()

  if (!roleAtLeast(user.role, minimum)) {
    throw new ForbiddenError(
      `This action needs ${minimum} access; ${user.name} has ${user.role}.`,
      minimum,
      user.role,
    )
  }

  return user
}

export const requireSupervisor = () => requireRole(UserRole.SUPERVISOR)
export const requireAdmin = () => requireRole(UserRole.ADMIN)

/** Confirms the user may act on this site. Site scoping applies on top of role. */
export async function requireSite(siteId: string): Promise<AuthContext> {
  const user = await requireUser()

  // An admin covers every site; everyone else is limited to their assignments.
  if (user.role !== UserRole.ADMIN && !user.siteIds.includes(siteId)) {
    throw new ForbiddenError(`No access to site ${siteId}.`, UserRole.USER, user.role)
  }

  return user
}

export { ForbiddenError }
