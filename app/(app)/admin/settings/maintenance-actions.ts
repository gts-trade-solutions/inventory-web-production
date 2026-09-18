'use server'

import { revalidatePath } from 'next/cache'
import { UserRole } from '@prisma/client'
import { requireRole } from '@/lib/auth/guards'
import { rebuildStockProjection, runNightlySweep } from '@/lib/services/maintenance'

/**
 * Checking and repairing the stock projection.
 *
 * `stock_levels` agreeing with the ledger is this system's central claim, so an
 * administrator needs to be able to ask the question and to act on the answer
 * without a developer.
 */

export interface MaintenanceState {
  error?: string
  message?: string
  driftRows?: number
}

export async function runSweepAction(): Promise<MaintenanceState> {
  const admin = await requireRole(UserRole.ADMIN)

  try {
    const result = await runNightlySweep(admin.db, admin.mode)

    return {
      driftRows: result.drift.rows,
      message:
        result.drift.rows === 0
          ? `Checked in ${(result.ms / 1000).toFixed(1)}s. The ledger and the projection agree, and ${result.expiry.markedExpired} batches were marked expired.`
          : `${result.drift.rows} stock rows do not match the ledger. Nothing has been changed — rebuild once you know why.`,
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'The check could not be run.' }
  }
}

export async function rebuildProjectionAction(): Promise<MaintenanceState> {
  const admin = await requireRole(UserRole.ADMIN)

  try {
    const result = await rebuildStockProjection(admin.db, { userId: admin.userId })

    revalidatePath('/inventory')
    revalidatePath('/dashboard')

    return {
      driftRows: 0,
      message: `Rebuilt ${result.rows} stock rows from the ledger, correcting ${result.driftBefore} that disagreed.`,
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'The rebuild could not be run.' }
  }
}
