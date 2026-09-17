import 'server-only'
import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { UserRole } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import type { z } from 'zod'
import { dbFor, type AppMode } from '@/lib/mode'
import { roleAtLeast } from '@/lib/auth/guards'
import { bearerFrom, verifyAccessToken, type AccessClaims } from './jwt'
import { ErrorCode, apiError, fromZodError, toApiError, type ApiErrorBody } from './errors'

/**
 * The wrapper every /api/v1 route goes through.
 *
 * Authenticate, resolve the mode, parse the body, call the handler, and shape
 * whatever comes back into the one envelope the mobile client codes against
 * (API_CONTRACT.md). Routes stay thin enough to read in one screen.
 *
 * Every response carries a request id. When an operator reports "it failed at
 * about ten past three", that id is what turns the complaint into a log line.
 */

export interface ApiContext<TBody = unknown> {
  claims: AccessClaims
  /** The database for the token's mode. The only way a route reaches one. */
  db: PrismaClient
  mode: AppMode
  body: TBody
  requestId: string
  request: Request
}

export interface RouteOptions<TSchema extends z.ZodTypeAny | undefined> {
  /** Minimum role. Most endpoints are open to any signed-in user. */
  minimumRole?: UserRole
  schema?: TSchema
}

type Handler<TBody> = (context: ApiContext<TBody>) => Promise<unknown>

export function apiRoute<TSchema extends z.ZodTypeAny | undefined = undefined>(
  options: RouteOptions<TSchema>,
  handler: Handler<TSchema extends z.ZodTypeAny ? z.infer<TSchema> : undefined>,
): (request: Request) => Promise<NextResponse> {
  return async (request: Request) => {
    const requestId = randomUUID()

    try {
      const token = bearerFrom(request.headers.get('authorization'))
      if (!token) {
        return fail(
          apiError(
            ErrorCode.TOKEN_INVALID,
            'This endpoint needs a bearer token.',
            undefined,
            requestId,
          ),
          401,
          requestId,
        )
      }

      const verified = await verifyAccessToken(token)
      if (!verified.ok) {
        // Expiry and invalidity are distinct on purpose: one means refresh, the
        // other means sign in again. Conflating them loops the client.
        return fail(
          apiError(
            verified.code,
            verified.code === 'TOKEN_EXPIRED'
              ? 'That access token has expired. Refresh it.'
              : 'That access token is not valid.',
            undefined,
            requestId,
          ),
          401,
          requestId,
        )
      }

      const { claims } = verified

      if (options.minimumRole && !roleAtLeast(claims.role, options.minimumRole)) {
        return fail(
          apiError(
            ErrorCode.FORBIDDEN,
            `This endpoint needs ${options.minimumRole} access.`,
            { required: options.minimumRole },
            requestId,
          ),
          403,
          requestId,
        )
      }

      const db = dbFor(claims.mode)

      // A revoked device must stop working immediately, not when its 15-minute
      // access token happens to expire.
      if (claims.deviceId) {
        const device = await db.device.findUnique({
          where: { id: claims.deviceId },
          select: { active: true },
        })
        if (device && !device.active) {
          return fail(
            apiError(
              ErrorCode.DEVICE_REVOKED,
              'This device has been revoked. Keep any unsynced work and sign in again.',
              undefined,
              requestId,
            ),
            403,
            requestId,
          )
        }
      }

      let body: unknown = undefined
      if (options.schema) {
        const raw = await readJson(request)
        const parsed = options.schema.safeParse(raw)
        if (!parsed.success) {
          return fail(fromZodError(parsed.error.issues, requestId), 400, requestId)
        }
        body = parsed.data
      }

      const result = await handler({
        claims,
        db,
        mode: claims.mode,
        body: body as never,
        requestId,
        request,
      })

      return NextResponse.json(result ?? { ok: true }, {
        headers: headersFor(requestId, claims.mode),
      })
    } catch (thrown) {
      const { body, status, logged } = toApiError(thrown, requestId)

      if (logged) {
        // The detail stays server-side; the caller gets an id to quote.
        console.error(`[api ${requestId}]`, logged)
      }

      return fail(body, status, requestId)
    }
  }
}

/** An unauthenticated route, for health checks and token issuance. */
export function publicRoute<TSchema extends z.ZodTypeAny | undefined = undefined>(
  options: { schema?: TSchema },
  handler: (context: {
    body: TSchema extends z.ZodTypeAny ? z.infer<TSchema> : undefined
    requestId: string
    request: Request
  }) => Promise<unknown>,
): (request: Request) => Promise<NextResponse> {
  return async (request: Request) => {
    const requestId = randomUUID()

    try {
      let body: unknown = undefined
      if (options.schema) {
        const parsed = options.schema.safeParse(await readJson(request))
        if (!parsed.success) {
          return fail(fromZodError(parsed.error.issues, requestId), 400, requestId)
        }
        body = parsed.data
      }

      const result = await handler({ body: body as never, requestId, request })
      return NextResponse.json(result ?? { ok: true }, { headers: { 'X-Request-Id': requestId } })
    } catch (thrown) {
      const { body, status, logged } = toApiError(thrown, requestId)
      if (logged) console.error(`[api ${requestId}]`, logged)
      return fail(body, status, requestId)
    }
  }
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    // An empty or malformed body becomes a validation failure with field paths
    // rather than a parser stack trace.
    return {}
  }
}

function headersFor(requestId: string, mode: AppMode): Record<string, string> {
  return {
    'X-Request-Id': requestId,
    // Echoed for display and logging only. The client cannot SET it — the mode
    // lives in the signed token (WADR-024).
    'X-App-Mode': mode,
  }
}

function fail(body: ApiErrorBody, status: number, requestId: string): NextResponse {
  return NextResponse.json(body, { status, headers: { 'X-Request-Id': requestId } })
}

export { UserRole }
