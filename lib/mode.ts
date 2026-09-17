import 'server-only'
import type { PrismaClient } from '@prisma/client'
import { demoPrisma, livePrisma } from '@/lib/db'

/**
 * LIVE or DEMO. The single place the two databases are chosen between.
 *
 * Mode is carried in the signed session (web) or the signed JWT (mobile) — never
 * in a header, query parameter or request body, so a client cannot pick it per
 * request (WADR-024). That is what guarantees demo data can never reach live
 * reporting, and a demo session can never write live stock.
 *
 * Reference: docs/ARCHITECTURE.md §8, docs/DEMO_MODE.md §2
 */

export const APP_MODES = ['LIVE', 'DEMO'] as const
export type AppMode = (typeof APP_MODES)[number]

export const DEFAULT_MODE: AppMode = 'LIVE'

/** Whether signing in against the demo database is offered at all. */
export function isDemoModeEnabled(): boolean {
  return process.env.DEMO_MODE_ENABLED !== 'false'
}

/**
 * Narrows an untrusted value to an AppMode. Anything unrecognised — including a
 * spoofed header or a corrupted claim — falls back to LIVE, which is read-safe:
 * a LIVE session simply cannot see demo data.
 *
 * DEMO is refused outright when the deployment has demo mode switched off.
 */
export function parseMode(value: unknown): AppMode {
  if (value === 'DEMO') return isDemoModeEnabled() ? 'DEMO' : DEFAULT_MODE
  if (value === 'LIVE') return 'LIVE'
  return DEFAULT_MODE
}

/** The database for this mode. The only supported way to reach a Prisma client. */
export function dbFor(mode: AppMode): PrismaClient {
  return mode === 'DEMO' ? demoPrisma() : livePrisma()
}

/**
 * Guards operations that must never touch live data — `POST /api/v1/demo/reset`
 * above all. There is deliberately no code path from those to `livePrisma()`.
 */
export function assertDemoMode(mode: AppMode, operation: string): asserts mode is 'DEMO' {
  if (mode !== 'DEMO') {
    throw new ModeViolationError(`${operation} is only available in DEMO mode.`)
  }
}

export class ModeViolationError extends Error {
  readonly code = 'MODE_VIOLATION'

  constructor(message: string) {
    super(message)
    this.name = 'ModeViolationError'
  }
}

/**
 * Whether outbound side effects are permitted. DEMO blocks printing to real
 * hardware, email, webhooks and integrations at the service boundary
 * (DEMO_MODE.md §7), so a demo can never reach into the physical world.
 */
export function allowsOutboundEffects(mode: AppMode): boolean {
  return mode === 'LIVE'
}
