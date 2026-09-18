'use server'

import { z } from 'zod'
import { requireUser } from '@/lib/auth/guards'
import { assertDemoMode } from '@/lib/mode'
import { push, type PushMovement, type PushResult } from '@/lib/services/sync'

/**
 * The simulated handset's outbox.
 *
 * This demonstrates the MOBILE contract from the web, before the mobile app
 * exists: work is queued while disconnected, then pushed as one batch and
 * judged row by row (DEMO_MODE §6, "Offline and sync").
 *
 * It deliberately does NOT make the web movement form offline-capable. The web
 * app is online by design; offline belongs to the phone. Threading a demo-only
 * queue through the real write path would put demo branching into production
 * code, which is the thing Demo mode exists to avoid (DEMO_MODE §3).
 *
 * What it does instead is call the same `/sync/push` service the phone will,
 * so the verdicts are real: a genuine document number, a genuine duplicate on
 * replay, a genuine negative-stock flag landing in Exceptions.
 */

const rowSchema = z.object({
  id: z.string().uuid(),
  itemId: z.string().uuid(),
  type: z.enum(['RECEIVE', 'ISSUE', 'MOVE', 'ADJUST', 'SCRAP', 'COUNT']),
  quantity: z.number().int().positive(),
  fromLocationId: z.string().uuid().nullable().optional(),
  toLocationId: z.string().uuid().nullable().optional(),
  occurredAt: z.string(),
})

export interface SyncOutcome {
  results?: PushResult[]
  serverTime?: string
  error?: string
}

export async function syncOutboxAction(rows: unknown): Promise<SyncOutcome> {
  const user = await requireUser()

  // No path from this screen to live stock. The page is only rendered in DEMO,
  // and this refuses anyway rather than trusting that.
  try {
    assertDemoMode(user.mode, 'The simulated handset')
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Demo mode only.' }
  }

  const parsed = z.array(rowSchema).max(100).safeParse(rows)
  if (!parsed.success) return { error: 'That outbox could not be read.' }

  const siteId = user.defaultSiteId ?? user.siteIds[0]
  if (!siteId) return { error: 'Your account is not assigned to a site.' }

  const movements: PushMovement[] = parsed.data.map((row) => ({
    ...row,
    siteId,
    // `push` stamps the source as MOBILE itself, which is right: this is
    // standing in for a handset, and a demo that logged these as WEB would
    // misrepresent the ledger it is showing off.
    fromLocationId: row.fromLocationId ?? null,
    toLocationId: row.toLocationId ?? null,
  }))

  try {
    const outcome = await push(user.db, movements, {
      userId: user.userId,
      deviceId: null,
    })
    return outcome
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'The outbox could not be pushed.' }
  }
}
