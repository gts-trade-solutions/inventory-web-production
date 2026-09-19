import { randomUUID } from 'node:crypto'
import { ForbiddenError } from '@/lib/auth/errors'
import { ModeViolationError } from '@/lib/mode'
import { TransactionRetryError } from '@/lib/services/tx'
import type { MovementError } from '@/lib/domain/movement'

/**
 * One error envelope, for Server Actions and `/api/v1` alike.
 *
 * The shape is fixed in API_CONTRACT.md and the mobile client codes against it,
 * so it cannot drift: the 422 codes map one-to-one onto the mobile app's
 * `MovementError` sealed interface, which is what lets the phone render its
 * existing error copy with no translation layer.
 *
 * Never a bare string. A client that has to parse prose to find out what went
 * wrong breaks the first time the prose is improved.
 */

export interface ApiErrorBody {
  error: {
    code: string
    message: string
    details?: Record<string, unknown>
    requestId: string
  }
}

export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  INVALID_CURSOR: 'INVALID_CURSOR',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  FORBIDDEN: 'FORBIDDEN',
  DEVICE_REVOKED: 'DEVICE_REVOKED',
  SITE_NOT_ALLOWED: 'SITE_NOT_ALLOWED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  SESSION_ALREADY_SUBMITTED: 'SESSION_ALREADY_SUBMITTED',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',
  PRINTER_UNREACHABLE: 'PRINTER_UNREACHABLE',
  READER_UNREACHABLE: 'READER_UNREACHABLE',
  MODE_VIOLATION: 'MODE_VIOLATION',
} as const
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

/** Domain rejections, all 422. They mean "understood, and not allowed". */
const DOMAIN_CODES = new Set([
  'UNKNOWN_ITEM',
  'UNKNOWN_LOCATION',
  'INVALID_QUANTITY',
  'INSUFFICIENT_STOCK',
  'SAME_LOCATION',
  'REASON_REQUIRED',
  'REASON_CODE_REQUIRED',
  'NO_CHANGE',
  'BATCH_REQUIRED',
  'UNKNOWN_BATCH',
  'BATCH_EXPIRED',
  'BATCH_BLOCKED',
  'EXPIRY_REQUIRED',
  'SERIALS_REQUIRED',
  'SERIAL_COUNT_MISMATCH',
  'UNKNOWN_SERIAL',
  'SERIAL_NOT_AT_LOCATION',
  'SERIAL_ALREADY_ISSUED',
  'ADJUSTMENT_TOO_LARGE',
  'LOCATION_WRONG_SITE',
  'LOCATION_NOT_A_PLACE',
])

const STATUS_BY_CODE: Record<string, number> = {
  VALIDATION_FAILED: 400,
  INVALID_CURSOR: 400,
  TOKEN_EXPIRED: 401,
  TOKEN_INVALID: 401,
  FORBIDDEN: 403,
  DEVICE_REVOKED: 403,
  SITE_NOT_ALLOWED: 403,
  MODE_VIOLATION: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  SESSION_ALREADY_SUBMITTED: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  PRINTER_UNREACHABLE: 502,
  READER_UNREACHABLE: 502,
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ApiError'
  }

  get status(): number {
    return statusFor(this.code)
  }
}

export function statusFor(code: string): number {
  if (DOMAIN_CODES.has(code)) return 422
  return STATUS_BY_CODE[code] ?? 500
}

export function apiError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  requestId: string = randomUUID(),
): ApiErrorBody {
  return { error: { code, message, details, requestId } }
}

export function fromMovementError(error: MovementError, requestId?: string): ApiErrorBody {
  return apiError(error.code, error.message, error.details, requestId)
}

/**
 * Turns anything thrown into the envelope.
 *
 * Unrecognised errors become a bare INTERNAL with no detail, because an
 * exception message can carry a table name, a query fragment or a file path.
 * The real error is logged against `requestId` so it is still findable — the
 * caller gets an id to quote, not the internals.
 */
export function toApiError(
  thrown: unknown,
  requestId: string = randomUUID(),
): { body: ApiErrorBody; status: number; logged: unknown } {
  if (thrown instanceof ApiError) {
    return {
      body: apiError(thrown.code, thrown.message, thrown.details, requestId),
      status: thrown.status,
      logged: null,
    }
  }

  if (thrown instanceof ForbiddenError) {
    return {
      body: apiError(ErrorCode.FORBIDDEN, thrown.message, { required: thrown.required }, requestId),
      status: 403,
      logged: null,
    }
  }

  if (thrown instanceof ModeViolationError) {
    return {
      body: apiError(ErrorCode.MODE_VIOLATION, thrown.message, undefined, requestId),
      status: 403,
      logged: null,
    }
  }

  if (thrown instanceof TransactionRetryError) {
    // Lock contention that outlasted the retries. The caller can try again; the
    // request was not applied.
    return {
      body: apiError(
        ErrorCode.CONFLICT,
        'The system was too busy to complete that. Please try again.',
        { attempts: thrown.attempts },
        requestId,
      ),
      status: 409,
      logged: thrown,
    }
  }

  return {
    body: apiError(ErrorCode.INTERNAL, 'Something went wrong on our side.', undefined, requestId),
    status: 500,
    logged: thrown,
  }
}

/** Formats a Zod error into the envelope, keeping the field paths. */
export function fromZodError(
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
  requestId?: string,
): ApiErrorBody {
  return apiError(
    ErrorCode.VALIDATION_FAILED,
    issues[0]?.message ?? 'That request is not valid.',
    {
      fields: issues.map((issue) => ({
        field: issue.path.map(String).join('.') || '(root)',
        message: issue.message,
      })),
    },
    requestId,
  )
}
