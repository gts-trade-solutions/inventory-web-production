/**
 * Structured logging (PROJECT_PLAN 9.4).
 *
 * One JSON object per line, on stdout. Not because JSON is pleasant to read —
 * it is not — but because the question people actually ask of a log is "show me
 * everything for request abc123" or "how many print jobs failed yesterday", and
 * neither can be answered by grepping prose that changes whenever somebody
 * improves the wording.
 *
 * `console` on purpose. The process writes to stdout and whatever runs it —
 * systemd, pm2, a container runtime — owns collection. A logger that writes
 * files itself has to solve rotation, permissions and disk space, none of which
 * is this application's problem (OPERATIONS.md §8).
 *
 * NOTHING SENSITIVE. Fields are redacted by name, the same list the audit trail
 * uses, because a log is the copy that ends up in a third-party search index.
 */

export type Level = 'debug' | 'info' | 'warn' | 'error'

/** Redacted wherever they appear, at any depth. */
const SENSITIVE = new Set([
  'password',
  'passwordHash',
  'secret',
  'secretHash',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'cookie',
])

export function redact(value: unknown, depth = 0): unknown {
  // Deep enough for any context object worth logging, and bounded so a
  // circular structure cannot take the process down. A logger that can crash
  // the thing it is observing is worse than no logger.
  if (depth > 6) return '[deep]'

  if (value === null || typeof value !== 'object') return value
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => redact(entry, depth + 1))

  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE.has(key) ? '[redacted]' : redact(entry, depth + 1)
  }

  return out
}

export interface LogFields {
  /** Ties every line of one request together. */
  requestId?: string
  userId?: string | null
  deviceId?: string | null
  mode?: string
  /** Anything else worth searching on later. */
  [key: string]: unknown
}

function emit(level: Level, event: string, fields: LogFields = {}): void {
  const line = {
    level,
    // `event` is a stable slug — "print.failed", not a sentence. Wording can
    // then be improved without breaking the query that counts them.
    event,
    at: new Date().toISOString(),
    ...(redact(fields) as Record<string, unknown>),
  }

  const text = JSON.stringify(line)

  if (level === 'error') console.error(text)
  else if (level === 'warn') console.warn(text)
  else console.log(text)
}

export const log = {
  debug: (event: string, fields?: LogFields) => emit('debug', event, fields),
  info: (event: string, fields?: LogFields) => emit('info', event, fields),
  warn: (event: string, fields?: LogFields) => emit('warn', event, fields),

  /**
   * An error, with the stack kept separate from the message.
   *
   * The thrown value is never spread into the line: an exception can carry a
   * query fragment, a file path or a connection string, and this is the copy
   * that leaves the building.
   */
  error: (event: string, thrown: unknown, fields?: LogFields) =>
    emit('error', event, {
      ...fields,
      error: thrown instanceof Error ? thrown.message : String(thrown),
      stack: thrown instanceof Error ? thrown.stack : undefined,
    }),
}

/**
 * Where an unexpected error goes.
 *
 * One seam, so an error reporter is wired in one place rather than sprinkled
 * through every catch block. Sentry is the intended one (PROJECT_PLAN 9.4):
 * install `@sentry/nextjs`, set `SENTRY_DSN`, and add the capture call below.
 *
 * It is NOT wired yet, deliberately. Adding an SDK that cannot be verified
 * without a DSN produces exactly the thing this codebase keeps refusing — a
 * control nobody has watched work. The logging below is real and is what the
 * runbook tells an operator to read.
 */
export function report(event: string, thrown: unknown, fields?: LogFields): void {
  log.error(event, thrown, fields)

  // Sentry.captureException(thrown, { tags: { event }, extra: redact(fields) })
}
