import 'server-only'
import { SignJWT, jwtVerify, type JWTPayload } from 'jose'
import type { UserRole } from '@prisma/client'
import { parseMode, type AppMode } from '@/lib/mode'

/**
 * Device-bound access tokens for the mobile app.
 *
 * Separate from the web session because an offline phone cannot round-trip a
 * cookie, and a lost device has to be revocable without disabling the person who
 * used it (ARCHITECTURE §6).
 *
 * `mode` is a signed claim. A DEMO token cannot be presented against LIVE, which
 * is what stops demo data reaching real reporting (WADR-024).
 */

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60

const ISSUER = 'inventory-web-app'
const AUDIENCE = 'inventory-mobile-app'

export interface AccessClaims {
  userId: string
  role: UserRole
  siteIds: string[]
  deviceId: string | null
  mode: AppMode
}

function signingKey(): Uint8Array {
  const secret = process.env.JWT_SIGNING_KEY
  if (!secret) {
    throw new Error('JWT_SIGNING_KEY is not set. The mobile API cannot issue tokens.')
  }
  // Deliberately distinct from AUTH_SECRET: a web session cookie and a device
  // bearer token should never be interchangeable.
  return new TextEncoder().encode(secret)
}

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({
    role: claims.role,
    siteIds: claims.siteIds,
    deviceId: claims.deviceId,
    mode: claims.mode,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(signingKey())
}

export type VerifyResult =
  { ok: true; claims: AccessClaims } | { ok: false; code: 'TOKEN_EXPIRED' | 'TOKEN_INVALID' }

/**
 * Verifies an access token.
 *
 * Distinguishes expiry from invalidity, because the client's response differs:
 * an expired token means refresh, an invalid one means sign in again. Conflating
 * them sends a phone into a refresh loop it can never win.
 */
export async function verifyAccessToken(token: string): Promise<VerifyResult> {
  try {
    const { payload } = await jwtVerify(token, signingKey(), {
      issuer: ISSUER,
      audience: AUDIENCE,
    })

    const claims = toClaims(payload)
    return claims ? { ok: true, claims } : { ok: false, code: 'TOKEN_INVALID' }
  } catch (error) {
    const code = (error as { code?: string }).code
    return {
      ok: false,
      code: code === 'ERR_JWT_EXPIRED' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
    }
  }
}

function toClaims(payload: JWTPayload): AccessClaims | null {
  if (typeof payload.sub !== 'string' || !payload.sub) return null
  if (typeof payload.role !== 'string') return null

  return {
    userId: payload.sub,
    role: payload.role as UserRole,
    siteIds: Array.isArray(payload.siteIds) ? payload.siteIds.map(String) : [],
    deviceId: typeof payload.deviceId === 'string' ? payload.deviceId : null,
    // Narrowed rather than trusted: an unrecognised value falls back to LIVE,
    // which is read-safe because a LIVE session cannot see demo data.
    mode: parseMode(payload.mode),
  }
}

/** Reads a bearer token from an Authorization header. */
export function bearerFrom(header: string | null): string | null {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1] ?? null
}
