'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { UserRole } from '@prisma/client'
import { requireRole, requireUser } from '@/lib/auth/guards'
import { resetDemoData } from '@/lib/services/demo-reset'
import { runSelfTest } from '@/lib/services/devices'
import type { SelfTestReport } from '@/lib/devices/printer'

/**
 * Running a device self-test from the console.
 *
 * Open to any signed-in user. The person standing next to a printer that is not
 * printing is the one who needs to know why, and making them find a supervisor
 * first turns a five-minute problem into an hour.
 */

const schema = z.object({ deviceId: z.string().uuid() })

export interface SelfTestState {
  report?: SelfTestReport
  error?: string
}

export async function runSelfTestAction(
  _prev: SelfTestState,
  formData: FormData,
): Promise<SelfTestState> {
  const user = await requireUser()

  const parsed = schema.safeParse({ deviceId: formData.get('deviceId') })
  if (!parsed.success) return { error: 'That device could not be identified.' }

  try {
    return { report: await runSelfTest(user.db, parsed.data.deviceId, user.mode) }
  } catch (error) {
    // A self-test that cannot run is itself a finding, so it comes back as a
    // message rather than an error page.
    return {
      error: error instanceof Error ? error.message : 'The self-test could not be started.',
    }
  }
}

// ---------------------------------------------------------------------------

/**
 * Resetting the demo data.
 *
 * Admin-only and audited. The mode assertion lives in the service, on its first
 * line, so there is no path from here to the live database even if this file
 * were called in LIVE mode by mistake (DEMO_MODE §7.6).
 */
export interface DemoResetState {
  message?: string
  error?: string
}

export async function resetDemoAction(
  _prev: DemoResetState,
  _formData: FormData,
): Promise<DemoResetState> {
  const user = await requireRole(UserRole.ADMIN)

  try {
    const result = await resetDemoData(user.db, user.mode, { userId: user.userId })

    revalidatePath('/', 'layout')
    return {
      message: `Demo data reset in ${(result.ms / 1000).toFixed(1)} seconds. Every screen is back to its starting state.`,
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'The demo data could not be reset.',
    }
  }
}
