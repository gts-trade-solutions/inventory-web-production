import 'server-only'
import { randomBytes, randomUUID } from 'node:crypto'
import { UserRole } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import { ApiError, ErrorCode } from '@/lib/api/errors'
import { hashPassword } from '@/lib/auth/password'

/**
 * User administration.
 *
 * The rule that shapes most of this: a user is never deleted. They own
 * movements, counts they approved, print jobs and audit entries, and the
 * ledger's value comes from being able to say who did what. Deactivating stops
 * them signing in and leaves the history intact.
 */

export interface UserRow {
  id: string
  email: string
  name: string
  role: UserRole
  active: boolean
  siteCodes: string[]
  defaultSiteId: string | null
  lastLoginAt: Date | null
  createdAt: Date
}

export async function listUsers(db: PrismaClient): Promise<UserRow[]> {
  const users = await db.user.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      active: true,
      defaultSiteId: true,
      lastLoginAt: true,
      createdAt: true,
      sites: { select: { site: { select: { code: true } } } },
    },
    // Inactive last: the list is for finding somebody, and retired accounts are
    // rarely who you are looking for.
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
  })

  return users.map((user) => ({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    active: user.active,
    siteCodes: user.sites.map((link) => link.site.code),
    defaultSiteId: user.defaultSiteId,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  }))
}

export interface CreateUserInput {
  email: string
  name: string
  role: UserRole
  siteIds: string[]
}

export interface CreatedUser {
  user: UserRow
  /**
   * Shown once, to be handed over.
   *
   * There is no email service yet, so an invitation link would go nowhere. A
   * generated password the admin passes on is honest about that; a link that
   * silently fails is not. When email arrives this becomes a proper invite.
   */
  temporaryPassword: string
}

/** Long, random, and never stored in plain text — only its hash is kept. */
export function generatePassword(): string {
  // base64url of 12 bytes: 16 characters, no ambiguous punctuation to read out
  // over a radio or copy off a sticky note.
  return randomBytes(12).toString('base64url')
}

export async function createUser(db: PrismaClient, input: CreateUserInput): Promise<CreatedUser> {
  const email = input.email.trim().toLowerCase()

  const existing = await db.user.findUnique({
    where: { email },
    select: { id: true, deletedAt: true },
  })
  if (existing) {
    throw new ApiError(
      ErrorCode.CONFLICT,
      existing.deletedAt
        ? 'An account with that address existed before and was removed. Ask a developer to restore it rather than creating a second one.'
        : 'An account with that address already exists.',
    )
  }

  const temporaryPassword = generatePassword()
  const id = randomUUID()

  await db.$transaction(async (tx) => {
    await tx.user.create({
      data: {
        id,
        email,
        name: input.name.trim(),
        role: input.role,
        passwordHash: await hashPassword(temporaryPassword),
        defaultSiteId: input.siteIds[0] ?? null,
      },
    })

    if (input.siteIds.length > 0) {
      await tx.userSite.createMany({
        data: input.siteIds.map((siteId) => ({ userId: id, siteId })),
      })
    }
  })

  const [user] = await listUsers(db).then((rows) => rows.filter((row) => row.id === id))
  if (!user)
    throw new ApiError(ErrorCode.INTERNAL, 'The account was created but could not be read back.')

  return { user, temporaryPassword }
}

export interface UpdateUserInput {
  name?: string
  role?: UserRole
  siteIds?: string[]
  active?: boolean
}

export async function updateUser(
  db: PrismaClient,
  userId: string,
  input: UpdateUserInput,
  actor: { userId: string },
): Promise<UserRow> {
  const before = await db.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: { id: true, role: true, active: true },
  })
  if (!before) throw new ApiError(ErrorCode.NOT_FOUND, 'That account does not exist.')

  // Two ways to lock everybody out, both easy to do by accident on a screen
  // that lists your own name alongside everyone else's.
  if (userId === actor.userId && input.active === false) {
    throw new ApiError(ErrorCode.VALIDATION_FAILED, 'You cannot deactivate your own account.')
  }
  if (userId === actor.userId && input.role && input.role !== UserRole.ADMIN) {
    throw new ApiError(
      ErrorCode.VALIDATION_FAILED,
      'You cannot remove your own administrator access. Ask another administrator to do it.',
    )
  }

  if (input.active === false || (input.role && input.role !== UserRole.ADMIN)) {
    await assertNotLastAdmin(db, userId)
  }

  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: {
        name: input.name?.trim(),
        role: input.role,
        active: input.active,
        ...(input.siteIds ? { defaultSiteId: input.siteIds[0] ?? null } : {}),
      },
    })

    if (input.siteIds) {
      await tx.userSite.deleteMany({ where: { userId } })
      if (input.siteIds.length > 0) {
        await tx.userSite.createMany({
          data: input.siteIds.map((siteId) => ({ userId, siteId })),
        })
      }
    }
  })

  // Every live session is dropped when an account is deactivated or demoted.
  // A refresh token outliving the change would leave somebody working with
  // access they no longer have, for up to thirty days.
  if (input.active === false || (input.role && input.role !== before.role)) {
    await db.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    })
  }

  const [user] = await listUsers(db).then((rows) => rows.filter((row) => row.id === userId))
  if (!user) throw new ApiError(ErrorCode.INTERNAL, 'The account could not be read back.')
  return user
}

/**
 * Sets a new password and returns it once.
 *
 * Not "send a reset link": there is no email service. An administrator reads
 * the password out to the person, which is how a warehouse actually works when
 * somebody is locked out at six in the morning.
 */
export async function resetPassword(
  db: PrismaClient,
  userId: string,
): Promise<{ temporaryPassword: string }> {
  const user = await db.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: { id: true },
  })
  if (!user) throw new ApiError(ErrorCode.NOT_FOUND, 'That account does not exist.')

  const temporaryPassword = generatePassword()

  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(temporaryPassword) },
    })

    // The old password is gone, so the sessions it authorised must go too.
    await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    })
  })

  return { temporaryPassword }
}

/**
 * Refuses to remove the last administrator.
 *
 * Without this the system can be locked out of its own administration by one
 * click, and recovering means a developer with database access — which is
 * precisely the dependency this phase exists to remove.
 */
async function assertNotLastAdmin(db: PrismaClient, userId: string): Promise<void> {
  const admins = await db.user.count({
    where: { role: UserRole.ADMIN, active: true, deletedAt: null, id: { not: userId } },
  })

  if (admins === 0) {
    throw new ApiError(
      ErrorCode.VALIDATION_FAILED,
      'This is the only active administrator. Promote somebody else first, or the system cannot be administered at all.',
    )
  }
}
