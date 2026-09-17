import 'server-only'
import { Prisma } from '@prisma/client'
// Type-only: erased at compile time, so it cannot construct a client and bypass
// the mode resolver. The lint rule allows it for exactly that reason.
import type { PrismaClient } from '@prisma/client'
import type { Db } from '@/lib/db'

/**
 * Transaction helpers for the ledger write path.
 *
 * InnoDB deadlocks are a NORMAL operating condition, not a bug: any transaction
 * that takes more than one row lock can hit one, and MySQL resolves it by
 * killing the cheaper transaction. The correct response is to retry the whole
 * transaction — not to retry a statement inside it, because MySQL has already
 * rolled the transaction back by the time the error surfaces.
 *
 * The ledger write path locks several stock rows plus the named serial units
 * plus a numbering row (ARCHITECTURE §4.3), so this is the wrapper it runs in.
 *
 * Reference: docs/ARCHITECTURE.md §4.3
 */

/** MySQL error numbers that mean "this transaction lost a race; try again". */
const RETRYABLE_MYSQL_ERRORS = [
  1213, // ER_LOCK_DEADLOCK      — deadlock found, transaction rolled back
  1205, // ER_LOCK_WAIT_TIMEOUT  — lock wait timeout exceeded
] as const

const DEFAULT_MAX_ATTEMPTS = 5
const BASE_BACKOFF_MS = 20

export function isRetryableTransactionError(error: unknown): boolean {
  // Prisma's own code for a write conflict / deadlock on the query engine path.
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
    return true
  }

  // Raw SQL surfaces as P2010 with the driver's error number in the message,
  // e.g. "Raw query failed. Code: `1213`".
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const haystack = `${error.message} ${JSON.stringify(error.meta ?? {})}`
    return RETRYABLE_MYSQL_ERRORS.some((code) => haystack.includes(String(code)))
  }

  return false
}

export interface TransactionOptions {
  maxAttempts?: number
  /** Appears in the error when every attempt fails; make it name the operation. */
  label?: string
  /** Passed through to Prisma. Raise it for large batch pushes. */
  timeoutMs?: number
}

/**
 * Runs `fn` in a transaction, retrying the WHOLE transaction on deadlock or lock
 * wait timeout with jittered exponential backoff.
 *
 * `fn` must be safe to run more than once. Keep it to database work: no emails,
 * no printing, no external calls, and no mutation of anything outside it. Side
 * effects belong after this returns.
 */
export async function withDeadlockRetry<T>(
  db: PrismaClient,
  fn: (tx: Db) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const label = options.label ?? 'transaction'

  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await db.$transaction((tx) => fn(tx as Db), {
        timeout: options.timeoutMs ?? 15_000,
      })
    } catch (error) {
      lastError = error

      if (!isRetryableTransactionError(error) || attempt === maxAttempts) {
        throw error
      }

      // Jitter matters: without it, two transactions that deadlocked together
      // back off for the same interval and deadlock again on the retry.
      const backoff = BASE_BACKOFF_MS * 2 ** (attempt - 1) * (0.5 + Math.random())
      await sleep(backoff)
    }
  }

  throw new TransactionRetryError(label, maxAttempts, lastError)
}

export class TransactionRetryError extends Error {
  readonly code = 'TRANSACTION_RETRY_EXHAUSTED'

  constructor(
    label: string,
    readonly attempts: number,
    override readonly cause: unknown,
  ) {
    super(`${label} failed after ${attempts} attempts due to repeated lock contention.`)
    this.name = 'TransactionRetryError'
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Locks are taken in a deterministic order so two transactions touching the same
 * rows can never hold them in opposite orders — which is the deadlock a MOVE
 * between two locations would otherwise cause constantly (ARCHITECTURE §4.3).
 */
export function deterministicLockOrder<T extends string>(
  ids: readonly (T | null | undefined)[],
): T[] {
  return [...new Set(ids.filter((id): id is T => Boolean(id)))].sort()
}
