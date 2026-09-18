'use server'

import { z } from 'zod'
import { requireUser } from '@/lib/auth/guards'
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
    return { report: await runSelfTest(user.db, parsed.data.deviceId) }
  } catch (error) {
    // A self-test that cannot run is itself a finding, so it comes back as a
    // message rather than an error page.
    return {
      error:
        error instanceof Error ? error.message : 'The self-test could not be started.',
    }
  }
}
