'use server'

import { requireUser } from '@/lib/auth/guards'
import { resolveScan, type ScanResolution } from '@/lib/services/scan'

export interface ScanState {
  /** Newest first, so the latest scan is at the top of the screen. */
  history: Array<{ code: string; at: string; result: ScanResolution }>
  error?: string
}

export async function scanAction(prev: ScanState, formData: FormData): Promise<ScanState> {
  const user = await requireUser()
  const code = String(formData.get('code') ?? '').trim()

  if (!code) return { ...prev, error: 'Nothing was scanned.' }

  const siteId = user.defaultSiteId ?? user.siteIds[0]
  if (!siteId) return { ...prev, error: 'Your account is not assigned to a site.' }

  const result = await resolveScan(user.db, code, siteId)

  return {
    // Capped, because an operator working a shift would otherwise accumulate
    // hundreds of entries in a page that never reloads.
    history: [{ code, at: new Date().toISOString(), result }, ...prev.history].slice(0, 25),
  }
}
