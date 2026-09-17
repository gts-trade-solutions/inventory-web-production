import { NextResponse } from 'next/server'

/**
 * Unauthenticated, for uptime checks and for a device to confirm it can reach
 * the server before deciding it is offline.
 *
 * Deliberately does not touch the database: an uptime check that fails when
 * MySQL is briefly busy tells you nothing useful about the web tier.
 */
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    time: new Date().toISOString(),
    version: process.env.npm_package_version ?? '0.1.0',
  })
}
