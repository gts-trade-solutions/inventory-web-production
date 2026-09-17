import 'server-only'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { DeviceConnection, DeviceKind } from '@prisma/client'
import type { UserRole } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import { verifyPassword, fakeVerify } from '@/lib/auth/password'
import { ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS, signAccessToken } from '@/lib/api/jwt'
import { ApiError, ErrorCode } from '@/lib/api/errors'
import type { AppMode } from '@/lib/mode'

/**
 * Issuing and rotating device tokens.
 *
 * Refresh tokens are opaque random strings stored as SHA-256 hashes. They are
 * not JWTs: a JWT cannot be revoked before it expires, and the whole point of a
 * refresh token is that an admin can kill a lost phone today rather than in
 * thirty days.
 *
 * Rotation is strict — using a refresh token invalidates it and issues a new
 * one. Presenting an already-used token means it was captured, so the entire
 * chain for that device is revoked rather than just refused.
 */

export interface DeviceDescriptor {
  id?: string
  label?: string
  platform?: string
  appVersion?: string
  osVersion?: string
}

export interface TokenPair {
  accessToken: string
  refreshToken: string
  expiresIn: number
  user: { id: string; name: string; email: string; role: UserRole }
  sites: Array<{ id: string; code: string; name: string }>
  defaultSiteId: string | null
  mode: AppMode
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex')

export async function issueTokens(
  db: PrismaClient,
  credentials: { email: string; password: string },
  device: DeviceDescriptor | undefined,
  mode: AppMode,
): Promise<TokenPair> {
  const user = await db.user.findUnique({
    where: { email: credentials.email.toLowerCase() },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      active: true,
      deletedAt: true,
      passwordHash: true,
      defaultSiteId: true,
      sites: { select: { site: { select: { id: true, code: true, name: true } } } },
    },
  })

  // Same time and the same message whether the address exists or the password
  // is wrong, so the endpoint cannot be used to enumerate accounts.
  if (!user) {
    await fakeVerify(credentials.password)
    throw new ApiError(ErrorCode.TOKEN_INVALID, 'Those credentials do not match an active account.')
  }

  const valid = await verifyPassword(credentials.password, user.passwordHash)
  if (!valid || !user.active || user.deletedAt) {
    throw new ApiError(ErrorCode.TOKEN_INVALID, 'Those credentials do not match an active account.')
  }

  const deviceId = device ? await registerDevice(db, device, user.id) : null

  return buildPair(db, {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      defaultSiteId: user.defaultSiteId,
      sites: user.sites.map((s) => s.site),
    },
    deviceId,
    mode,
  })
}

/**
 * Registers or updates the device and binds it to the user.
 *
 * The id comes from the client so a reinstall on the same handset is recognised
 * as that handset, not as a new one accumulating in the registry.
 */
async function registerDevice(
  db: PrismaClient,
  device: DeviceDescriptor,
  userId: string,
): Promise<string> {
  const id = device.id ?? randomUUID()

  const existing = await db.device.findUnique({
    where: { id },
    select: { id: true, active: true },
  })

  if (existing && !existing.active) {
    // Revoked by an admin. The client must keep its unsynced outbox and prompt
    // for re-login rather than discarding work (API_CONTRACT §1).
    throw new ApiError(ErrorCode.DEVICE_REVOKED, 'This device has been revoked.')
  }

  await db.device.upsert({
    where: { id },
    update: {
      label: device.label ?? undefined,
      assignedUserId: userId,
      appVersion: device.appVersion ?? undefined,
      lastSeenAt: new Date(),
    },
    create: {
      id,
      label: device.label ?? 'Mobile device',
      kind: DeviceKind.MOBILE_COMPUTER,
      connection: DeviceConnection.NETWORK,
      vendor: device.platform ?? null,
      model: device.osVersion ?? null,
      assignedUserId: userId,
      appVersion: device.appVersion ?? null,
      lastSeenAt: new Date(),
    },
  })

  return id
}

