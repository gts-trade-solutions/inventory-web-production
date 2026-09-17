import 'server-only'
import { PrismaClient } from '@prisma/client'

/**
 * Two Prisma clients, one per mode, both singletons.
 *
 * Nothing outside `lib/mode.ts` should import these directly — go through
 * `dbFor(mode)` so LIVE and DEMO stay isolated (WADR-024). The ESLint config
 * enforces that.
 *
 * They are cached on `globalThis` because Next.js discards module state on every
 * hot reload in development, and a fresh PrismaClient per reload exhausts the
 * MySQL connection pool within a few minutes.
 */

const globalForPrisma = globalThis as unknown as {
  prismaLive?: PrismaClient
  prismaDemo?: PrismaClient
}

function createClient(url: string | undefined, label: 'LIVE' | 'DEMO'): PrismaClient {
  if (!url) {
    throw new Error(
      `Missing database URL for ${label} mode. ` +
        `Set ${label === 'LIVE' ? 'DATABASE_URL' : 'DATABASE_URL_DEMO'} in .env — see .env.example.`,
    )
  }

  return new PrismaClient({
    datasourceUrl: url,
    log:
      process.env.NODE_ENV === 'development'
        ? [
            { level: 'warn', emit: 'stdout' },
            { level: 'error', emit: 'stdout' },
          ]
        : [{ level: 'error', emit: 'stdout' }],
  })
}

export function livePrisma(): PrismaClient {
  globalForPrisma.prismaLive ??= createClient(process.env.DATABASE_URL, 'LIVE')
  return globalForPrisma.prismaLive
}

export function demoPrisma(): PrismaClient {
  globalForPrisma.prismaDemo ??= createClient(process.env.DATABASE_URL_DEMO, 'DEMO')
  return globalForPrisma.prismaDemo
}

/** A transaction handle, or the client itself. Services accept either. */
export type Db = PrismaClient | Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]