export async function refreshTokens(
  db: PrismaClient,
  refreshToken: string,
  mode: AppMode,
): Promise<TokenPair> {
  const tokenHash = hash(refreshToken)

  const stored = await db.refreshToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      userId: true,
      deviceId: true,
      expiresAt: true,
      revokedAt: true,
      replacedById: true,
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          active: true,
          deletedAt: true,
          defaultSiteId: true,
          sites: { select: { site: { select: { id: true, code: true, name: true } } } },
        },
      },
    },
  })

  if (!stored) throw new ApiError(ErrorCode.TOKEN_INVALID, 'That refresh token is not recognised.')

  // A token that was already rotated is being replayed, which means it leaked.
  // Refusing this one alone would leave the thief holding the newer token, so
  // the whole chain for the device goes.
  if (stored.replacedById || stored.revokedAt) {
    await revokeDeviceTokens(db, stored.userId, stored.deviceId)
    throw new ApiError(
      ErrorCode.TOKEN_INVALID,
      'That refresh token has already been used. All sessions for this device have been ended.',
    )
  }

  if (stored.expiresAt < new Date()) {
    throw new ApiError(ErrorCode.TOKEN_EXPIRED, 'That refresh token has expired. Sign in again.')
  }

  if (!stored.user.active || stored.user.deletedAt) {
    throw new ApiError(ErrorCode.TOKEN_INVALID, 'That account is no longer active.')
  }

  if (stored.deviceId) {
    const device = await db.device.findUnique({
      where: { id: stored.deviceId },
      select: { active: true },
    })
    if (device && !device.active) {
      throw new ApiError(ErrorCode.DEVICE_REVOKED, 'This device has been revoked.')
    }
  }

  const pair = await buildPair(db, {
    user: {
      id: stored.user.id,
      name: stored.user.name,
      email: stored.user.email,
      role: stored.user.role,
      defaultSiteId: stored.user.defaultSiteId,
      sites: stored.user.sites.map((s) => s.site),
    },
    deviceId: stored.deviceId,
    mode,
    replaces: stored.id,
  })

  return pair
}

async function buildPair(
  db: PrismaClient,
  input: {
    user: {
      id: string
      name: string
      email: string
      role: UserRole
      defaultSiteId: string | null
      sites: Array<{ id: string; code: string; name: string }>
    }
    deviceId: string | null
    mode: AppMode
    replaces?: string
  },
): Promise<TokenPair> {
  const siteIds = input.user.sites.map((site) => site.id)

  const accessToken = await signAccessToken({
    userId: input.user.id,
    role: input.user.role,
    siteIds,
    deviceId: input.deviceId,
    mode: input.mode,
  })

  // 32 random bytes, stored hashed. A database leak does not hand out sessions.
  const refreshToken = randomBytes(32).toString('base64url')
  const id = randomUUID()

  await db.$transaction(async (tx) => {
    await tx.refreshToken.create({
      data: {
        id,
        tokenHash: hash(refreshToken),
        userId: input.user.id,
        deviceId: input.deviceId,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
      },
    })

    if (input.replaces) {
      await tx.refreshToken.update({
        where: { id: input.replaces },
        data: { replacedById: id, revokedAt: new Date() },
      })
    }

    await tx.user.update({ where: { id: input.user.id }, data: { lastLoginAt: new Date() } })
  })

  return {
    accessToken,
    refreshToken,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    user: {
      id: input.user.id,
      name: input.user.name,
      email: input.user.email,
      role: input.user.role,
    },
    sites: input.user.sites,
    defaultSiteId: input.user.defaultSiteId ?? siteIds[0] ?? null,
    mode: input.mode,
  }
}

/** Ends every live session for a device, or for the user when it has none. */
export async function revokeDeviceTokens(
  db: PrismaClient,
  userId: string,
  deviceId: string | null,
): Promise<number> {
  const result = await db.refreshToken.updateMany({
    where: {
      userId,
      ...(deviceId ? { deviceId } : {}),
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  })

  return result.count
}
